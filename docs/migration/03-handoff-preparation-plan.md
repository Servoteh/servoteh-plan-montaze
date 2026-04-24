# Plan pripreme handoff paketa za eksterni razvojni tim

> **Status:** draft v0.1 (24. april 2026)
> **Autor:** Nenad + AI asistent
> **Tip:** Internal action plan
> **Cilj:** Dnevni breakdown rada za pripremu handoff paketa pre kick-off-a sa eksternim timom (planiran za **1.5.2026**).
> **Pretpostavlja:** AI-augmented workflow (Cursor + Claude/GPT), Nenad kao PO (ne kuca), AI asistent kao executor.
> **Predmet rada:** materijali iz `docs/migration/02-reuse-inventory.md`.

---

## 0. TL;DR

| Metrika | Vrednost |
|---|---|
| **Ukupno deliverable-a** | 17 dokumenata + 1 SQL baseline + 1 seed file + screenshots |
| **Ukupno radnih dana (AI workflow)** | **7 dana** |
| **Buffer** | 5 dana |
| **Kalendar** | **25.4.2026 → 09.5.2026** (2 nedelje) |
| **Kick-off sa timom** | 12.5.2026 (ako se polazi od dva-nedeljne pripreme) |
| **GO-LIVE target (po STRATEGIJA_MES_v0.1)** | 30.9.2026 |

**Glavna razlika u odnosu na moju prvotnu procenu (6–8 nedelja):** koristim AI-augmented baseline. Ako se radi tradicionalno, isti scope traje **6–8 nedelja**. Vidi sekciju **5. Kalibracija procena**.

---

## 1. Roles i odgovornosti tokom pripreme

| Uloga | Ko | Šta radi | Trošak vremena |
|---|---|---|---|
| **Product Owner / Decision maker** | Nenad | Definiše scope, odgovara na pitanja, daje screenshots, validira deliverable | ~2–3h dnevno |
| **AI Executor** | Claude / Cursor | Generiše dokumente, ekstraktuje SQL, piše spec-ove, predlaže strukturu | n/a |
| **Tehnički validator** | Nenad / spoljni recenzent | Review na kraju svakog dana | ~30 min dnevno |
| **Domain expert (po potrebi)** | Negovan / drugi | Pojašnjava VBA logiku, edge case-ove iz BigTehn | Ad-hoc, najverovatnije nedostupno |

**Ako se Negovan ne uključuje:** Plan ostaje validan, ali spec dokumenti će imati `[NEGOVAN_INPUT_TBD]` na mestima gde nemamo definitive answer. Tim će morati da debug-uje uživo.

---

## 2. Dnevni breakdown (7 radnih dana)

### Dan 1 (D1) — Database baseline + handoff README

**Deliverable:**

1. **`handoff-package/db/db_schema_baseline.sql`**
   - Konsolidovati svih 70 migracija u jedan ekvivalentan DDL fajl
   - Eliminisati redundantne migracije (`*_v2`, `*_v3`, `cleanup_*`, `disable_*`, `enable_*`)
   - Ukloniti Supabase-specific reference (`auth.users`, `auth.uid()`)
   - Dodati TODO komentare gde postoji `tenant_id` placeholder za multi-tenant
   - Generic Postgres 16 dijalekt (bez Supabase ekstenzija; `pg_cron` ostaje opcionalan)
2. **`handoff-package/db/db_migration_history.md`**
   - Kratka istorija evolucije po modulu (1 paragraf po modulu)
3. **`handoff-package/README.md`**
   - Index svih dokumenata + redosled čitanja
   - Glossary (skraćenice: TPS, RN, RBAC, RLS, MES, ERP, ...)
   - Setup instrukcije (kako da podigne tim DEV environment)

**Vreme (AI workflow):** **6–8h** (uključujući validaciju da DDL prolazi clean apply na praznoj bazi)

**Verifikacija:**
- `psql -f db_schema_baseline.sql` na čistoj bazi prolazi bez grešaka
- Broj tabela = broj tabela u trenutnoj Supabase bazi (manje audit log koji se generiše triger-ima)
- `tests/scripts/schemaSecurityBaseline.test.js` — adaptirati i pokrenuti

