# Servoteh ERP — Plan Montaže + Kadrovska + Podešavanja

Modularna Vite + vanilla JS aplikacija za:

- **Plan Montaže** — projekti → work packages → faze, Gantt, mobilne kartice, total Gantt, reminders, 3D model panel, eksport (JSON/XLSX/PDF).
- **Kadrovska** — zaposleni, odsustva, mesečni grid (Excel-like), sati pojedinačno, ugovori, izveštaji (bolovanja).
- **Podešavanja** — korisnici / uloge (admin only), placeholderi za matične podatke i sistem.

Backend: Supabase (Auth + Postgres + RLS).

**Lokacije delova:** [docs/Lokacije_modul.md](docs/Lokacije_modul.md) · **Kadrovska:** [docs/Kadrovska_modul.md](docs/Kadrovska_modul.md) · **Planiranje proizvodnje:** [docs/Planiranje_proizvodnje_modul.md](docs/Planiranje_proizvodnje_modul.md)

---

## Tech stack

- **Vite 5** (build + dev server, ES modules)
- **Vanilla JS** (bez framework-a, bez TypeScript-a) — sve preko `addEventListener`
- **Supabase REST API** (`sbReq` wrapper, `Authorization: Bearer <jwt>`)
- **localStorage / sessionStorage** za cache, theme, hub state, role cache itd.
- **CDN lazy load** za XLSX (SheetJS), PDF (jsPDF + html2canvas)

Struktura izvora:

```
src/
  main.js                    # bootstrap (theme, auth restore, router)
  lib/                       # constants, dom, date, storage, theme, xlsx, pdf, phase, gantt
  services/                  # supabase, auth, employees, absences, workHours, contracts,
                             # grid, projects, plan, users, userRoles
  state/                     # auth, kadrovska, planMontaze, users
  styles/legacy.css          # SVE stilove (port iz legacy/index.html)
  ui/
    auth/loginScreen.js
    hub/moduleHub.js
    router.js
    kadrovska/               # employees / absences / workHours / contracts / grid / reports tabovi
    planMontaze/             # shell, projectBar, planTable, mobileCards, gantt, totalGantt,
                             # reminderZone, statusPanel, modelDialog, reminderModal, exportModal
    podesavanja/             # users tab + matični/sistem placeholderi
legacy/index.html            # arhivirana monolitna verzija (referenca, NE bundle-uje se)
public/
  legacy/index.html          # kopija legacy verzije za rollback bez novog deploya
  _redirects                 # Cloudflare Pages SPA fallback
  _headers                   # CF Pages cache + security header-i
sql/migrations/              # SQL migracije (ručno izvršavanje u Supabase SQL Editor-u)
```

---

## Setup (lokalno)

1. **Klonirati repo** i instalirati Node 18+.
2. **Instalirati zavisnosti**:

   ```bash
   npm install
   ```

3. **Kopiraj `.env.example` u `.env`** i popuni sa vrednostima iz Supabase Dashboard
   (`Settings → API → Project URL` i `Project API keys → anon public`):

   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJ...
   ```

4. **Pokreni dev server**:

   ```bash
   npm run dev
   ```

   Otvori http://localhost:5173/.

   Napomena za Windows + PowerShell: ako `npm run dev` ne prolazi zbog
   "execution policy", pokreni `cmd.exe` umesto PowerShell-a, ili podigni
   policy: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

5. **Build za produkciju**:

   ```bash
   npm run build      # → dist/
   npm run preview    # statički preview dist-a na :4173
   ```

---

## Deploy — Cloudflare Pages

Build settings na CF Pages projektu:

| Polje | Vrednost |
| --- | --- |
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `20` (env var `NODE_VERSION=20`) |

Environment variables (na **Production** i **Preview** scope-u):

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Posle prvog deploya:

- `https://servoteh-plan-montaze.pages.dev/` — nova Vite verzija
- `https://servoteh-plan-montaze.pages.dev/legacy/` — arhivirana
  monolitna verzija (rollback bez novog deploya, vidi MIGRATION.md)

`public/_redirects` rewriteuje sve ne-asset rute na `/index.html` (SPA),
a `public/_headers` postavlja `no-cache` na HTML i `immutable` na
`/assets/*` (jer Vite dodaje content-hash u imena).

---

## Supabase

SQL šeme i migracije su u `sql/`:

- `sql/schema.sql` — početna šema (projects, work_packages, phases,
  user_roles, reminder_log).
- `sql/migrations/*.sql` — inkrementalne migracije (Kadrovska Phase 1,
  attendance grid, work extras, user_roles RLS hardening...).

Migracije se izvršavaju **ručno** u Supabase Dashboard → SQL Editor.

### Role hijerarhija

`admin > leadpm > pm > hr > viewer`

- `admin` — full pristup, jedini koji vidi modul Podešavanja.
- `leadpm` — full edit Plan Montaže.
- `pm` — edit Plan Montaže (svoji projekti).
- `hr` — full pristup Kadrovska.
- `viewer` — read-only.

Role se dodaju **isključivo kroz Supabase SQL Editor** (audit-trail):

```sql
INSERT INTO user_roles (email, role, is_active, full_name, team)
VALUES ('novi.kolega@servoteh.com', 'pm', true, 'Ime Prezime', 'Tim X');
```

UI dozvoljava admine da menjaju i brišu postojeće redove, ali ne može
da kreira nove (to je svesna bezbednosna odluka — vidi
`src/services/users.js`).

---

## Testing

Trenutno nema automatizovanog test suite-a. Smoke test pre cutover-a:

1. Login sa admin nalogom → hub → svi moduli (Plan, Kadrovska,
   Podešavanja) se otvaraju.
2. Plan Montaže → izaberi projekat → Plan tab, Gantt tab, Total Gantt
   tab. Drag/resize Gantt bar-a snima u Supabase (status panel
   pokazuje "✔ Sačuvano").
3. Kadrovska → svi tabovi rade, mesečni grid radi batch upsert.
4. Podešavanja → Korisnici → edit role / activate-deactivate radi (samo
   admin vidi).
5. Logout → login kao `pm`/`hr`/`viewer` — dostupni samo dozvoljeni
   moduli.
6. Export modal → JSON/XLSX/PDF radi. JSON import vraća snapshot.

---

## Migracija sa legacy-a

Istorija + cutover checklist su u [`MIGRATION.md`](./MIGRATION.md).
