# Strategija razvoja Servoteh MES — Faza 2

> **Status:** draft za internu diskusiju, verzija 0.1 (24. april 2026)
> **Autor:** Nenad Jaraković + AI asistent
> **Tip dokumenta:** Tehnički brief / RFP za eksterni razvojni tim
> **Cilj:** kompletna zamena BigTehn (MSSQL + Access) + integracija postojećih modula u jedinstven MES sistem na on-prem Postgres infrastrukturi
> **Vremenski okvir:** 5 meseci (Maj–Septembar 2026)
> **Tim:** 3 senior developer-a (eksterni) + Nenad kao Product Owner

---

## 0. OTVORENA PITANJA — moraju se odgovoriti pre kick-off-a

Sledeća pitanja su trenutno označena pretpostavkama u dokumentu (oznaka `[PRETPOSTAVKA: ...]`). Pre nego što se dokument preda timu, **mora** se odlučiti:

| # | Pitanje | Trenutna pretpostavka | Status |
|---|---------|----------------------|--------|
| Q1 | **BigBit — šta je tačno?** Vendor, format, API, sync smer | Sekcija 2.2 ima placeholder | OTVORENO |
| Q2 | **Multi-tenant od starta?** | (b) — multi-tenant aware, `tenant_id` u svim tabelama | POTVRDITI |
| Q3 | **5 meseci scope** — šta MORA biti GO-LIVE | MVP scope: 6 modula u prod, 2 odložena | POTVRDITI |
| Q4 | **Pravna struktura** — IP, repo, maintenance, SLA | Servoteh vlasnik koda, Git u Servoteh org-u | POTVRDITI |
| Q5 | **Acceptance owner po modulu** | Sekcija 8.3 ima placeholder po imenima | DOPUNITI |
| Q6 | **Negovan Vasić** — saradnja na prevodu Access VBA | Pretpostavka: nedostupan, Nenad pomaže | POTVRDITI |
| Q7 | **Naziv proizvoda** — Servoteh MES ili novo komercijalno ime | "Servoteh MES" interno, finalno ime do 01.06.2026 | OTVORENO |

---

## 1. Executive summary

Servoteh trenutno koristi tri sistema paralelno: **BigTehn** (MSSQL + Access UI, 10+ godina, proizvodne pozicije), **BigBit** (komercijalni magacin i šifarnici delova), i **Servoteh moduli** (web, Supabase, 5 modula u produkciji). Cilj projekta je da se BigTehn **u potpunosti zameni** modernim MES sistemom, a postojeći Servoteh moduli **integrišu u isti sistem**, na **on-prem Postgres** infrastrukturi.

**Šta jeste u scope-u Faze 2:**
- Kompletan MES — radni nalozi, tehnološki postupak, kontrola kvaliteta, magacin proizvodnih pozicija, plan proizvodnje, lokacije
- Re-build postojećih 5 Servoteh modula (Plan Montaže, Kadrovska, Lokacije, Održavanje, Podešavanja) na novom stack-u
- Mobilna aplikacija (rebuild from scratch)
- Migracija podataka iz BigTehn MSSQL i postojeće Supabase baze
- Read-only sync sa BigBit-om za šifarnike delova i komercijalni magacin

**Šta NIJE u scope-u Faze 2:**
- ERP funkcionalnosti (GL, PDV, AP/AR, platni spisak) — ostaju u BigBit-u, predviđeno za Fazu 3 (2028+)
- Komercijalni magacin (BigBit) — ostaje na svom mestu
- Migracija na cloud — sve ostaje on-prem

**Tehnička strategija:**
- **Baza**: Postgres na Servoteh serveru (on-prem)
- **Frontend**: Next.js 15 (App Router) + TypeScript
- **Backend**: tehnologijski neutralno — tim predlaže (NestJS, .NET, Fastify, drugo)
- **Mobile**: Capacitor wrapper oko iste web aplikacije + native barcode scanner
- **Auth**: predlog Auth.js (NextAuth) sa Postgres adapter-om, kartice + telefon check-in
- **Migracija strategija**: novi sistem postaje izvor istine **od starta**, BigTehn MSSQL postaje read-only arhiva

**Tim**: 3 senior eksterna developer-a, Nenad kao Product Owner i nadzorni arhitekta.

**Krajnji rezultat**: 0 korisnika na BigTehn-u/Access-u za pogonsku operativu do 01.10.2026.

---

## 2. Trenutno stanje sistema u Servotehu

### 2.1 BigTehn (MSSQL + Access)

| Komponenta | Status | Karakteristike |
|---|---|---|
| MSSQL baza | ~4 GB, u produkciji 10+ godina | 67+ tabela, dokumentovana u `docs/SUPABASE_PUBLIC_SCHEMA.md` (cache deo) |
| Access UI | 5+ modula, desktop-only | Windows-only, autor Negovan Vasić |
| Vlasništvo schema | Servoteh ima MSSQL schemu | Business pravila u Access VBA kodu (Q6) |

**Šta BigTehn pokriva**:
- Šifarnici proizvodnih pozicija
- Radni nalozi (RN), stavke RN-a, saglasnosti, lansiranja
- Tehnološki postupak (operacije, mašine, vremena)
- Tehnologijska kontrola kvaliteta
- Magacin **samo proizvodnih pozicija** (komponente, sklopovi, gotovi proizvodi)
- Audit trail (dnevnik, revizije)

### 2.2 BigBit `[PRETPOSTAVKA — Q1]`

> **TODO**: Nenad mora da popuni ovu sekciju sa detaljima o BigBit sistemu pre handoff-a.
>
> Tipično očekivane informacije za novi tim:
> - Vendor i verzija BigBit-a
> - Tip baze (MSSQL, Oracle, druga?)
> - Da li ima REST API, SOAP, ili samo SQL pristup
> - Sync smer ka MES-u (read-only, jednosmerno BigBit→MES)
> - Frequency sync-a (real-time, hourly batch, daily batch)
> - Kontakt vendor-a / podrške ako su potrebna pojašnjenja
> - Koji business procesi prelaze preko BigBit-a (samo magacin delova ili i drugo)

**Šta BigBit pokriva (potvrđeno)**:
- Komercijalni magacin (delovi, materijal, repromaterijal)
- Šifarnici artikala / delova
- `[PRETPOSTAVKA]` Eventualno: ulazne fakture, dobavljači, narudžbenice — Nenad da potvrdi

**Šta BigBit NE pokriva**:
- Proizvodne pozicije (to je u BigTehn-u)
- Radne naloge i tehnologiju (BigTehn)
- Pogonsku operativu (BigTehn)

### 2.3 Servoteh moduli (postojećih 5 + 1)

Trenutni repozitorijum: `servoteh-plan-montaze` (Vite + vanilla JavaScript + Supabase).

| Modul | Korisnici | Stanje |
|---|---|---|
| Plan Montaže | PM, leadpm, menadžment | Aktivan, projekti se vode |
| Kadrovska | HR, admin | Aktivan |
| Lokacije delova | Magacioneri, tehnolozi | Aktivan, mobilno radi |
| Održavanje mašina | Šef održavanja, admin | Aktivan |
| Podešavanja | Admin | Aktivan |
| Sastanci | Menadžment | Najnoviji modul |

**Tehnička osnova**:
- Frontend: Vite + vanilla JS (bez React/TS)
- Backend: Supabase Cloud (Postgres + PostgREST + Auth + Storage)
- Mobile: PWA + Capacitor (Android APK, iOS sideload)
- Sync sa MSSQL-om: Node.js worker (`workers/loc-sync-mssql`)
- Sigurnost: 90 RLS politika, 48 SECURITY DEFINER funkcija, audit log
- Deploy: Cloudflare Pages

**Šta se zaključava 01.05.2026** (kraj Faze 1, Nenadova završna isporuka): vidi sekciju 15 (Handoff Package).

### 2.4 Postojeći developerski materijal (predaje se timu)