---

### Dan 2 (D2) — Lokacije modul spec

**Deliverable:**

1. **`handoff-package/module_specs/lokacije_spec.md`**
   - **Sekcije:**
     - Business kontekst (šta je Lokacije, ko koristi, koji procesi)
     - Data model (tabele, RPC, RLS — sa link-ovima na konkretne migracije)
     - User flows (operater skenira lokaciju, magacioner pomera predmete, štampa labele)
     - Sync pattern ka MSSQL-u (outbox, claim/mark, idempotency)
     - Edge cases (case-insensitive duplikate, drawing_no parsing, order scope)
     - Acceptance kriterijumi (lista test scenarija)
2. **`handoff-package/ui_reference/lokacije/`** — screenshots (~10) sa anotacijama
3. **Refresh** `docs/Lokacije_modul.md` ako ima zastarelih informacija

**Vreme (AI workflow):** **6h** (najmanji modul)

**Verifikacija:**
- Spec pregleda Nenad
- Screenshots se snimaju iz produkcije (live click-through)

---

### Dan 3 (D3) — Kadrovska modul spec (najveći)

**Deliverable:**

1. **`handoff-package/module_specs/kadrovska_spec.md`** — najveći spec, ~5000 reči
   - **Podsekcije po tab-u:**
     - Employees (CRUD, contracts, children, salary terms)
     - Grid prisustva (matrix view, klik za absences)
     - Salary & Payroll (v2 + obračun)
     - Vacation & absences (sub-types, days calculation)
     - Work hours (daily entry, monthly summary)
     - Holidays (configurable per year)
     - HR Notifications
     - Reports
2. **`handoff-package/reference_implementation/payroll_calc.js`** — kopija + komentari + link na test
3. **`handoff-package/reference_implementation/tests/payrollCalc.test.js`** — sa svim fixtures
4. **`handoff-package/ui_reference/kadrovska/`** — screenshots (~25)

**Vreme (AI workflow):** **8h** (najveći deo dana, najveći modul)

**Verifikacija:**
- Test fixtures pokrivaju sve scenarije iz dokumenta
- Spec eksplicitno markira TODO-ove gde Negovan input fali
- Screenshots organizovani po tab-u

---

### Dan 4 (D4) — Plan Montaže modul spec

**Deliverable:**

1. **`handoff-package/module_specs/plan_montaze_spec.md`**
   - **Specijalna pažnja:**
     - Gantt chart (drag/drop, overlap detection, totalGantt aggregation)
     - Project bar (status panel, reminder zone)
     - Linked drawings dialog (priključci na pozicije)
     - Phase descriptions, phase types
     - WP assembly drawing dialog
     - Mobile cards view
     - Export modal (PDF/Excel)
2. **`handoff-package/ui_reference/plan_montaze/`** — screenshots (~15)
3. **`handoff-package/reference_implementation/grid_logic.js`** — ako ima delova reuse-abilnih

**Vreme (AI workflow):** **8h** (kompleksna UI logika)

**Verifikacija:**
- Acceptance scenariji pokrivaju Gantt drag/drop, overlap, total view
- Screenshots demonstriraju sve glavne UX patterns

---

### Dan 5 (D5) — Ostala 3 modula (Plan Proizvodnje, Održavanje, Sastanci)

**Deliverable:**

1. **`handoff-package/module_specs/plan_proizvodnje_spec.md`** (~2h)
   - Overlays, drawings manager, pregled po mašini, departments view
2. **`handoff-package/module_specs/odrzavanje_spec.md`** (~2h)
   - Machines catalog, files, incidents, profiles, notifications, outbox
3. **`handoff-package/module_specs/sastanci_spec.md`** (~2h)
   - Dashboard, projektni sastanak, akcioni plan, pmTeme, arhiva
4. **`handoff-package/ui_reference/`** — screenshots za sva 3 (~20 ukupno)

