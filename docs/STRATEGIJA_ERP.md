# Strategija migracije BigTehn → Servoteh ERP

> **Status:** draft za internu diskusiju, verzija 0.1 (20. april 2026)
> **Autor:** Nenad Jaraković + AI asistent
> **Cilj:** zameniti BigTehn (MS Access UI + MSSQL 4 GB) modernim web/mobile ERP-om
> koji gradi tim od 4 developera tokom ~12 meseci.

---

## 1. TL;DR (ako nemaš vremena čitati sve)

- **Gradimo novi projekat od nule** (`servoteh-erp`) sa React + TypeScript stack-om, ne nastavljamo `servoteh-plan-montaze` (vanilla JS).
- **Ista Supabase baza** za oba projekta → postojeći moduli (Lokacije, Održavanje, Kadrovska) rade dalje, novi ERP pristupa istim podacima.
- **Supabase Pro plan ($25/mes)** pokriva trenutne potrebe (4 GB → limit 8 GB, 50 korisnika → limit 100k MAU). Team plan **NIJE POTREBAN**.
- **12 meseci posla** podeljeno u 4 quarterly release-a. Svaki Q daje 2–3 produkcijska modula.
- **Access se potpuno gasi na kraju Q4** (mart 2027), MSSQL ostaje read-only arhiva do prelaska na self-host PostgreSQL (Q5/2027, opciono).
- **Tim:** 1 arhitekta (Nenad) + 3 senior backend developera, svaki vlasnik 2 modula.

---

## 2. Trenutno stanje

### 2.1 Šta postoji danas

| Komponenta | Status | Problem |
|---|---|---|
| **BigTehn MSSQL baza** | ~4 GB, u produkciji 10+ godina | Ne boli, radi. Vendor-lock u MSSQL + Access. |
| **MS Access UI** | 5+ modula, desktop-only | Windows-only, nemoguće mobilno, teško je održavati. Naslednik originalnog dev-a (Negovan Vasić) potreban za svaku izmenu. |
| **servoteh-plan-montaze** (ovaj repo) | Vite + **vanilla JavaScript** (bez React) | 5 modula u produkciji: Plan Montaže, Kadrovska, Lokacije, Održavanje mašina, Podešavanja. Postoje PWA + Capacitor mobilni wrap. |
| **Tech tim** | 1 arhitekta + 3 senior-a (backend-heavy) | Nisu specijalisti za React. Postgres znaju, Supabase ne. |

### 2.2 Šta ne postoji

- Centralizovan state management (svaka stranica ima svoj)
- TypeScript type safety (sve je JS)
- Komponentna biblioteka (HTML se piše string-om u svakoj stranici)
- End-to-end testovi (samo unit testovi na ~10% koda)
- CI za full regression
- Dokumentacija arhitekture

### 2.3 Zašto ovo nije „dovoljno dobar start" za 4-člani tim

Kratko: trenutni stack je **optimalan za 1 developera + 5 modula**. Za **4 dev-a + 67 tabela** izlaze 3 problema:

1. **Bez TS-a, refactor nije izvodljiv** — promena imena kolone u bazi lomi kod na 10+ mesta koji je nemoguće naći bez grep-a. Za ERP ovo je nepregorivo.
2. **Bez komponenti, duplikacija raste eksponencijalno** — forma za novi nalog, kontrolu, lokaciju, radnika… sve liče ali su nezavisno napisane. Bug fix u jednoj = copy-paste u 10.
3. **Bez konvencija, 4 dev-a idu u 4 smera** — svaki senior ima svoj stil za render tabele/forme, što lomi code review i stvara „svačije, ničije" fajlove.

Refactor postojećeg repo-a je zamka: **6+ meseci rada da bismo imali tek start-ing point**. Efikasnije je novi repo sa modernim paternima od prvog dana.

---

## 3. Ciljevi projekta

### 3.1 Poslovni ciljevi