Iz `servoteh-plan-montaze` repo-a, `docs/` direktorijum:
- `STRATEGIJA_ERP.md` — prethodna strategija (zastareva, zameniti ovim dokumentom)
- `SECURITY.md` — bezbednosna pozicija i obrasci
- `RBAC_MATRIX.md` — auto-generisana matrica uloga (90 politika)
- `SUPABASE_PUBLIC_SCHEMA.md` — schema dump
- `Plan_montaze_modul.md`, `Kadrovska_modul.md`, `Lokacije_modul.md`, `Planiranje_proizvodnje_modul.md` — dokumentacija po modulu
- `MOBILE.md` — mobilna arhitektura
- `notes.md` — operativne beleške
- `CLAUDE_PROJECT_INSTRUCTIONS.md` — instrukcije za AI agente (može biti referenca i za novi projekat)

---

## 3. Cilj Faze 2 — obim i kriterijumi uspeha

### 3.1 Šta JESTE u scope-u

| # | Stavka | Prioritet | Mesec ciljni |
|---|--------|-----------|--------------|
| 1 | Postgres on-prem + infra (backup, monitoring, deploy) | P0 | M1 |
| 2 | Schema + auth + RBAC | P0 | M1–M2 |
| 3 | Šifarnici (proizvodne pozicije, radnici, mašine, operacije, kupci) | P0 | M2 |
| 4 | Lokacije delova (re-build sa proširenjima) | P0 | M2 |
| 5 | Plan Proizvodnje (re-build) | P0 | M3 |
| 6 | Radni nalozi (NEW — paritet sa BigTehn-om) | P0 | M3 |
| 7 | Tehnološki postupak + Kontrola kvaliteta | P0 | M3–M4 |
| 8 | Magacin proizvodnih pozicija (NEW — paritet sa BigTehn-om) | P0 | M4 |
| 9 | Mobilna aplikacija (Lokacije, RN, QC) | P0 | M4 |
| 10 | Plan Montaže (re-build iz vanilla JS) | P1 | M4 |
| 11 | Održavanje mašina (re-build) | P1 | M5 |
| 12 | Kadrovska (re-build) | P1 | M5 |
| 13 | Sastanci (re-build) | P2 | M5 ako stigne |
| 14 | BigTehn MSSQL → Postgres data migracija (one-off) | P0 | M2 |
| 15 | BigBit sync (read-only) | P0 | M2–M3 |
| 16 | Audit, monitoring, izveštavanje | P0 | M5 |

### 3.2 Šta NIJE u scope-u

Eksplicitno isključeno iz Faze 2 (da se izbegne scope creep):

- ❌ Glavna knjiga, knjiženja, GL — Faza 3
- ❌ PDV, regulatorni obračuni — Faza 3 (ostaje BigBit / drugi sistem)
- ❌ Ulazne i izlazne fakture (AR/AP) — ostaje u BigBit-u
- ❌ Platni spisak — Faza 3 (ili specijalizovani vendor)
- ❌ Osnovna sredstva, amortizacija — Faza 3
- ❌ E-fakture (SEF) integracija — Faza 3
- ❌ Bank integracije, NBS kursevi — Faza 3
- ❌ Komercijalni magacin (delovi, repromaterijal) — ostaje BigBit
- ❌ CRM, prodaja, ponude — van scope-a, eventualno Faza 3
- ❌ BI / data warehouse / izveštajni cube — eventualno Faza 3
- ❌ Cloud deploy — sve ostaje on-prem; cloud opciono kasnije

### 3.3 Kriterijumi uspeha (merljivi KPI)

Po završetku Faze 2 (cilj 30.09.2026):

| # | KPI | Cilj | Merenje |
|---|-----|------|---------|
| 1 | Korisnika na Access-u za pogonsku operativu | **0** | Anketa svih korisnika |
| 2 | RN otvaranje, vreme radnje | < starog Access-a | Time-tracking pre/posle |
| 3 | Magacioner unos lokacije | < 15 sek po stavci | Telemetrija mobilne app |
| 4 | QC kontrolor unos rezultata | 100% u istom danu | Izveštaj po danima |
| 5 | Dashboard za 500 RN-a | < 3 sek | Performance test |
| 6 | Mobilni dashboard za gazdu | update < 5 sek | Telemetrija |
| 7 | Uptime sistema | ≥ 99.5% radnih sati | Monitoring |
| 8 | Test coverage | ≥ 70% backend, ≥ 50% frontend | CI |
| 9 | Migrirano podataka iz BigTehn-a | 100% RN-a, šifarnika, lokacija | Validacioni report |
| 10 | Acceptance signoff | 6/6 P0 modula potpisano od strane key user-a | Sekcija 8.3 |

---

## 4. Arhitekturna preporuka

> **Napomena**: Ova sekcija je **savetodavna**. Tim donosi konačnu tehničku odluku, uz Nenadovu saglasnost na arhitekturne preseke. Tehnologijski neutralno tamo gde je naznačeno.

### 4.1 Slojevi sistema

