# Uputstvo za Claude Projekat → instrukcije za Cursor (implementacioni agent)

**Repo:** `servoteh-plan-montaze`  
**Cilj:** Kada korisnik radi sa tobom (Claude) u projektnom chatu, ti generišeš **zadatak** koji se zatim daje **Cursor agentu** (npr. Composer) da implementira. Ovo uputstvo definiše *kako* da pišeš te zadatke da budu precizni, u skladu sa arhitekturom, i da izbegnu tipične greške.

---

## 1. Podela uloga

| Ko | Uloga |
|----|--------|
| **Korisnik + Claude (ti)** | Razbijanje zahteva, odluke (npr. RLS model), acceptance criteria, redosled, šta ne dirati. |
| **Cursor agent** | Čitanje stvarnog koda, implementacija, migracije, testovi, pokretanje `npm test` / CI provera, minimalan diff. |

**Pravilo:** Ne traži od agenta “pogodi kako” — daj *eksplicitan* očekivani rezultat i ograničenja (fajlovi, tabele, ponašanje).

---

## 2. Kako formulisati zadatak za Cursor agenta (šablon)

Koristi ovu strukturu (kopiraj u novi chat / issue):

1. **Kontekst (1–3 rečenice):** modul, korisnički scenario, zašto.
2. **Izvor istine:** koji fajl(evi) / migracije su relevantni (pogledaj sekciju “Dokumenti i fajlovi” ispod).
3. **Obim:** šta *ulazi* u zadatak, šta je **van obima** (eksplicitno).
4. **Ponašanje / acceptance criteria:** bullet lista, proverljivo (npr. “neautentifikovan ne vidi X”, “RLS baca 42501 na INSERT u Y”).
5. **Bezbednost:** RLS, servisna uloga, audit — vidi sekciju 4.
6. **Testovi:** koji tip testa (Vitest, pgTAP) i koji fajl dodati/izmeniti.
7. **Nakon implementacije:** agent treba da pokrene `npm test`, `npm run check:schema-baseline`, `npm run check:rbac-matrix` (ako se diraju `sql/migrations/`), i ako treba `npm run gen:rbac-matrix` nakon promena politika.
8. **Commit poruka / PR** (opciono): jedna rečenica šta se menja i zašto.

**Dobar primer (kratko):**  
*“Dodaj SELECT politiku na `public.foo` da samo učesnik vidi red; ne menjaj `bigtehn_*`. Dodaj pgTAP u `sql/tests/...` koji proverava da user A ne vidi user B. Posle: `gen:rbac-matrix` + `check:rbac-matrix`.”*

**Loš primer:**  
*“Poboljšaj security za sastanke.”* (nedefinisano, agent će nagađati.)

---

## 3. Tehnički stek (kratko)

- **Front:** Vite, **vanilla JS** (nije React u core delu), UI pod `src/ui/`, servisi `src/services/`, state `src/state/`.
- **Auth u browseru:** JWT kroz Supabase klijent; **UI helperi** (`src/state/auth.js` — `canEdit`, `isAdmin`, …) su **samo za prikaz**; *prava se ne smeju poveriti samo UI-u.*
- **Backend:** Supabase = Postgres + PostgREST + RLS + Edge Functions.
- **Autoritativna kontrola pristupa:** **Postgres RLS** + retko **SECURITY DEFINER** funkcije (`has_edit_role`, `current_user_is_admin`, `current_user_is_management`, itd.). Agent treba uvek proveriti postojeći obrazac u migracijama, ne izmišljati `RETURN true` u produkciji.
- **Pozadinski procesi:** `workers/` (npr. Node), Edge funkcije u `supabase/functions/`. Oni često koriste **service role**; audit atribucija: header **`X-Audit-Actor`** (poverljivo samo u kontekstu service role) — vidi `docs/SECURITY.md`.

---

## 4. Bezbednost — šta uvek pomenuti u zadatku