| # | Cilj | Merljiv KPI |
|---|---|---|
| 1 | Magacioneri unose lokacije sa **telefona** umesto da idu do kompa | Vreme unosa: < 15 sek po stavci |
| 2 | Kontrolor QC-a unosi rezultat **sa računara u hali**, ne iz kancelarije | 100% unosa u istom danu, ne sledećeg |
| 3 | Tehnolog vidi **status svih naloga** bez otvaranja 3 ekrana | Dashboard < 3 sekunde za 500 naloga |
| 4 | Gazda vidi **KPI proizvodnje** u real-time | Mobilni dashboard, update < 5 sek |
| 5 | Ugasiti Access ✖ | 0 korisnika na Access-u do kraja Q4/2027 |

### 3.2 Tehnički ciljevi

| # | Cilj |
|---|---|
| 1 | 100% TypeScript, strogi mod |
| 2 | 80%+ code coverage (unit + E2E) |
| 3 | Arhitektura nezavisna od Supabase — ako se sutra prebacimo na self-host Postgres, menja se samo connection string + jedan adapter |
| 4 | Mobilno kao first-class citizen (responsivni dizajn, Capacitor wrap) |
| 5 | Deploy za < 5 min preko CI |
| 6 | Svi domeni (schema + API + UI) verzionisani u Git-u |

---

## 4. Stack odluka — argumentovano

### 4.1 Preporučen stack

```
┌─ Frontend ────────────────────────────────────────────────────┐
│                                                               │
│  Next.js 15 (App Router) + React 19 + TypeScript 5.5          │
│  Tailwind CSS v4 + shadcn/ui                                  │
│  React Hook Form + Zod (forme + validacija)                   │
│  TanStack Table v8 (tabele)                                   │
│  TanStack Query v5 (client-side caching)                      │
│  Zustand (minimalan global state)                             │
│                                                               │
│  Mobile: Capacitor wrapper oko istog UI-a (PWA + native)      │
└───────────────────────────────────────────────────────────────┘

┌─ Backend ─────────────────────────────────────────────────────┐
│                                                               │
│  Supabase:                                                    │
│   - Postgres 15 (baza)                                        │
│   - PostgREST (auto REST API)                                 │
│   - RPC (custom SQL funkcije)                                 │
│   - Auth (email + kartica)                                    │
│   - Storage (PDF, slike)                                      │
│   - Realtime (dashboard live update)                          │
│                                                               │
│  Za sync sa MSSQL-om: Node.js worker (postoji skelet)         │
└───────────────────────────────────────────────────────────────┘

┌─ Infra ───────────────────────────────────────────────────────┐
│  Git repo:  monorepo (pnpm workspaces)                        │
│  CI/CD:     GitHub Actions                                    │
│  Deploy:    Cloudflare Pages (web) + TestFlight/APK (mobile)  │
│  Monitoring: Supabase built-in + Sentry za frontend           │
└───────────────────────────────────────────────────────────────┘
```

### 4.2 Zašto Next.js za backend-heavy tim

Tim je backend-heavy (Node/.NET/PHP). Moglo bi se pomisliti da React nije pravi izbor jer je „front-heavy" framework. **Ali Next.js 15 App Router radi obrnuto od klasičnog SPA React-a:**

- **Server Components** — komponente koje se renderuju na serveru, nema hooks, nema state management. Izgleda kao `async function Page() { const data = await sb.from(...).select(); return <Table data={data} />; }` → to je suštinski async funkcija koja vraća HTML. Backend dev razume to prvim pogledom.
- **Route Handlers** — isti mental model kao Express/Fastify endpoint. Backend devs navikli na to.
- **Server Actions** — forma direktno poziva server funkciju. Nema fetch + state machine. Bilo je brže napisati nego klasičan REST endpoint.