```
┌─ KORISNICI ──────────────────────────────────────────────────────┐
│                                                                  │
│  Desktop (kompovi u kancelariji)    Mobilno (telefoni hala)      │
│      │                                  │                        │
│      └──────────────┬───────────────────┘                        │
│                     ▼                                            │
│              Web pregledač / Capacitor wrapper                   │
└─────────────────────┬────────────────────────────────────────────┘
                      │ HTTPS (TLS 1.3)
                      ▼
┌─ FRONTEND APP ───────────────────────────────────────────────────┐
│  Next.js 15 (App Router) + TypeScript 5.5+                       │
│  React 19 + Tailwind CSS v4 + shadcn/ui                          │
│  React Hook Form + Zod (forme + validacija)                      │
│  TanStack Table v8 (tabele) + TanStack Query v5 (cache)          │
│  Hostuje se na Servoteh serveru (Node.js / Docker)               │
└─────────────────────┬────────────────────────────────────────────┘
                      │ REST / RPC, JSON, JWT
                      ▼
┌─ BACKEND SERVIS ─────────────────────────────────────────────────┐
│  [Tehnologijski neutralno — tim predlaže]                        │
│  Predlozi: NestJS (Node), .NET 8, Fastify, ili kombinacija       │
│  Odgovornosti:                                                   │
│   - Autentifikacija (JWT issuance, refresh, kartice, telefon)    │
│   - Autorizacija (RBAC, multi-tenant)                            │
│   - Business logika (RN workflow, MRP izračuni, planer)          │
│   - Validacija + transformacija                                  │
│   - Sync orkestracija (BigTehn migracija, BigBit pull)           │
│   - File storage proxy (potpisani URL-ovi)                       │
│   - Audit attribution                                            │
└─────────────────────┬────────────────────────────────────────────┘
                      │ Postgres protokol (TLS), connection pool
                      ▼
┌─ POSTGRES (on-prem) ─────────────────────────────────────────────┐
│  PostgreSQL 16 ili 17 (najnovija stable)                         │
│  Docker container ili native                                     │
│  - Schema: javna + audit + sync                                  │
│  - RLS kao defense-in-depth (backend ima service role)           │
│  - Trigger-based audit log                                       │
│  - pg_cron za scheduled task-ove                                 │
│  - Logical replication ka read-replici (opciono)                 │
│                                                                  │
│  File storage: MinIO (S3-compatible) ili filesystem + nginx      │
└──────────────────────────────────────────────────────────────────┘

┌─ INTEGRACIJE (eksterni sistemi) ─────────────────────────────────┐
│                                                                  │
│  BigTehn MSSQL  →  one-off migracija (M2), zatim read-only arhiva│
│  BigBit         →  read-only sync (cron, period TBD u Q1)        │
│  Email (SMTP)   →  servisni nalog za notifikacije                │
│  Telefoni (FCM/APNS) → push notifikacije za mobilnu              │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 Postgres on-prem

**Verzija**: PostgreSQL 16 ili 17 (najnovija stabilna sa LTS podrškom).

**Deployment opcije** (tim odlučuje):
- (a) Native instalacija na Windows Server (vaš trenutni standard)
- (b) Docker container na Windows Server
- (c) Linux VM (Ubuntu LTS) sa Postgres native ili Docker

**Preporuka**: (c) **Linux VM sa Docker-om**. Razlozi:
- Postgres na Linux-u je standard, više dokumentacije, više resursa za rešavanje problema
- Docker daje izolaciju, lakšu nadogradnju, ponovljiv setup
- VM može da živi na vašem Windows host-u (Hyper-V, VMware), IT infrastruktura ostaje ista

**Konfiguracija (orijentaciono)**:
- 8 GB RAM minimum (16 GB preporučeno za prvih 100 korisnika)
- 4 CPU core
- 100 GB SSD za bazu (rast: ~1-2 GB mesečno)
- Posebna particija za WAL logove
- `shared_buffers = 2GB`, `effective_cache_size = 6GB`, `work_mem = 16MB` (početne vrednosti, podesiti)

**Backup strategija** (kritično):
- **Daily logical backup** (`pg_dump`) na NAS / drugu mašinu
- **WAL archiving** za point-in-time recovery (PITR)
- **Off-site** backup minimum 1× nedeljno na fizički odvojenoj lokaciji (ili enkriptovano u cloud, npr. Backblaze B2 — $5/TB/mes)
- **Disaster recovery drill** — minimum 2× godišnje, dokumentovano
- **Retention**: 30 dana daily, 1 godina monthly, 5 godina annual

**Monitoring**:
- pg_stat_statements za query analizu
- Prometheus + Grafana ili Uptime Kuma za uptime
- Alert na: disk > 80%, replikacija lag > 5min, Postgres down, dump failed

### 4.3 Frontend: Next.js

**Stack** (potvrđeno):
- Next.js 15 sa App Router
- TypeScript 5.5+, strict mode
- React 19
- Tailwind CSS v4 + shadcn/ui (copy-paste komponente)
- React Hook Form + Zod za validaciju
- TanStack Query v5 za data fetching i cache
- TanStack Table v8 za tabele
- Zustand za minimalan global state

**Patterns**:
- Server Components za read-heavy stranice (listing, dashboard) — backend dev model
- Client Components samo gde stvarno treba (input, modal, drag-drop)
- Server Actions za jednostavne mutacije
- API routes / route handlers za složeniju logiku
- File structure: `app/`, `components/`, `lib/`, `services/`, `types/`

**Deployment**:
- Docker container, hostuje se na Servoteh serveru
- Nginx kao reverse proxy + TLS termination
- Domena: `[PRETPOSTAVKA] mes.servoteh.local` interno, eventualno `mes.servoteh.com` ako treba spoljni pristup preko VPN-a

### 4.4 Backend servis (tehnologijski neutralno)

Tim predlaže stack. Sledeći zahtevi su obavezni bez obzira na izbor:

**Funkcionalni zahtevi**:
- REST API sa OpenAPI 3.0 dokumentacijom (auto-generisanom)
- JWT autentifikacija (HS256 ili RS256)
- Connection pool ka Postgresu (min 10, max 50 konekcija)
- Async/await pattern (ili asinhrono ekvivalent u izabranom jeziku)
- Strukturirano logovanje (JSON format) sa correlation ID-om
- Health check endpoint (`/health`, `/ready`)
- Graceful shutdown (drain konekcija pre zatvaranja)
- Migration framework za Postgres schema (Flyway, Liquibase, Prisma Migrate, Knex, ili native u jeziku)

**Predlozi (tim bira)**:

| Stack | Pro | Con |
|---|---|---|
| **NestJS (Node + TS)** | Najbliži Next.js-u (deljeni TS tipovi), strukturiran, decoratori, DI | Node ekosistem, jedna tehnologija u celom sistemu |
| **.NET 8 (C#)** | Najjači u enterprise, ozbiljan tooling, performanse | Drugi jezik od front-a, dual-skill tim |
| **Fastify (Node)** | Manji od NestJS-a, brži, fleksibilan | Manje konvencija, treba pisati strukturu |
| **Go (Gin/Echo)** | Najbrže performanse, mali deployment binary | Treći jezik, manji hiring pool |

**Moja preporuka**: NestJS, jer (1) tim drži samo jednu tehnologiju (Node + TS i u front-u i u back-u), (2) deljeni tipovi između front-a i back-a su prirodna prednost, (3) Postgres adapter (TypeORM, Prisma, Drizzle) je sazreo. Ali tim odlučuje.

### 4.5 Auth + RBAC

**Identitet** (kako se korisnik prijavljuje):
- Email + lozinka (default)
- ID kartica (HID reader emulacija tastature) — postojeći obrazac, prebacuje se
- Telefon check-in — novi: korisnik skenira QR sa monitora ili ID kartice, app na njegovom telefonu se ulogovala, zna se ko radi šta

**Predlog tehnologije**:
- **Auth.js (NextAuth) sa Postgres adapter-om** — najbliže Next.js-u, sesije u Postgres bazi, podržava Credentials provider (kartice), Email magic link, OAuth (ako kasnije treba SSO)
- Alternative: Keycloak (enterprise ali težak), Authentik (modernije), Ory Kratos (modular), custom JWT (najveća kontrola)

**Uloge** (preuzeto iz postojećeg `user_roles` + prošireno):

| Uloga | Pristup |
|---|---|
| `admin` | Sve, uključujući user management, audit, sistemska podešavanja |
| `menadzment` | Read-write na operativu, read-all na izveštaje |
| `leadpm` | Vodi projekte, planira, dodeljuje |
| `pm` | Project manager za svoje projekte |
| `tehnolog` | RN, TP, QC, PDM |
| `magacin` | Lokacije, magacin (NEW), izdavanja |
| `qc` | Kontrola kvaliteta |
| `odrzavanje` | Održavanje mašina |
| `hr` | Kadrovska |
| `viewer` | Read-only |

**Multi-tenant** (Q2):
- Predlog: dodati `tenant_id` u SVAKU domain tabelu (osim sistemskih)
- RLS politike sve filtriraju po `tenant_id = current_setting('app.tenant_id')`
- Backend setuje session variable po prijavljenom korisniku
- Početni tenant: `servoteh` (UUID)

**Audit**:
- Trigger-based, append-only `audit_log` tabela
- Kolone: `id`, `tenant_id`, `actor_email`, `actor_role`, `action`, `entity_type`, `entity_id`, `before`, `after`, `created_at`, `correlation_id`
- Backend prosleđuje `actor_email` kroz session variable ili header
- Postojeći obrazac iz `docs/SECURITY.md` (X-Audit-Actor) se prenosi

### 4.6 Server, deploy, backup, monitoring

**Server (Servoteh on-prem)**:
- Windows Server kao host (postojeći standard)
- Hyper-V VM-ovi za izolaciju:
  - VM1: Postgres (Linux Ubuntu 22/24)
  - VM2: Backend + Frontend (Linux ili Windows, Docker)
  - VM3: MinIO (storage) ili filesystem na host-u
  - VM4: Monitoring (Prometheus + Grafana, opciono)
- UPS, RAID, redundansa napajanja — postojeće
- Backup već radi — proširiti na novi Postgres dump i MinIO dump

**Pristup**:
- VPN obavezan za sve eksterne korisnike
- LAN za interne
- Eksterni dev tim dobija pristup samo jednoj VM-u (DEV environment), ne produkciji
- Nenad ima admin pristup svuda
- IT firma + interni IT admin održavaju host

**Environments**:
- **DEV** — eksterni tim radi, baza sa lažnim podacima
- **STAGING** — Nenad i key users testiraju, baza sa pravim ali starim podacima (ne najnovijim)
- **PROD** — produkcija, samo Nenad + IT admin imaju pristup za deploy

**CI/CD**:
- Git repo na Servoteh GitHub Org-u (ili self-host GitLab/Gitea)
- GitHub Actions (ili ekvivalent) za:
  - Lint, typecheck, unit test na svaki PR
  - pgTAP testovi za RLS i funkcije baze
  - E2E testovi (Playwright) na merge u main
  - Build Docker image-a, push na registry
  - Auto-deploy na DEV iz `main` brane
  - Manual approval za STAGING i PROD

---

## 5. Schema strategija

### 5.1 Tri input-a u dizajn schema-e

1. **BigTehn MSSQL schema** — postojeća, dokumentovana u `script.sql` i `docs/SUPABASE_PUBLIC_SCHEMA.md` (cache deo). 67 tabela, 10 godina istorije.
2. **Postojeća Supabase schema** — Servoteh moduli (Plan Montaže, Lokacije, Kadrovska, Održavanje, Sastanci). 90 RLS politika.
3. **Business pravila iz Access VBA** — koja **nisu** u SQL schemi nego u VBA kodu Access UI-a. Ovo je rizik (Q6 — Negovan).

### 5.2 Pristup: from-scratch sa migracijom podataka

Schema se piše **od nule** (Q3 odluka), uz sledeće principe:

**Imenovanje (konvencije)**:
- `snake_case` za sve (tabele, kolone, funkcije)
- Tabele u množini: `work_orders`, `tech_routings`, `quality_checks`
- Bez prefiksa `tbl_`, `tk_`, `t` (čisto, moderno)
- Eventualno schema separation: `core.`, `mes.`, `audit.`, `sync.`

**Standardne kolone** (svaka domain tabela):
- `id` UUID (gen_random_uuid()) ili `bigint` generated identity
- `tenant_id` UUID (Q2 — multi-tenant)
- `created_at` timestamptz NOT NULL DEFAULT now()
- `created_by` UUID (FK ka users)
- `updated_at` timestamptz
- `updated_by` UUID
- `deleted_at` timestamptz (soft delete)

**Migracija podataka** (jednokratna, tokom M2):
- Skripte za ETL iz BigTehn MSSQL → Postgres novi sistem
- Skripte za ETL iz postojeće Supabase → Postgres novi sistem
- Validacioni report: koliko redova migrirano, koliko grešaka, koje su mape
- Rollback strategija: ako migracija ne uspe, vraćamo se na BigTehn + Supabase do sledećeg pokušaja

**Migrations framework**:
- Sve schema promene u verzionisanim SQL fajlovima
- Alat: tim bira (Flyway, Liquibase, Prisma Migrate, Drizzle Kit, native)
- Migracije obavezno reverzibilne gde god je moguće
- Code review obavezan za svaku migraciju (Nenadovo odobrenje za production)

### 5.3 Multi-tenant odluka (Q2)

**Preporuka**: Multi-tenant aware od starta.

| Pristup | Pro | Con | Preporuka |
|---|---|---|---|
| **Single-tenant** | Najjednostavnije sada | Rebuild ako se otvore klijenti | ❌ Skupo dugoročno |
| **`tenant_id` u svim tabelama + RLS** | Mali dodatni napor sada (1-2 nedelje), nula rebuild kasnije | Treba pažnje sa indeksima | ✅ **Preporučeno** |
| **Schema-per-tenant** | Najjača izolacija | Kompleksno za migracije, deploy | ❌ Premoćno za sada |
| **DB-per-tenant** | Maksimalna izolacija | Operativno teško, skupo | ❌ Možda za enterprise klijente kasnije |

Konkretno:
- Svaka domain tabela ima `tenant_id UUID NOT NULL`
- Index `(tenant_id, ...)` na svakoj relevantnoj koloni
- RLS politika: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`
- Backend postavlja `SET LOCAL app.tenant_id = ...` na početku svake transakcije
- Sistemske tabele (users, audit) imaju `tenant_id` ili su kros-tenant (audit kros-tenant sa indeksom)

