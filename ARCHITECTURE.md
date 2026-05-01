# Servosync (MES) — arhitektura

Primarni kontekst za rad u Cursor-u: smanjuje skeniranje celog repoa i usmerava izmene ka pravim modulima i Supabase slojevima.

**Supabase MCP:** povezan na projekat **Servoteh's Project** (`fniruhsuotwsrjsbhrxd`, `eu-west-1`).

---

## 1. Project Overview

**Servosync** je web MES/ERP shell za Servoteh: plan montaže po projektima, planiranje i praćenje proizvodnje (BigTehn sinhronizacija), lokacije delova, CMMS održavanje, kadrovska, sastanci, podešavanja (predmeti, org. struktura, održavanje profili). Entry je `index.html` → `src/main.js`; rutiranje preko History API (`src/lib/appPaths.js`, `src/ui/router.js`). PWA + Capacitor mobilni magacionerski tok (`/m/*`).

---

## 2. Tech Stack

| Area | Version / note |
|------|----------------|
| **Runtime (web)** | Vite `^5.4.10`, ES modules, **vanilla JS** (nema React/Vue; nema shadcn/ui) |
| **Mobile wrapper** | Capacitor `^8.3.x` (`@capacitor/core`, android/ios) |
| **Tests** | Vitest `^2.1.9` |
| **Backend** | Supabase (Postgres 17, Auth, PostgREST, RLS, Edge Functions) |
| **Types** | JSDoc + `src/types/`; generisani tipovi: `npm run gen:db-types` → `src/types/supabase-generated.d.ts` (lokalni Supabase ili linked projekat) |
| **Workers (repo)** | `workers/loc-sync-mssql`: Node `>=20`, `@supabase/supabase-js` `^2.45.4`, MSSQL |
| **Tools** | `tools/label-proxy` — lokalni TSPL2 proxy za štampače |

---

## 3. Module Map

Glavni UI moduli žive u `src/ui/<folder>/index.js` (ili `pracenjeRouter.js` za praćenje). Hub: `src/ui/hub/moduleHub.js`.

| # | Modul | Ruta (glavna) | Ulaz / ključni fajlovi | Kratak opis |
|---|--------|---------------|-------------------------|-------------|
| 1 | **Plan montaže** | `/plan-montaze` | `src/ui/planMontaze/index.js`, `gantt.js`, `planTable.js`, `wpAssemblyDrawingDialog.js` | Gantogram, faze, WP, PDF/Excel export, projekti |
| 2 | **Planiranje proizvodnje** | `/plan-proizvodnje` | `src/ui/planProizvodnje/index.js`, `poMasiniTab.js`, `drawingManager.js` | Redosled operacija po mašini, BigTehn RN/crteži |
| 3 | **Praćenje proizvodnje** | `/pracenje-proizvodnje` | `src/ui/pracenjeProizvodnje/index.js`, `pracenjeRouter.js`, `aktivniPredmetiList.js`, `tab1Pozicije.js`, `tab2OperativniPlan.js` | Aktivni predmeti, stablo RN, tabovi `#tab=po_pozicijama` / `#tab=operativni_plan` |
| 4 | **Lokacije delova** | `/lokacije-delova` | `src/ui/lokacije/index.js`, `scanModal.js`, `labelsPrint.js` | Lokacije, magacin, sync queue ka MSSQL worker-u |
| 5 | **Održavanje mašina** | `/maintenance` (+ deep linkovi) | `src/ui/odrzavanjeMasina/index.js`, panel fajlovi `maint*.js` | CMMS: incidenti, WO, katalog, inventar, dokumenta |
| 6 | **Kadrovska** | `/kadrovska` | `src/ui/kadrovska/index.js`, `employeesTab.js`, `salaryTab.js`, … | Zaposleni, ugovori, odsustva, plate (RBAC) |

**Dodatni delovi istog frontenda (nisu u “šestic” ali su prvi razred):**

- **Sastanci** — `/sastanci`, `src/ui/sastanci/`
- **Podešavanja** — `/podesavanja`, `src/ui/podesavanja/` (predmeti, org. struktura, maint profili)
- **Mobilni shell** — `/m`, `/m/scan`, … `src/ui/mobile/`

**Deljeni slojevi:** `src/services/` (Supabase HTTP, auth, domen), `src/state/auth.js`, `src/lib/`.

---

## 4. Database Schema (High Level)

### Šeme i domene