**Klijentske komponente** (sa `"use client"`) pišu se samo tamo gde je stvarno potrebno (input, submit, modal). Za to koristimo **shadcn/ui** copy-paste komponente — dev ih ne piše, već ih samo konfiguriše.

Rezultat: **backend dev vidi 80% koda koji mu izgleda poznato** (async funkcije, SQL upiti, endpoint-i), samo 20% tipično React (forme). Učenje je 1-2 nedelje, ne 3 meseca.

### 4.3 Zašto NE Vue, Svelte, HTMX

| Opcija | Pro | Con | Presuda |
|---|---|---|---|
| **Vue 3** | Jednostavniji template, bliži HTML-u | Manji hiring pool od React, manji ekosistem Supabase tipova | ❌ React ima 3x više developera na tržištu, bitno za budući rast tima |
| **Svelte/SvelteKit** | Najmanja kompleksnost, najbrža runtime | Najmanji ekosistem, manje komponenti gotovo | ❌ Rizik „niche tech" kroz 5 godina |
| **HTMX + Server-render** | Idealno za backend-heavy, nema state | Capacitor mobilno teško, nema realtime komponenti | ❌ Mobilni ERP sa HTMX nije solid |
| **Remix / TanStack Start** | Modernije od Next.js u nekim aspektima | Manja prisutnost u enterprise, manje resursa za rešavanje problema | ❌ Pažljivo — još uvek u evoluciji |
| **Next.js 15** | Market standard, dokumentacija ogromna, Server Components | Uči se App Router, malo složeniji od Pages Router-a | ✅ **Best fit** |

### 4.4 Zašto NE zadržavamo Vanilla JS

- Bez TS-a, u ERP-u od 67 tabela, dobijaš 100+ bugova godišnje koji ne bi bili da je TS
- 4 dev-a će produkovati 4 različita stila — code review postaje „policija stila"
- Nema komponenti = duplikovane forme = bug fix u 10 mesta
- Mobilno radi kako-tako, ali nije standard — Capacitor sa React Native ili PWA+React je češći i bolje podržan

---

## 5. Arhitektura — dva projekta, jedna baza

```
┌─────────────────────────────┐     ┌─────────────────────────────┐
│ servoteh-plan-montaze        │    │ servoteh-erp (NOVI)          │
│ (ovaj repo, ostaje)          │    │                              │
│                              │    │ Next.js 15 + TypeScript      │
│ Vite + vanilla JS            │    │ Tailwind + shadcn/ui         │
│ Moduli:                      │    │ Moduli:                      │
│  - Plan Montaže              │    │  A. Šifarnici (temelji)      │
│  - Kadrovska                 │    │  B. PDM (crteži)             │
│  - Lokacije ← postepeno      │    │  C. Radni nalozi             │
│  - Održavanje  migrira ka →  │    │  D. Kontrola kvaliteta       │
│  - Podešavanja               │    │  E. Magacin                  │
│                              │    │  F. MRP                      │
│ Deploy: Cloudflare Pages     │    │  G. Planer                   │
│ URL: app.servoteh.com (ili sl.) │  │  H. Sistem / access kontrola │
│                              │    │                              │
│                              │    │ Deploy: Cloudflare Pages     │
│                              │    │ URL: erp.servoteh.com        │
└──────────────┬───────────────┘    └──────────────┬───────────────┘
               │                                   │
               │          Supabase klijent         │
               │          (REST + RPC + Auth)      │
               └───────────────┬───────────────────┘
                               │
                               ▼
            ┌───────────────────────────────────────┐
            │  SUPABASE (Pro plan, $25/mes)         │
            │  Postgres 15 + PostgREST + Auth       │
            │  4 GB → 8 GB → +$0.125/GB             │
            │                                       │
            │  Schema deljena između dva projekta   │
            │  RLS policies, RPC funkcije, triggeri │
            └──────────────┬────────────────────────┘
                           │
                           ▼
            ┌───────────────────────────────────────┐
            │  MSSQL BigTehn bridge (prelazan)      │
            │  Node.js worker (postojeći skelet)    │
            │  - Inbound pull (MSSQL → Supabase)    │
            │  - Outbound push (Supabase → MSSQL)   │
            │                                       │
            │  Traje do kraja Q4/2027, zatim OFF    │
            └───────────────────────────────────────┘
```