---

## 6. Mapa modula

### 6.1 BigTehn paritet (preuzima se funkcionalnost)

| Modul | BigTehn naziv | Novi naziv | Kompleksnost | Mesec |
|---|---|---|---|---|
| Šifarnici | tRadnici, tOperacije, tPozicije, tRJ, tKupci... | `core.workers`, `core.operations`, `core.positions`... | Srednja (15+ tabela) | M2 |
| Radni nalozi | tRN, tStavkeRN, tSaglasanRN, tLansiranRN | `mes.work_orders`, `mes.work_order_lines` | Visoka (workflow) | M3 |
| Tehnološki postupak | tTehPostupak, tTehPostupakDokumentacija | `mes.tech_routings` | Visoka | M3 |
| Kontrola kvaliteta | Nalepnice, tLokacijeDelova | `mes.quality_checks`, `mes.quality_labels` | Srednja | M3-M4 |
| Magacin proizvodnih pozicija | T_Robna dokumenta, T_Robne stavke | `mes.warehouse_documents`, `mes.warehouse_lines` | Visoka (transakcije) | M4 |
| PDM (crteži) | PDMCrtezi, SklopoviPDMCrteza | `mes.drawings`, `mes.drawing_assemblies` | Srednja | M4 |
| Plan montaže (BigTehn deo) | T_Planer | `mes.production_plan` | Srednja | M3 |

### 6.2 Servoteh moduli koji se preuzimaju

Re-build iz vanilla JS u Next.js + TS. Funkcionalnost ostaje, schema se redizajnira.

| Postojeći modul | Repo path | Novi modul | Mesec |
|---|---|---|---|
| Plan Montaže | `src/ui/planMontaze/` | `mes.assembly_plan` | M4 |
| Kadrovska | `src/ui/kadrovska/` | `core.hr` | M5 |
| Lokacije | `src/ui/lokacije/` | `mes.locations` | M2 (rano, mobilno!) |
| Održavanje | `src/ui/odrzavanje/` | `mes.maintenance` | M5 |
| Podešavanja | `src/ui/podesavanja/` | `core.settings` | M1 |
| Sastanci | `src/ui/sastanci/` | `core.meetings` | M5 (P2) |
| Plan Proizvodnje | `src/ui/planProizvodnje/` | `mes.production_plan` (sa BigTehn delom) | M3 |

### 6.3 Novi moduli (nisu postojali ranije)

| Modul | Opis | Mesec |
|---|---|---|
| Mobilna app | Magacioner skeniranje, RN status, QC unos | M4 |
| Dashboard za gazdu | KPI, real-time metrike | M5 |
| Notifikacije | Email + push (mobilno) | M5 |
| Audit pretraživač | UI nad audit log-om | M5 |

### 6.4 Šta NE preuzimamo

- ❌ BigBit komercijalni magacin → ostaje BigBit, samo read-only sync
- ❌ BigTehn finansije (ako uopšte ima) → ostaje gde je, ili migrira u Fazi 3
- ❌ Access UI → gasi se kad svaki modul izađe na novom sistemu

---

## 7. Roadmap — 5 meseci, mesečne milestone

### Mesec 1 (Maj 2026) — TEMELJI

**Cilj**: infrastruktura radi, prvi modul počinje.

- [ ] Server postavljen, Postgres radi, backup verifikovan
- [ ] Git repo, CI/CD, DEV environment dostupan timu
- [ ] Auth + RBAC schema, osnovne uloge
- [ ] Schema baseline (`tenant_id`, audit, common columns)
- [ ] Podešavanja modul (najmanji, prvi koji izlazi)
- [ ] Konvencije dokumentovane (`docs/CONVENTIONS.md` u repo-u)
- [ ] DR drill — restore baze iz dump-a uspeo

**Kriterijum**: tim ima 100% radan setup, prvi PR-ovi merge-uju se na main.

### Mesec 2 (Juni 2026) — ŠIFARNICI + LOKACIJE

**Cilj**: temelji svega + prvi production modul.

- [ ] Šifarnici (radnici, operacije, pozicije, mašine, kupci) migrirani iz BigTehn-a
- [ ] BigTehn one-off data migracija završena, validovana
- [ ] BigBit sync (read-only) radi
- [ ] **Lokacije delova** — production-ready, 5 magacionera prebačeno
- [ ] Mobilna app (Lokacije deo) — APK i iOS instalisano na 5 telefona

**Kriterijum**: magacioneri ne otvaraju Access za lokacije.

### Mesec 3 (Juli 2026) — RADNI NALOZI + TEHNOLOGIJA

**Cilj**: srce proizvodnje radi.

- [ ] Radni nalozi (otvaranje, saglasnost, lansiranje) — production
- [ ] Tehnološki postupak — production
- [ ] Kontrola kvaliteta (osnova) — production
- [ ] Plan Proizvodnje — production
- [ ] Plan Montaže — production (rebuild iz vanilla JS)

**Kriterijum**: tehnolog otvara RN u novom sistemu, PM vodi projekat.

### Mesec 4 (Avgust 2026) — MAGACIN + MOBILNO + KVALITET

**Cilj**: pogon kompletan.

- [ ] Magacin proizvodnih pozicija — production
- [ ] PDM crteži — production
- [ ] Mobilna app (RN, QC tabovi) — production
- [ ] QC napredne funkcije (nalepnice, izveštaji)