1. **RLS prvo:** Ako se menja pristup podacima, promena ide u **SQL migraciju** pod `sql/migrations/`, ne samo u JS.
2. **Ne oslanjati se na front:** Rute u `src/ui/router.js` mogu ograničiti ulaz u modul, ali **ne** zamenjuju RLS.
3. **Migracije vs. baseline:** Aplikacioni `sql/schema.sql` i CI mogu imati odvojene tokove; jasno reci da li zadatak obuhvata ažuriranje `sql/schema.sql` (ako se baseline menja) ili **samo** novu migraciju — u ovom repou često: **migracija je izvor istine za produ**, baseline se ažurira usklađeno sa projektnom praksom.
4. **Service role:** Sve sa service ključem **bypass-uje RLS**; zato su važni audit zapisi i ograničen pristup ključu. Ako se dodaje novi worker/edge writer, uputi agenta da doda smislen **`X-Audit-Actor`** (kao postojeći obrasci).
5. **REGRESIJE:**  
   - `scripts/check-schema-security-baseline.cjs` — npr. zabranjeni “pilot” obrasci u `sql/schema.sql`.  
   - `scripts/generate-rbac-matrix.cjs` — nakon `CREATE POLICY` / `GRANT` u migracijama, regenerisati `docs/RBAC_MATRIX.md` i proveriti sync (`--check` u CI).
6. **pgTAP:** Za RLS i funkcije, preferiraj testove u `sql/tests/*.sql` (pogledaj postojeće `security_*.sql` za obrasce: seed, JWT simulacija, `row_security` gde treba).

---

## 5. Struktura repoa (gde agent traži stvari)

| Putanja | Svrha |
|--------|--------|
| `sql/migrations/*.sql` | Evolucija šeme; **ovde idu nove RLS/politike/ funkcije**. |
| `sql/schema.sql` | Baseline; mora proći `check:schema-baseline` gde je primenjivo. |
| `sql/ci/00_bootstrap.sql`, `sql/ci/migrations.txt` | CI baza i redosled migracija za testove. |
| `sql/tests/*.sql` | pgTAP testovi; security: `security_has_edit_role.sql`, `security_user_roles_rls.sql`, `security_audit_log.sql`, plus modulski (`loc_*.sql`). |
| `src/state/auth.js` | Helperi pristupa (UI + eventualni guard-i). |
| `src/ui/router.js` | Rute, `assertModuleAllowed`, itd. |
| `src/services/*.js` | API pozivi ka Supabase. |
| `supabase/functions/*/index.ts` | Edge funkcije. |
| `workers/**` | Node workeri (npr. sync). |
| `scripts/*.cjs` | Alati (schema baseline, RBAC matrica). |
| `docs/SECURITY.md` | Živi opis posture-a i faza. |
| `docs/RBAC_MATRIX.md` | **Generisano** — ne ručno održavati duži tekst; koristiti `npm run gen:rbac-matrix`. |
| `docs/STRATEGIJA_ERP.md` | Strategija; multi-tenant nije trenutni fokus. |
| `docs/*_modul.md` | Modulska dokumentacija. |
| `docs/SUPABASE_PUBLIC_SCHEMA.md` | Pregled šeme (kada postoji; može zastareti u odnosu na migracije). |

---

## 6. Skripte koje agent treba da zna (iz `package.json`)

- `npm test` — Vitest (JS + testovi skripti).
- `npm run check:schema-baseline` — provera `sql/schema.sql`.
- `npm run gen:rbac-matrix` — generiše `docs/RBAC_MATRIX.md`.
- `npm run check:rbac-matrix` — **mora** proći ako su menjane politike / grantovi u migracijama bez regeneracije.

CI na `main` / PR: uključuje schema baseline, RBAC matrix check, Vitest, SQL bootstrap + pgTAP (vidi `.github/workflows/ci.yml`).

---

## 7. Kako ti (Claude) smanjuješ greške u uputstvima