### 5.1 Kako dva repo-a dele bazu

- **Isti Supabase projekat** (isti URL + anon key)
- **Ista SQL schema** — migracije se commit-uju u JEDAN repo (predlog: novi `servoteh-erp` repo drži sve migracije, stari ih samo čita)
- **RLS policies** kontrolišu pristup po korisničkoj ulozi, ne po repo-u — Supabase ne zna i ne treba da zna odakle dolazi request
- **TypeScript tipovi** generisani iz schema-e (`supabase gen types typescript`) → novi repo ih koristi direktno, stari se ne dira
- **Auth tokeni** se dele kroz cookies na *.servoteh.com domenu → radnik ne mora da se ulogin-uje 2 puta

---

## 6. Mapa modula — 9 modula, 67 tabela

Grupisano iz analize `script.sql` (BigTehn MSSQL):

### A. ŠIFARNICI (22 tabele) — **temelji svega**
> Predmeti, Komitenti, tRadnici, tOperacije, tRadneJedinice, tPozicije, tVrsteKvaliteta, R_Artikli, Magacini, BBOdeljenja, Cenovnik, Prodavci, UplatniRacuni, Statusi*, Vrsta naloga, Parametri za rad…

**Bez Modula A, ništa drugo ne radi.** Svi drugi moduli joinuju na A.

### B. PDM (12 tabela) — crteži i primopredaja
> PDMCrtezi, PDM_PDFCrtezi, SklopoviPDMCrteza, KomponentePDMCrteza, PrimopredajaCrteza, NacrtPrimopredaje, PDM_Planiranje…

Vlasnik: tehnolog. Produkuje crteže i primopredaju radionici.

### C. RADNI NALOZI (8 tabela) — srce proizvodnje
> tRN, tStavkeRN, tRNKomponente, tSaglasanRN, tLansiranRN, tStavkeRNSlike…

Otvaranje naloga, saglasnost, lansiranje.

### D. KONTROLA KVALITETA (6 tabela) — ono što smo juče počeli
> tTehPostupak, tTehPostupakDokumentacija, Nalepnice, tLokacijeDelova…

Kontrola realizacije + fizičke lokacije delova na policama.

### E. MAGACIN (5 tabela) — roba i dokumenti
> T_Robna dokumenta, T_Robne stavke, RobneStavkeMirror, Radni fajlovi…

Prijem, izdatak, interni transferi.

### F. MRP (5 tabela) — material requirements
> MRP_Potrebe, MRP_PotrebeStavke, MRP_StanjeArtikala, MRP_SyncStatus…

Potrebe za materijalom, stanje artikala.

### G. PLANER (3 tabele) — proizvodni plan
> T_Planer, T_PlanerGrupeUsera, tR_Grupa

Raspored operacija po mašinama, radnim danima.

### H. SISTEM / ACCESS (9 tabela) — auth i access
> BBDefUser, BBPravaPristupa, _RegAccess, _RegUsers, _RegApps, tPristupMasini, _Dnevnik, _Rev, CFG_Global, CFG_Sys

Autentifikacija, prava, audit trail, konfiguracija.

---

## 7. Podela tima — ko radi šta

### 7.1 Vlasnici modula (vertikalno)