- **`public`**: projekti/WP/faze (plan montaže), `user_roles`, **BigTehn cache** tabele (`bigtehn_*_cache`), `production_overlays` / `production_drawings`, **lokacije** (`loc_*`), **kadrovska** (`employees`, `work_hours`, `salary_*`, …), **sastanci** (`sastanci`, `akcioni_plan`, …), **maintenance** (`maint_*`), `audit_log`, `production_active_work_orders`, `predmet_aktivacija` mapiran kroz migracije u `production` gde je potrebno, itd.
- **`production`**: kanonski MES model — `radni_nalog`, pozicije, `tp_operacija`, `prijava_rada`, `operativna_aktivnost*`, `predmet_aktivacija`, `predmet_prioritet`, napomene za praćenje, …
- **`core`**: šifarnici (`odeljenje`, `work_center`, `radnik`, …)
- **`pdm`**: `drawing` (PDM crteži)

### Relacije (skica)

- Projekat → work_packages → phases (plan montaže).
- BigTehn: RN i linije u cache tabelama; veza ka projektima kroz poslovna pravila i overlay tabele.
- `production.predmet_aktivacija` — jedan red po predmetu (`bigtehn_items_cache.id`); **aktivna lista** za Plan/Praćenje: `public.get_aktivni_predmeti()` + `je_aktivan = true` (bez MES filtera na listi predmeta — vidi Bugbot).
- Lokacije: `loc_locations` hijerarhija → `loc_location_movements` → `loc_item_placements`; outbound `loc_sync_outbound_events` za worker.
- CMMS: `maint_assets` supertype, `maint_machines`, incidenti, WO, delovi, dokumenta (Storage).

### RLS strategija

- RLS je **uključen** na klijentskim tabelama (vidljivo u MCP listi tabela).
- Pristup se rezuje preko **rola** (`user_roles`, funkcije tipa `has_edit_role()` / modulski helperi) i policy-ja po tabeli; osetljivi HR podaci imaju dodatne trigere (`employees_sensitive_guard`).
- **Servisni ključ** samo u worker-ima / Edge funkcijama — nikad u browser kodu.

### Edge Functions (MCP — aktivni deploy)

Na projektu je deployovana bar jedna funkcija sa JWT verifikacijom:

| Slug | Status |
|------|--------|
| `admin-invite-once` | ACTIVE (`verify_jwt: true`) |

**Repo** (`supabase/functions/`, deploy odvojeno od MCP liste):

| Folder | Namena |
|--------|--------|
| `hr-notify-dispatch/` | Kadrovske notifikacije (cron/queue pattern — vidi README u folderu) |
| `maint-notify-dispatch/` | CMMS notifikacije |
| `sastanci-notify-dispatch/` | Sastanci notifikacije |

Ako MCP ne prikazuje sve funkcije, proveri Dashboard → Edge Functions ili `supabase functions deploy`.

### Database triggers (MCP — pregled)

**Interni sistemski:** npr. `cron.job` → `cron.job_cache_invalidate`.

**Domen:**

- **touch `updated_at`:** širom `core`, `production`, `pdm`, `public` (production i maint tabele).
- **Audit:** `audit_row_change` na kritičnim `production.*`, HR, lokacije, user_roles, itd.
- **Lokacije:** `loc_after_movement_insert`, path/hierarchy guard-i na `loc_locations`.
- **Predmet aktivacija:** na insert u `bigtehn_items_cache` → `production.tg_predmet_aktivacija_default`.
- **Maint:** auto WO iz incidenta, stock movement, WO broj, facility/vehicle/IT guard-i, …
- **HR/plate:** `salary_payroll_compute_totals`, zatvaranje prethodnih `salary_terms`, …
- **Sastanci:** notifikacije na insert/update akcija/sastanaka.

Kompletan spisak triggera na živoj bazi dobija se SQL-om (kao u MCP): `pg_trigger` join `pg_proc` / `pg_class`, bez sistemskih šema. Pri frontend promenama koja dira insert/update, **proveri da li postoji trigger** koji menja isti red ili šalje notifikacije.

---

## 5. State Management

- **Nema React Query / Redux.** Podaci: **async funkcije** u `src/services/*.js` koje pozivaju **`sbReq()`** (`src/services/supabase.js`) — tanki `fetch` na PostgREST/RPC sa JWT iz `src/state/auth.js`.
- **Auth stanje:** `src/state/auth.js` — snapshot + `onAuthChange` pub/sub.
- **Uloga:** `src/services/userRoles.js` + `loadAndApplyUserRole` pri bootstrap-u (`main.js`).
- **Sesija:** localStorage (ključevi u `src/lib/constants.js`), kompatibilno sa starijim shell-om.

