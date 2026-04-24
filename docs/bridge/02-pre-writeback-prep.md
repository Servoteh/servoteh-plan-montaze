# Phase B/C/D/E preparation — pre-writeback analysis

> **Status:** Pre-decision dokument. Phase B (risk register), Phase C (design opcije), Phase D (preporuka — skeleton), Phase E (PoC plan — skeleton). Nije implementacija. Nije commit u kod. **Čeka eksplicitnu listu polja od korisnika** pre nego što se Phase D popuni i Phase E aktivira.
> **Datum:** 2026-04-23 (rev 1).
> **Predmet analize:** Supabase → MSSQL write-back za sve module ovog repo-a (Lokacije, Plan Proizvodnje, Plan Montaže, Kadrovska, Sastanci).
> **Pretpostavka:** sve činjenice iz `docs/bridge/01-current-state.md` (revizija 2, sa §11 postscript-om) važe. Citati u ovom dokumentu se ne ponavljaju ako su već u Phase A; nove činjenice (sa konkretnim brojevima/imenima) imaju svoj citat.

---

## 0. Sažetak za rukovodstvo

Trenutno **NE pišemo iz Supabase u MSSQL** (potvrdio korisnik). Kod (`workers/loc-sync-mssql`) je pripremljen, ali ciljni T-SQL SP `dbo.sp_ApplyLocationEvent` **ne postoji u BigTehn (`QBigTehn`) bazi** — verifikovano u `script.sql` dump-u. To znači da bilo koji projekat write-back-a uključuje **i dostavljanje novog T-SQL SP-a u BigBit**, ne samo Supabase i Node stranu.

Tehnički, najmanji rizik / najveća predvidljivost dolazi od **proširenja postojećeg outbox patterna** (Supabase → outbox → Node worker → idempotentni T-SQL SP), jer:

