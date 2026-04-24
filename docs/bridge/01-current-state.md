# Phase A — Current state of SQL Server ↔ Supabase bridge

> **Status:** Phase A deliverable (Discovery, read-only). **Revisija 2: 2026-04-23 (kasno popodne)** — dodate verifikovane činjenice iz `script.sql` (BigBit MSSQL DDL, 6.17 MB) i odgovora korisnika na 10 ciljanih pitanja. Originalni tekst nije promenjen; dopune su naznačene kao **NEW (rev 2)** i sažete u sekciji 11.
> **Datum:** 2026-04-23.
> **Autor:** AI senior architect (analiza kroz `CURSOR_BRIDGE_ANALYSIS_PROMPT.md`).
> **Pravilo:** ovaj dokument iznosi **samo činjenice sa citatima**. Bez preporuka. Sve što nisam mogao da utvrdim iz koda obeleženo je sa **`ASSUMPTION — needs verification`**.
> **Skopi:** šta je danas u repo-u `servoteh-plan-montaze`. Spoljni servisi (npr. „Bridge" koji puni `bigtehn_*_cache`) mogu se opisati samo posredno — kroz tragove u kodu (tabele, kolone, banner-i, env varijable). Eksplicitno je naznačeno gde je tako.

---

## 0. TL;DR

U repo-u postoji **jedan eksplicitan most**: outbound queue `Supabase → MSSQL` za modul Lokacije, implementiran kao Outbox + Node worker + idempotentni T-SQL stored procedure.

Pored njega, postoji **drugi (eksterni) Bridge proces** koji ovaj repo *ne sadrži*, ali na njegove tragove se nailazi: tabele `bigtehn_*_cache` i `bridge_sync_log`, banner u UI-ju koji upozorava na zaostajanje sync-a, jednokratna backfill skripta (`scripts/backfill-bigtehn-work-orders.js`) koja čita direktno iz `dbo.tRN`. Taj eksterni servis radi **MSSQL → Supabase** smer.

Postoji i treći mehanizam: **fajlovi (PDF crteži)** se sinhronizuju iz Win foldera `C:\PDMExport\PDFImportovano` u Supabase Storage bucket `bigtehn-drawings`, opet od strane eksternog procesa (komentari u migraciji ga zovu „Bridge").

**Trenutno stanje smerova:**

| Smer | Status | Vlasnik |
|---|---|---|
| MSSQL → Supabase (RN-ovi, kupci, mašine, tech routing, items, predmeti) | Aktivan, eksterni Bridge | Van repo-a (ASSUMPTION — needs verification) |
| MSSQL → Supabase (PDF crteži iz BigBit foldera) | Aktivan, eksterni Bridge | Van repo-a (ASSUMPTION — needs verification) |
| Supabase → MSSQL (lokacije / pokreti) | Aktivan, `workers/loc-sync-mssql` | Repo |
| Supabase → MSSQL (sve ostalo: kadrovska, plan montaže, plan proizvodnje) | Ne postoji u kodu | — |

Korisnikov cilj — **upis minimalnog seta polja iz Supabase nazad u MSSQL** — već je implementiran *za Lokacije modul* na način koji je arhitektonski najbliži „Option 4 / Service Broker-like" iz prompt-a (Outbox + idempotentni SP), s tim što umesto Service Broker-a koristi vlastiti queue u Postgres-u i Node worker.

---

## 1. Bridge topology

### 1.1 Outbound (Supabase → MSSQL): Lokacije

**Procesni model:** dugotrajan Node proces, polling petlja, batch po 10 redova, `FOR UPDATE SKIP LOCKED`.

| Stavka | Vrednost | Citat |
|---|---|---|
| Entry point | `workers/loc-sync-mssql/src/index.js` | `workers/loc-sync-mssql/src/index.js:25-75` (`main()` + `while(!shuttingDown)` petlja) |
| Polling interval | `POLL_INTERVAL_MS=5000` (default), idle `IDLE_INTERVAL_MS=15000` | `workers/loc-sync-mssql/src/config.js:55-61` + `.env.example:18-21` |
| Batch size | `BATCH_SIZE=10`, hard cap u SQL-u na 100 | `workers/loc-sync-mssql/src/config.js:57` + `sql/migrations/add_loc_step5_sync_rpcs.sql:29` (`GREATEST(1, LEAST(..., 100))`) |
| Claim mehanizam | RPC `loc_claim_sync_events(text, int)` — `FOR UPDATE SKIP LOCKED` u CTE-u | `sql/migrations/add_loc_step5_sync_rpcs.sql:35-55` |
| Direction | **Jedan smer:** Supabase → MSSQL | `workers/loc-sync-mssql/README.md:7-23` (ASCII dijagram) |
| Mode | Batch polling, **nije** streaming | `workers/loc-sync-mssql/src/index.js:46-70` (eksplicitan `while + sleep`) |
| Fizička lokacija pokretanja | **ASSUMPTION — needs verification** | `.env.example:6` ima `MSSQL_HOST=sql.servoteh.local` što sugeriše LAN, ali skripta nigde ne dokumentuje gde se host-uje (cron, systemd, container) — ne postoji `Dockerfile`, `docker-compose.yml`, `systemd.service` ni `wrangler.jsonc` za ovaj worker u repo-u (potvrđeno `Glob` pretragom) |
| Graceful shutdown | SIGTERM + SIGINT → `shuttingDown = true`, zatvara MSSQL pool | `workers/loc-sync-mssql/src/index.js:77-86` |

**Šta worker NE radi (eksplicitno verifikovano čitanjem koda):**

- Nema circuit breaker (nema brojača grešaka koji bi pauzirao petlju). Poll petlja samo loguje grešku i nastavlja: `workers/loc-sync-mssql/src/index.js:63-65`.
- Nema metric eksport (Prometheus, OTel). Sav „observability" je structured JSON na stdout/stderr: `workers/loc-sync-mssql/src/logger.js:6-22`.
- Nema kill switch flag (env var ili tabelarni red koji disable-uje obradu). Stop = SIGTERM celom procesu.
- Nema concurrency unutar batch-a — events se obrađuju **sekvencijalno** (komentar u kodu: očuvanje redosleda za istu stavku): `workers/loc-sync-mssql/src/processor.js:5-9`.

### 1.2 Outbound (Supabase → MSSQL): jednokratni backfill

| Stavka | Vrednost | Citat |
|---|---|---|
| Entry point | `workers/loc-sync-mssql/scripts/backfill-bigtehn-work-orders.js` | cela datoteka |
| Smer | **MSSQL → Supabase** (NE outbound) — čita `dbo.tRN`, upsertuje u `public.bigtehn_work_orders_cache` | `scripts/backfill-bigtehn-work-orders.js:1-9` (header) + `:182-188` (SELECT) + `:230-237` (upsert) |
| Frekvencija | Jednokratno, ručno, po potrebi | `README.md:99-119` (sekcija „Backfill"); nigde nije scheduled |
| Privilegije | Service role + `SELECT` na `dbo.tRN` (delegira se na `MSSQL_USER` iz iste env grupe) | `scripts/backfill-bigtehn-work-orders.js:201-208` |

### 1.3 Inbound (MSSQL → Supabase) — eksterni Bridge (van repo-a)

**Ovaj proces nije u repo-u.** Tragovi:

| Trag | Citat |
|---|---|
| Tabela `bridge_sync_log(id, sync_job, started_at, finished_at, status, rows_inserted, rows_updated, rows_deleted, error_message, duration_ms)` postoji u live bazi | `docs/SUPABASE_PUBLIC_SCHEMA.md:410-419` |
| Tabele `bigtehn_*_cache` (8+ tabela: `bigtehn_work_orders_cache`, `bigtehn_work_order_lines_cache`, `bigtehn_machines_cache`, `bigtehn_customers_cache`, `bigtehn_tech_routing_cache`, `bigtehn_items_cache`, `bigtehn_drawings_cache`, `bigtehn_worker_types_cache`) postoje u live bazi | `docs/SUPABASE_PUBLIC_SCHEMA.md:373-409` |
| **Ni jedna `CREATE TABLE bigtehn_*_cache` (osim `bigtehn_drawings_cache`) ne postoji u `sql/migrations/`** — verifikovano `Grep` pretragom | grep `CREATE TABLE.*bigtehn_` u `sql/` nalazi samo `bigtehn_drawings_cache` (`add_bigtehn_drawings.sql:21`) i `projekt_bigtehn_rn` (`add_sastanci_module.sql:30`); ostale `_cache` tabele **nisu pod migration kontrolom u ovom repo-u** |
| UI banner upozorava na zaostajanje cache-a po `bridge_sync_log.finished_at` (TTL: 6h za production_*, 36h za catalog_items, 7 dana za production_bigtehn_drawings) | `docs/Lokacije_modul.md:69` |
| Komentar u migraciji za bigtehn_drawings: „**Bridge** sinhronizuje iz Win foldera `C:\PDMExport\PDFImportovano` na BigBit virtualnom serveru" | `sql/migrations/add_bigtehn_drawings.sql:7-9` |

**Zaključak Phase A za inbound smer:** postoji eksterni servis (ASSUMPTION — needs verification: jedan ili više) koji:
- piše u `bridge_sync_log` (sync_job, status, broj redova),
- održava `bigtehn_*_cache` tabele (refresh patern verovatno truncate/upsert ili CDC — **needs verification**),
- održava `bigtehn_drawings_cache` + Storage bucket `bigtehn-drawings`,
- referenciše imena `production_work_orders`, `production_work_order_lines`, `production_tech_routing`, `production_bigtehn_drawings`, `catalog_items` u UI banner logici (`docs/Lokacije_modul.md:69`) — **ali se u repo-u sql-u ova imena ne nalaze**, što sugeriše da banner gleda `sync_job` ime u `bridge_sync_log`, ne stvarne tabele (needs verification).

---

## 2. Authentication & network path

### 2.1 Supabase autentikacija worker-a

| Stavka | Vrednost | Citat |
|---|---|---|
| Ključ | `SUPABASE_SERVICE_ROLE_KEY` (BYPASSRLS) | `workers/loc-sync-mssql/src/supabaseClient.js:14-18` |
| Klijent | `@supabase/supabase-js` v2, `persistSession: false`, `autoRefreshToken: false` | `workers/loc-sync-mssql/src/supabaseClient.js:15-18` |
| Custom header | `x-loc-sync-worker: 1` (za log filtering) | `workers/loc-sync-mssql/src/supabaseClient.js:17` |
| Šta zove | RPC `loc_claim_sync_events`, `loc_mark_sync_synced`, `loc_mark_sync_failed` | `workers/loc-sync-mssql/src/supabaseClient.js:25-54` |
| RPC permisije | `REVOKE FROM anon, authenticated; GRANT EXECUTE TO service_role` | `sql/migrations/add_loc_step5_sync_rpcs.sql:59-61, 88-90, 140-142` |
| Posledica za audit log | `audit_row_change()` snima `actor_email = NULL` jer service_role nema JWT | dokumentovano u `docs/SECURITY.md:204-206` (sekcija „Service-role atribucija") |

### 2.2 MSSQL autentikacija

| Stavka | Vrednost | Citat |
|---|---|---|
| Auth tip | SQL Authentication (user + password) | `workers/loc-sync-mssql/.env.example:7-9` |
| Default user | `loc_sync_worker` | `.env.example:8` |
| Preporučene privilegije po README-u | samo `EXECUTE` na `dbo.sp_ApplyLocationEvent` (least privilege) | `workers/loc-sync-mssql/README.md:54-55` |
| **Stvarne privilegije korisnika** | **ASSUMPTION — needs verification** (zavisi od MSSQL administratora; backfill skripta zahteva i `SELECT` na `dbo.tRN` što znači da isti user ima ili još jednu rolu ili je over-privileged) |
| Konekcija | `mssql` npm paket v11, ConnectionPool (max 5, min 0, idleTimeout 30s) | `workers/loc-sync-mssql/src/mssqlClient.js:19-28` + `src/config.js:49-53` |
| Driver | `tedious` (default ispod `mssql` paketa) | `workers/loc-sync-mssql/package.json:21` (`"mssql": "^11.0.1"` — `mssql` v11 koristi `tedious` JavaScript driver, ne ODBC) |
| TLS | `MSSQL_ENCRYPT=true`, `MSSQL_TRUST_SERVER_CERT=true` | `.env.example:11-12` + `src/config.js:46-48` |
| Server | `MSSQL_HOST=sql.servoteh.local` (default u .env.example), port 1433 | `.env.example:6-7` |
| **Kontekst iz prompt-a** (instance `MEGABAYT\SQLEXPRESS`) | **ASSUMPTION — needs verification** — `.env.example` ne dokumentuje named instance; ako je SQL Express sa named instance, `MSSQL_HOST=sql.servoteh.local` + `MSSQL_PORT=1433` neće raditi bez SQL Browser servisa ili eksplicitne port konfiguracije |

### 2.3 Network path

| Stavka | Vrednost |
|---|---|
| Worker → Supabase | HTTPS REST (PostgREST) preko `https://*.supabase.co` (javni internet, TLS) — **ASSUMPTION** za izlazak iz LAN-a; `SUPABASE_URL` u .env je placeholder `https://YOUR_PROJECT.supabase.co` |
| Worker → MSSQL | TCP 1433, TDS protokol, **ASSUMPTION**: isti LAN kao MSSQL (sugerisano `.local` sufiks-om) |
| Eksterni Bridge → Supabase | **needs verification** (van repo-a) |
| Port-forwarding / VPN / MikroTik NAT | **needs verification** — nije dokumentovano u repo-u |

---

## 3. Schema mapping (relevantno za pisanje)

### 3.1 Supabase strana: outbound queue (Lokacije)

**`public.loc_sync_outbound_events`** (full citat: `sql/migrations/add_loc_module.sql:142-160`):

| Kolona | Tip | Default | Indeks |
|---|---|---|---|
| `id` | UUID | (eksplicitno postavljen na `loc_location_movements.id`) | PK |
| `source_table` | TEXT NOT NULL | — | — |
| `source_record_id` | UUID NOT NULL | — | — |
| `target_procedure` | TEXT NOT NULL | `'dbo.sp_ApplyLocationEvent'` | — |
| `payload` | JSONB NOT NULL | — | — |
| `status` | `loc_sync_status_enum` NOT NULL | `'PENDING'` | partial idx: `(status, created_at) WHERE status IN ('PENDING','FAILED')` |
| `attempts` | SMALLINT NOT NULL | 0 | — |
| `last_error` | TEXT | NULL | — |
| `locked_by_worker` | TEXT | NULL | — |
| `locked_at` | TIMESTAMPTZ | NULL | — |
| `next_retry_at` | TIMESTAMPTZ | NULL | — |
| `created_at` | TIMESTAMPTZ NOT NULL | `now()` | — |
| `synced_at` | TIMESTAMPTZ | NULL | — |

**Trigger koji puni queue:** `loc_after_movement_insert()` (najnovija verzija u `sql/migrations/add_loc_v4_drawing_no.sql:89-206`) — pokreće se `AFTER INSERT ON public.loc_location_movements` i pravi jedan red u outbound queue za svaki movement.

**Payload (JSONB) format po v4:**

```json
{
  "event_uuid": "<uuid>",
  "item_ref_table": "<text>",
  "item_ref_id": "<text>",
  "order_no": "<text or empty>",
  "drawing_no": "<text or empty>",
  "from_location_code": "<text or null>",
  "to_location_code": "<text or null>",
  "movement_type": "TRANSFER|INITIAL_PLACEMENT|...",
  "quantity": "<numeric>",
  "moved_at": "<timestamptz iso>",
  "moved_by": "<uuid>",
  "note": "<text or null>"
}
```

(citat: `add_loc_v4_drawing_no.sql:180-202`)

### 3.2 MSSQL strana: očekivani entry point

| Stavka | Vrednost | Citat |
|---|---|---|
| Procedura | `dbo.sp_ApplyLocationEvent(@EventId UNIQUEIDENTIFIER, @Payload NVARCHAR(MAX))` | `workers/loc-sync-mssql/README.md:33-42` (skeleton) + `src/mssqlClient.js:5-12` (komentar) |
| Poziv iz worker-a | `req.execute('dbo.sp_ApplyLocationEvent')` sa `EventId: UniqueIdentifier`, `Payload: NVarChar(MAX)`, timeout 30s | `workers/loc-sync-mssql/src/mssqlClient.js:45-57` |
| **Stvarno telo procedure** | **NIJE U REPO-U** — README eksplicitno kaže „očekivani potpis"; implementacija je u MSSQL bazi van Git-a | `workers/loc-sync-mssql/README.md:31-44` |
| Idempotentnost | obavezna po `@EventId` (`README.md:71-72`) — ali to je *zahtev*, ne dokaz da SP zaista to radi |
| Komentar u kodu: „Ako potpis u vašem ERP-u razlikuje, prilagodite `src/mssqlClient.js`" | `workers/loc-sync-mssql/README.md:44` |

### 3.3 Inventory tabela na obe strane (relevantno za posao iz prompt-a)

**Supabase strana (verifikovano):**

| Tabela | PK | Triger(i) |
|---|---|---|
| `loc_locations` | UUID | `loc_locations_touch_updated`, `loc_locations_guard_and_path_trg` (BEFORE), `loc_locations_after_path_trg` (AFTER) — sve u `add_loc_module.sql:171-273` |
| `loc_location_movements` | UUID | `loc_mov_after_insert` (AFTER INSERT) → `loc_after_movement_insert()` — `add_loc_module.sql:331-334`, prepravljeno više puta (poslednji put `add_loc_v4_drawing_no.sql:89-206`) |
| `loc_item_placements` | UUID + UNIQUE `(item_ref_table, item_ref_id, order_no, location_id)` (v3) | `loc_placements_touch_updated` (BEFORE UPDATE) |
| `loc_sync_outbound_events` | UUID (poklapa se sa movement.id) | nema triggera |

**MSSQL strana — `dbo.tRN` (radni nalozi):** kolone se izvode iz `mapRowToCache()` u backfill skripti:

`scripts/backfill-bigtehn-work-orders.js:122-147` (lista kolona u SELECT-u):

```
IDRN, IDPredmet, BBIDKomitent, IdentBroj, Varijanta, BrojCrteza,
NazivDela, Materijal, DimenzijaMaterijala, JM, Komada,
TezinaNeobrDela, TezinaObrDela, StatusRN, Zakljucano, Revizija,
IDVrstaKvaliteta, IDStatusPrimopredaje, Napomena, RokIzrade,
DatumUnosa, DIVUnosaRN, DIVIspravkeRN, SifraRadnika
```

**MSSQL kolone — tipovi/kolacije:** `ASSUMPTION — needs verification`. Repo nema MSSQL `script.sql` (referenciran u `STRATEGIJA_ERP.md:435` i `notes.md`) commit-ovan. Tipove izvodimo posredno iz mapping logike:

| MSSQL kolona | Posredno utvrđen tip | Izvor |
|---|---|---|
| `IDRN`, `IDPredmet`, `BBIDKomitent`, `IDVrstaKvaliteta`, `SifraRadnika` | INT/BIGINT (Number cast) | mapper |
| `IdentBroj`, `BrojCrteza`, `NazivDela`, `Materijal`, `Revizija`, `Napomena`, `JM`, `DimenzijaMaterijala` | VARCHAR/NVARCHAR (String cast) | mapper |
| `Varijanta`, `Komada`, `IDStatusPrimopredaje` | INT (`Number.isFinite(Number(...)) ? Number : 0`) | mapper |
| `TezinaNeobrDela`, `TezinaObrDela` | FLOAT/DECIMAL (`Number(r.X)`) | mapper |
| `StatusRN`, `Zakljucano` | BIT (mapper koristi `boolOr(v, def)` koji prepoznaje `null`/`true`/`false`) | mapper komentar `add_loc_v4` `:84-86` |
| `RokIzrade`, `DatumUnosa`, `DIVUnosaRN`, `DIVIspravkeRN` | DATETIME / DATETIME2 (mapper konvertuje `Date → toISOString()`) | mapper :87-88 |

**Kolacija `dbo.tRN.*` (Cyrillic concern iz prompt-a §1.5):** nepoznata. Backfill skripta koristi `sql.NVarChar(50)` za bind `@Ident` (`scripts/backfill-bigtehn-work-orders.js:152, 177`), što znači da tedious driver šalje vrednost kao Unicode (`N'...'`). Ako su ciljne kolone `VARCHAR` sa Windows kolacijom (npr. `Cyrillic_General_CI_AS`), implicitna konverzija u MSSQL-u će raditi, ali sa risk-om: ako neka kolona ima `SQL_Latin1_General_CP1_CI_AS`, ćirilica se gubi (postaje `?`). **Needs verification** za svaku kolonu koja bi se pisala nazad.

### 3.4 Postoji li `rowversion` / `timestamp` na MSSQL strani?

**Needs verification.** Repo ne sadrži DDL `dbo.tRN`. Backfill SELECT u 24-koloni se ne oslanja na `rowversion`. Mapper računa `synced_at = new Date().toISOString()` na strani Supabase-a, NE iz `rowversion` MSSQL-a (`scripts/backfill-bigtehn-work-orders.js:116`).

### 3.5 Foreign keys koji „pokazuju IN" u target tabele

**Needs verification.** Bez DDL-a `dbo.tRN`, `dbo.tStavkeRN`, `dbo.tTehPostupak` ne mogu se utvrditi FK ka tim tabelama. `STRATEGIJA_ERP.md:218-225` (sekcija C, RADNI NALOZI) nabraja imena (`tRN`, `tStavkeRN`, `tRNKomponente`, `tSaglasanRN`, `tLansiranRN`, `tStavkeRNSlike`) ali ne i FK strukturu.

---

## 4. Data type crosswalk (za potencijalne write-back tačke)

Za svaku kolonu koju bi mogli pisati nazad u MSSQL, ovo je prvi sloj kros-mape. Mismatch flag-ovi su konzervativni (RED = sigurna gubitak/korumpiranje; YELLOW = pažnja).

| Supabase kolona | Pretp. MSSQL kolona | Tip mismatch? | Flag | Napomena |
|---|---|---|---|---|
| `loc_locations.location_code` (TEXT) | `dbo.??.LocationCode` (VARCHAR/NVARCHAR ?) | TEXT ↔ VARCHAR(?) | YELLOW | dužina ne ograničena na PG strani; v3/v4 ograničili `order_no`/`drawing_no` na 40 char; `location_code` nema CHECK na dužinu — može da padne MSSQL strana |
| `loc_location_movements.id` (UUID) | `@EventId UNIQUEIDENTIFIER` (`mssqlClient.js:48`) | UUID ↔ UNIQUEIDENTIFIER | **RED — endianness** | Postgres UUID je big-endian string; MSSQL UNIQUEIDENTIFIER je mixed-endian (prvi 3 segmenta little-endian). Worker pretpostavlja da `mssql` npm paket sa `sql.UniqueIdentifier` rešava — needs verification (potvrditi reverse round-trip: vrednost koju SP upiše kao `@EventId` čitati nazad u Supabase i porediti) |
| `loc_location_movements.moved_at` (TIMESTAMPTZ) | `dbo.??.MovedAt` (DATETIME ?) | TIMESTAMPTZ ↔ DATETIME (naive) | **RED — TZ drift** | Supabase je UTC. MSSQL `DATETIME` nema timezone. Trenutni payload prosleđuje ISO string sa Z. Procedura mora znati šta sa tim raditi (pretvoriti u Belgrade local? čuvati UTC?). DST transit pravi 2 sata greške 2× godišnje. needs verification kako SP to obrađuje |
| `loc_location_movements.quantity` (NUMERIC(12,3)) | `dbo.??.Komada` (INT?) ili `Quantity` (DECIMAL?) | NUMERIC(12,3) ↔ INT? | YELLOW | `bigtehn_work_orders_cache.komada` je INT (`SUPABASE_PUBLIC_SCHEMA.md:383`). Ako bi se pisalo nazad u INT kolonu, decimalni deo se gubi tihim okruglovanjem |
| `loc_location_movements.note` (TEXT, ćirilica) | `dbo.??.Note` (NVARCHAR?) | TEXT (UTF-8) ↔ NVARCHAR (UTF-16) | YELLOW | UTF-8 → UTF-16 konverzija je bezgubitkovna ako MSSQL kolona je `NVARCHAR`. Ako je `VARCHAR` sa kolacijom koja nema ćirilicu → `?????`. **Test sa: „Петровић", „Đorđe", „Čačak"** kako prompt traži |
| `loc_location_movements.movement_type` (enum) | `dbo.??.MovementType` (VARCHAR? ili FK ka tipu?) | ENUM ↔ ? | YELLOW | Worker šalje `.movement_type::text` u JSON-u (`add_loc_v4:195`). MSSQL strana mora znati 11 enum vrednosti (`docs/SUPABASE_PUBLIC_SCHEMA.md:35-48`). Ako se enum doda u Supabase a SP ne zna za njega → silent skip ili FK error |
| `loc_location_movements.moved_by` (UUID, `auth.users.id`) | `dbo.??.MovedBy` (?) | UUID Postgres → ? | **RED — atribucija** | Supabase `auth.users.id` je UUID generisan u Supabase Auth. MSSQL strana ne zna ko je taj korisnik (osim ako postoji explicit mapping tabela). Audit trail u ERP-u dobija `bridge_user` ili NULL — gubitak atribucije |

**Šire (za buduće write-back kolone — ovo je referentna lista iz prompt-a §3.4 mapirana na ovaj projekat):**

| Pretp. mismatch | Slučaj u ovom projektu |
|---|---|
| `DATETIME` vs `TIMESTAMPTZ` | Sve datumske kolone u Supabase su `TIMESTAMPTZ` (UTC); MSSQL strana je verovatno naive `DATETIME`/`DATETIME2` (needs verification). DST briga je realna |
| `DATETIME2` precision | Supabase mikrosekunde (6); MSSQL `DATETIME` ima 3.33ms preciznost, `DATETIME2(7)` 100ns. Needs verification koja se koristi |
| `VARCHAR` + Windows collation vs `text` UTF-8 | Vidi napomenu §3.3 — needs verification per kolona |
| `NVARCHAR` vs `text` | Ako je MSSQL strana NVARCHAR, sigurnije |
| `MONEY`/`SMALLMONEY` vs `numeric(19,4)` | Ne nalazim u trenutnom payload-u (Lokacije nemaju novac); biće relevantno ako se piše nazad cenovnik / payroll |
| `BIT` vs `boolean` | Pogledati `loc_locations.is_active` ako se ikada bude pisalo nazad — JSON `true/false` se mora mapirati u `BIT 0/1` u SP-u |
| `UNIQUEIDENTIFIER` vs `uuid` | Vidi RED gore — endianness needs verification |
| `DECIMAL(p,s)` | `loc_location_movements.quantity NUMERIC(12,3)` — needs verification koliki je MSSQL pandan |
| `VARBINARY(MAX)` vs `bytea` | Ne primenjuje se na Lokacije; binarno (PDF crteži) ide kroz Storage, ne kroz queue |

---

## 5. Existing writers on SQL side (target tables)

**Trenutno: nepoznato.** Repo ne sadrži MSSQL DDL/DML. Iz prompt-a (§1) i `STRATEGIJA_ERP.md:243-247` znamo:

- **Access front-end (BBDefUser, BBPravaPristupa, _RegAccess, _RegUsers, _Dnevnik)** — primarni writer u sve target tabele danas.
- **Vlasnik baze:** Negovan Vasić (`STRATEGIJA_ERP.md:28`).

**Za bilo koji write-back, ovo je kritičan blok:**

| Element | Status |
|---|---|
| Spisak SP-ja koje pišu u target tabele | needs verification (zahteva sa MSSQL strane: `SELECT object_name(parent_id) FROM sys.sql_modules WHERE definition LIKE '%TARGET_TABLE%'`) |
| Spisak triggera | needs verification (`SELECT * FROM sys.triggers WHERE parent_id = OBJECT_ID('dbo.TARGET_TABLE')`) |
| Access forme koje pišu | needs verification (zahteva inspekciju Access fronend-a) |
| Scheduled jobs | needs verification (`SELECT * FROM msdb.dbo.sysjobs`) |
| SSIS package-i | needs verification |

**Bezbedna pretpostavka:** dok se ovo ne mapira eksplicitno, *svaki* write u dotičnu tabelu može da naiđe na neočekivani trigger koji menja audit, replikuje, kaskadira ili throw-uje. Vidi `prompt §3 / Phase B / risk #2 (Trigger cascade)`.

---

## 6. Transactional semantics (trenutno)

### 6.1 Outbound (loc-sync-mssql)

| Property | Vrednost | Citat |
|---|---|---|
| Idempotentnost | Po dizajnu: SP `sp_ApplyLocationEvent` mora biti idempotentna po `@EventId` | `README.md:71-72` |
| `markSynced` se zove **posle** uspešnog SP poziva | da | `processor.js:32-39` |
| Race window | Postoji: ako worker padne *između* uspešnog SP-a i `markSynced`, event ide ponovo u FAILED → retry | `README.md:71-72` (potvrđeno) → SP će se pozvati DRUGI put → mora biti idempotentna |
| Conflict policy | **N/A** — nema `MERGE` ni `INSERT ... ON CONFLICT` na worker strani; sve se prepušta SP-u | `processor.js`, `mssqlClient.js` |
| Partial failure unutar batch-a | Svaki event ide nezavisno; greška na event N **ne** rolback-uje N-1; svaki gubi svoje `markFailed` | `processor.js:25-54` |
| Retry | Exponential backoff `2,4,8,16,32,64,128 min` (cap 360 min = 6h), 10 pokušaja → `DEAD_LETTER` | `add_loc_step5_sync_rpcs.sql:122-135` |
| Isolation level (worker → MSSQL) | Default (READ COMMITTED) — nije eksplicitno postavljen | `mssqlClient.js:45-57` (nema `SET TRANSACTION ISOLATION LEVEL`) |
| Transakcija oko SP poziva | Ne postoji `BEGIN TRAN` u worker-u; SP je sam za svoju transakciju | `mssqlClient.js:45-57` |
| `READ COMMITTED SNAPSHOT` na bazi | needs verification (treba upit `SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = 'ServoTehERP'`) |

### 6.2 Outbound queue (Postgres strana)

| Property | Vrednost | Citat |
|---|---|---|
| Insert u queue | Atomski u istoj transakciji sa `loc_location_movements` (jedinstven trigger) | `add_loc_v4_drawing_no.sql:89-206` |
| Claim | `UPDATE ... FOR UPDATE SKIP LOCKED` u CTE — atomski | `add_loc_step5_sync_rpcs.sql:35-55` |
| Concurrent workers | Bezbedno: SKIP LOCKED garantuje da dva worker-a ne uzmu isti red | dokumentovano u `README.md:67-68` |
| Mark synced | `UPDATE ... WHERE id = ? AND status = 'IN_PROGRESS'` — ako je status već promenjen, `RETURN false` ali ne baca grešku | `add_loc_step5_sync_rpcs.sql:67-86` |
| Pg_cron retencija | 03:15 UTC dnevno, briše SYNCED starije od 90 dana | `add_loc_step4_pgcron.sql:72-76` |

---

## 7. Observability

| Stavka | Vrednost | Citat |
|---|---|---|
| Worker log format | JSON na stdout/stderr (`error`/`warn` → stderr, ostalo → stdout) | `workers/loc-sync-mssql/src/logger.js:8-22` |
| Polja u log entry-ju | `ts, level, service, msg, ...extra` | `logger.js:11-17` |
| Log retention | **needs verification** — zavisi od host-a (ako se logovi ne hvataju u Loki/CloudWatch/Datadog, gube se po restartu) |
| Metrics | Nema (nema `/metrics` endpoint-a, nema OTel SDK-a u `package.json`) | `workers/loc-sync-mssql/package.json:19-23` |
| Health check | Nema endpoint-a; jedini „health signal" je da log-uje `batch processed` periodično | `workers/loc-sync-mssql/src/index.js:54-65` |
| Audit u Postgres-u | `loc_sync_outbound_events.attempts/last_error/locked_by_worker/locked_at/synced_at` čuvaju per-event audit | `add_loc_module.sql:142-156` |
| Admin UI za queue | Tab „Sync" u UI Lokacija (samo admin) — vidi poslednjih 100 redova queue-a | `docs/Lokacije_modul.md:36` |
| `bridge_sync_log` | Tabela postoji (vidi §1.3) ali je popunjava eksterni Bridge, ne ovaj worker | `docs/SUPABASE_PUBLIC_SCHEMA.md:410-419` |

---

## 8. Šta nije pokriveno (eksplicitno deklarisano kao otvoreno)

| Pitanje | Status |
|---|---|
| Stvarni potpis i telo `dbo.sp_ApplyLocationEvent` | needs verification (pročitati iz MSSQL-a: `sp_helptext 'dbo.sp_ApplyLocationEvent'`) |
| DDL `dbo.tRN` (kolacije, FK, triggeri, defaults) | needs verification |
| Lista MSSQL writers (SP, triggeri, Access forme, jobs, SSIS) za sve potencijalne target tabele | needs verification |
| Da li postoji `rowversion` ili neki druga concurrency token u target tabelama | needs verification |
| Stvarni MSSQL kolacioni standard (Serbian_Cyrillic_100_CI_AS? SQL_Latin1_General_CP1_CI_AS? per-column?) | needs verification |
| MSSQL edition (SQL Express ima ograničenja na Service Broker, CDC, replication) | prompt §1 kaže `SQLEXPRESS` — needs verification (`SELECT @@VERSION`); Express NEMA SQL Server Agent (osim u Express with Advanced Services), pa Service Broker baseline funkcioniše ali scheduling ograničen |
| Eksterni Bridge (vlasnik koda, smer, frekvencija, deduplikacija) | needs verification |
| Network putanja worker-a do Supabase i MSSQL-a (LAN, VPN, MikroTik NAT) | needs verification |
| Backup politika MSSQL-a, RPO/RTO | needs verification |
| Da li `MSSQL_USER=loc_sync_worker` ima ikakve druge privilegije osim `EXECUTE` | needs verification |
| Specifična polja koja korisnik **želi** da piše nazad iz Supabase u MSSQL (Phase A ne pretpostavlja) | needs verification |

---

## 9. Mapa fajlova (za buduće faze)

```
workers/loc-sync-mssql/
├─ README.md                                      # ASCII arhitektura, env, ops
├─ package.json                                   # mssql ^11, supabase-js ^2.45, dotenv
├─ .env.example                                   # SUPABASE_*, MSSQL_*, BATCH_SIZE, intervali
├─ src/
│   ├─ config.js                                  # env validacija (crash-early)
│   ├─ index.js                                   # main loop + signal handling
│   ├─ logger.js                                  # JSON stdout/stderr
│   ├─ supabaseClient.js                          # claimBatch / markSynced / markFailed RPC wrapper
│   ├─ mssqlClient.js                             # ConnectionPool + sp_ApplyLocationEvent execute
│   └─ processor.js                               # batch obrada, sequential per batch
├─ scripts/
│   └─ backfill-bigtehn-work-orders.js            # JEDNOKRATNI MSSQL→Supabase backfill (cache)
└─ test/
    └─ processor.test.js                          # node:test, 3 case-a (sve OK / SP throw / markFailed throw)

sql/migrations/
├─ add_loc_module.sql                             # 4 tabele, enumi, triggeri, RLS, RPC v1
├─ add_loc_module_step1_tables.sql                # bare tables (ako step1 fali)
├─ add_loc_step2_ci_unique.sql                    # case-insensitive unique na location_code
├─ add_loc_step3_cleanup.sql                      # purge SP, RPC v2 (preciznije greške)
├─ add_loc_step4_pgcron.sql                       # dnevni purge cron 03:15 UTC
├─ add_loc_step5_sync_rpcs.sql                    # claim / mark_synced / mark_failed RPC za worker
├─ add_loc_v2_quantity.sql                        # quantity dimenzija
├─ add_loc_v3_order_scope.sql                     # order_no dimenzija (poslovni nalog)
├─ add_loc_v4_drawing_no.sql                      # drawing_no dimenzija (poslednja verzija trigger-a)
├─ add_loc_menadzment_manage_locations.sql        # role 'menadzment' u edit grupi
├─ add_loc_report_by_locations_rpc.sql            # SECURITY INVOKER report RPC
├─ add_loc_report_v2_bigtehn_columns.sql          # join sa BigTehn cache-om
├─ add_loc_tps_for_predmet_rpc.sql                # listing TP-ova za predmet
├─ add_loc_tps_for_predmet_rpc_v2.sql             # v2
├─ add_loc_tps_for_predmet_rpc_v3.sql             # v3 (najnovija)
├─ add_bigtehn_drawings.sql                       # bigtehn_drawings_cache + Storage bucket bigtehn-drawings (eksterni Bridge target)
└─ add_v_production_operations.sql                # view koji DTO-uje cache + overlays za Plan Proizvodnje

docs/
├─ Lokacije_modul.md                              # Bridge banner pravila (TTL 6h/36h/7d)
├─ SECURITY.md                                    # service_role atribucija, audit log status
├─ STRATEGIJA_ERP.md                              # 12-mes roadmap, BigTehn migracija, eksterni bridge plan
├─ SUPABASE_PUBLIC_SCHEMA.md                      # flat dump 58 tabela, 12 view-ova, enum vrednosti
└─ bridge/01-current-state.md                     # OVAJ DOKUMENT
```

---

## 10. Šta NIJE pronađeno u repo-u (eksplicitno potvrđeno)

- Nema `script.sql` (BigTehn MSSQL DDL) — referenciran u `STRATEGIJA_ERP.md:435` i `notes.md`, ali nije commit-ovan u `c:/.../servoteh-plan-montaze`. Verifikovano `Glob` pretragom.
- Nema `sp_ApplyLocationEvent` definicije ni jednom u `sql/migrations/` ni u `sql/manual/`. Worker ga zove ali ga ne upravlja.
- Nema `pyodbc`, `pymssql`, `aioodbc`, FDW-a, Debezium-a, n8n-a, Airbyte-a, Airflow-a, SSIS-a, ni Linked Server-a — verifikovano `Grep` pretragom (samo `mssql` Node paket nalažen u `workers/loc-sync-mssql/`).
- Nema `Dockerfile`, `docker-compose.yml`, `systemd.service`, `wrangler.jsonc` ni `Procfile` za worker — verifikovano `Glob` pretragom; način pokretanja worker-a u produkciji **needs verification**.
- Nema `.github/workflows/` job-a koji deploy-uje ili testira worker — verifikovano (CI samo radi `schema-baseline`, `js-tests`, `sql-tests` po `docs/SECURITY.md:162`).
- Nema testova koji simuliraju end-to-end Supabase→MSSQL flow — postoje samo unit testovi za `processor.js` (3 slučaja) bez stvarne baze.
- Nema MSSQL strane testova (pgTAP postoji za Postgres po `docs/SECURITY.md:196`, ali ne za MSSQL SP).

---

*Kraj Phase A deliverable-a. Phase B (risk register za predloženi write-back) može da krene tek pošto korisnik:*
1. *potvrdi listu polja koja konkretno želi da piše nazad u MSSQL,*
2. *odgovori na ciljana pitanja iz pratećeg poruke (max 10).*

---

## 11. Postscript — verifikovano iz `script.sql` + odgovora korisnika (rev 2)

> Korisnik je 2026-04-23 priložio `c:\Users\nenad.jarakovic\Desktop\BigbitRaznoNenad\script.sql` (6 172 454 B, datiran 2026-04-10) i odgovorio na 10 ciljanih pitanja.
> Ova sekcija razrešava deo `ASSUMPTION — needs verification` markera iz sekcija 1–10. Citati se odnose na taj `script.sql` (lokalni put, **nije commit-ovan u repo**).

### 11.1 Verifikacije baze i topologije

| Pitanje (sekcija) | Status pre rev 2 | Status posle rev 2 | Izvor |
|---|---|---|---|
| Ime baze (sve sekcije pretpostavljale `ServoTehERP`) | pretpostavka iz `.env.example` | **`QBigTehn`** — verifikovano | `script.sql:1` (`USE [QBigTehn]`) |
| Postoji li `dbo.sp_ApplyLocationEvent` u BigTehn-u? (§3.2, §10) | needs verification | **NE postoji** u dump-u (Grep nad celim 6.17 MB fajlom: 0 hits za `sp_ApplyLocationEvent`). Postoji slična, ali Negovan-ova procedura `dbo.spIzvrsiPrenosIliCiscenjeDelaSaLokacije` koja radi inserte u `dbo.tLokacijeDelova`. | `script.sql:9799–9895` |
| Postoji li ikakav UUID/`UNIQUEIDENTIFIER` u BigTehn-u? (§4 RED endianness) | needs verification | **NE postoji** — Grep `\[uniqueidentifier\]` = 0 hits. Sve ID kolone su `int IDENTITY(1,1)`. | Grep count |
| Postoji li `rowversion`/`timestamp` kolona? (§3.4) | needs verification | **NE postoji** — Grep `rowversion` = 0 hits. | Grep count |
| Da li `script.sql` pominje „supabase", „bridge", „outbox", „loc_sync", „ServoTeh"? (§1.3, §10) | unknown | **0 hits** za sve od navedenih tokena. BigTehn baza nema ni jedan trag bridge-a u DDL-u. | Grep count |
| Worker host (§1.1, §2.3) | needs verification | **VM `192.168.64.24` (Win Server 2016)**, polling-u podlogi je „update na 15 min, za sada samo MSSQL→Supabase" (citira se eksterni Bridge, NE ovaj repo-ov worker). Konfirmacija korisnika: „na toj mašini fizički radi". | Korisnikovi odgovori #3, #4 |
| Telegram notifikacije (§7) | unknown | **Postoje** (korisnikova reč: „radili smo chatbota Telegram koji javlja ako nešto ne prolazi"). Mehanizam i koji procesi šalju → needs verification (van repo-a). | Korisnikov odgovor #5 |
| Trenutno aktivan write-back? (§0, §1.4) | naznačeno kao „Aktivan, repo" | **„Za sada ne pišemo nazad"** — korisnikova eksplicitna potvrda. To se slaže sa nalazom da SP `sp_ApplyLocationEvent` ne postoji u BigTehn-u → worker iz repo-a (`workers/loc-sync-mssql`) je **kod pripremljen za buduću upotrebu, ne aktivan u produkciji** (ili ako je pokrenut — sve eventi padaju na `FAILED`/`DEAD_LETTER`). Tabela §0 se na osnovu ovoga koriguje (vidi §11.7). | Korisnikov odgovor #6 |
| Atribucija (§4 RED MovedBy) | needs verification | **„Gazda zna odakle to dolazi" — ne treba mapping**. Zaključak: za buduće SP-ove dovoljno je hardkodirati `SifraRadnika = X` ili koristiti rezervisani ID-jevi za „Bridge user". | Korisnikov odgovor #8 |
| Latencija prag prihvatljiv? (§1.1) | needs verification | **15–30 sekundi je OK** — što znači da je `POLL_INTERVAL_MS=5000` previše agresivan, a `IDLE_INTERVAL_MS=15000` taman. Default-ovi mogu da ostanu, ali se može reduce-ovati polling pritisak. | Korisnikov odgovor #10 |
| Negovanove SP-ove tretirati u Phase B? | otvoreno pitanje | **Korisnik kaže: preskočiti Negovana u ovoj fazi**. To znači da pri write-back dizajnu ne smemo dirati postojeće Negovan-ove SP-ove (`dbo.spIzvrsiPrenosIliCiscenjeDelaSaLokacije`, `dbo.spKreirajRNZaNacrtPrimopredaje`, ...). Naš novi SP mora biti zaseban i **non-overlapping** sa njihovim pisačima. | Korisnikov odgovor #7 |

### 11.2 DDL koje znamo (verifikovano iz `script.sql`)

> Sve tabele su u istoj `[PRIMARY]` filegroup, **bez** explicit `COLLATE` klauzule po koloni. To znači da koriste **default kolaciju baze `QBigTehn`** (treba potvrditi: `SELECT collation_name FROM sys.databases WHERE name = N'QBigTehn'` — ne mogu utvrditi iz dump-a). Tipičan kandidat za stari BigBit/Access stack je `Cyrillic_General_CI_AS` ili `SQL_Cyrillic_General_CP1251_CI_AS`; **needs verification** ali većina kolona je već `nvarchar` (Unicode) pa kolacija utiče samo na sortiranje/poređenje, ne na čuvanje.

#### 11.2.1 `dbo.tLokacijeDelova` — append-only inventory ledger

```
[IDLokacije]        int IDENTITY(1,1)  PK CLUSTERED, NOT NULL
[IDRN]              int                NOT NULL                 -- nije FK!
[IDPredmet]         int                NOT NULL  FK→Predmeti
[IDVrstaKvaliteta]  int                NOT NULL                 -- nije FK!
[IDPozicija]        int                NOT NULL  FK→tPozicije   -- "polica/lokacija"
[SifraRadnika]      int                NOT NULL  FK→tRadnici    -- ko je uneo
[Datum]             datetime           NOT NULL  DEFAULT getdate()  -- date deo (CONVERT(date, GETDATE()) u SP-u)
[Kolicina]          int                NOT NULL  DEFAULT 0      -- + = postavljeno, - = uklonjeno
[DatumIVremeUnosa]  datetime           NULL      DEFAULT getdate()
```

Citat: `script.sql:5429–5448` (CREATE TABLE), `:7893–7907` (defaults), `:8233–8246` (FK).

**Posledice za pisanje nazad za Lokacije modul:**

- `IDLokacije` je SUR PK — Supabase mora čuvati round-trip mapping `loc_movement_id (UUID) → IDLokacije (int)` da ne bi pri retry-u dvostruko inserte (jer SP nema natural key da brani od duplikata).
- **`Kolicina` je `int`** (vidi §4 YELLOW). Supabase `loc_location_movements.quantity` je `NUMERIC(12,3)`. Bilo kakva decimalna količina → **silent rounding ili reject u SP-u**. Mora se odlučiti politika (zaokruživanje, raise error).
- **Nema FK ka `tRN`** iako `IDRN NOT NULL`. Aplikativni layer to brani. Naš SP mora ručno verifikovati da `IDRN` postoji (ili dozvoliti orphan, kao Negovanovi SP-ovi).
- **Nema FK ka `tVrsteKvalitetaDelova`** iako `IDVrstaKvaliteta NOT NULL`. Isto — ručna provera.
- **Datum/DatumIVremeUnosa su `datetime` (3.33ms preciznost), bez TZ.** Naš SP mora primiti TIMESTAMPTZ iz Supabase i konvertovati u Belgrade local (jer SP `dbo.spIzvrsiPrenosIliCiscenjeDelaSaLokacije:9839` koristi `GETDATE()` bez TZ → BigBit baza je „naive Belgrade local").

#### 11.2.2 `dbo.tRN` (radni nalozi) — kandidat za status write-back

```
[IDRN]                       int IDENTITY(1,1) PK NONCLUSTERED  -- aaaaatRN_PK
[IDPredmet]                  int            NOT NULL
[IdentBroj]                  nvarchar(50)   NOT NULL
[Varijanta]                  int            NOT NULL
[BBIDKomitent]               int            NOT NULL
[BBNazivPredmeta]            nvarchar(250)  NULL
[BBDatumOtvaranja]           datetime       NOT NULL
[DatumUnosa]                 datetime       NOT NULL
[Komada]                     int            NOT NULL
[BrojCrteza]                 nvarchar(100)  NOT NULL
[Proizvod]                   nvarchar(150)  NULL
[TezinaNeobrDela]            float          NULL
[NazivDela]                  nvarchar(250)  NOT NULL
[IdentMaterijala]            int            NULL
[Materijal]                  nvarchar(250)  NOT NULL
[DimenzijaMaterijala]        nvarchar(150)  NOT NULL
[JM]                         nvarchar(50)   NOT NULL
[TezinaObrDela]              float          NULL
[Napomena]                   nvarchar(max)  NULL
[StatusRN]                   bit            NULL
[RokIzrade]                  datetime       NULL
[DIVUnosaRN]                 datetime       NOT NULL
[DIVIspravkeRN]              datetime       NOT NULL
[SifraRadnika]               int            NOT NULL  FK→tRadnici
[Zakljucano]                 bit            NULL
[Potpis]                     nvarchar(50)   NULL
[PrnTimer]                   int            NULL
[VezaSaBrojemCrteza]         nvarchar(100)  NULL
[IDVrstaKvaliteta]           int            NOT NULL
[Revizija]                   nvarchar(3)    NOT NULL
[IDPrimopredaje]             int            NOT NULL
[IDCrtez]                    int            NOT NULL
[IDStatusPrimopredaje]       int            NOT NULL
[SifraRadnikaPrimopredaje]   int            NOT NULL  FK→tRadnici (FK_tRN_SifraRadnikaPrimopredaje_tRadnici)
```

Citat: `script.sql:1660–1700` (CREATE TABLE), `:8310–8323` (FK).

**Posledice:**

- **Concurrency token = `DIVIspravkeRN datetime NOT NULL`.** To je „last modified" stamp. Pošto nema `rowversion`, jedini siguran način optimistic update je `WHERE IDRN = ? AND DIVIspravkeRN = ?` — ali samo ako se Supabase može osloniti na to da nijedan drugi pisač **NE** menja taj stamp van naše kontrole. Korisnik nije potvrdio da li Negovan-ove SP-ove ažuriraju `DIVIspravkeRN` (verovatno DA — to je BigBit konvencija). **Risk: TOCTOU.**
- **`StatusRN bit NULL`** i **`IDStatusPrimopredaje int NOT NULL`** — dve različite "status" kolone. `view [dbo].[viewAktivniRNPreLansiranja]` (`script.sql:1717–1725`) gleda **`IDStatusPrimopredaje IN (0,1,3)`**, ne `StatusRN`. To znači:
  - 0 = U obradi
  - 1 = Saglasan
  - 2 = Odbijeno (svesno ignorisano)
  - 3 = Lansiran
- Dakle za bilo kakav „write-back statusa RN-a" iz Supabase, ciljna kolona je **`IDStatusPrimopredaje`** (ne `StatusRN`). `StatusRN bit` je legacy ili sekundarni flag.
- **Cyrillic concern (§3.3 RED):** sve text kolone su `nvarchar` → Unicode → bezbedno za ćirilicu ako tedious driver šalje N-string (što već radi). Validacija sa „Петровић", „Đorđe", „Čačak" treba potvrditi na live bazi, ali risk je nizak.

#### 11.2.3 `dbo.tStavkeRN`, `dbo.tTehPostupak`, `dbo.tRadnici`, `dbo.Predmeti`, `dbo.Komitenti`

Sve verifikovano (citat lokacije u `script.sql`):

| Tabela | Linija | PK | Concurrency token | Notabilni FK | Notabilni tipovi za write-back |
|---|---|---|---|---|---|
| `dbo.tStavkeRN` | 1922 | `IDStavkeRN int IDENTITY` | `DIVIspravke datetime NOT NULL` | (nije citirana FK lista direktno; presumptivno FK→tRN) | `OpisRada nvarchar(max)`, `Tpz/Tk float`, `TezinaTO float` |
| `dbo.tTehPostupak` | 1849 | `IDPostupka int IDENTITY` (NONCLUSTERED) | `DatumIVremeUnosa datetime NOT NULL` | **samo FK→tRadnici (NEMA FK→tRN ni FK→Predmeti iako su NOT NULL)** | `ZavrsenPostupak bit NULL`, `DatumIVremeZavrsetka datetime NULL`, `Napomena ntext` (legacy) |
| `dbo.tRadnici` | 2617 | `SifraRadnika int IDENTITY` | nema | (FK target) | `Aktivan bit NULL` |
| `dbo.Predmeti` | 1731 | `IDPredmet int IDENTITY` | `DatumIVreme datetime NULL` (ne NOT NULL — manje pouzdan) | (FK target) | `Memo ntext NULL`, `NabavnaVrednost money NULL`, `RokZavrsetka datetime NULL` |
| `dbo.Komitenti` | 1781 | `Sifra int IDENTITY` | `PoslednjaIzmena datetime NULL` (+ `PoslednjaIzmenaUser nvarchar(20)`) | (FK target) | `Naziv nvarchar(50)` (kratak!), `Email nvarchar(50)`, `Mobilni nvarchar(20)` |
| `dbo.tPozicije` | 5419 | `IDPozicije int` (manuelno!) | nema | (FK target) | `Pozicija nvarchar(20)` (vrlo kratak za Supabase `location_code text`) |
| `dbo.tVrsteKvalitetaDelova` | 5405 | `IDVrstaKvaliteta int` (manuelno!) | nema | (FK target) | `VrstaKvaliteta nvarchar(50)` |
| `dbo.tRNKomponente` | 2663 | `IDKomponente int IDENTITY` | nema | (UNIQUE `(IDRN, IDRNPodkomponenta)`) | `BrojKomada int`, `Napomena nvarchar(255)` |
| `dbo.BBDefUser` | 6116 | `UserName nvarchar(20)` | nema | — | `DefaultGodina/DefaultOJ/DefaultOD int`, `Level smallint` (autorizaciona tabela) |

**Citat za FK listu (potpuna, deo):** `script.sql:8143–8385` (svi `ALTER TABLE ... ADD CONSTRAINT FK_*`). Ukupno 60 hits za FK pretragu (head limit), ne sumnja se da je još.

### 11.3 Postojeći writers u BigTehn-u (verifikovano)

> Ovo zamenjuje §5 „Existing writers on SQL side" — sada imamo eksplicitne SP-ove pisače.

| SP | Linija | Cilj | Pisac u koje tabele | Vlasnik |
|---|---|---|---|---|
| `dbo.spIzvrsiPrenosIliCiscenjeDelaSaLokacije` | 9799 | Prenos/trebovanje delova između polica | INSERT ×2 u `tLokacijeDelova` (par +/− za prenos; jedan − za trebovanje) | Negovan (po stilu, autor neeksplicitan u ovom SP-u) |
| `dbo.spKreirajRNZaNacrtPrimopredaje` | 9897 | Kreira RN-ove iz Nacrta primopredaje (sa BEGIN TRY/TRAN/XACT_ABORT) | INSERT/UPDATE u `tRN`, `tRNKomponente`, `NacrtPrimopredajeStavke`, koristi `THROW 51021` za biz-rule violations | Negovan (`Author: Negovan Vasic`, `Create date: 15-08-2025`) |

**0 triggera** na bilo kojoj relevantnoj tabeli (`tRN`, `tStavkeRN`, `tTehPostupak`, `tLokacijeDelova`, `Predmeti`, `Komitenti`, `tRadnici`, `tPozicije`, `tVrsteKvalitetaDelova`) — Grep `CREATE TRIGGER ... ON [dbo].[X]` daje 0 matchova. To znači:

- **Risk #2 iz prompt-a (Trigger cascade) je MITIGIRAN za ove tabele** — ne postoji nijedan postojeći trigger koji bi se uplitao u naš write-back.
- Ako u budućnosti dodajemo trigger sa Supabase strane na `bigtehn_*_cache` (npr. da ulazne promene cache-a triggeruju outbound u MSSQL), kreće se „greenfield" — bez naslednih trigger lanaca u BigBit-u.

**Access front-end** ostaje nepoznat (van dump-a). Risk-test: pri PoC-u, paralelno otvoriti BigBit Access klijent i izmeniti isti red kroz njega + naš novi SP, posmatrati da li dolazi do `DIVIspravkeRN` race-a.

### 11.4 Kolacija, izolacija, MSSQL setup (delimično)

| Stavka | Status | Izvor |
|---|---|---|
| `SET ANSI_NULLS ON` + `SET QUOTED_IDENTIFIER ON` | Postavljeno za **svaki** CREATE TABLE/PROCEDURE/FUNCTION | `script.sql` (stotine `SET ANSI_NULLS ON` direktiva pre svakog objekta) |
| Default kolacija baze `QBigTehn` | **Nije u dump-u** (SSMS „Script Database as CREATE" nije bio uključen) | needs verification preko `SELECT collation_name FROM sys.databases WHERE name = N'QBigTehn'` na live bazi |
| `READ_COMMITTED_SNAPSHOT` (RCS) | **Nije u dump-u** (database scoped option nije scriptovan) | needs verification preko `SELECT is_read_committed_snapshot_on FROM sys.databases WHERE name = N'QBigTehn'` |
| `ALLOW_SNAPSHOT_ISOLATION` | needs verification | isto |
| Edition (Express?) | needs verification — prompt je rekao `MEGABAYT\SQLEXPRESS`, ali Negovanovi SP-ovi koriste `THROW`, `BEGIN TRY/CATCH`, `XACT_ABORT` što radi i na Express | `script.sql:9917–9920` |

### 11.5 Šta je NOVO razrešeno iz `needs verification` liste (sekcija 8)

| Originalno otvoreno pitanje | Novo stanje |
|---|---|
| Stvarni potpis i telo `dbo.sp_ApplyLocationEvent` | **Ne postoji** u BigTehn-u. Ako je negde drugde — npr. dev/staging — needs verification, ali u produkciji koju korisnik koristi: **nema ga**. |
| DDL `dbo.tRN` (kolacije, FK, triggeri, defaults) | **Verifikovano** (vidi §11.2.2). Triggera nema. Kolacija default baze (needs verification samo za default kolaciju baze). |
| Lista MSSQL writers (SP, triggeri, Access forme, jobs, SSIS) | Delimično: 2 ključna SP-a verifikovana (§11.3); 0 triggera verifikovano. Access forme i jobs/SSIS i dalje needs verification (van dump-a). |
| Da li postoji `rowversion` ili neki druga concurrency token? | **`rowversion` = 0 hits.** Postoji **`DIVIspravkeRN datetime NOT NULL`** kao surrogate concurrency token — ali samo za `tRN`/`tStavkeRN`. Ostale tabele (`Predmeti`, `Komitenti`) imaju nullable `DatumIVreme*` kolone — manje pouzdan. **Tabela `tLokacijeDelova` je append-only ledger** — nema potrebu za concurrency tokenom. |
| Stvarni MSSQL kolacioni standard | needs verification (vidi §11.4); ali sve relevantne tekst kolone su `nvarchar`, što minimizuje rizik za UTF→ANSI gubitke. |
| MSSQL edition (SQL Express ima ograničenja) | needs verification (`SELECT @@VERSION`); SP-ovi rade `THROW`/`BEGIN TRY` što SQL Express 2017 podržava. |
| Eksterni Bridge (vlasnik koda, smer, frekvencija, deduplikacija) | **Frekvencija 15 minuta**, smer **MSSQL→Supabase**, hostuje se na **VM 192.168.64.24 (Win Srv 2016)**. Vlasnik koda i deduplikacija logika i dalje needs verification. |
| Network putanja worker-a do Supabase i MSSQL-a (LAN, VPN) | Worker bi trebalo da radi sa iste VM (`192.168.64.24`). LAN do MSSQL-a, javni HTTPS do Supabase. |
| Backup politika MSSQL-a, RPO/RTO | needs verification |
| Da li `MSSQL_USER=loc_sync_worker` ima ikakve druge privilegije osim `EXECUTE` | needs verification (još uvek); ali pošto SP `sp_ApplyLocationEvent` ne postoji, taj user verovatno **trenutno nema EXECUTE permisiju** ni na šta. |
| Specifična polja za write-back | **Korisnik treba eksplicitno da odgovori** (Question #1 iz mojeg prethodnog seta). |

### 11.6 Telegram notifikacioni kanal

Korisnik je rekao: „pa valjda postoji jer smo radili i chatbota Telegram koji javlja ako nešto ne prolazi". To je **eksterni notifier** koji NE pripada ovom repo-u (nema `bot_token`, `TELEGRAM_*` env varijabli, niti `node-telegram-bot-api` paketa u `package.json` repo-a — verifikovano `Grep` pretragom). Smatramo ga **out-of-band alerting** kanalom koji ćemo u Phase E (PoC) integrisati ako bude potrebno.

### 11.7 Korigovana TL;DR tabela (zamena za §0)

| Smer | Status (rev 2) | Vlasnik | Frekvencija |
|---|---|---|---|
| MSSQL → Supabase (RN, kupci, mašine, items, ...) | **Aktivan**, eksterni Bridge na VM 192.168.64.24 | Van repo-a | 15 min |
| MSSQL → Supabase (PDF crteži) | **Aktivan**, eksterni Bridge na istoj VM | Van repo-a | needs verification |
| Supabase → MSSQL (Lokacije / pokreti) | **Kod je u repo-u, ALI trenutno nije aktivan** (potvrda korisnika: „za sada ne pišemo nazad"; potvrda iz dump-a: SP `sp_ApplyLocationEvent` ne postoji u BigTehn-u) | Repo `workers/loc-sync-mssql` — **dormant** | — |
| Supabase → MSSQL (sve ostalo) | **Ne postoji** u kodu | — | — |

### 11.8 Šta ovo menja za Phase B/C/D

Najveće tri promene u odnosu na originalnu Phase A pretpostavku:

1. **Nemamo postojeći SP `sp_ApplyLocationEvent` na koji se možemo osloniti.** Bilo koji write-back projekat **mora** uključiti dizajn i dostavu T-SQL SP-a u BigBit bazu — to je sada explicit deliverable, ne „assumption".
2. **`tLokacijeDelova` koristi `int` kolone i `int Kolicina`** — ne može direktno primiti Supabase `numeric(12,3)` quantity. Mora se rešiti politika (zaokruženje, zabrana decimalnih).
3. **0 triggera na ciljnim tabelama** = **niži rizik** od cascade efekata; ali Negovan-ovi SP-ovi se izvršavaju paralelno (Access front-end), pa **race condition na `DIVIspravkeRN`** je realan i jedini pravi rizik za concurrency u `tRN`/`tStavkeRN` write-back-u.

Sve ostalo iz §1–§10 ostaje na snazi. Phase B se može sada raditi kao **generic risk register sa konkretnim BigTehn kontekstom** (vidi `02-pre-writeback-prep.md`).