### `sbReq` (error handling)

- `sbReq` vraća **`null`** na HTTP/pars/mrežnu grešku (i odgovarajući oblik za `withCount` varijantu).
- **Pravilo:** u servisima, **odmah posle** `await sbReq(...)` uvek generisati rano izlaz ako nema podataka, npr. `if (data == null) return null;` / `if (!rows) { showToast?; return; }` — da se izbegne `Uncaught TypeError: cannot read properties of null` u lancu poziva.
- Isti pattern za **lance** (više `sbReq` zaredom): proveri svaki korak pre pristupa poljima.

---

## 6. Authentication Flow

1. `restoreSession()` (`src/services/auth.js`) učitava token iz storage-a, refresh po potrebi.
2. Login: direktan `fetch` na `/auth/v1/token?grant_type=password`; user + token u `state/auth.js`.
3. `sbReq` šalje `Authorization: Bearer <access_token>` ili anon ključ.
4. Reset lozinke: ruta `/reset-password`, fragment/query obrada u auth modulu.
5. **Role** dolazi iz DB (`user_roles`), ne iz JWT metapodataka kao jedini izvor.

---

## 7. Development Standards

- **Moduli:** UI po folderima ispod `src/ui/`; zajednička logika u `src/services/` i `src/lib/`.
- **Konvencija novih UI delova (vanilla):** novi modul = **novi folder** ispod `src/ui/`. Folder **mora** imati `index.js` kao entry (mount/render). Stil: po potrebi **CSS fajl istog bazičnog imena** kao modul (npr. `planMontaze.css`) uvezen **na vrhu** entry fajla (uskladiti sa susednim modulima u repou).
- **Supabase:** koristi **`sbReq`** i postojeće servise; ne uvodi `supabase-js` u glavni bundle bez razloga (worker je izuzetak).
- **BigTehn cache vs upis:** tabele `bigtehn_*_cache` tretirati kao **read-only** sa klijenta — **nema** `INSERT`/`UPDATE` direktno u te tabele iz frontenda. Sinhronizacija je van app-a (worker/backfill). Lokalne izmene MES modela idu kroz **`production_overlays`**, **`production_drawings`**, druge dozvoljene tabele ili **RPC** funkcije, ne kroz cache.
- **JSDoc i tipovi:** u `src/services/*.js` za **svaku novu** izvezenu funkciju dodati JSDoc sa **`@param`** i **`@returns`**, referencirajući tipove iz `src/types/supabase-generated.d.ts` (i postojeće `src/types/*.js` gde treba) — npr. `/** @param {import('...').Row} x */` ili `Database['public']['Tables']['...']` u `.d.ts`.
- **Mobilni shell (`/m`, `src/ui/mobile/`):** ne oslanjati se na `window.open` niti na kompleksne hover interakcije kao primarni UX. Za skeniranje u native (Capacitor) koristiti postojeći sloj: **`src/services/nativeBarcode.js`** (`@capacitor-mlkit/barcode-scanning`); web skener u ostatku app-a ostaje odvojen (npr. ZXing u modulima kao `scanModal`).
- **Tipovi (opšte):** gde postoji, koristi generisane tipove iz **`gen:db-types`** / ručne `src/types/*`; izbegavaj “magične” stringove za RPC bez centralizacije.
- **RBAC:** provere i na backend-u (RLS/RPC); UI samo odražava.
- **Rute:** ne lomi `/pracenje-proizvodnje`, `?predmet=`, `?rn=`, hash tabove za praćenje.
- **Tajne:** nikad `service_role` u frontendu.
- **Izvozi:** PDF/Excel moraju da prate isti model kao ekran (Bugbot).
- **Performanse:** izbegavaj N+1 RPC poziva.

---

## 8. Known Patterns & Pitfalls