**Kriterijum**: jedna smena 100% na novom sistemu, niko se ne vraća na Access.

### Mesec 5 (Septembar 2026) — OSTALO + GO-LIVE

**Cilj**: finalizacija, sve smene prelaze.

- [ ] Kadrovska — production
- [ ] Održavanje mašina — production
- [ ] Sastanci — production (ako stigne, P2)
- [ ] Dashboard za gazdu — production
- [ ] Notifikacije, audit pretraživač
- [ ] Sve smene prelaze na novi sistem
- [ ] BigTehn / Access se gase
- [ ] Stari Servoteh moduli (vanilla JS) se gase, korisnici migrirani

**Kriterijum**: 0 korisnika na Access-u, 0 korisnika na starim modulima, sistem stabilan 2 nedelje bez kritičnih bug-ova.

### Posle Faze 2 (oktobar 2026+)

- Stabilizacija, hot-fix-evi
- Korisnička obuka, dokumentacija
- Eventualno Sastanci (ako nije završen)
- Početak diskusije o Fazi 3 (pravi ERP, GL, finansije)

---

## 8. Tim i odgovornosti

### 8.1 Eksterni razvojni tim (3 senior dev-a)

`[PRETPOSTAVKA Q4 — pravna struktura ostaje da se definiše]`

**Profil tima** (potvrđeno):
- Ozbiljno iskustvo sa Next.js (App Router)
- Ozbiljno iskustvo sa Postgres
- Ozbiljno iskustvo sa Docker
- DevOps imaju rešenje (eksterno ili u timu)

**Predlog podele odgovornosti**:

| Dev | Glavna oblast | Sekundarno |
|---|---|---|
| **Dev A (lead)** | Backend arhitektura, auth, RBAC, schema | Code review, deploy, technical decisions |
| **Dev B** | MES core (RN, TP, QC, magacin) | Backend API conventions |
| **Dev C** | Frontend, mobilno, UI library | Plan Montaže, Lokacije UI |

Svaki dev ima jedan **horizontalni stub** (preseca ceo projekat):
- Dev A: infra (Postgres tuning, backup, monitoring, CI/CD)
- Dev B: data layer (schema, migracije, indeksi, performanse)
- Dev C: UI komponente (shadcn customizacije, design system, mobilno)

### 8.2 Nenadova uloga (Product Owner)

**ŠTA RADIM**:
- Definišem **šta** se gradi (scope, prioriteti, modul po modul)
- Pišem acceptance kriterijume za svaki modul
- Potvrđujem release-ove na PROD (manual approval u CI)
- Vodim komunikaciju sa key user-ima (tehnolog, magacioner, šef)
- Čuvam i ažuriram ovaj dokument
- Code review na arhitekturne PR-ove (schema, auth, security), ne na svaki PR

**ŠTA NE RADIM**:
- Ne pišem produktivni kod (osim eventualno demonstrativnih primera)
- Ne odlučujem tehnički stack u backend-u (tim odlučuje, ja samo verifikujem)
- Ne odlučujem stilove koda, framework-e, biblioteke (tim odlučuje)
- Ne kontaktiram tim svaki dan — strukturiran komunikacioni ritam (sekcija 17)

### 8.3 Servoteh interni stakeholders + acceptance owners (Q5)

`[PRETPOSTAVKA — Nenad da popuni imena]`

| Modul | Acceptance owner | Kontakt |
|---|---|---|
| Šifarnici | `[Ime]` | `[email]` |
| Lokacije | `[Magacioner — ime]` | `[email]` |
| Plan Proizvodnje | `[Tehnolog — ime]` | `[email]` |
| Radni nalozi | `[Tehnolog ili PM]` | |
| Tehnološki postupak | `[Tehnolog]` | |
| Kontrola kvaliteta | `[QC kontrolor — ime]` | |
| Magacin | `[Magacioner za proizvodne pozicije]` | |
| PDM | `[Tehnolog ili konstruktor]` | |
| Plan Montaže | `[Lead PM]` | |
| Kadrovska | `[HR osoba]` | |
| Održavanje | `[Šef održavanja]` | |
| Mobilno | `[Magacioner — testira u hali]` | |
| Dashboard | **Gazda** | |
| Sve | **Nenad** (final signoff) | |

### 8.4 Pomoćni timovi

- **IT firma + interni IT admin**: održavaju server, backup, network, VPN
- **Nenad**: prevod business pravila iz Access VBA (Q6 — ako Negovan ne sarađuje)
- **Negovan Vasić** (autor BigTehn-a): `[PRETPOSTAVKA Q6: nedostupan]` — Nenad pokriva pojašnjenja

---

## 9. Konvencije razvoja (obavezne)

### 9.1 Schema konvencije

**Imenovanje**:
- Tabele: `snake_case`, množina (`work_orders`, ne `tWorkOrder`)
- Kolone: `snake_case` (`created_at`, ne `createdAt` ili `CreatedAt`)
- FK kolone: `<entity>_id` (`worker_id`, `work_order_id`)
- Boolean: `is_*` ili `has_*` (`is_active`, `has_approval`)
- Timestamp: `*_at` (`created_at`, `started_at`)
- Date: `*_date` (`due_date`)

**Tipovi**:
- ID: `bigint generated identity` ili `uuid` (tim odlučuje, doslednost obavezna)
- Tekst: `text`, ne `varchar(N)` (osim ako stvarno postoji ograničenje)
- Novac: `numeric(15,4)` (4 decimale za interne kalkulacije)
- Vremena: uvek `timestamptz` (sa vremenskom zonom)

**Obavezne kolone na svakoj domain tabeli**:
```sql
id, tenant_id, created_at, created_by,
updated_at, updated_by, deleted_at
```

**Indeksi**: obavezni na FK, na `(tenant_id, ...)` za multi-tenant scan, na pretražne kolone.

### 9.2 Migracije

- Svaka schema promena ide kao **verzionisani SQL fajl** u `migrations/` direktorijumu
- Imenovanje: `YYYYMMDDHHMM_description.sql`
- **Nepotpisane** migracije se ne deploy-uju na PROD (Nenad potpisuje)
- Migracije moraju biti **idempotentne** ako je moguće (`IF NOT EXISTS`, `ON CONFLICT`)
- **Reverzibilnost**: gde god je moguće, ima i down migracija
- **Code review**: minimum 1 dev odobri, Nenad za PROD

### 9.3 Backend API

**REST konvencije**:
- `/api/v1/<resource>` — verzionisanje obavezno
- HTTP metode: GET (read), POST (create), PATCH (update), DELETE (soft delete)
- Response format JSON, uvek omotan: `{ "data": ..., "meta": ... }` ili `{ "error": ... }`
- Error format: `{ "error": { "code": "...", "message": "...", "details": [...] } }`
- Status kodovi: 200 OK, 201 Created, 400 validation, 401 auth, 403 forbidden, 404 not found, 409 conflict, 422 unprocessable, 500 server error

**RPC konvencije** (gde se koriste):
- `/api/v1/rpc/<action_name>` — POST sa JSON body
- Action u snake_case glagol: `approve_work_order`, `transfer_inventory`

**Autentifikacija**:
- JWT u Authorization header (`Bearer <token>`)
- Token expiration: 1h, refresh token 30d
- Logout invalidira refresh token

**OpenAPI**:
- Auto-generisana spec na `/api/v1/openapi.json`
- Swagger UI na `/api/v1/docs` (samo u DEV)

### 9.4 Frontend

- TypeScript strict mode
- ESLint + Prettier konfigurisani, CI fail ako lint padne
- Komponente u `components/` (shared) ili `app/<route>/_components/` (route-specific)
- Forme uvek sa React Hook Form + Zod schema
- Tabele uvek sa TanStack Table
- Data fetching uvek sa TanStack Query (cache, retry, background refetch)
- Bez direktnih `fetch` poziva u komponentama — sve kroz `services/<resource>.ts`
- Storybook za reusable komponente (preporuka, ne obavezno)

### 9.5 Testiranje

**Backend**:
- Unit testovi za svaku service funkciju
- Integration testovi za API endpoint-e
- pgTAP testovi za RLS politike i SQL funkcije
- Coverage ≥ 70%