| Dev | Glavna odgovornost | Sekundarno |
|---|---|---|
| **Nenad (arhitekta)** | **A. Šifarnici** + **H. Sistem/Auth/RLS** | Code review svih PR-ova, schema konsistencija, deploy |
| **Dev 1 (senior)** | **C. Radni nalozi** + **D. Kontrola kvaliteta** | API layer (RPC konvencije, PostgREST) |
| **Dev 2 (senior)** | **B. PDM** + **F. MRP** | Data layer (schema migracije, indeksi, optimizacija) |
| **Dev 3 (senior)** | **E. Magacin** + **G. Planer** | UI library (shadcn/ui customizacije, dizajn system) |

### 7.2 Horizontalni stubovi (odgovornosti)

Pored modula, svaki dev ima **jedan horizontalni stub** koji preseca ceo projekat:

- **Nenad:** infra (CI, deploy, monitoring, secret management)
- **Dev 1:** API konvencije (kako se pišu RPC-ovi, naming, error codes)
- **Dev 2:** schema standardi (naming, konvencije za tabele, migracije)
- **Dev 3:** UI komponente (shadcn customizacije, forme, tabele kao reuse)

### 7.3 Zašto ovaj raspored

- **Nenad drži šifarnike** jer se tu kreira schema konvencija koju svi drugi nasleđuju
- **Dev 1 dobija RN + QC** jer su to dva najpovezanija modula i isti tok (radni nalog → postupak kontrole)
- **Dev 2 dobija PDM + MRP** jer su oba data-heavy, planiranje i potrebe
- **Dev 3 dobija Magacin + Planer** jer su oba workflow-heavy, kretanje robe i raspored

Ako se jedan dev razboli, mapa je nadgrađiva — manja je kolizija nego kad bi svi radili na istom modulu.

---

## 8. Roadmap — 12 meseci, quarterly release

### Q1 / April–Juni 2026 — **TEMELJI** (3 meseca)
**Release:** `erp-1.0` — šifarnici + auth + read-only pregled MSSQL podataka

- Kreiran `servoteh-erp` repo, stack postavljen, CI/CD radi
- Svi šifarnici (Modul A) — schema + import iz MSSQL-a (one-off) + RLS
- Auth: email + ID kartica za desktop (HID reader emulacija)
- Import 4 GB MSSQL → Supabase kao read-only arhiva
- Dashboard: „pregled podataka iz MSSQL" — za timove koji samo gledaju
- Access ostaje primarni za UPIS

**Kriterijum uspeha:** šefovi koriste novi dashboard umesto da zovu Access power usera

### Q2 / Juli–Septembar 2026 — **PDM + Magacin** (paralelno)
**Release:** `erp-2.0` — PDM i Magacin žive

- **Modul B (PDM):** upload crteža, primopredaja, revizije — tehnolog radi sve iz web-a
- **Modul E (Magacin):** prijem/izdatak, stanje, dokumenta — magacioner radi iz web-a
- Write-back sinhro: oba modula pišu u Supabase + worker gura u MSSQL da Access i dalje vidi
- **Modul H (Sistem):** audit log, rev kontrola — prati sve akcije

**Kriterijum uspeha:** tehnolog + magacioner ne otvaraju Access dvaput dnevno

### Q3 / Oktobar–Decembar 2026 — **Radni nalozi + Kontrola kvaliteta**
**Release:** `erp-3.0` — glavna linija proizvodnje

- **Modul C (RN):** otvaranje, saglasnost, lansiranje
- **Modul D (QC):** tTehPostupak, Nalepnice (print sa Code128 + QR), povezivanje sa lokacijama
- Proširenje Lokacija iz starog repo-a: dodaje se IDRN + kvalitet kao dimenzije
- **Pilot**: jedna smena prelazi 100% na novi ERP, ostale i dalje na Access

**Kriterijum uspeha:** pilot smena ne traži povratak na Access

### Q4 / Januar–Mart 2027 — **MRP + Planer + SHUTDOWN**
**Release:** `erp-4.0` — kompletan ERP

- **Modul F (MRP):** potrebe za materijalom, stanje, planiranje
- **Modul G (Planer):** raspored operacija po mašinama
- **Access shutdown:** sve smene prelaze na novi ERP
- MSSQL postaje read-only arhiva (worker se isključuje)