- Uvek navedi **imena tabela** i **kolone** u SQL delu, ako su poznate (ili reci: “pogledaj migraciju X”).
- Razlikuj **read** vs **write** politike; za INSERT ponekad važi `WITH CHECK` posebno od `USING`.
- Ako zadatak dira učesništvo / email polja, navedi da se **email normalizuje** kako u postojećem kodu (`LOWER`, itd.) — uskladi se sa `auth.jwt() ->> 'email'`.
- Za rekurziju RLS (npr. tabela učesnika), navedi da se koriste **postojeći SECURITY DEFINER** helperi ili da se doda novi po istom obrascu kao u `harden_sastanci_rls_phase2.sql`.
- Zatraži **minimalan diff** i “ne refaktorisi nepovezane fajlove” (usklađeno sa očekivanjima u ovom repou).

---

## 8. Dokumenti koje uvek drži u Claude Projektu (kao priloge / znanje)

**Obavezno (jezgra):**

1. `docs/SECURITY.md` — trenutna posture, faze, RLS, service role, `X-Audit-Actor`, šta je namerno van obima (npr. multi-tenant).  
2. `docs/STRATEGIJA_ERP.md` — poslovni kontekst i granice.  
3. `docs/RBAC_MATRIX.md` — trenutni pregled politika (generisan; korisno za “ko šta sme” na nivou SQL).  
4. `.github/workflows/ci.yml` — šta tačno CI puća.  

**Preporučeno po modulu nad kojim korisnik radi:**

5. `docs/Plan_montaze_modul.md` / `docs/Kadrovska_modul.md` / `docs/Lokacije_modul.md` / itd.  
6. `docs/bridge/01-current-state.md` (ako se radi most / migracija).  

**Kada je relevantno za šemu / SQL:**

7. `docs/SUPABASE_PUBLIC_SCHEMA.md` — samo uz napomenu da migracije mogu biti novije.  
8. Relevantne **konkretne** migracije iz `sql/migrations/` (npr. poslednja `harden_sastanci_rls_*.sql`, `add_audit_*.sql`).

**Opciono:**

- `AGENTS.md` ili `README` iz root-a ako postoje (projekat-level pravila).  
- Kratak isečak iz `package.json` (scripts) — ili samo ova lista iz sekcije 6.

---

## 9. Jedna rečenica za kraj

Kad pišeš zadatak za Cursor agenta, ponašaj se kao **product + tech lead** koji daje **scope, acceptance tests i bezbednosne neizbežne tačke**; agent je **implementer** koji mora imati jasne puteve do fajlova i provera, ne nagađanje.

---

## 10. Gotovi primeri zadataka (copy-paste u Cursor)

### 10.1 Nova RLS politika + migracija + pgTAP + matrica

```text
Kontekst: Tabela public.X mora ograničiti SELECT tako da korisnik vidi samo redove
gde je kolona owner_email = jwt email (ili učesnik u pomoćnoj tabeli Y — navedi tačno).

Obim: Nova migracija sql/migrations/<opisno_ime>.sql. Ne menjaj druge module osim
ako su direktno vezani. Ažuriraj sql/ci/migrations.txt + sql/ci/00_bootstrap.sql
ako CI mora imati tabelu/polja za test.

Acceptance:
- RLS uključen na public.X ako već nije; politika za authenticated.
- Nema širokog USING (true) na ovoj tabeli posle ove promene.
- sql/tests/security_X_rls.sql (ili proširi postojeći) sa pgTAP: user A ne vidi red user B;
  admin/menadzment ponašanje — definisati po uzoru na docs/SECURITY.md.

Posle: npm run gen:rbac-matrix && npm run check:rbac-matrix, npm run check:schema-baseline
(samo ako je diran sql/schema.sql), npm test.
```

### 10.2 Samo frontend guard (ruta / modul)