1. **Aktivni predmeti** — lista mora ići kroz **`get_aktivni_predmeti()`** i **`predmet_aktivacija.je_aktivan`**; ne mešati automatski MES listu aktivnih RN (`v_active_bigtehn_work_orders`) u tu listu.
2. **Praćenje — završne količine** — samo iz finalne kontrole; ne zaključivati iz “poslednje operacije” osim ako eksplicitno označeno.
3. **Napomene u praćenju** — ne pišu se u BigTehn cache; **admin + menadžment**; validacija na backend-u.
4. **`sbReq` vraća `null` na grešku** — odmah nakon poziva: `if (!data) return ...`; nikad pristup poljima bez provere (izbegni `TypeError` na `null`).
5. **Triggeri** — insert u `bigtehn_items_cache` i mnoge maint/lokacije tabele pokreću side-effecte; testiraj i Edge/cron obaveštenja.
6. **Dva izvora istine za Edge funkcije** — MCP lista deployovanih funkcija može da se razlikuje od `supabase/functions/` u gitu; pre izmene frontenda koji zove funkciju, proveri oba.
7. **Worker `loc-sync-mssql`** — koristi **service role** samo u secure okruženju; ne kopiraj pattern u Vite klijent.

---

## 9. Design Language & UI Patterns

Vizuelna konzistentnost: **industrial** tema, IBM Plex, Servoteh akcent; izvor tokena u kodu je **`src/styles/legacy.css`** (`:root` / `[data-theme="light|dark"]`), uz dopunske fajlove `src/styles/planProizvodnje.css`, `maintenance.css`, `sastanci.css`, `mobile.css`. Ne postoji odvojen `vars.css` — nove promenljive dodavati uz postojeće imenovanje.

### 9.1 CSS filozofija (globalno vs lokalno)

- **Globalno:** boje, razmaci, senke, font — **isključivo preko CSS varijabli** iz `legacy.css` (npr. `var(--bg)`, `var(--surface)`, `var(--accent)`, `var(--text)`, `var(--border)`). Ne uvoditi nasumične HEX vrednosti u novom kodu ako već postoji token; modulski CSS sme da dodaje samo layout/modul-specifične pravila.
- **Lokalno:** modulski `.css` fajl za posebne komponente (npr. sastanci), u skladu sa tokenima iznad.

### 9.2 Layout struktura

- Stranica modula: **header** (naslov + primarne akcije) → **tabovi** (ako postoje) **odmah ispod headera** → **main** (scrollabilan sadržaj, tabele, paneli) → **footer** po potrebi (status, sume, paginacija).
- Unutar main-a često `.table-wrap` za horizontalni scroll širokih tabela (`legacy.css`).

### 9.3 Komponente (standardi)

- **Tabele:** semantički `<table>`; široki layout u **`.table-wrap`**; region-specifične klase već postoje (npr. `.kadrovska-table`, `.gantt-table`, `.grid-table`). **Akcije** (izmena / brisanje / …) držati u **poslednjoj koloni** (vidi npr. `.col-actions` u kadrovskoj). Za nove, dosledne MES tabele po uzoru na ostatak app-a — izbegavati “čisti” HTML table bez postojećih utility klasa.
- **Dijalozi / potvrde:** izbegavati `window.alert` / `window.confirm` u **novom** kodu; koristiti postojeće obrasce (**`modal-overlay` / `modal-panel`**, **`kadr-modal`**, **`emp-modal`**, ili modulski modal kao u Plan montaže / Plan proizvodnje) i **`showToast()`** iz `src/lib/dom.js` za kratke poruke. (U legacy kodu još uvek postoje `alert` pozivi — novi moduli ih ne uvode.)
- **Form polja:** svako polje sa **`<label>`** (ili `aria-label`) i smislenim **`placeholder`** gde pomaže; fokus stanje **jasno vidljivo** — npr. `outline` / `border-color` preko **`var(--accent)`** (ili postojećih input klasa iz legacy).

### 9.4 Responzivnost (desktop-first i `/m`)

- **Primarni cilj:** desktop (~**1920×1080**), hala/kancelarija — gust tabele, hover na redovima gde ima smisla.
- **`/m/` (Capacitor):** odvojen UI u `src/ui/mobile/` + `mobile.css` — **jedna kolona**, veliki touch targeti; ne mešati desktop raspored u mobilni shell.

### 9.5 Ikonice

- Nema centralnog `icons.js` ni Font Awesome / Lucide u bundle-u. U praksi: **inline SVG** u šablonima, Unicode simboli gde je već urađeno (npr. hub kartice), ili **`/icons/`** statički asseti za PWA. **Ne dodavati** nove eksterne icon biblioteke u module bez potrebe — držati se istog stila kao susedni fajlovi.

---

*Poslednji put ažurirano na osnovu repoa i Supabase MCP (projekat `fniruhsuotwsrjsbhrxd`).*