**Kriterijum uspeha:** 0 korisnika na Access-u do 31. marta 2027

### Q5+ / April 2027+ — **Opciono: self-host PostgreSQL**

- Supabase je običan Postgres pod haubom, 100% portable
- Ako želite kontrolu nad infrastrukturom → dump + restore na lokalni server
- Kad odlučite, rad je 1-2 nedelje (schema + data seluje se sa `pg_dump`/`pg_restore`)

---

## 9. Budžet — orijentaciono

### 9.1 Mesečni operativni troškovi (Supabase)

| Stavka | Cena |
|---|---|
| Supabase Pro plan | **$25/mes** |
| Micro compute (default, 60 konekcija) | uključeno (deducted iz $10 credit-a) |
| Dodatno ako pređemo 50 aktivnih → Small compute | +$15/mes |
| Dodatno za 8+ GB baze (posle 2 god) | +$0.125/GB/mes (~$2-5/mes na 30 GB) |
| Cloudflare Pages deploy | $0 (free plan dovoljan) |
| GitHub Actions CI | $0 (free plan dovoljan za mali tim) |
| Domene (erp.servoteh.com) | postojeće |
| Sentry monitoring (opciono) | $0-26/mes |
| **Ukupno prva godina** | **~$25-50/mes** = ~$300-600/god |

### 9.2 Developer troškovi (referentno)

Ne upisujem konkretne brojke jer zavise od ugovora, ali orijentaciono:

- 12 meseci × 4 developera = **48 čovek-meseci**
- Od toga Nenad 50% (arhitekta, code review, nije full-coding) ≈ **6 čovek-meseci**
- Ostala 3 dev-a puno vreme = **36 čovek-meseci**
- **Ukupno ~42 čovek-meseca** za kompletan ERP

Ako želiš tačan budžet — dodaj mesečne rate × broj meseci × broj dev-a.

---

## 10. Rizici i mitigacija

| Rizik | Verovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| **Supabase rate limiti ili outage** | Niska | Visok | Self-host ostaje opcija (Postgres je 100% portable); automatski backup dnevno |
| **Tim ne zna React dobro, kašnjenje** | Srednja | Srednji | 2 nedelje onboarding-a sa shadcn; parovanje (pair programming) prve 4 nedelje |
| **BigTehn MSSQL ne da da se pravilno sync-uje (network, firewall)** | Srednja | Visok | Rezervna opcija: export BACPAC fajl, restore u read-only Supabase tabele |
| **Access users odbijaju prelazak** | Visoka | Srednji | Pilot jedna smena u Q3, UX mora biti najmanje koliko i Access (ne lošiji); trening |
| **4 GB baza raste brže nego projektovano** | Niska | Nizak | Archive/partition strategija posle 2 god; Supabase već podržava table partitioning |
| **Gubitak podataka tokom migracije** | Niska | KATASTROFALAN | 3-level backup: Supabase PITR + MSSQL ostaje + dnevni dump na naš server. Niko ne commit-uje direktno na prod. |
| **Scope creep** (Q1 produži na 6 meseci) | **Visoka** | Visok | Fiksan scope po quarterly release-u, feature-freeze 2 nedelje pre release-a |
| **Tim prestaje da sarađuje** (4 dev-a rade 4 različite stvari) | Srednja | Visok | Weekly sync 30 min, shared architecture document (ovaj), pair programming rotacija |

---

## 11. Kick-off checklist — prve 2 nedelje (kad tim krene)

### Nedelja 1 — infrastruktura