**Frontend**:
- Unit za pure funkcije, hooks
- Component testovi (Vitest + React Testing Library)
- E2E za kritične flow-ove (Playwright): login, otvaranje RN-a, lokacija unos, mobilni scan
- Coverage ≥ 50%

**CI**:
- Sve testove na svaki PR
- Bez merge ako bilo šta padne

### 9.6 Git workflow

- Branch model: **trunk-based** (kratke feature grane, brzi merge u `main`)
- Naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`
- PR template (template fajl u repo):
  - Šta se menja
  - Zašto se menja
  - Kako je testirano
  - Screenshots (UI promene)
  - Migracije (lista ako ih ima)
  - Breaking changes
- **Code review obavezan**: minimum 1 odobrenje od drugog dev-a
- **Nenad odobrenje obavezno za**: schema migracije, RLS izmene, auth promene, deploy na STAGING/PROD
- Commit messages: `type(scope): description` (Conventional Commits)
- Squash merge u main (čista istorija)

### 9.7 Dokumentacija (živi dokumenti)

Tim je dužan da održava:
- `README.md` — kako pokrenuti projekat
- `docs/ARCHITECTURE.md` — high-level arhitektura, dijagrami
- `docs/SCHEMA.md` — auto-generisan iz Postgres-a
- `docs/API.md` — auto-generisan iz OpenAPI
- `docs/RBAC.md` — auto-generisan iz uloga + dozvola
- `docs/MODULES/<modul>.md` — jedan po modulu (preuzeti format iz postojećih `Plan_montaze_modul.md`, `Lokacije_modul.md`)
- `docs/CONVENTIONS.md` — sve iz sekcije 9 ovde
- `docs/DEPLOYMENT.md` — kako se deploy-uje, runbook za incidente
- `docs/HANDOFF.md` — šta se predaje od Nenada (sekcija 15)

---

## 10. CI/CD i environment-i

### 10.1 Environments

| Env | Cilj | Pristup | Baza |
|---|---|---|---|
| **DEV** | Tim radi, eksperimentiše | Eksterni tim + Nenad | Lažni podaci, briše se nedeljno |
| **STAGING** | Nenad i key users testiraju | Nenad + key users + tim (read-only) | Subset PROD-a, 1 nedelju star |
| **PROD** | Produkcija | Samo Nenad + IT admin za deploy | Pravi podaci, backup-ovan |

### 10.2 CI pipeline

Na svaki PR:
1. Lint (ESLint, Prettier check)
2. Typecheck (`tsc --noEmit`)
3. Unit testovi
4. Integration testovi
5. pgTAP testovi
6. Build (Next.js + backend)
7. Docker image build (na merge u main)

Na merge u `main`:
1. Sve gore navedeno
2. E2E testovi (Playwright)
3. Build i push Docker image-a u registry
4. Auto-deploy na DEV
5. Smoke test na DEV
6. **Manual approval** za STAGING

Iz STAGING u PROD:
1. **Nenad odobrava** ručno
2. Backup baze pre deploy-a
3. Deploy
4. Smoke test
5. Notifikacija ako padne (rollback runbook)

### 10.3 Versioning i release

- Semantic versioning: `MAJOR.MINOR.PATCH`
- Tagged release-ovi na main brani
- Changelog auto-generisan iz Conventional Commits

---

## 11. Bridge ka starim sistemima

### 11.1 BigTehn MSSQL — strategija

**Odluka (Q3)**: Novi sistem postaje **izvor istine od starta**. BigTehn MSSQL postaje **read-only arhiva** posle migracije.

**Razlozi**:
- 5 meseci je premalo za održavanje paralelnog write-back sync-a
- Novi MES će biti jednostavniji za debug, manje grešaka
- BigTehn ostaje dostupan za istorijske upite (read-only) ako iko zatreba
- Gašenje BigTehn-a se može odložiti do M5 (kad poslednji modul izađe), ali nema dvosmerne write logike

**Implementacija**:
- M2: jednokratan ETL iz BigTehn → Postgres (svi RN-ovi, šifarnici, lokacije, magacin)
- M2-M5: novi sistem piše samo u Postgres
- BigTehn MSSQL ostaje u read-only modu (samo pristup za history queries, ako iko otvori Access)
- M5: BigTehn / Access se isključuju
- BigTehn baza se backup-uje kao snapshot, čuva se 5+ godina (compliance)

### 11.2 BigBit — strategija

**Odluka**: Read-only sync iz BigBit-a u Postgres.

**Implementacija** (`[PRETPOSTAVKA Q1 — detalji nakon BigBit definicije]`):
- Worker (cron job) povlači podatke iz BigBit-a u Postgres `sync.bigbit_*` tabele
- Frequency: M2 odluka — real-time, hourly, ili daily (zavisi od BigBit API-ja)
- Smer: BigBit → MES (jednosmerno)
- Ako MES korisnik treba da unese novi deo, **i dalje to radi u BigBit-u**, sync ga povuče
- Ovo se može menjati u Fazi 3 (BigBit zamena ili integracija)

### 11.3 Postojeća Supabase baza — migracija

- Jednokratan ETL u M1-M2
- Tabele: `projects`, `work_packages`, `phases`, `user_roles`, `audit_log`, `loc_*`, `maint_*`, `phr_*`, `sastanci_*`...
- Mapiranje na novu schemu (preimenovanja, tipovi, FK-ovi)
- Validacioni report
- Stara Supabase baza ostaje read-only do M5
- M5: Supabase Cloud se gasi (uštede $25/mes), backup se čuva off-line

### 11.4 Postojeći Servoteh moduli — koegzistencija

- Maj-Jun: stari moduli rade nepromenjeno (samo critical bug fix, Nenad održava)
- Jul-Septembar: novi moduli izlaze paralelno, korisnici se postepeno prebacuju
- Septembar: stari moduli se gase, sve na novom sistemu
- Cloudflare Pages deploy stari → može da ostane online još mesec dana posle M5 za "samo da vidim staro" pristup

---

## 12. Auth i RBAC

### 12.1 Identitet

Tri načina prijave:

**1. Email + lozinka** (default za desktop):
- Korisnik unosi email i lozinku
- Backend verifikuje (bcrypt), izdaje JWT
- Refresh token traje 30 dana

**2. ID kartica** (HID reader, postojeći obrazac):
- Kartica se koristi kao USB tastatura, emulira tipkanje koda
- Frontend hvata kod, šalje na backend kao "card login"
- Backend verifikuje karticu protiv `users.card_code` polja

**3. Telefon check-in** (NEW):
- Na monitoru u hali / na kartici je QR kod sa user ID-em
- Magacioner skenira QR sa svoje mobilne app
- App registruje "ovaj telefon je sad korisnik X"
- Korisnik radi sa svog telefona, sistem zna ko šta radi

### 12.2 Sesije

- JWT u Authorization header
- Sesije čuvane u Postgres `auth.sessions` tabeli (Auth.js obrazac)
- Logout invalidira sesiju
- Idle timeout: 8h (radni dan)
- Multi-device dozvoljen (kartica + telefon istovremeno)

### 12.3 Uloge i dozvole

Vidi sekciju 4.5 za listu uloga. Detaljna RBAC matrica generisana automatski u `docs/RBAC.md`.

**RLS pristup**:
- Sve domain tabele imaju RLS uključen
- Politike koriste `current_setting('app.user_role')` i `current_setting('app.tenant_id')`
- Backend setuje session variable po prijavljenom korisniku
- Service role ima `BYPASSRLS` za worker / cron poslove (audit attribution kroz `X-Audit-Actor`)

### 12.4 Audit

- `audit.log` tabela, append-only, immutable
- Trigger-based na svaku domain tabelu (BEFORE INSERT/UPDATE/DELETE)
- Polja: `id`, `tenant_id`, `actor_email`, `actor_role`, `action`, `entity_type`, `entity_id`, `before` (jsonb), `after` (jsonb), `created_at`, `correlation_id`, `ip_address`, `user_agent`
- Indexi: `(entity_type, entity_id)`, `(actor_email, created_at)`, `(tenant_id, created_at)`
- Audit pretraživač UI (sekcija 6.3) za admin
- Retention: 7 godina (compliance)

---

## 13. Mobilna aplikacija

### 13.1 Pristup

- **Capacitor wrapper** oko iste Next.js aplikacije
- Native modul: barcode scanner (Google ML Kit za Android, Vision za iOS)
- PWA fallback za desktop test pristup
- Distribuira se: APK (Android, internal), TestFlight ili sideload (iOS)

### 13.2 Funkcionalnosti

| Tab | Sadržaj | Korisnik |
|---|---|---|
| Skeniraj | Barcode → otvori RN ili lokaciju | Magacioner, QC |
| Lokacije | Premeštanje delova | Magacioner |
| Moji RN-ovi | Lista RN-ova dodeljenih meni | Tehnolog, radnik |
| QC unos | Brza forma za rezultat kontrole | QC kontrolor |
| Istorija | Šta sam ja uradio danas | Svi |
| Notifikacije | Push notifikacije | Svi |

### 13.3 Offline mode

- Lokalna baza (SQLite via Capacitor)
- Queue mehanizam za nesinhronizovane akcije
- Background sync čim se WiFi vrati
- Vidljiv indikator stanja (online / offline / syncing / error)

---

## 14. Multi-tenant strategija (Q2)

`[PRETPOSTAVKA: idemo sa multi-tenant aware od starta]`

### 14.1 Model

- **Row-level multi-tenancy** sa `tenant_id` u svakoj domain tabeli
- Jedna baza, jedna schema, više tenant-a
- Servoteh = `tenant_id = '00000000-0000-0000-0000-000000000001'` (ili nazivni UUID)
- Svaki budući klijent dobija svoj `tenant_id`

### 14.2 Tehničke implikacije

- RLS politike obavezne (već je plan)
- Backend setuje `app.tenant_id` session variable
- API rute su iste za sve tenant-e, tenant se određuje iz JWT-a
- Migrations su iste za sve tenant-e (jedna schema)
- Backup je per-tenant ili globalan (po izboru)

### 14.3 Šta NIJE u scope-u za sada

- Self-service tenant onboarding (UI gde klijent sam kreira nalog)
- Per-tenant branding (logo, boje, naziv)
- Per-tenant subscription i billing
- Tenant isolation testovi (penetration testing)

Ovo se gradi kad/ako počne stvarna prodaja klijentima.

---

## 15. Handoff package od Nenada (01.05.2026)

Predmeta predaje na dan zaključavanja Faze 1:

### 15.1 Tehnički materijal

- [ ] Git repo `servoteh-plan-montaze` u `main` branu (snapshot tag `v-handoff-2026-05-01`)
- [ ] Postgres dump postojeće Supabase baze (`pg_dump --format=custom --schema=public`)
- [ ] Postgres dump audit log-a (zasebno, jer je veliki)
- [ ] Storage bucket dump (sve fajlove iz Supabase Storage: `production-drawings`, `bigtehn-drawings`, drugi)
- [ ] Lista Supabase Edge Functions sa source kodom
- [ ] Lista Workers sa source kodom (`workers/loc-sync-mssql` i drugi)
- [ ] BigTehn MSSQL schema (`script.sql`) i pristup za read
- [ ] BigBit pristup i dokumentacija (Q1)

### 15.2 Dokumentacija

- [ ] `STRATEGIJA_MES.md` — ovaj dokument (finalna verzija)
- [ ] `SECURITY.md` — postojeća, prevesti na novi sistem
- [ ] `RBAC_MATRIX.md` — postojeća, kao baseline za novi RBAC
- [ ] `Lokacije_modul.md`, `Plan_montaze_modul.md`, `Kadrovska_modul.md`, `Planiranje_proizvodnje_modul.md`, `MOBILE.md` — postojeća, kao spec za rebuild
- [ ] `notes.md` — operativne beleške
- [ ] `CLAUDE_PROJECT_INSTRUCTIONS.md` — može poslužiti kao referenca za AI workflow novog tima
- [ ] **NOVO**: `BIGBIT.md` — Nenad piše opis BigBit-a (Q1)
- [ ] **NOVO**: `OPEN_ISSUES.md` — lista poznatih bug-ova, neispravljenih scenarija
- [ ] **NOVO**: `BUSINESS_RULES.md` — pravila iz Access VBA koja Nenad uspe da prevede
- [ ] **NOVO**: `KEY_USERS.md` — sekcija 8.3 popunjena imenima i kontaktima

### 15.3 Pristupi (credentials, secrets)

- [ ] Servoteh server: VPN config, SSH ključevi, admin lozinka (u manager-u)
- [ ] Postgres na serveru: superuser pristup
- [ ] Domeni i DNS: pristup registrar-u
- [ ] Email servis (SMTP): credentials
- [ ] BigTehn MSSQL: SQL Server login
- [ ] BigBit: API key ili DB credentials (Q1)
- [ ] GitHub Org: dodati 3 dev-a kao member-i, role developer
- [ ] Cloudflare Pages: pristup (za stare module)
- [ ] Supabase Cloud: pristup za read tokom migracije

### 15.4 Operativno

- [ ] Lista trenutnih korisnika sa ulogama (export iz `user_roles`)
- [ ] Spisak kartica i koja je dodeljena kojem radniku
- [ ] Spisak telefona u upotrebi (iOS/Android, modeli, pristup za sideload)
- [ ] Lista magacina i lokacija u trenutnoj upotrebi
- [ ] Spisak BigTehn izveštaja koji se moraju očuvati u novom sistemu
- [ ] Spisak Access ekrana koji moraju imati paritet u novom MES-u

### 15.5 Edukacija tima (prve 2 nedelje)

- [ ] Walkthrough postojećih modula sa Nenadom (1-2 dana)
- [ ] Demo BigTehn-a sa key user-ima (tehnolog, magacioner — 1 dan)
- [ ] Demo BigBit-a (1 dan)
- [ ] Code review postojeće Supabase baze (kako su rešeni određeni patterni — Lokacije movement, Plan Montaže Gantt, mobilno)
- [ ] Demo CI, deploy, monitoring postojećeg sistema

---

## 16. Šta tim mora da održava (živa dokumentacija)

Tim je dužan da održava ažurnu dokumentaciju u repo-u. Nenad prati u code review-u.

| Dokument | Auto-gen ili ručno | Frequency |
|---|---|---|
| `README.md` | Ručno | Po promeni setup-a |
| `docs/ARCHITECTURE.md` | Ručno | Po arhitekturnoj promeni |
| `docs/SCHEMA.md` | Auto-gen iz Postgres-a | Svaki PR koji menja schemu |
| `docs/API.md` | Auto-gen iz OpenAPI | Svaki PR koji menja API |
| `docs/RBAC.md` | Auto-gen iz politika | Svaki PR koji menja RBAC |
| `docs/MODULES/<modul>.md` | Ručno | Po feature promeni modula |
| `docs/DEPLOYMENT.md` | Ručno | Po promeni deploy procedure |
| `docs/CHANGELOG.md` | Auto-gen iz Conventional Commits | Svaki release |
| `docs/RUNBOOK.md` | Ručno | Po novom incidentu |

---

## 17. Komunikacija i nadzor (Nenadova uloga)

### 17.1 Strukturiran ritam

| Frequency | Format | Učesnici | Trajanje |
|---|---|---|---|
| **Dnevno** | Async update u Slack/Discord/Teams kanalu | Tim + Nenad | 5 min (čitanje) |
| **Nedeljno** | Sync poziv (Mon ili Pon) | Tim + Nenad | 30 min |
| **Mesečno** | Demo + retro + planiranje sledećeg meseca | Tim + Nenad + key user(s) | 2h |
| **Po milestone-u** | Acceptance + signoff | Tim + Nenad + acceptance owner | 1-2h |
| **Ad-hoc** | Kad nešto blokira | Inicijator → Nenad | po potrebi |

### 17.2 Alat za komunikaciju

- **Chat**: Slack ili Microsoft Teams (firma odlučuje)
- **Issue tracking**: GitHub Issues + Projects ili Linear
- **Dokumentacija**: Markdown u Git repo-u (već navedeno)
- **Video pozivi**: Google Meet ili Teams
- **Email**: za formalne stvari (acceptance, ugovor, eskalacije)

### 17.3 Eskalacija

| Nivo | Slučaj | Adresat |
|---|---|---|
| 1 | Dev ima tehničko pitanje | Lead dev (Dev A) |
| 2 | Lead dev ne može da odluči | Nenad |
| 3 | Nenad ne može da odluči (poslovna stvar) | Gazda |
| 4 | Konflikt sa eksternim sistemom (BigBit vendor) | Nenad + IT firma |

---

## 18. Rizici i mitigacija

| Rizik | Verovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **5 meseci je premalo** | Visoka | Visok | Strogi P0/P1/P2, P2 može pasti, scope-cap; weekly tracking |
| **Tim ne razume BigTehn business pravila** | Srednja | Visok | Nenad prevodi VBA, demo sesije sa Negovan-om (ako pristane); BigTehn ostaje paralelno do M5 kao fallback |
| **BigBit integracija komplikovana** (Q1) | ?? | Srednja | Definisati u prvih 2 nedelje, ako BigBit nema dobar API → workaround (CSV export, scheduled SQL) |
| **Server outage / disk failure** | Niska | KATASTROFALAN | Off-site backup, DR drill 2× godišnje, dokumentovan runbook |
| **Migracija podataka ne uspe** | Srednja | Visok | Dry run u DEV i STAGING, validacioni report, rollback plan |
| **Magacioneri / radnici otpor prema novom sistemu** | Srednja | Srednji | UX mora biti najmanje jednako dobar kao Access; mobilno mora biti brže od desktop unosa; trening; pilot smena |
| **Tim raste / smanjuje se tokom projekta** | Niska | Visok | Knowledge sharing dnevno, dokumentacija, pair programming rotacija |
| **Negovan ne sarađuje** (Q6) | Visoka | Srednji | Nenad pokriva, ali +1-2 nedelje na svaki kompleksan modul |
| **Multi-tenant odluka pogrešna** (Q2) | Niska | Visok | Multi-tenant aware od starta — minimal cost, maksimalna fleksibilnost |
| **Eksterni tim kasni / kvalitet pada** | Srednja | Visok | Q4 — ugovor sa SLA, retencija isplata, pravo na raskid |
| **Scope creep tokom 5 meseci** | **Visoka** | **Visok** | **Feature freeze 2 nedelje pre milestone-a; sve novo ide u backlog za posle Faze 2** |
| **Audit / compliance zahtev posle go-live-a** | Niska | Srednji | Audit log od dana 1, retention 7 godina, dokumentovano |

---

## 19. Pravna i komercijalna struktura (placeholder za ugovor — Q4)

`[OVO MORA POPUNITI NENAD + PRAVNIK PRE POTPISIVANJA SA TIMOM]`

Tipične stavke u ugovoru sa eksternim timom:

- **Predmet**: razvoj Servoteh MES po ovom dokumentu
- **Trajanje**: 5 meseci, sa pravom produženja
- **Cena**: fixed price ili time & material (firma odlučuje)
- **Plaćanje**: po milestone-u (preporuka), npr. 20% kick-off, 20% po M2, 20% po M3, 20% po M4, 20% po M5+acceptance
- **IP ownership**: 100% Servoteh (ili po dogovoru)
- **Source code**: Git repo u Servoteh organizaciji, tim ima pristup developer
- **Subcontracting**: dozvoljeno samo uz pisanu saglasnost Nenada
- **Confidentiality**: NDA na 5 godina (BigTehn schema, BigBit integracija, business pravila)
- **Acceptance procedure**: po sekciji 8.3, signoff po milestone-u
- **Warranty**: 6 meseci posle Go-Live, bug fix bez dodatne naplate
- **Maintenance**: opciono produženje posle warranty perioda, posebna stavka
- **Termination**: pravo Servoteh-a na raskid uz 30 dana otkaza, prorata za izvršen rad
- **SLA tokom projekta**: response time za blokere (npr. 24h), uptime DEV-a
- **SLA posle go-live-a**: ako se nastavlja maintenance ugovor

---

## 20. Šta tek treba odlučiti (otvoreno za diskusiju)

Pored Q1-Q7 sa vrha, sledeće stvari nisu blocker za start, ali se moraju odlučiti tokom prvih nedelja:

| # | Pitanje | Deadline |
|---|---------|----------|
| D1 | Backend stack (NestJS, .NET, drugo) | Nedelja 1 |
| D2 | Database migrations alat (Flyway, Prisma Migrate, Knex...) | Nedelja 1 |
| D3 | Auth biblioteka (Auth.js, custom JWT, Keycloak...) | Nedelja 2 |
| D4 | Storage backend (MinIO, filesystem + nginx, drugo) | Nedelja 2 |
| D5 | Monitoring stack (Prometheus + Grafana, Uptime Kuma, drugo) | Nedelja 2 |
| D6 | Issue tracker (GitHub Projects, Linear, Jira) | Nedelja 1 |
| D7 | Chat platforma (Slack, Teams, Discord) | Nedelja 1 |
| D8 | Acceptance owners po modulu (Q5) | Nedelja 2 |
| D9 | Naziv proizvoda (Q7) | Mesec 1 |
| D10 | Multi-tenant detalji (Q2) | Nedelja 2 |

---

## Apendiks A — Glosar

- **MES** = Manufacturing Execution System (sistem za izvršenje proizvodnje)
- **ERP** = Enterprise Resource Planning
- **RN** = Radni nalog
- **TP** = Tehnološki postupak
- **QC** = Quality Control (kontrola kvaliteta)
- **PDM** = Product Data Management (upravljanje crtežima)
- **MRP** = Material Requirements Planning
- **RLS** = Row Level Security (Postgres feature)
- **RBAC** = Role-Based Access Control
- **PITR** = Point In Time Recovery
- **SSO** = Single Sign-On
- **HID** = Human Interface Device (USB kartica čitač koji emulira tastaturu)
- **RPC** = Remote Procedure Call
- **CRUD** = Create, Read, Update, Delete
- **DTO** = Data Transfer Object
- **JWT** = JSON Web Token
- **DR** = Disaster Recovery
- **SLA** = Service Level Agreement
- **NDA** = Non-Disclosure Agreement
- **App Router** = Next.js routing paradigma (od v13+)
- **Server Components** = React komponente koje se renderuju samo na serveru

---

## Apendiks B — Reference (postojeća dokumentacija)

Tim treba da pročita sledeće dokumente iz `servoteh-plan-montaze` repo-a pre kick-off-a:

1. `docs/STRATEGIJA_ERP.md` — prethodna strategija (zastareva, ali korisno za kontekst)
2. `docs/SECURITY.md` — bezbednosna pozicija (security obrasci se nasleđuju)
3. `docs/SUPABASE_PUBLIC_SCHEMA.md` — postojeća schema baseline
4. `docs/RBAC_MATRIX.md` — auto-generisana matrica uloga
5. `docs/Lokacije_modul.md`, `docs/Plan_montaze_modul.md`, `docs/Kadrovska_modul.md`, `docs/Planiranje_proizvodnje_modul.md`, `docs/MOBILE.md` — postojeća dokumentacija po modulu
6. `docs/notes.md` — operativne beleške
7. `docs/CLAUDE_PROJECT_INSTRUCTIONS.md` — može biti adaptirano za novi projekat
8. BigTehn `script.sql` — schema dump
9. **NOVO**: `docs/BIGBIT.md` — Nenad piše (Q1)

---

## Apendiks C — Postojeća Supabase schema (placeholder)

Pun schema dump treba da bude priložen kao zaseban fajl:
- `attachments/postgres_schema_servoteh_2026-05-01.sql` — pun `pg_dump --schema-only`
- `attachments/postgres_data_seed_2026-05-01.sql` — sample podataka za DEV
- `attachments/bigtehn_schema_2026-05-01.sql` — BigTehn MSSQL schema export

Tim treba da analizira pre nego što počne sa novom schemom, da bi razumeo postojeće obrasce i izbegao greške istorijskog karaktera.

---

*Kraj dokumenta. Verzija 0.1 — draft za internu diskusiju.*
*Kritike, predlozi i izmene su dobrodošli pre potpisivanja sa eksternim timom.*