**Vreme (AI workflow):** **8h** (paralelno)

**Verifikacija:**
- Sva 3 spec-a imaju isti format (templating konzistentnost)

---

### Dan 6 (D6) — Cross-cutting (auth, audit, bridge, security)

**Deliverable:**

1. **`handoff-package/cross_cutting/auth_and_rbac_spec.md`**
   - RBAC matrix (port iz `docs/RBAC_MATRIX.md`)
   - Role hijerarhija (admin, hr, menadzment, member)
   - Migration path: Supabase Auth → novi auth provider
   - JWT claim shema, session management
2. **`handoff-package/cross_cutting/audit_pattern_spec.md`**
   - Audit trigger pattern (port iz `add_audit_log.sql`)
   - Actor attribution (RLS context vs JWT claim)
   - Retention policy (`audit_log_cleanup`)
3. **`handoff-package/cross_cutting/bridge_pattern_spec.md`**
   - Outbox pattern dijagram
   - Polling vs NOTIFY/LISTEN trade-off
   - Lessons learned iz `loc-sync-mssql`
   - Reference za buduće MSSQL → MES backfill (ako bude potrebno)
4. **`handoff-package/cross_cutting/mobile_spec.md`**
   - Capacitor 8 deps + native plugins
   - Offline queue pattern
   - Barcode scanner integracija
   - Lessons learned iz produkcije

**Vreme (AI workflow):** **8h**

**Verifikacija:**
- Svi cross-cutting dokumenti imaju link-ove na konkretne migracije ili kod
- `auth_and_rbac_spec` pokriva sve uloge koje koriste current users

---

### Dan 7 (D7) — Seed data + ops + final review

**Deliverable:**

1. **`handoff-package/db/db_seed_data.sql`**
   - Master data (departments, roles, holidays, machine catalog, default config)
   - Sample tenant + 1 admin user (za DEV environment)
   - **NE** uključuje pravu employee data (privacy)
2. **`handoff-package/ops/infra_recommendations.md`**
   - Postgres tuning (connection pool, work_mem, shared_buffers za 4GB DB)
   - Backup strategija (pg_dump dnevno + WAL archive za PITR)
   - Monitoring (Prometheus exporter, Grafana dashboards)
   - On-prem network topology (LAN, VPN za remote dev)
3. **`handoff-package/ops/monitoring_baseline.md`**
   - Lift iz `docs/SECURITY.md` + dopune
4. **Final cross-check:**
   - Svaki spec ima link na seed data
   - Svaki RPC iz baseline-a se pominje barem jednom u nekom spec-u
   - Glossary u `README.md` pokriva sve skraćenice

**Vreme (AI workflow):** **6–8h**

**Verifikacija:**
- `db_seed_data.sql` se primenjuje posle baseline-a bez grešaka
- DEV environment se može podići iz handoff paketa za < 1h

---

## 3. Buffer (5 dana)

Posle 7 radnih dana imamo deliverable-e. Sledećih 5 dana ide na:

| Aktivnost | Vreme |
|---|---|
| **Dry-run handoff** sa internom osobom (npr. drugi developer iz Servoteha) | 1–2 dana |
| **Korekcije na osnovu feedback-a** | 1 dan |
| **Pitanja od potencijalnog tima** (ako su već identifikovani) | 1 dan |
| **Polishing, formatting, prevod ako treba** | 1 dan |

**Završetak:** 09.5.2026, kick-off 12.5.2026.

---

## 4. Workflow konvencije tokom pripreme

### 4.1 Git workflow

- Sav handoff materijal ide u `handoff-package/` folder na **posebnoj branch-i**: `prep/handoff-package`
- Daily commit, conventional message format (`docs(handoff): add lokacije module spec`)
- Pre kick-off-a, branch se merge-uje u `main` ili extract-uje u poseban repo (po dogovoru sa timom)

### 4.2 Iteracija sa AI-em