- [ ] Kreiran `servoteh-erp` Git repo (public/private po izboru)
- [ ] Monorepo struktura sa pnpm workspaces: `apps/web`, `apps/mobile`, `packages/ui`, `packages/db`, `packages/config`
- [ ] Next.js 15 + TS skeleton u `apps/web`, build prolazi
- [ ] shadcn/ui init, 5 osnovnih komponenti (button, input, table, dialog, form)
- [ ] Supabase projekat kreiran, env var-ovi u `.env.local`, GitHub Secrets postavljeni
- [ ] GitHub Actions CI: lint + typecheck + test na svaki PR
- [ ] Cloudflare Pages deploy (erp.servoteh.com → GitHub)
- [ ] Ovaj dokument u `docs/STRATEGIJA_ERP.md` u novom repo-u

### Nedelja 2 — arhitektura i prva migracija

- [ ] Schema konvencije zapisane u `docs/SCHEMA_GUIDE.md` (naming, tipovi, indeksi)
- [ ] API konvencije zapisane u `docs/API_GUIDE.md` (RPC naming, error format)
- [ ] UI konvencije zapisane u `docs/UI_GUIDE.md` (shadcn patterns, formama)
- [ ] Prva tabela iz Modula A migrirana (npr. `kom_komitenti`), RLS napisan, tipovi generisani
- [ ] Prva stranica (listing komitenata) postoji, radi, tested na staging-u
- [ ] 4 dev-a uparen na prvoj stranici — da zajedno nauče pattern

**Ako ovo zatvorimo za 2 nedelje, imamo realan osećaj brzine tima → možemo projektovati Q1 tačnije.**

---

## 12. Naredni koraci (za tebe kao arhitektu)

Pre nego što podeliš ovaj dokument sa timom, odluči sledeće:

1. **Da li je ova strategija ono što želiš?** Ako ne, vrati se na sekciju 4 (stack) ili 7 (podela tima) — to su najsubjektivnije odluke.
2. **Angažovanje tima** — kad potpišu ugovor, koliko imaju iskustva sa Next.js App Router? Ako 0, treba 1-2 nedelje onboarding-a.
3. **Pravni okvir** — intellectual property, NDA, kod vlasništvo (preporuka: ti kao company vlasnik).
4. **Komunikacioni alati** — Slack? Discord? Teams? + GitHub Issues + Projects za task tracking.
5. **Poslovna vrednost** — svaki quarterly release treba da ima **jasan business owner** (gazda, tehnolog, magacioner…) koji potpisuje „da, ovo zamenjuje Access za moju ulogu".

---

## Apendiks A — Glosar

- **ERP** = Enterprise Resource Planning
- **RLS** = Row Level Security (Postgres feature koji ograničava redove po useru)
- **RPC** = Remote Procedure Call (u Supabase kontekstu: custom SQL funkcija izložena preko REST-a)
- **PostgREST** = auto-generated REST API iznad Postgres-a
- **MAU** = Monthly Active Users
- **PITR** = Point In Time Recovery (Supabase backup feature)
- **App Router** = Next.js routing paradigma iz v13+ (pre: Pages Router)
- **Server Components** = React komponente koje se renderuju samo na serveru, bez JS-a u browseru
- **HID reader** = Human Interface Device (tipična USB kartica čitač koji emulira tastaturu)

## Apendiks B — Referentni linkovi

- Supabase pricing: https://supabase.com/pricing
- Supabase docs (Auth, RLS): https://supabase.com/docs
- Next.js 15 App Router: https://nextjs.org/docs/app
- shadcn/ui: https://ui.shadcn.com
- TanStack Query: https://tanstack.com/query
- TanStack Table: https://tanstack.com/table
- BigTehn analiza: `docs/notes.md` (staro) + `script.sql` (MSSQL schema)
- Postojeći moduli: `docs/Lokacije_modul.md`, `docs/Kadrovska_modul.md`, `docs/Planiranje_proizvodnje_modul.md`, `docs/MOBILE.md`

---

*Kraj dokumenta. Sve kritike, predlozi i izmene su dobrodošli — komentariši direktno u PR-u.*