```text
Kontekst: Modul Z treba da bude nedostupan bez prijave, kao ostali guard-ovani moduli.

Obim: src/state/auth.js (helper canAccessZ), src/ui/router.js (assertModuleAllowed,
restoreOrShowHub). Ne menjati RLS u ovom zadatku — samo UI ulaz.

Acceptance: Neautentifikovan korisnik ne može da ostane na ruti modula Z; toast/redirect
konzistentan sa postojećim modulima. npm test ne sme regresovati.
```

### 10.3 Novi worker / Edge Function koji piše u DB (service role)

```text
Kontekst: Novi job u workers/foo ili supabase/functions/foo koji koristi
SUPABASE_SERVICE_ROLE_KEY / service client.

Obim: Implementacija + svi globalni headeri: dodati X-Audit-Actor sa stabilnim identitetom
npr. foo@worker.servoteh ili foo@edge.servoteh, kao u postojećim fajlovima
(hr-notify-dispatch, maint-notify-dispatch, loc-sync-mssql).

Acceptance: Svaki mutirajući RPC ka DB nosi audit atribuciju; docs/SECURITY.md se ne mora
menjati osim ako menjaš security model, ali migracija add_audit* mora ostati dosledna
current_user_email() ponašanju. Po potrebi pgTAP u security_audit_log.sql.
```

### 10.4 Ispravka regresije u CI (pgTAP puca)

```text
Kontekst: CI job sql-tests puca na fajlu sql/tests/....sql nakon moje grane.

Obim: Pronađi root cause (bootstrap vs migracija vs redosled). Minimalan fix:
sql/ci/migrations.txt, 00_bootstrap, ili test — bez širenja opsega.

Acceptance: Lokalno repro ili objasni zašto je fix ispravan; nema slabljenja
asserta osim ako je bug u testu, ne u produkciji.
```

---

## 11. Checklist pre slanja zadatka agentu (Claude)

- [ ] **Tabela/entitet** imenovan; ako nisi siguran u kolone, reci: “pročitaj migraciju koja kreira `public.X`”.
- [ ] **Read vs write**: SELECT je drugačiji od INSERT/UPDATE/DELETE; za RLS: USING vs WITH CHECK.
- [ ] **Ko je “admin”** u smislu ovog repoa: `user_roles`, `current_user_is_admin`, `has_edit_role` — u zadatku navedi koji scenario važi.
- [ ] **Da li** treba ažurirati `sql/ci/migrations.txt` i `sql/ci/00_bootstrap.sql` (skoro uvek **da** za nove tabele/RLS testove u CI).
- [ ] **Dokumentacija:** da li korisnik želi ažuriran `docs/SECURITY.md` u istom PR-u (Faza, istorija) — ako da, reci eksplicitno.
- [ ] **Regeneracija** `docs/RBAC_MATRIX.md` posle `CREATE POLICY` / `GRANT` u migracijama.

---

## 12. Zamke (PostgreSQL, RLS, CI) — pomeni u zadatku gde treba

| Zamka | Zašto | Šta napisati agentu |
|--------|--------|----------------------|
| UPDATE/DELETE i RLS | `USING` ne prolazi → **0 redova**, često **nema** SQLSTATE 42501 | Očekuj “0 affected” ili nulu redova, ne uvek `throws_ok`. |
| INSERT | `WITH CHECK` može **baciti** 42501 | `throws_ok` je često ispravan za zabranjeni INSERT. |
| `FORCE ROW LEVEL SECURITY` | Superuser/test seed može pasti na RLS | Po uzoru na postojeće testove: `SET LOCAL row_security = off` oko seed-a. |
| Rekurzija politika | Polisa na tabeli T poziva T → često rekurzija | Koristi `SECURITY DEFINER` helper (vidi sastanci helper-e). |
| `auth.jwt()` u testu | Prazan JWT u čistom psql | Test mora setovati role/claims kako u postojećim `security_*.sql`. |
| `PRIMARY KEY` i `NULL` u `user_roles` | `COALESCE` u PK nije dozvoljen | Uzori u `sql/ci/00_bootstrap` — unique index + coalesce. |
| “Samo uredi JS” | Nema RLS = nema stvarne zaštite | Ako su podaci osetljivi, zadatak Mora uključiti SQL. |