- **Pre svakog dana:** Nenad otvori chat, pogleda šta je planirano za taj dan, validira scope
- **Tokom dana:** AI generiše drafts, Nenad daje screenshots i odgovara na targeted pitanja
- **Kraj dana:** Nenad komituje, sutra počinje sa fresh chat-om (kontekst zadržan kroz dokumente)

### 4.3 Format konvencije

- Sav Markdown
- Code blocks sa jezikom (```sql, ```ts, ```js)
- Citati postojećeg koda u formatu `path/to/file.js:LINE_START-LINE_END`
- Slike: u relativnom path-u, format PNG, ime opisno (`lokacije-scan-modal-default-state.png`)
- **Jezik:** srpski po defaultu, ali ako tim ima ne-srpske članove, prevod ide u D7 (dodaje 1 dan)

---

## 5. Kalibracija procena — zašto AI workflow daje ovakve brojeve

Ovo je **referenca za sve buduće procene** u kontekstu ovog projekta.

### 5.1 Tradicionalna industrijska tabela (moj default)

| Posao | Tradicionalni baseline |
|---|---|
| Konsolidacija 60 migracija | 2–3 nedelje |
| Annotated module spec (1 modul) | 3–5 dana |
| Bridge pattern spec | 1 nedelja |
| Cross-cutting (auth, audit, security) | 1.5 nedelja |
| Seed data + ops | 1 nedelja |
| **TOTAL** | **8–10 nedelja** |

Ovo važi za:
- Tim od 1–2 čoveka koji manuelno kucaju
- Senior dev produktivnost ~200 LoC kvalitetnog koda dnevno
- Discovery overhead (čitanje kod-a za razumevanje)
- Code review cikulus (pull request → review → fix → merge)

### 5.2 AI-augmented workflow (ova procena)

| Posao | AI workflow |
|---|---|
| Konsolidacija 60 migracija | 1 dan |
| Annotated module spec (1 modul) | 0.5–1 dan |
| Bridge pattern spec | 2–3h |
| Cross-cutting | 1 dan |
| Seed data + ops | 1 dan |
| **TOTAL** | **7 dana + 5 dana buffer = 12 dana** |

**Ubrzavajući faktori:**
- Code generation: **5–20× brže**
- Codebase discovery (`Grep`, `SemanticSearch`): **50–200× brže**
- Documentation generation: **3–10× brže**
- Boilerplate refactor: **5–10× brže**

**Ne-ubrzavajući faktori (i dalje real-time):**
- Snimanje screenshots-a (Nenad + browser, ne AI)
- Validacija sa stejkholderima
- Decision-making (Nenad)
- Manual testing na DEV bazi

### 5.3 Prevod istih kalibracija na 5-mesečni MES projekat

Ovo je **najvažnija sekcija** za STRATEGIJU_MES_v0.1:

| Scenario | Procena trajanja MES projekta |
|---|---|
| **Tradicionalan rad, 3 senior bez AI-a** | **8–12 meseci** |
| **3 senior sa Cursor/Claude (kao Nenad)** | **5–7 meseci** ← targetiran scope |
| **3 senior, AI-first kultura, jak PO** | **4–5 meseci** ← optimistično |

**Zaključak:** Plan od 5 meseci u STRATEGIJA_MES_v0.1 je **realan AKO**:
1. Tim **stvarno koristi** AI-augmented workflow (ne samo da pita ChatGPT povremeno)
2. Nenad ostaje aktivan PO sa istim tempom
3. Negovan VBA logic je dostupna ili prevedena unapred
4. Scope se ne širi tokom puta
5. On-prem infra setup ne trpi rebound-e (npr. firewall problemi sa korporativnom mrežom)

Ako bilo koja od pretpostavki padne, **scope se mora seći**, ne pomerati datum.

---

## 6. Risk register za fazu pripreme

| # | Risk | Verovatnoća | Impact | Mitigacija |
|---|------|------------|---------|------------|
| R1 | Nenad nema 2–3h dnevno (operativni hitni zahtevi) | Srednja | Visok — produžava timeline | Block calendar slots, defer non-critical tasks |
| R2 | Negovan ne odgovara — VBA logic nedostupan | Visoka | Srednji — TBD u spec-ovima | Označiti ekspilcitno, prebaciti na tim za live debug |
| R3 | Identifikovani tim ima drugačiji stack preferences (npr. Java umesto NestJS) | Srednja | Mali — adapter sloj se prilagođava | Spec-ovi su tech-neutralni, kod se port-uje |
| R4 | BigBit detalji ostaju nejasni (Q1 iz STRATEGIJA_MES) | Visoka | Srednji — odlaže BigBit integraciju | Označiti kao Faza 2.5, ne blokira ostale module |
| R5 | Multi-tenant odluka se menja tokom pripreme | Niska | Visok — `tenant_id` u svim tabelama | Odluka **mora** biti gotova pre D1 |
| R6 | Nedostatak tehničkog validator-a (samo Nenad gleda) | Srednja | Srednji — moguće greške ostaju | Dry-run u buffer fazi sa neutralnom osobom |
| R7 | Screenshots zastarevaju ako produkcija evoluira | Niska | Mali | Capture batch-no u D2-D5 |
| R8 | Tim odbija da koristi naš materijal ("write from scratch") | Niska | Visok — gubitak svih ovih napora | Materijal mora biti evidentno korisan, ne nametnut |

---

## 7. Acceptance kriterijumi za handoff paket

Pre kick-off-a, paket je "ready" ako:

- [ ] `db_schema_baseline.sql` se primenjuje na praznu Postgres 16 bazu bez grešaka
- [ ] `db_seed_data.sql` se primenjuje posle baseline-a bez grešaka
- [ ] DEV environment se može podići iz README instrukcija za < 1h
- [ ] Svaki od 6 module spec dokumenata ima:
  - Business kontekst
  - Data model + link na konkretne tabele/RPC
  - Najmanje 5 user flow opisa
  - Najmanje 5 acceptance scenarija
  - Najmanje 5 screenshots
- [ ] RBAC matrix je sinhron sa baseline-om
- [ ] Audit pattern je opisan sa konkretnim primerom
- [ ] Bridge pattern dokumentovan (čak i ako se ne koristi odmah)
- [ ] Glossary u README pokriva sve domain-specific skraćenice
- [ ] Sav materijal je commit-ovan u `prep/handoff-package` branch
- [ ] Dry-run pokazao manje od 10 ozbiljnih komentara od neutralnog recenzenta

---

## 8. Otvorena pitanja (treba odgovor pre D1)

| # | Pitanje | Decision deadline |
|---|--------|-------------------|
| 1 | Multi-tenant od starta? (Q2 iz STRATEGIJA_MES) | **Pre D1** — utiče na DDL |
| 2 | Folder struktura handoff paketa OK? | Pre D1 |
| 3 | Jezik dokumentacije: srpski / engleski / oba? | Pre D2 |
| 4 | Da li tim dobija Git read access ovom repu? | Pre D6 (utiče na "spec only" sekcije) |
| 5 | Da li planiramo dry-run sa internim recenzentom? Ako da — ko? | Pre D7 |
| 6 | Da li handoff-package ide u zaseban repo ili ostaje u ovom? | Pre buffer faze |
| 7 | Negovan — finalna pozicija (uključen / nedostupan / ad-hoc)? | Što pre |
| 8 | BigBit informacije — kada planiramo da ih popunimo? | Pre kick-off-a sa timom |

---

## 9. Sledeći koraci

Ako ovaj plan odobravaš:

1. **Odluči o pitanjima u sekciji 8** (osnovne odluke)
2. **Kreiramo `handoff-package/` folder strukturu**
3. **Krećemo sa D1** (db baseline) prvog narednog radnog dana

Ako želiš izmene:
- Reduciraj ili proširi scope (sekcija 2)
- Promeni prioritet dnevnih deliverable-a
- Promeni format outputa (npr. Notion umesto Markdown)

**Sledeći očekivani dokument** (opciono): `04-handoff-package-template.md` — prazan template fajla za svaki od 17 deliverable-a, da se vidi struktura pre nego što se popunjavaju.
