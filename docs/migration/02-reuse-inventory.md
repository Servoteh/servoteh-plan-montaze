# Inventar reusable rada — šta od `servoteh-plan-montaze` ide u novi MES

> **Status:** draft v0.1 (24. april 2026)
> **Autor:** Nenad + AI asistent
> **Tip:** Internal planning dokument
> **Cilj:** Pre handoff-a eksternom timu, identifikovati šta od **postojećeg rada** (kod, schema, dokumentacija, business logic) ide direktno u novi MES — i šta se odbacuje.
> **Ne sadrži:** odluke o stack-u (to je `STRATEGIJA_MES_v0.1.md`), tehnički bridge analiza (to je `docs/bridge/01-current-state.md`).

---

## 0. TL;DR

Od ~140 fajlova kod-a + 70 SQL migracija + 12 dokumentacionih fajlova u ovom repu, **realan reuse ratio** za novi MES je:

| Sloj | Reuse % | Forma reuse-a | Napomena |
|---|---|---|---|
| **Database schema (DDL, indeksi, RLS, RPC)** | **70–85%** | Direktan port u Postgres baseline | Kopiranje + minor cleanup |
| **Business logic (services/*.js)** | **40–60%** | SPEC + reference implementation | Tim portuje na TS, ali pravila su rešena |
| **UI ergonomika i layout** | **20–30%** | Screenshots + opis tokova | Next.js komponente se pišu ispočetka |
| **Test fixtures (payroll, csv, lokacije)** | **80–95%** | Direktan port (data fixtures su jezički neutralne) | Pomažu tim da ne reverse-engineer-uje pravila |
| **Dokumentacija modula** | **90–100%** | Lift-and-shift + dopune | Već je urađen najteži deo (discovery) |
| **Audit, RBAC matrix, security baseline** | **80%** | Specifikacija + reference RLS politike | Tim implementira u svom adapter sloju |
| **Bridge artifacts** | **30%** | Outbox pattern + retry logika kao referenca | Specifična za Supabase RPC, ne MSSQL adapter |
| **Capacitor mobile shell** | **0–20%** | Samo deps lista, kod ide ispočetka | Next.js + Capacitor stack se gradi novo |

**Ukupna procena uštede vremena za tim** (vs. greenfield bez ovog repa):
- Tradicionalni rad: **3–4 meseca** uštede (od 5 meseci scope-a)
- AI-augmented rad: **1.5–2 meseca** uštede (manja relativna ušteda jer AI ionako ubrzava discovery)

**Najveća vrednost koju predajemo timu nije kod** — već **rešena business pravila** (kako se računa plata, kako radi grid prisustva, kako rade overlays plana proizvodnje, kako ide sync sa MSSQL-om).

---

## 1. Sloj-po-sloj analiza

### 1.1 Database schema (Postgres DDL + RLS + RPC)

**Stanje u repu:** 70 SQL migracija u `sql/migrations/`, evolutivno akumulirane.

**Šta se prenosi:**

| Modul | Tabele | RPC funkcije | RLS politike | Procena reuse-a |
|---|---|---|---|---|
| **Lokacije** | 4 (`loc_predmeti`, `loc_lokacije`, `loc_sync_outbound_events`, `loc_audit_log`) | 8 (`loc_claim_sync_events`, `loc_mark_sync_*`, `loc_purge_synced_events`, `loc_tps_for_predmet`, `loc_report_by_locations`) | 12 politika | **85%** — direktan port |
| **Kadrovska** | 14 (employees, contracts, salary, payroll, work hours, absences, vacation, holidays, children, grid, notifications, ...) | ~20 RPC | ~25 politika | **75%** — port + cleanup duplikata |
| **Plan Montaže** | 8 (planMontaze, projects, projektniSastanak, akcioniPlan, pmTeme, model, ...) | ~10 RPC | ~15 politika | **70%** — neki delovi (overlays) treba refactor |
| **Plan Proizvodnje** | 3 (`production_overlays`, `production_drawings`, `v_production_operations` view) | 2 | 5 | **80%** — relativno čist |
| **Održavanje Mašina** | 6 (machines, files, incidents, profiles, notifications, outbox) | ~8 | ~12 | **65%** — outbox pattern se preplapira sa Lokacijama |
| **Audit / RBAC** | 2 (`audit_log`, `user_roles`) + 50 SECURITY DEFINER fn | n/a | core | **80%** — pattern je opšti |

**Šta NE ide direktno (cleanup pre porta):**
- Migracije sa `cleanup_*`, `disable_*`, `enable_*`, `fix_*` u imenu (ima ih ~6) — to su iteracije, finalno stanje treba konsolidovati
- `add_admin_tasic_srejic.sql` — hard-coded korisnici, treba pretvoriti u seed
- `add_*_v2.sql`, `*_v3.sql`, `*_v4.sql` (lokacije i RPC) — finalna verzija + delete starih
- Sve što je vezano za Supabase Auth (`auth.users` reference) — treba zameniti sa novim auth provider-om

**Output za tim:**
> **`db_schema_baseline.sql`** — jedan konsolidovan SQL fajl, dijaletkat: standardni Postgres 16 (bez Supabase ekstenzija). Predstavlja "verziju 1.0" baze koju tim treba da nastavi da evolvira.

**Procena vremena za pripremu (AI workflow):** 1–2 dana
**Procena vremena za pripremu (tradicionalno):** 2–3 nedelje

---

### 1.2 Business logic — `src/services/*.js` (32 fajla, ~8K LoC)

**Stanje u repu:** Vanilla JS service moduli koji omotavaju Supabase RPC pozive i dodaju business logiku.

**Klasifikacija:**

| Tip | Fajlova | Reuse forma |
|---|---|---|
| **Pure business logic** (computation, validation) | 6 | **Direktan TS port — 80% kod ostaje** |
| **CRUD wrapperi nad Supabase** | 18 | **Spec only — kod se piše ispočetka u novom adapter sloju** |
| **Auth & users** | 3 | **Spec only — vezano za Supabase Auth** |
| **Capacitor native bridge** | 2 | **Spec only — drugi mobile stack** |
| **Offline queue** | 1 | **Pattern only — implementacija zavisi od novog frontend-a** |
| **Sync workers** | 2 | **Pattern + spec — vezano za Supabase Realtime** |

**Top kandidati za "pure logic" port:**

| Fajl | LoC | Šta sadrži | Reuse vrednost |
|---|---|---|---|
| `src/services/payrollCalc.js` | ~600 | Računanje plate, koeficijenti, prekovremeno, bolovanje, godišnji | **VRLO VISOKA** — kompleksna pravila, već testirana (`tests/services/payrollCalc.test.js`) |
| `src/services/workHours.js` | ~400 | Sumiranje časova po danima/tipovima | **VISOKA** — zavisi od `payrollCalc.js` |
| `src/services/grid.js` | ~500 | Logika prisustva (grid evidencija) | **VISOKA** — netrivijalna pravila |
| `src/services/holidays.js` | ~150 | Praznici, neradni dani | **SREDNJA** — relativno jednostavno |
| `src/services/barcode.js` | ~200 | Barcode generation, format validation | **VISOKA** — domain knowledge |
| `src/services/salary.js` | ~300 | Salary terms, ugovori | **VISOKA** — vezana za payrollCalc |

**Šta se predaje za ovih 6 fajlova:** **`module_specs/kadrovska_calc_spec.md`** — pseudokod + invariante + edge cases + reference na test fixtures.

**Output za tim:**
> Reference implementacija u JS-u + specifikacija u Markdown-u. Tim portuje na TS u svom backend stack-u, koristi naše testove kao acceptance kriterijum.

**Procena pripreme (AI workflow):** 2–3 dana za sve module
**Procena pripreme (tradicionalno):** 2–3 nedelje

---

### 1.3 UI sloj — `src/ui/**/*.js` (78 fajla)

**Stanje u repu:** Vanilla JS DOM manipulacija, bez framework-a. Stilovi u `src/styles/`.

**Reuse procena:** **20–30%** — i to **NE kao kod**, već kao:
- **Screenshots** sa anotacijama (toks, edge cases)
- **Wireframe descriptions** ("ovde je Gantt sa 3 kolone, drag-and-drop podržava overlap detection")
- **User flow narrativi** ("kada operater skenira lokaciju, otvara se modal koji prikazuje sve TPS predmete na toj lokaciji")

**Zašto tako malo direktnog reuse-a:**
- Vanilla DOM kod ne mapira na React komponente
- Nema design sistem (komponente se ad-hoc grade)
- Različite UX paradigme (jQuery-style imperativno vs. React deklarativno)

**Šta tim dobija (umesto koda):**

| Modul | Forma reuse-a | Količina |
|---|---|---|
| **Plan Montaže** | 15–20 screenshots Gantt-a + tabele + modala, opis drag/drop logike, exportModal flow | 1 markdown spec ~3000 reči |
| **Lokacije** | 10 screenshots (predmet tab, scan modal, lookup, štampa labela) + business flow opis | 1 spec ~2500 reči |
| **Kadrovska** | 20+ screenshots (employees, grid, salary, payroll, vacation, absences, reports) — najveći modul | 1 spec ~5000 reči |
| **Održavanje** | 8 screenshots + tasks/incidents/files | 1 spec ~2000 reči |
| **Plan Proizvodnje** | overlays UI, drawings manager, pregled po mašini | 1 spec ~1500 reči |
| **Sastanci** | dashboard, projektni, akcioni plan | 1 spec ~1500 reči |

**Šta postoji već u repu i može se reuse-ovati:**
- `screenshots/` folder — već ima ~30+ slika
- `docs/Lokacije_modul.md`, `docs/Kadrovska_modul.md`, `docs/Plan_montaze_modul.md`, `docs/Planiranje_proizvodnje_modul.md` — postoje, treba ih dopuniti

**Procena pripreme (AI workflow):** 3–4 dana za sve module (uključujući snimanje screenshots-a)
**Procena pripreme (tradicionalno):** 4–5 nedelja

---

### 1.4 Tests — `tests/**/*.js` (9 fajla)

**Stanje:** Vitest unit testovi za pure-logic delove (CSV parsing, lokacije filteri, payroll, RBAC matrix, schema baseline, barcode parsing).

**Reuse procena:** **80–95%**

| Test fajl | Šta pokriva | Reuse forma |
|---|---|---|
| `tests/services/payrollCalc.test.js` | Sva pravila plate (koeficijenti, prekovremeno, bolovanje) | **Test fixtures direktno reusable** — tim implementira logic, naši testovi prolaze |
| `tests/lib/csv.test.js` | CSV parsing edge cases | **Direktan port** |
| `tests/lib/lokacijeFilters.test.js` | Filter logika lokacija | **Direktan port** |
| `tests/lib/barcodeParse.test.js` | Barcode format parsing | **Direktan port** |
| `tests/lib/tspl2.test.js` | TSPL2 label generation za štampač | **Direktan port** |
| `tests/scripts/rbacMatrix.test.js` | Provera da je RBAC matrix sinhron | **Spec only** — tim implementira u svom CI |
| `tests/scripts/schemaSecurityBaseline.test.js` | Security baseline za schema | **Spec only** |
| `tests/state/lokacije.test.js` | State management lokacija | **Reference samo** — nova arhitektura |
| `tests/lib/dom.test.js` | DOM utility testovi | **Skip — vezano za vanilla DOM** |

**Vrednost za tim:** **VRLO VISOKA**. Testovi su izvršiva specifikacija. Ako tim portuje payroll logic u .NET ili NestJS, naši test cases (sa konkretnim ulaznim/izlaznim vrednostima) garantuju paritet sa starim sistemom.

**Procena pripreme (AI workflow):** 0.5 dana (samo cleanup i ekstrakt fixtures-a u JSON)
**Procena pripreme (tradicionalno):** 2–3 dana

---

### 1.5 Bridge i sync (workers + RPC)

**Stanje:** `workers/loc-sync-mssql/` — Node.js worker sa outbox pattern-om za Supabase → MSSQL sync.

**Reuse procena:** **30%** kao **arhitekturni pattern**, **0%** kao kod (specifičan za stari stack).

**Šta je vredno:**

| Element | Reuse vrednost | Forma |
|---|---|---|
| **Outbox pattern** (events tabela + claim/mark RPC) | **VISOKA** — proveren u prod | Pattern spec + reference u dokumentu |
| **Idempotency ključevi** | **VISOKA** | Pattern + lessons learned |
| **Retry sa exponential backoff** | **SREDNJA** | Bilo koji moderni framework ima |
| **Telegram bot za alerte** | **NISKA** | Trivijalno za reimplement |
| **`scripts/backfill-bigtehn-work-orders.js`** | **VISOKA** | Reference za buduće migracije iz MSSQL-a |

**Šta se odbacuje:**
- Konkretan kod (Supabase RPC pozivi su irelevantni za novi stack)
- `mssqlClient.js` (vezan za stari connection string i `sp_ApplyLocationEvent` koji ne postoji)

**Output za tim:**
> Sekcija u `migration_specs/bridge_pattern.md` koja opisuje:
> 1. Outbox pattern dijagram
> 2. Lessons learned (zašto smo izabrali polling umesto NOTIFY/LISTEN, zašto 15s, kako handlujemo duplicate-e)
> 3. Migration script template za buduće MSSQL → Postgres backfill

**Procena pripreme (AI workflow):** 0.5 dana
**Procena pripreme (tradicionalno):** 3–4 dana

---

### 1.6 Audit, RBAC, security

**Stanje:**
- `sql/migrations/add_audit_log.sql` — generic audit triggers
- `sql/migrations/add_audit_actor_attribution.sql` — actor email tracking
- `docs/RBAC_MATRIX.md` (auto-generisano)
- `docs/SECURITY.md`
- `tests/scripts/schemaSecurityBaseline.test.js`
- 50 SECURITY DEFINER funkcija sa validiranim search_path-ovima

**Reuse procena:** **80%**

**Šta se prenosi:**
- Audit log table struktura (pattern)
- 50 SECURITY DEFINER fn — direktan port (Postgres je Postgres)
- RLS politike kao reference (treba reorganizovati za multi-tenant)
- Security baseline check kao spec za tim CI

**Šta se prilagođava:**
- `auth.uid()` (Supabase Auth) → `current_setting('app.current_user_id')` ili JWT claim
- `auth.users` reference → custom users tabla u novom auth sistemu
- `tenant_id` mora se dodati u svaku RLS politiku (multi-tenant)

**Output za tim:** **`security_baseline_spec.md`** — opisi audit pattern-a, RBAC matrice, RLS strategy + reference na konkretne migracije.

**Procena pripreme (AI workflow):** 1 dan
**Procena pripreme (tradicionalno):** 1 nedelja

---

### 1.7 Mobile (Capacitor)

**Stanje:** Capacitor 8.x wrapper oko Vite buildanog web-a, sa native barcode scanner-om (`@capacitor-mlkit/barcode-scanning`).

**Reuse procena:** **0–20%**

**Šta se prenosi:**
- Iskustvo: koje native pluginove smo koristili (mlkit barcode, app)
- Pattern: kako se offline queue radi u browseru
- `docs/MOBILE.md` — operacije specifične za mobile

**Šta se odbacuje:**
- Sav UI kod (vanilla DOM)
- Offline queue implementacija (tied to vanilla)
- PWA manifest (Vite specifičan)

**Šta tim radi novo:**
- Capacitor wrapper oko Next.js (ako se zadržava Capacitor) ILI
- React Native (ako se odluče za drugi pristup) — to je ipak strateška odluka tima

**Procena pripreme:** 0.5 dana (samo opisi)

---

### 1.8 Ostalo (config, scripts, infra)

| Element | Reuse |
|---|---|
| `vite.config.js` | 0% — drugi build tool |
| `capacitor.config.json` | 50% — app id, icon paths reusable |
| `eslint.config.js` | 80% — pravila reusable, dijalekt nije |
| `scripts/generate-rbac-matrix.cjs` | 50% — pattern + dijalekt cleanup |
| `scripts/check-schema-security-baseline.cjs` | 70% — direktan port |
| `scripts/render-supabase-schema-md.cjs` | 30% — pattern, ali pgTAP ekvivalent treba |
| `.github/workflows/` (ako postoji) | 50% — CI pattern reusable |

---

## 2. Šta se NE prenosi (eksplicitno scope cap)

Ovo je važno da tim **ne pita kasnije**:

| Element | Razlog odbacivanja |
|---|---|
| Vite + vanilla JS frontend stack | Tim koristi Next.js + TS |
| Supabase Auth integracije | Drugi auth provider |
| Supabase Storage URL-ovi | Drugi blob storage (MinIO predloženo) |
| Supabase Realtime | Drugi mehanizam za realtime ako bude potrebno |
| Supabase Edge Functions | Backend API umesto edge fn |
| `pg_cron` job-ovi | Mogu se reuse-ovati ako se zadržava (preporučeno) ili zameniti sa external scheduler-om |
| Cloudflare worker `loc-sync-mssql` | Bridge ka MSSQL ide u Fazu 3 ili se eliminiše |
| Telegram bot za alerte | Drugi alerting (Grafana, Alertmanager) |
| sve `*_v2.sql`, `*_v3.sql` migracije | Konsoliduju se u baseline |
| `disable_*`, `cleanup_*` migracije | Iteracije, samo finalno stanje |

---

## 3. Šta tim mora da uradi sam (gde nema reuse-a)

Iako mnogo toga prenosimo, **realan posao tima** je veliki:

| Posao | % projekta | Reuse pomaže? |
|---|---|---|
| Frontend (Next.js + TS + komponente) | ~30% | Indirektno (kroz spec dokumente) |
| Backend API (REST/GraphQL/RPC) | ~25% | Delimično (RPC nazivi i parametri ostaju) |
| Auth implementacija | ~5% | Slabo (drugi provider) |
| Mobile rebuild | ~10% | Slabo |
| Infrastructure (Postgres tuning, monitoring, backup, VPN) | ~10% | Nikako (on-prem novo) |
| Data migracija iz BigTehn MSSQL | ~10% | Donekle (bridge backfill skripte kao referenca) |
| Testing (E2E, integration, perf) | ~10% | Test fixtures pomažu, framework ne |

**Realan zaključak:** Postojeći rad daje timu **~30–40% prečicu** u smislu vremena, najveći deo te prečice je u **discovery + business pravilima**, ne u kodu.

---

## 4. Prioritet pripreme handoff materijala

Ako počnemo planiranje sutra (25.4.2026) za handoff 1.5.2026:

| Dan | Deliverable | Razlog za prioritet |
|---|---|---|
| **D1** | `db_schema_baseline.sql` | Najveći ROI, lako se ekstraktuje |
| **D2** | `module_specs/lokacije_spec.md` + screenshots | Najmanji modul, brzo se završava |
| **D3** | `module_specs/kadrovska_spec.md` + screenshots | Najveći modul, najveća vrednost |
| **D4** | `module_specs/plan_montaze_spec.md` + screenshots | Visoka kompleksnost (Gantt) |
| **D5** | Ostala 3 modula (sastanci, plan_proizvodnje, odrzavanje) | Manji moduli |
| **D6** | `bridge_pattern.md` + `security_baseline_spec.md` | Cross-cutting |
| **D7** | `db_seed_data.sql` (master data) + handoff README | Završni paket |

**Buffer:** 1 nedelja za neplanirana pitanja od tima ili Negovana, dodatno čišćenje, test verifikaciju.

**Total:** 7 radnih dana + 5 dana buffer = **~2 nedelje kalendarski**, što je **mnogo manje** od mojih originalnih 6–8 nedelja (koje su pretpostavljale tradicionalan rad).

---

## 5. Pregled outputa za tim

Konačan handoff folder će izgledati ovako:

```
handoff-package/
├── README.md                          # Index + reading order + glossary
├── db/
│   ├── db_schema_baseline.sql         # Konsolidovan DDL + RLS + RPC
│   ├── db_seed_data.sql               # Master data, sifarnici, primer korisnika
│   └── db_migration_history.md        # Kratki opis evolucije
├── module_specs/
│   ├── lokacije_spec.md
│   ├── kadrovska_spec.md
│   ├── plan_montaze_spec.md
│   ├── plan_proizvodnje_spec.md
│   ├── odrzavanje_spec.md
│   └── sastanci_spec.md
├── cross_cutting/
│   ├── auth_and_rbac_spec.md
│   ├── audit_pattern_spec.md
│   ├── bridge_pattern_spec.md         # MSSQL ↔ MES sync (ako bude potrebno)
│   └── mobile_spec.md
├── reference_implementation/
│   ├── payroll_calc.js                # Pure logic — možeš direktno port-ovati
│   ├── grid_logic.js
│   ├── workhours.js
│   └── tests/                         # Sva test fixtures iz tests/ folder-a
├── ui_reference/
│   ├── screenshots/                   # Sve iz screenshots/ + nove
│   └── wireframe_notes.md
└── ops/
    ├── infra_recommendations.md       # Šta smo naučili o on-prem (kratko)
    └── monitoring_baseline.md         # Što je u SECURITY.md sada
```

---

## 6. Otvorena pitanja za potvrdu

Pre nego što krenemo sa pisanjem deliverable-a:

1. **Da li je folder struktura iznad OK?** Možda preferiraš drugačiji raspored (npr. sve u flat repo, ne nested folderi).
2. **Da li tim dobija read-only Git pristup ovom repu?** Ako da, mnoge "spec" sekcije mogu da budu kraće (samo link na fajl). Ako ne, treba sve eksplicitno copy-paste-ovati.
3. **Format spec dokumenata: Markdown ili nešto bogatije** (Notion, Confluence, ASCIIDoc)? Ja predlažem Markdown jer Git-friendly.
4. **Jezik dokumentacije: srpski ili engleski?** Trenutno repo je mešan. Ako tim ima ne-srpske članove, sve treba na engleski (dodaje 1–2 dana prevoda).
5. **Da li je u redu da Negovan VBA logika ostane "TBD" u spec dokumentima?** (jer je nedostupan, kao što si rekao). Tim će onda morati live da debug-uje sa BigTehn-om.

---

**Sledeći dokument:** `docs/migration/03-handoff-preparation-plan.md` — konkretan plan rada sa dnevnim deliverable-ima.