---

## 13. Supabase / API napomene (za precizne zadatke)

- **PostgREST** mapira tabele i RPC; **imena** RPC i parametra moraju tačno odgovarati SQL-u.
- Anon i authenticated ključ: **ne** oslanjati se da “sakriven UI” sprečava odlazak ka API-ju — RLS i grantovi.
- **Edge Function deploy** (`--no-verify-jwt` itd.): to je zasebna odluka; u zadatku reci “ne menjaj deploy flag” osim ako je eksplicitno traženo.
- Ako se poziva preko **supabase-js** sa service key-em, obavezno pomenuti **global** ili **per-request** headere za `X-Audit-Actor` gde već postoji obrazac u kodu.

---

## 14. Konvencije (kako formulisati da agent ne pogađa stil)

- **Jezik u UI i porukama:** srpski (ćirilica/latinica po postojećem ekranu); u kodu i imenima **konzistentno sa fajlom** koji se menja.
- **ID-evi:** UUID gde tabela očekuje UUID; ne mešati string id bez razloga.
- **Imena migracija:** opisno, datuma ili faze, npr. `add_foo_rls_....sql` — ne prepisivati stare migracije koje su već deploy-ovane; uvek **nova** migracija.
- **Minimalan diff:** “Ne refaktorisi nepovezane module”; “Jedan PR = jedan logički cilj” gde je moguće.

---

## 15. Kada eksplicitno tražiti ažuriranje `docs/SECURITY.md`

- Nova **faza** hardeninga ili promena **nivoa** (npr. CRITICAL → rešeno).
- Nova kategorija **service** aktera (`X-Audit-Actor` vrednost).
- Bitna promena **RLS modela** (npr. sastanci Model B).
- Dodavanje **novih** CI provera (nova skripta u workflow-u) — u SECURITY ili u ovom fajlu u sekciju 6.

---

## 16. Jezički šablon za “šta ne raditi” (dodaj u zadatak)

```text
Ne dirati: node_modules, generisane build artefakte, ne menjaj stare migracije in-place
(osim ako je eksplicitno hotfix iste verzije — retko).
Ne uvođi novi framework (React u core) bez eksplicitne odluke.
Ne smanjuj security test (skip, komentar) osim ako test laže o produkčnom ponašanju.
```

---

## 17. Dodatak: šta dodatno učitati u Claude Projekat (osim sekcije 8)

- **Ciljni modul** jedan fajl: `src/ui/...` koji se menja (ako je zadatak UI-težak).
- **Jedan** reprezentativni servis, npr. `src/services/employees.js` (obrasci poziva) — ne ceo `src/`.
- Poslednje 2–3 **commit** poruke sa `main` (stil i ton).
- Ako postoji, root **README** ili CONTRIBUTING (ako bude dodat u repo).

---

## 18. Dva kompletna fiktivna zadatka + šta agent prvo otvara

Ovo su **vežbe** za Claude: gotovi tekst za copy-paste, plus “mapa rada” da agent ne lutaju po celom repou.

### 18.1 Scenario A — “Komentari na zadatak” (RLS + read/write)

**Zadatak (za Cursor):**