- već radimo to za Lokacije (kod je tu, treba ga samo „upaliti"),
- 0 triggera na ciljnim tabelama u BigBit-u → niži rizik cascade efekata (verifikovano `script.sql` Grep-om),
- imamo `DIVIspravkeRN` kao surrogate concurrency token za optimistic locking u `tRN`/`tStavkeRN`,
- imamo Telegram alerter koji već radi (potvrdio korisnik) → operativna observability na čekanju.

Najveći rizici za bilo koje pisanje su:

1. **Race sa BigBit Access front-endom i Negovan-ovim SP-ovima** — paralelno menjaju iste redove u `tRN`/`tStavkeRN` (rizik #1, vidi §1.1).
2. **`int` vs `numeric(12,3)` neslaganje za količine** — `tLokacijeDelova.Kolicina int` ne prima decimalne (rizik #4).
3. **Naive datetime u BigBit-u vs `TIMESTAMPTZ` u Supabase** — DST pomak 2× godišnje (rizik #6).

Svaki taj rizik ima konkretan kontrol-mehanizam koji se može implementirati pre prvog redovnog write-a (vidi §1).

---

## 1. Phase B — Risk register

> Forma: 18 obaveznih rizika iz prompt-a §3, sa konkretnim BigTehn kontekstom. Polja: **vrsta**, **opis**, **šansa** (L/M/H), **uticaj** (L/M/H), **detekcija**, **mitigacija**, **owner**.
> **Šansa/uticaj** su procene na osnovu trenutnih činjenica; svaka može biti revidirana kad korisnik specificira polja za write-back.

### 1.1 Race condition / izgubljen update

| | |
|---|---|
| **Vrsta** | Concurrency |
| **Opis** | Access front-end (BigBit) i Supabase istovremeno menjaju isti red u `tRN` ili `tStavkeRN`. Pošto BigBit nema `rowversion`, oslanjamo se na `DIVIspravkeRN datetime` kao optimistic lock token. Ako Access ne ažurira `DIVIspravkeRN` pri svakom save-u (ili ako naša UPDATE klauzula ne uključuje `DIVIspravkeRN` u `WHERE`), drugi pisač pregazi prvog. |
| **Šansa** | **M** za Lokacije (radnik retko menja istu policu istovremeno na 2 mesta), **H** za `tRN.IDStatusPrimopredaje` (statusne promene su frekventne, dva čoveka mogu istovremeno) |
| **Uticaj** | **H** — silently lost write, audit trail u ERP-u izvan zdravog razuma |
| **Detekcija** | (a) periodična cron skripta koja poredi `tRN.DIVIspravkeRN` sa `bigtehn_work_orders_cache.div_ispravke_rn` (ako je migrišemo); (b) UPDATE sa `WHERE DIVIspravkeRN = @ExpectedTs` vraća `@@ROWCOUNT = 0` → SP raise-uje `THROW 60001, 'STALE_VERSION'` koji worker mapira u `loc_sync_outbound_events.status = 'FAILED'` sa `last_error = 'STALE_VERSION'`. |
| **Mitigacija** | Obavezan optimistic concurrency u SP-u: `UPDATE ... WHERE PK = @Id AND DIVIspravkeRN = @ExpectedTs`. Pri `STALE_VERSION` Supabase strana ne pokušava ponovo automatski — zahteva user intervention (UI banner: „Promenjeno u BigBit-u, refresh i pokušajte ponovo"). |
| **Owner** | Backend (T-SQL SP autor + Supabase RPC autor) |

### 1.2 Trigger cascade efekti

| | |
|---|---|
| **Vrsta** | Cross-system side-effects |
| **Opis** | Naš UPDATE/INSERT pokrene trigger u BigBit bazi koji menja druge tabele, šalje email, repliciraj na drugu instancu, baci grešku. |
| **Šansa** | **L** — Grep nad `script.sql` daje 0 hits za `CREATE TRIGGER ... ON [dbo].[tRN|tStavkeRN|tTehPostupak|tLokacijeDelova|Predmeti|Komitenti|tRadnici|tPozicije]`. |
| **Uticaj** | **H** ako bi se desilo (silent korumpacija drugih tabela) |
| **Detekcija** | Pre prvog production write-a, query `SELECT * FROM sys.triggers WHERE parent_id IN (OBJECT_ID('dbo.tRN'), ...)` na **live** bazi (dump može biti zastareo). |
| **Mitigacija** | (a) PoC test u staging kopiji baze sa real data, posmatranjem `sys.dm_exec_query_stats` na trigger objekte; (b) ako se otkrije trigger, ručno mapirati šta radi i prilagoditi SP. |
| **Owner** | Backend |

### 1.3 Foreign key violations

| | |
|---|---|
| **Vrsta** | Referential integrity |
| **Opis** | Pišemo `IDPredmet` ili `BBIDKomitent` koji ne postoji u BigBit-u (npr. korisnik je u Supabase-u dodao novog kupca, eksterni Bridge još nije sinkronizovao njegov `Komitenti.Sifra`). |
| **Šansa** | **H** za sve module koji nisu Lokacije (Lokacije se pišu **samo na osnovu** stavki koje su već u BigBit-u — RN-ovi); za Plan Proizvodnje / Sastanke verovatno se pojavljuju Supabase-only entiteti. |
| **Uticaj** | **M** — SP odbija INSERT, worker beleži `FAILED`, `attempts` raste, eventualno `DEAD_LETTER`. Ne korumpira, ali blokira business proces. |
| **Detekcija** | SP eksplicitno proverava `IF NOT EXISTS (SELECT 1 FROM Predmeti WHERE IDPredmet = @IDPredmet) THROW 60002, 'PREDMET_NOT_FOUND', 1`. |
| **Mitigacija** | (a) Pre svakog write-back-a, Supabase RPC verifikuje da BigTehn FK-target postoji u relevantnoj `bigtehn_*_cache` tabeli — ako ne, baca grešku **pre** ulaska u outbox; (b) za nove Supabase-only entitete, definisati explicit "create-on-demand" politiku ili "BigTehn user mora prvo da dodaje". |
| **Owner** | Backend + UX (kako prikazati grešku) |

### 1.4 Tip / kolacija mismatch

| | |
|---|---|
| **Vrsta** | Schema |
| **Opis** | Supabase `text` (UTF-8, neograničen) vs BigBit `nvarchar(20)` ili `nvarchar(50)` — vrednost iz Supabase je predugačka i SP truncate-uje ili odbija. Konkretni primeri: `Komitenti.Naziv nvarchar(50)`, `tPozicije.Pozicija nvarchar(20)`. |
| **Šansa** | **M** — biva čim se prvi put pojavi naziv duži od 50 char. |
| **Uticaj** | **L** ako SP odbija; **M** ako tiho truncate-uje (naročito problematično jer ostaje u BigBit-u nepotpun naziv). |
| **Detekcija** | Pre INSERT/UPDATE, Supabase RPC validira `length(naziv) <= 50`. SP dodatno koristi explicit `CAST/CONVERT` da bi truncation bio eksplicitan. |
| **Mitigacija** | Validation u Supabase pre nego što se ulazi u outbox. |
| **Owner** | Backend (Supabase RPC) |

### 1.5 Cyrillic / encoding (gubitak ćirilice/dijakritika)

| | |
|---|---|
| **Vrsta** | Schema |
| **Opis** | Supabase šalje UTF-8, BigBit kolone su `nvarchar` (UTF-16). Tedious driver bind-uje sa `sql.NVarChar(...)` — bezbedno. **Default kolacija baze** (needs verification, verovatno `Cyrillic_General_CI_AS`) utiče samo na sortiranje/poređenje, ne na čuvanje (`nvarchar` čuva sve Unicode codepoint-e). |
| **Šansa** | **L** za stored values; **M** za query/sortiranje (npr. ako se kasnije pretražuje po `LIKE N'%Петровић%'` i kolacija je akcent-sensitive, ne nađe „Петровиц"). |
| **Uticaj** | **L** za stored values; **M** za pretragu. |
| **Detekcija** | PoC test sa: „Петровић", „Đorđe", „Čačak", „Aliđorđevitcz" — round-trip Supabase → MSSQL → backfill nazad → poređenje. |
| **Mitigacija** | Svi bind-ovi `sql.NVarChar` (ne `sql.VarChar`); SP koristi `N'...'` literale; validacija round-trip-a u PoC-u. |
| **Owner** | Backend |

### 1.6 Datum/vreme i DST (TZ drift)

| | |
|---|---|
| **Vrsta** | Schema (TZ) |
| **Opis** | Supabase je UTC (`TIMESTAMPTZ`). BigBit je „naive Belgrade local" (`datetime`, ali bez TZ; SP-ovi koriste `GETDATE()` koji je server-local). Ako SP samo radi `INSERT ... VALUES (@MovedAtUtc)`, vrednost u BigBit-u će biti UTC, ali sortirana sa Belgrade local datumima → naizgled „pomereno za 1–2 sata". DST transit (poslednja nedelja marta i oktobra) duplira/ispari sat. |
| **Šansa** | **H** ako SP ne konvertuje TZ. |
| **Uticaj** | **M** — datum izveštaji u BigBit-u prikazuju pogrešan dan za eventove blizu ponoći. |
| **Detekcija** | PoC test sa eventom u 23:30 UTC (odgovara 00:30 ili 01:30 Belgrade — depending on DST) → SP upiše datum, BigBit izveštaj prikazuje 00:30, ne 23:30. Verifikuje se vizuelno. |
| **Mitigacija** | SP konvertuje: `SET @MovedAtLocal = @MovedAtUtc AT TIME ZONE 'UTC' AT TIME ZONE 'Central European Standard Time'` (SQL Server 2017 podržava). Sve `Datum`/`DatumIVremeUnosa` u SP-u dolaze iz `@MovedAtLocal`, ne `GETDATE()`. |
| **Owner** | Backend |

### 1.7 UUID / endianness

| | |
|---|---|
| **Vrsta** | Schema (UUID) |
| **Opis** | Supabase UUID je big-endian; MSSQL `UNIQUEIDENTIFIER` je mixed-endian (prve 3 grupe little-endian). `sql.UniqueIdentifier` u tedious driver-u radi konverziju, ali round-trip mora biti potvrđen. |
| **Šansa** | **N/A** ako ne čuvamo Supabase UUID u BigBit-u (dovoljan je idempotency token u outbox-u). |
| **Uticaj** | **L** ako je samo idempotency; **H** ako se UUID koristi kao FK ili upit. |
| **Detekcija** | Test: insert event sa UUID `00112233-4455-6677-8899-aabbccddeeff`, čitati nazad iz BigBit-a kao varbinary(16), uveri se da je `33221100-5544-7766-8899-aabbccddeeff` (mixed-endian) ili identičan (driver-fixed). |
| **Mitigacija** | (a) **Ne čuvamo UUID u BigBit-u** — koristimo ga samo kao `@EventId` parametar SP-a za idempotency check (vrednost se može hash-ovati u BIGINT i čuvati u `dbo._sync_processed_events(event_hash bigint, processed_at datetime)`); (b) ako moramo čuvati pun UUID, koristimo `nchar(36)` (string), ne `UNIQUEIDENTIFIER`. |
| **Owner** | Backend |

### 1.8 Decimalni / scale gubitak (`int` vs `numeric(12,3)`)

| | |
|---|---|
| **Vrsta** | Schema (numerika) |
| **Opis** | `tLokacijeDelova.Kolicina int` ne prima decimalne. Supabase `loc_location_movements.quantity NUMERIC(12,3)` može imati 1.5 ili 0.001. |
| **Šansa** | **M** — zavisi od poslovne politike (da li se delovi mere u celim komadima ili kg). |
| **Uticaj** | **H** ako se decimalna vrednost tiho zaokružuje; **L** ako SP odbija sa explicit greškom. |
| **Detekcija** | PoC test: insert movement sa `quantity = 1.5` → SP raise-uje `THROW 60003, 'NON_INTEGER_QUANTITY_FOR_INT_TARGET', 1`. |
| **Mitigacija** | Supabase RPC validira pre outbox-a: ako je ciljana tabela `tLokacijeDelova`, `quantity` mora biti integer (`quantity = floor(quantity) AND quantity = ceil(quantity)`). UI Lokacija mora postaviti `step="1"` na input field-u. **Alternativno:** dogovoriti se sa Negovanom da `tLokacijeDelova.Kolicina` postane `decimal(12,3)` (DDL change u BigBit-u — risk-y, jer može slomiti Access UI). |
| **Owner** | Backend + Product (poslovna odluka) |

### 1.9 NULL / DEFAULT politika

| | |
|---|---|
| **Vrsta** | Schema (NULL) |
| **Opis** | `tRN.SifraRadnikaPrimopredaje int NOT NULL` — ako Supabase nema mapping ko je „primopredao", ne sme se pisati NULL. `Predmeti.NabavnaVrednost money NULL` — ako se piše 0 umesto NULL, gubi se semantička razlika. |
| **Šansa** | **M** — prvi pojavak za svaku novu kolonu. |
| **Uticaj** | **L** — INSERT odbija sa explicit greškom (NOT NULL violation). |
| **Detekcija** | SP eksplicitno validira da svi NOT NULL parametri stižu sa Supabase strane. |
| **Mitigacija** | Default-ovi u SP-u za NULL parametre koji moraju biti NOT NULL u tabeli (npr. `SifraRadnika = ISNULL(@SifraRadnika, @BridgeUserId)`); jasan kontrakt na Supabase strani. |
| **Owner** | Backend |

### 1.10 Audit / atribucija

| | |
|---|---|
| **Vrsta** | Audit |
| **Opis** | BigBit Access front-end loguje `Potpis nvarchar(50)` ko je radio promenu (npr. `tRN.Potpis`). Naš write-back, koji prolazi kroz service-role, ne prosleđuje pravog autora — gubi se atribucija. Korisnik je rekao: **„gazda zna odakle to dolazi" — atribucija nije kritična** (odgovor #8). |
| **Šansa** | **N/A** — tretira se kao prihvaćeni risk. |
| **Uticaj** | **L** — za internu reviziju dovoljno je da se zna „dolazi sa Supabase". |
| **Mitigacija** | Hard-kodirati `@Potpis = 'BRIDGE'` (ili `'SUPABASE'`) u SP-u; alternativno, koristiti rezervisani `tRadnici.SifraRadnika = -1` ili `9999` kao „Bridge user". |
| **Owner** | Backend |

### 1.11 Sigurnost — credential u plain-text-u

| | |
|---|---|
| **Vrsta** | Security |
| **Opis** | Worker zahteva `SUPABASE_SERVICE_ROLE_KEY` (BYPASSRLS) i `MSSQL_PASSWORD` u env. Ako se host (VM 192.168.64.24) kompromituje, attacker dobija oba. |
| **Šansa** | **L** — VM je u LAN-u, nije izložen na internet (verifikuj). |
| **Uticaj** | **H** — service_role ključ daje pun pristup celoj Supabase bazi. |
| **Detekcija** | LAN audit; provera da `192.168.64.24` nije port-forward-ovan; periodični rotacija ključeva. |
| **Mitigacija** | (a) Rotiraj `SUPABASE_SERVICE_ROLE_KEY` kvartalno (Supabase Dashboard); (b) MSSQL user `loc_sync_worker` da ima **samo `EXECUTE` na novi SP**, ne `SELECT/INSERT/UPDATE/DELETE` na sirove tabele; (c) ne loguj credentials (verifikuj da `logger.js` ne dump-uje cele config objekte); (d) razmotriti Hashicorp Vault / Windows Credential Store ako se ostane na Win VM-u. |
| **Owner** | DevOps |

### 1.12 Sigurnost — exposing Supabase service_role van repo-a

| | |
|---|---|
| **Vrsta** | Security |
| **Opis** | Korisnik je naveo da već postoji eksterni Bridge na istoj VM. Ako i naš worker koristi isti `SUPABASE_SERVICE_ROLE_KEY`, kompromitacija jednog ugrožava drugog. |
| **Šansa** | **L** — interni alat. |
| **Uticaj** | **H**. |
| **Mitigacija** | Po mogućstvu **odvojen Supabase user-management nije moguć za service_role** (samo jedan postoji), ali se može koristiti **Postgres role** sa explicitnom `GRANT` listom na specifične RPC-ove i bez BYPASSRLS. Worker u `02-pre-writeback-prep` opciji 2 koristi taj pristup (vidi §2.2). |
| **Owner** | DevOps + Backend |

### 1.13 Operativnost — circuit breaker / kill switch

| | |
|---|---|
| **Vrsta** | Operations |
| **Opis** | Worker trenutno **nema kill switch** (vidi §1.1 Phase A). Ako počne da pravi štetu (npr. masovni FAILED, ili — još gore — masovni nepoznati uspesi koji corrupte BigBit), potrebno je sat dana da se restartuje, log inspect-uje, popravi i deploy-uje. |
| **Šansa** | **M** posle aktivacije. |
| **Uticaj** | **H** za nepoznate uspehe; **L** za FAILED (FAILED je benign). |
| **Detekcija** | Telegram bot (već postoji) može da se proširi da reportuje broj FAILED u poslednjih 5 min. |
| **Mitigacija** | **Predlog (čeka korisnikovu odluku, vidi §6):** tabelarni red u Postgres-u `bridge_runtime_flags(flag_name text PK, enabled bool, updated_at timestamptz, updated_by uuid)`. Worker pre svakog batch-a pita `SELECT enabled FROM bridge_runtime_flags WHERE flag_name = 'loc_sync_worker_enabled'`. Ako je `false`, sleep 60s i pokuša ponovo. Toggling ne zahteva restart procesa. Admin UI tab gde admin klikne „Stop Bridge" → flag se postavlja na false; toggle se loguje u `audit_log` ako je istovremeno mapiran na `actor_email`. |
| **Owner** | Backend + DevOps |

### 1.14 Operativnost — observability i alerting

| | |
|---|---|
| **Vrsta** | Operations |
| **Opis** | Trenutno nema metrika (`/metrics`, OTel). Telegram bot postoji, ali ne znamo šta tačno alertuje. Bez observability-ja, problemi se otkrivaju kasno (kada korisnik prijavi „nešto fali"). |
| **Šansa** | **H**. |
| **Uticaj** | **M** — produžava MTTR. |
| **Mitigacija** | (a) Worker dodaje strukturni log za svaki batch: `{batch_size, succeeded, failed, dead_lettered, lag_seconds}`; (b) **Postgres view** `v_bridge_health` agregira poslednjih sat vremena i bira `LAG()` između `created_at` najstarijeg PENDING-a i `now()` → ako > 60s, Telegram alarm; (c) `bridge_sync_log` (već postoji za eksterni Bridge) proširiti da i naš worker piše u njega; (d) admin UI kartica „Bridge" pokazuje queue depth, success rate, last error. |
| **Owner** | DevOps + Backend |

### 1.15 Backlog overflow

| | |
|---|---|
| **Vrsta** | Operations |
| **Opis** | Ako worker padne ili MSSQL je nedostupan više od 24h, `loc_sync_outbound_events` može da naraste na hiljade redova. Pri ponovnom startu, batch flood može da preoptereti BigBit (Express edition ima limit od 1410 MB RAM i 4 cores). |
| **Šansa** | **L** za normalno; **M** za incidente. |
| **Uticaj** | **M** — usporava BigBit Access front-end; korisnici primete „spor je ERP". |
| **Mitigacija** | (a) `BATCH_SIZE` cap već je 100 (postojeći SQL); (b) dodati **rate limiting** u worker-u: max N events/sec; (c) **dead-letter** posle 10 retry-ja (postoji); (d) `pg_cron` purge već radi (90 dana). |
| **Owner** | Backend |

### 1.16 Idempotency boundary

| | |
|---|---|
| **Vrsta** | Correctness |
| **Opis** | Race u worker-u: SP uspeo, worker padne pre `markSynced` → event ide u FAILED, retry pozove SP **ponovo**. SP **mora** biti idempotentan po `@EventId` (originalan zahtev iz README). Bez idempotency, dobijamo duple inserte. |
| **Šansa** | **M** za long-running events. |
| **Uticaj** | **H** — duple kolicine u `tLokacijeDelova`, dupli statusni redovi. |
| **Detekcija** | Test: simulirati `kill -9` worker-a između SP-a i markSynced (mock-uj `markSynced` da throw-uje), proveriti da drugi pokušaj **ne pravi drugi insert**. |
| **Mitigacija** | SP ima `dbo._sync_processed_events(event_id_hash bigint primary key, processed_at datetime2(3) default sysutcdatetime())` tabelu i prvo radi `IF EXISTS (SELECT 1 FROM dbo._sync_processed_events WHERE event_id_hash = @EventIdHash) RETURN;` Inače prvo upisuje hash, pa radi posao u istoj transakciji. |
| **Owner** | Backend (T-SQL) |

### 1.17 Schema drift

| | |
|---|---|
| **Vrsta** | Maintenance |
| **Opis** | BigBit DBA (Negovan) menja `tRN` (npr. dodaje kolonu `Test bit NOT NULL DEFAULT 0`) bez najave. Naš SP koji radi `INSERT INTO tRN (...)` sa explicit listom kolona prestaje da radi (ako nova kolona je NOT NULL bez DEFAULT) ili ne mari (ako ima DEFAULT). |
| **Šansa** | **M** — Negovan je u poslednjih 6 meseci dodao više objekata (`viewAktivniRNPreLansiranja` poslednja izmena 31-01-2026, `ftPregledRNZaPrimopredaju` 12-02-2026). |
| **Uticaj** | **H** za NOT NULL bez DEFAULT. |
| **Detekcija** | (a) Daily cron na MSSQL strani: `INFORMATION_SCHEMA.COLUMNS` snapshot, diff sa baseline-om, alert ako ima novi NOT NULL bez DEFAULT u target tabelama; (b) GitHub Actions slot u repo-u koji čuva snapshot DDL-a (manuelno commit-ovan jednom mesečno). |
| **Mitigacija** | (a) **Sve INSERT-e u SP-u sa explicit kolonama** (nikad `INSERT INTO X VALUES (...)`); (b) sve UPDATE-e sa eksplicitnom WHERE klauzulom; (c) drift-monitoring cron. |
| **Owner** | DevOps |

### 1.18 Backup / point-in-time recovery

| | |
|---|---|
| **Vrsta** | Disaster |
| **Opis** | Ako write-back napravi pogrešnu masovnu izmenu (bug u SP-u, pogrešna lista polja), potrebna nam je mogućnost da vratimo BigBit u prethodno stanje. SQL Express ima ograničenja: nema SQL Agent Job-ova bez Express with Advanced Services, ali backup se može raditi ručno. RPO/RTO BigBit-a je needs verification (vidi §11.5 Phase A). |
| **Šansa** | **L** ako PoC validacija prođe; **M** za prvih 30 dana posle aktivacije. |
| **Uticaj** | **H** ako se bug aktivuje pre nego što je primećen. |
| **Detekcija** | Telegram alert na svaki SP error sa `STALE_VERSION`/`PREDMET_NOT_FOUND` (već definisano u rizicima 1.1 i 1.3). |
| **Mitigacija** | (a) Pre prvog production write-a, **full backup BigBit-a** + plan vraćanja; (b) prvih 7 dana write-back radi u **„dry-run mode"** (SP samo loguje šta bi uradio u tabelu `dbo._sync_dry_run_log`, bez stvarnog izmena); (c) tek posle 7 dana audit, prebacuje se na live mod (kill switch flag iz §1.13 to omogućava bez restart-a). |
| **Owner** | DevOps + Backend |

### 1.19 (bonus) Telegram bot reliability

| | |
|---|---|
| **Vrsta** | Operations |
| **Opis** | Korisnik se oslanja na Telegram bot za alerting. Ako bot bude rate-limited od Telegram-a ili token istekne, gubimo alerting. |
| **Šansa** | **L**. |
| **Uticaj** | **M** — gubimo „vid u stvar". |
| **Mitigacija** | Drugi nezavisni alerting kanal (email preko Resend MCP-a koji je već konfigurisan — vidi `mcps/plugin-resend-resend/`); ili **fallback**: ako Telegram bot ne odgovori za 5 min, worker piše u Supabase tabelu `bridge_critical_alerts` koju admin UI prikazuje crveno na vrhu. |
| **Owner** | DevOps |

---

## 2. Phase C — Design opcije za write-back

> Pet opcija iz prompt-a §3, prilagođene konkretnoj BigTehn realnosti. Nakon što korisnik odgovori na pitanje #1 (set polja), Phase D bira **jednu** od ovih opcija.

### 2.1 Opcija A — Proširiti postojeći outbox (Supabase → Node worker → idempotentni T-SQL SP)

**Šta bi bilo:**

- Za svaki novi modul (npr. „status RN-a", „operacija završena") dodajemo sopstveni outbound event tip u `loc_sync_outbound_events` ili paralelnu tabelu `bridge_outbound_events` (generička).
- Pišemo nove T-SQL SP-ove (`dbo.sp_ApplyRnStatus`, `dbo.sp_ApplyTehPostupak`, …) koji su idempotentni po `@EventId`.
- Postojeći worker (`workers/loc-sync-mssql`) se generalizuje da rutira po `target_procedure` polju (već to radi u kodu, vidi `mssqlClient.js:45`).

**Pros:**

- **Najmanje koda dodajemo** — 70% infrastrukture već postoji.
- Idempotentnost rešena ako se SP pravilno napiše.
- Outbox garantuje at-least-once delivery i atomski insert sa biz-event-om.
- Lako se monitoruje (queue depth = backlog).
- Telegram bot može da se proširi nezavisno.

**Cons:**

- Latencija minimum nekoliko sekundi (polling, ne push).
- Worker je **single point of failure** ako se ne replikuje. Mogućnost: 2 worker-a sa različitim `WORKER_ID` — `FOR UPDATE SKIP LOCKED` garantuje bez duplog pickup-a.
- Zahteva Node runtime na BigBit VM-u (već imamo, jer eksterni Bridge tu radi).

**BigTehn-specific cost:**

- 1 Node service file (već imamo skripte).
- N novih T-SQL SP-ova (jedan po smeru pisanja).
- Možda generalizacija outbox tabele (od `loc_sync_outbound_events` u `bridge_outbound_events`).

**Lift:** **Mali (1–2 nedelje)** za prvi modul + ~3 dana po dodatnom modulu.

---

### 2.2 Opcija B — Postgres FDW (`tds_fdw`) sa explicit transactions iz Supabase RPC

**Šta bi bilo:**

- Instalirati `tds_fdw` extension u Supabase (ili samohostovani Postgres ako Supabase ne dozvoljava); kreirati FOREIGN SERVER ka MSSQL-u.
- Supabase RPC (npr. `loc_apply_rn_status`) koja istovremeno menja Postgres tabelu **i** šalje UPDATE preko FDW-a — sve u jednoj transakciji.

**Pros:**

- **Sinhrono** — pisac dobija odmah ack ili error, bez polling delay-a.
- Bez novih servisa (nema Node worker-a).
- Atomski sa Postgres izmenama (jedan COMMIT).

**Cons:**

- **Supabase managed Postgres NE PODRŽAVA `tds_fdw`** (potrebno self-host) — verifikacija sa Supabase support-om.
- FDW ne garantuje idempotency — race u SP-u ostaje rizik.
- FDW ne radi async — ako MSSQL je sporo / nedostupno, Supabase RPC poziv visi (loš UX).
- Bez outbox-a, izgubljen connection = izgubljen update — nema retry-ja.

**Lift:** **Veliki** (može da bude blocker zbog Supabase managed limitacija).

**Verdict:** Verovatno NE, osim ako ne pređemo na self-hosted Postgres.

---

### 2.3 Opcija C — MSSQL Service Broker / SQL Agent koji „povlači" promene iz Supabase

**Šta bi bilo:**

- Supabase exposuje JSON endpoint (RPC ili Edge Function) sa svim promenama od poslednjeg `last_sync_id`.
- T-SQL Service Broker queue ili SQL Agent Job radi `EXEC sp_invoke_external_rest_endpoint` (SQL Server 2022+) ili PowerShell wrapper (SQL 2017) → fetcha promene → upisuje.

**Pros:**

- **Bez novog servisa van MSSQL-a** — sve radi u BigBit infrastrukturi.
- BigBit DBA ima pun nadzor.

**Cons:**

- **SQL Express NEMA SQL Agent Job-ove** (only Standard+). Confirmation needed.
- `sp_invoke_external_rest_endpoint` zahteva SQL Server 2022 ili Azure SQL — **NE radi na 2017**.
- Service Broker je kompleksan za debug; Negovan ne radi sa njim u trenutnom kodu.
- Inverzija odgovornosti — BigBit poziva Supabase, što znači da BigBit-u treba **outbound HTTPS dozvola** (firewall, sertifikati).

**Lift:** **Veliki** + verovatno blokiran tehničkim ograničenjima.

**Verdict:** Skip osim ako se kupi Standard edition i upgrade na 2022.

---

### 2.4 Opcija D — Edge Function direktno piše u MSSQL preko `tedious` u Deno

**Šta bi bilo:**

- Supabase Edge Function (Deno runtime) koristi `npm:tedious` da otvori TCP konekciju ka MSSQL-u.
- Promenа iz UI-ja ide preko Edge Function umesto preko outbox-a.

**Pros:**

- **Sinhrono** — kao Opcija B, ali bez FDW limitacija.
- Bez Node worker servisa van repo-a.
- Edge Function se pakuje sa repo-om (Git-managed).

**Cons:**

- Edge Functions zahtevaju **outbound TCP iz Supabase ka BigBit VM-u**. BigBit VM mora biti **public IP** ili imati VPN tunel ka Supabase-u — drastična promena network topology-je.
- Latencija varira (Edge Function cold start).
- Bez outbox-a, izgubljen poziv = izgubljen update.
- `tedious` u Deno možda ima TLS gotchas.

**Lift:** **Srednji** + zahteva network promene koje korisnik nije signalizirao da je spreman da uradi.

**Verdict:** Skip ako se BigBit VM ne želi izložiti.

---

### 2.5 Opcija E — Hibrid: Supabase outbox + Edge Function pumpa (umesto Node worker-a)

**Šta bi bilo:**

- Outbox kao u Opciji A, ali umesto Node worker-a koji polluje, **pg_cron** + **Edge Function**: cron svakih 30s zove Edge Function koja procesuje N PENDING events.
- Edge Function radi `tedious` poziv ka MSSQL-u, isti SP kao u Opciji A.

**Pros:**

- Bez Node servisa van repo-a — sve je serverless u Supabase ekosistemu.
- Cron schedule je predvidljiv i Git-managed.

**Cons:**

- Edge Function timeout (60s default) — može da limitira batch size.
- Network: Supabase → BigBit VM zahteva publike IP ili VPN (isti problem kao Opcija D).
- Edge Function loguje samo u Supabase Logflare → manje fleksibilan logging od dedicated Node service-a.

**Lift:** **Srednji** + zahteva network promene.

**Verdict:** Drugorazredna opcija — **prihvatljiva** ako želi konsolidaciju u Supabase, ali izgubi se „klasični" debugging.

---

### 2.6 Brza tabela poređenja (Phase D ulaz)

| Kriterijum | A. Outbox + Node | B. FDW | C. SB / SQL Agent | D. Edge → MSSQL | E. Outbox + Edge |
|---|---|---|---|---|---|
| Latencija | 5–30s | <1s | 30s–5min | <1s | 30s–60s |
| At-least-once garancija | **Da** | Ne | Da | Ne | **Da** |
| Idempotency obavezna | **Da** (već dizajnirano) | Ne | **Da** | Ne | **Da** |
| Risk od Supabase managed limit | Nema | **Visok** (FDW) | N/A | Nema | Nema |
| Risk od BigBit edition limit | Nema | Nema | **Visok** (Express bez Agent-a) | Nema | Nema |
| Network promene potrebne | Nema (već LAN) | Nema | Nema | **Da** (BigBit public/VPN) | **Da** |
| Operativna kompleksnost | **Niska** (već gotovo 70%) | Srednja | Visoka | Niska | Srednja |
| Debug-friendly | **Da** | Srednje | Loše | Srednje | Srednje |
| Ukupno (subjektivno) | **★★★★★** | ★★ | ★ | ★★ | ★★★ |

---

## 3. Phase D — Preporuka (skeleton, čeka set polja)

> Phase D će izabrati **jednu** od opcija A–E i konkretizovati je za listu polja koju korisnik definiše. Sve dok ne dobijem listu polja, mogu samo iznositi pretpostavku, koja se piše ovde i sačekuje potvrdu.

### 3.1 Pretpostavljena preporuka (čeka korisnikovu potvrdu set polja)

**Opcija A — Proširiti postojeći outbox.**

**Razlozi:**

1. 70% infrastrukture već je u repo-u (`workers/loc-sync-mssql`, `loc_sync_outbound_events`, `loc_claim_sync_events` RPC).
2. Telegram bot već postoji (mogućnost za alerting bez nove integracije).
3. Latencija 15–30s je prihvatljiva (potvrdio korisnik, odgovor #10).
4. Eksterni Bridge već radi na istoj VM (`192.168.64.24`) — naš worker se može hostovati pored njega bez dodatnih troškova.
5. Nema network promena potrebnih (Worker → MSSQL ostaje LAN; Worker → Supabase ostaje HTTPS, već radi za eksterni Bridge).
6. Naš tim (i ja) već zna ovaj patern — niža training cost.

### 3.2 Konkretni deliverable-i (kad set polja bude poznat)

> Ovo je **template** — popunjava se posle korisnikove potvrde liste polja.

| Tip | Specifika | Odgovornost |
|---|---|---|
| **Postgres migration** | `bridge_outbound_events` tabela (ili rename postojeće); generic claim/mark RPCs; insert triggeri za nove module | Backend (Postgres) |
| **T-SQL** | Po jedan SP per cilj (`dbo.sp_Apply<Module><Action>`), svi sa idempotency tabelom `dbo._sync_processed_events`, optimistic concurrency, eksplicitnim error codes (60001+), TZ konverzija UTC→Belgrade | Backend (T-SQL) — predlažem da pišemo mi (ne čekamo Negovana, korisnik je rekao da ga preskočimo u ovoj fazi), ali da Negovan validira pre deploy-a |
| **Worker** | Generalizacija (`workers/bridge-worker`) za ne-Lokacije module; dodavanje `bridge_runtime_flags` provere; rate limiter; Telegram alert hook | Backend (Node) |
| **UI** | Admin tab „Bridge" sa queue depth, error rate, kill switch toggle, manuelni replay konkretnog event-a | Frontend |
| **Observability** | `v_bridge_health` view, dnevni health report, Telegram alerter | DevOps |
| **PoC plan** | Vidi §4 | Backend |

---

## 4. Phase E — PoC plan (skeleton, čeka set polja)

> PoC se pokreće tek po **pisanoj potvrdi korisnika** da idemo sa Opcijom A (ili drugom) i sa konkretnom listom polja.
> Trajanje PoC-a: **5 radnih dana** (mali set polja) do **10 radnih dana** (veliki set + multiple SP-ova).

### 4.1 Faza 1 — Setup (dan 1–2)

| Korak | Akcija | Verifikacija |
|---|---|---|
| 1.1 | Backup `QBigTehn` baze (full) | `RESTORE VERIFYONLY FROM DISK = ...` |
| 1.2 | Klonirati u `QBigTehn_Staging` | `SELECT name FROM sys.databases` |
| 1.3 | Definisati MSSQL user `loc_sync_worker` ako ne postoji; dati mu `EXECUTE` samo na nove SP-ove | `SELECT * FROM sys.database_principals WHERE name = 'loc_sync_worker'` |
| 1.4 | Verifikovati da li je `READ_COMMITTED_SNAPSHOT` ON (`SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = N'QBigTehn'`) | Reportovati u PoC log |
| 1.5 | Verifikovati default kolaciju baze (`SELECT collation_name FROM sys.databases WHERE name = N'QBigTehn'`) | Reportovati |
| 1.6 | Verifikovati edition (`SELECT @@VERSION`) | Reportovati (utvrditi da li je SQL Express limit problem za nas) |

### 4.2 Faza 2 — Schema crosswalk (dan 2)

| Korak | Akcija | Verifikacija |
|---|---|---|
| 2.1 | Za svako polje sa korisnikove liste, popuni red u tabeli „Source → Target → Risks" (template u §4.6) | Review sa korisnikom |
| 2.2 | Identifikuj sva NOT NULL polja u target tabelama gde Supabase nema mapping; definiši default-ove | Pisano u SP-u |
| 2.3 | Identifikuj sve `nvarchar(N)` limite u target-ima i postavi validacije u Supabase RPC | RPC test |

### 4.3 Faza 3 — T-SQL SP-ovi (dan 3–4)

| Korak | Akcija | Verifikacija |
|---|---|---|
| 3.1 | Napisati `dbo._sync_processed_events` tabelu | `SELECT * FROM sys.tables WHERE name = N'_sync_processed_events'` |
| 3.2 | Napisati prvi SP (npr. `dbo.sp_ApplyRnStatusChange`) sa: `BEGIN TRY/TRAN`, `XACT_ABORT ON`, idempotency check, optimistic concurrency, TZ konverzija, eksplicitne error code-ove | unit test sa T-SQL `EXEC` |
| 3.3 | Test scenariji: (a) happy path, (b) `STALE_VERSION`, (c) duplicate event_id (idempotency), (d) FK miss | sve tri prolaze |

### 4.4 Faza 4 — Postgres + Worker (dan 4–5)

| Korak | Akcija | Verifikacija |
|---|---|---|
| 4.1 | Migracija `bridge_outbound_events` (ili reuse existing `loc_sync_*`) | `psql \dt` |
| 4.2 | Trigger na izvornoj Supabase tabeli koji puni outbox | `INSERT` test → red u outbox |
| 4.3 | Generalizacija `workers/loc-sync-mssql` na multi-procedure routing | unit test |
| 4.4 | `bridge_runtime_flags` tabela + provera u worker loop-u | toggle test |

### 4.5 Faza 5 — End-to-end (dan 5)

| Korak | Akcija | Verifikacija |
|---|---|---|
| 5.1 | Deploy worker na VM 192.168.64.24 (najpre **dry-run mod**) | Telegram alert „worker started" |
| 5.2 | UI klik → menjanje statusa RN-a → outbox → worker → SP `dry-run mode` (`dbo._sync_dry_run_log`) | red u dry-run log-u, pravo polje **NIJE** menjano |
| 5.3 | Verifikuj happy path 50 puta zaredom | `dry_run_log.count = 50` |
| 5.4 | Inject scenarios: stale version, FK miss, duplicate, decimal qty | Telegram alarmi za FAILED, queue ostaje konsistentan |
| 5.5 | Posle 24h dry-run-a, ako 0 nepoznatih grešaka, prebaciti `dry_run` flag → `live` (kill switch toggle) | Production write radi |
| 5.6 | Posle 7 dana production-a + 0 incidenata, ukinuti dry-run kod ili ga ostaviti za buduća proširenja | PoC finished |

### 4.6 Schema crosswalk template (popunjava se po polju)

| # | Source (Supabase) | Target (MSSQL) | Type/length match? | Cyrillic risk? | NULL/default? | Concurrency | Validation u Supabase | Mitigacija |
|---|---|---|---|---|---|---|---|---|
| 1 | `??` | `??` | | | | | | |

### 4.7 Rollback plan

Ako PoC dan 5 otkrije neprihvatljive probleme:

1. Worker na VM → `systemctl stop loc-sync-mssql.service` (ili `pm2 stop`).
2. Postgres outbox flag → `UPDATE bridge_runtime_flags SET enabled = false WHERE flag_name = 'loc_sync_worker_enabled'`.
3. PENDING events ostaju u outbox-u (ne brišu se).
4. MSSQL: ako je dry-run mod bio aktivan, **nema potrebe za rollback-om** podataka (nije ih ni bilo). Inače, restore iz backup-a sa dana 1.
5. Telegram poruka „Bridge disabled, manual intervention required".

---

## 5. Otvorena pitanja koja čekaju korisnika

Pre Phase D unlock-a (popunjavanje preporuke i pokretanja Phase E):

1. **Lista polja za write-back** (ovo je glavno pitanje #1 iz prethodnog seta — još uvek čekamo).
2. Da li je predlog za **kill switch** (tabelarni red u Postgres + admin UI toggle, vidi §1.13 i §6) prihvatljiv? Ili korisnik preferira nešto drugo (env var, file flag na VM-u, IP whitelist)?
3. Da li je 7-dnevni **dry-run period** prihvatljiv kao bezbedonosna mreža pre prvog production write-a? (Može se skratiti na 2–3 dana ako je urgent.)

---

## 6. Predlog za kill switch (odgovor na korisnikovo pitanje #9)

**Predlog: tabelarni red u Postgres + admin UI toggle.**

**Implementacija:**

```sql
CREATE TABLE public.bridge_runtime_flags (
  flag_name   text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id),
  notes       text
);

INSERT INTO public.bridge_runtime_flags (flag_name, enabled, notes)
VALUES
  ('loc_sync_worker_enabled', true, 'Master kill switch za Lokacije outbound worker'),
  ('rn_status_writeback_enabled', false, 'Po default off; admin uključuje kad je SP testiran');
```

**Zašto baš ovo:**

1. **Restart-free toggle:** Worker pre svakog batch-a pita flag (1 query, < 5ms u istoj DB transakciji); admin samo izmeni red, worker prima u sledećem ciklusu.
2. **Audit:** `updated_by` + `updated_at` daje ko i kad. Plus `audit_log` (već imamo `audit_row_change()` u repo-u) automatski logiluje.
3. **Granularnost:** Mogu da se isključe **pojedinačni** moduli, ne ceo worker. Korisno kad jedan SP ima problem a ostali rade.
4. **UI:** Admin tab sa toggle switchovima — korisnik klikne, worker se „uspava" za taj modul, ostali nastavljaju.
5. **Ne zahteva Linux/Windows access za toggle:** ako worker je deployovan kao service na VM, ne treba ssh/RDP da bi se pauzirao.
6. **Zero infrastructure cost:** koristi postojeću Supabase bazu; nema dodatnih servisa.

**Alternativni mehanizmi koje sam razmotrio:**

| Alternativa | Razlog odbijanja |
|---|---|
| Env var (`BRIDGE_ENABLED=false`) + restart | Restart svakog put kvari uptime; admin mora SSH na VM. |
| Fajl flag (`/var/run/loc-sync.disabled`) | Isti problem; plus needs file system permissions. |
| IP whitelist na MSSQL strani | Drastično — gasi sve, ne granularno. Zahteva DB admin akciju. |
| `systemctl stop` | Drastično — gubi PENDING events ako worker baš batchuje. |
| Killing procesa | Prljavo, gubi in-flight batch. |

---

## 7. Status Phase A → E

```
[X] Phase A — Discovery (rev 1, dat 2026-04-23)
[X] Phase A rev 2 — Postscript sa script.sql verifikacijama (dat 2026-04-23)
[X] Phase B — Risk register (generic, sa BigTehn kontekstom; dat 2026-04-23)
[X] Phase C — 5 design opcija sa pros/cons + tabela poređenja (dat 2026-04-23)
[ ] Phase D — Preporuka (skeleton spreman; čeka korisnikov set polja za write-back i potvrdu da idemo Opcija A)
[ ] Phase E — PoC plan (skeleton spreman; čeka Phase D potvrdu)
```

**Sledeći korak:** Korisnikov odgovor na pitanja u §5.