```text
Kontekst: Dodajemo tabelu public.task_comments (id uuid PK, task_id uuid NOT NULL FK na
postojeću tasks tabelu, author_email text NOT NULL, body text, created_at timestamptz).
Korisnik sme SELECT samo komentare na zadatke koji pripadaju projektima gde ima leadpm/pm
(bez menjanja postojećeg has_edit_role — samo pozovi postojeći obrazac iz migracija).

Obim: Nova migracija; RLS; NE menjati Plan Montaže UI osim ako tasks već ima ekran —
pretpostavi samo backend. Dodaj sql/tests/security_task_comments_rls.sql (pgTAP).

Acceptance:
- anon nema pristup; authenticated vidi komentare samo uz ispunjen uslov (projekat).
- INSERT dozvoljen samo ako je author_email = jwt email i korisnik sme da edituje taj projekat
  (koristi istu logiku kao ostale write operacije u tom modulu — pročitaj susedne tabele).
- CI: ažuriraj sql/ci/00_bootstrap.sql (minimalan stub tasks ako treba) i sql/ci/migrations.txt.

Posle: npm run gen:rbac-matrix, npm run check:rbac-matrix, npm test, npm run check:schema-baseline
ako menjaš sql/schema.sql.

Ne dirati: sastanci_*, edge funkcije, workers.
```

**Šta agent tipično prvo čita / menja (mapa):**

| Korak | Fajl / lokacija | Zašto |
|-------|------------------|--------|
| 1 | `sql/migrations/add_*_task_comments*.sql` (novi) | šema + RLS + indeksi |
| 2 | Postojeća migracija koja definiše `tasks` i `has_edit_role` / projekat | da ne izmisli pravilo |
| 3 | `sql/ci/migrations.txt` | redosled u CI |
| 4 | `sql/ci/00_bootstrap.sql` | stub tabele ako test nema punu šemu |
| 5 | `sql/tests/security_task_comments_rls.sql` (novi) | pgTAP |
| 6 | `docs/RBAC_MATRIX.md` | posle `gen:rbac-matrix` (generisano) |
| 7 | `docs/SECURITY.md` | samo ako product traži ažuriranje opisa |

---

### 18.2 Scenario B — “Notifier” (Edge + service role + audit)

**Zadatak (za Cursor):**

```text
Kontekst: Nova Edge funkcija supabase/functions/pm-digest-notify koja na trigger (HTTP)
čita iz public.daily_digest_queue (pretpostavi da tabela već postoji), šalje email preko
postojećeg provajdera ako postoji, i briše obrađene redove. Koristi service role samo unutar
funkcije; nema novog BYPASS klijenta u browseru.

Obim: Nova mapa funkcije + zajednički helper za rpc pozive ako već postoji obrazac.
Obavezno: X-Audit-Actor: pm-digest-notify@edge.servoteh na svakom mutirajućem pozivu ka PostgREST-u,
kao u hr-notify-dispatch.

Acceptance: Nema logovanja service role ključa; mutacije imaju smislen actor u audit trail-u
ako postoji trigger na diranim tabelama. TypeScript build prolazi.

Ne menjaj: --no-verify-jwt deploy konfiguraciju u ovom PR-u (odvojena priča).
```

**Šta agent tipično prvo čita / menja (mapa):**

| Korak | Fajl / lokacija | Zašto |
|-------|------------------|--------|
| 1 | `supabase/functions/hr-notify-dispatch/index.ts` | obrazac za `fetch` + headeri |
| 2 | `supabase/functions/maint-notify-dispatch/index.ts` | alternativni obrazac |
| 3 | `sql/migrations/add_audit_actor_attribution.sql` ili trenutni `current_user_email()` | kako se čita `X-Audit-Actor` |
| 4 | `supabase/functions/pm-digest-notify/index.ts` (novi) | implementacija |
| 5 | `docs/SECURITY.md` sekcija o service role | samo ako treba nova linija u “akteri” |

---

**Kako koristiti:** Claude prvo napiše zadatak kao u 18.1 ili 18.2, zatim doda **tabelu “mapa”** (kao gore) prilagođenu stvarnom imenu fajlova iz repoa posle brzog `grep`/`glob` u glavi korisnika.

---

*Verzija: 1.2 · za repo `servoteh-plan-montaze` · ažuriraj kada se promeni CI, SECURITY model ili obrasci u `sql/tests/`.*
