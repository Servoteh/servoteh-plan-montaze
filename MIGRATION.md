# Migracija — single-file `index.html` → Vite + ES modules

Ovaj dokument prati prelazak sa monolitne `legacy/index.html` aplikacije
na modularnu Vite + vanilla JS strukturu i sadrži cutover checklist za
production deploy na Cloudflare Pages.

## Pregled faza

| Faza | Tema | Status |
| ---: | --- | --- |
| F0 | Vite scaffold + env verifikacija | ✅ |
| F1 | CSS razdvajanje (`src/styles/legacy.css`) | ✅ |
| F2 | `lib/`, `services/`, `state/` ekstrakcija | ✅ |
| F3 | Auth + Module hub + Theme + Router | ✅ |
| F4 | Kadrovska modul (zaposleni + odsustva + sati + grid + ugovori + izveštaji) | ✅ |
| F5 | Plan Montaže modul (shell + tabela + mobilne kartice + gantt + total gantt + reminders + 3D + export) | ✅ |
| F5b | Podešavanja modul (Korisnici tab + Matični/Sistem placeholderi) | ✅ |
| F6 | Production cutover | ⏳ |

Sve "f"-faze su commit-ovane na `feature/vite-migration` granu kao
samostalni commiti — `git log --oneline feature/vite-migration` daje
istoriju.

## F6 — Production cutover

### Predzahtevi

- [ ] `npm run build` lokalno prolazi bez warning-a (`dist/` je ~225 KB JS, ~110 KB CSS).
- [ ] `npm run preview` na lokalu prolazi smoke test iz README → Testing.
- [ ] `.env` je popunjen sa pravim Supabase URL + anon key.
- [ ] U Supabase Dashboard, RLS politike na `user_roles`, `projects`,
      `work_packages`, `phases`, `employees`, `absences`, `work_hours`
      i `contracts` su aktivne i provežene (vidi `sql/migrations/`).

### Korak 1 — Cloudflare Pages projekt setup

Ako CF Pages projekt još uvek deployuje monolitni `index.html` direktno
sa main grane (bez build-a):

1. Cloudflare Dashboard → Workers & Pages → odgovarajući Pages projekt.
2. **Settings → Builds & deployments**:
   - **Production branch**: `main`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: `/` (ostavi prazno).
   - **Framework preset**: None.
3. **Settings → Environment variables**:
   - `NODE_VERSION = 20` (kao Production var).
   - `VITE_SUPABASE_URL` = `https://<project>.supabase.co` (Production +
     Preview).
   - `VITE_SUPABASE_ANON_KEY` = anon key (Production + Preview).
4. **Save**.

### Korak 2 — Staging deploy (preview na CF Pages)

1. Push trenutne `feature/vite-migration` grane na remote (već je gore).
2. CF Pages će automatski podići **preview deploy** za branch:
   `https://feature-vite-migration.<project>.pages.dev/`.
3. Otvori preview URL u privatnom prozoru i prođi smoke test iz README.
4. Posebno proveri:
   - Login + role lookup (admin/leadpm/pm/hr/viewer).
   - Plan Montaže drag/resize → "✔ Sačuvano" indikator (Supabase save
     radi).
   - Kadrovska mesečni grid → Excel-like cell edit + batch save.
   - Podešavanja → samo admin vidi karticu i listu.
   - `https://feature-vite-migration.<project>.pages.dev/legacy/` —
     legacy verzija je dostupna kao backup.

### Korak 3 — Side-by-side validacija (24–48 h)

Ostavi staging deploy aktivan dok production-a nema ovu verziju, pa
testiraj na realnim podacima sa pilot korisnicima:

- [ ] Pilot user 1 (admin) — sve module + Settings korisnici tab.
- [ ] Pilot user 2 (PM/leadpm) — Plan Montaže CRUD + total Gantt
      filteri + drag/resize.
- [ ] Pilot user 3 (HR) — Kadrovska tabovi + grid + reports XLSX.
- [ ] Sve role: theme toggle, hub, logout, session restore na refresh.
- [ ] Mobile sanity (iPhone/Android, portrait + landscape).
- [ ] Export modal — JSON/XLSX/PDF rade, JSON import vraća snapshot.

Ako pukne nešto kritično tokom validacije, korisnici se vraćaju ručno
na `/legacy/` URL bez deploya.

### Korak 4 — Cutover (merge u `main`)

```bash
# Na lokalnom checkout-u:
git checkout main
git pull --ff-only origin main
git merge --no-ff feature/vite-migration -m "feat: Vite migracija — production cutover"
git push origin main
```

CF Pages će izgraditi novi production deploy (~30 s).

Posle deploya:

- `https://<project>.pages.dev/` — nova Vite verzija (production).
- `https://<project>.pages.dev/legacy/` — arhivirana legacy verzija
  (i dalje deployovana, kao rollback).
- `Cache-Control: no-cache` na HTML znači da svi klijenti vide novu
  verziju kod sledećeg refresh-a (asseti su content-hash-ed pa se
  novi `index.html` automatski povezuje sa novim bundle-ovima).

### Korak 5 — Posle cutover-a

Tokom prve nedelje:

- [ ] Prati Supabase logs (PostgREST + Auth) na nepoznate greške.
- [ ] Prati CF Pages Functions/Edge logs ako budu uvedene.
- [ ] Sakupi feedback od pilot korisnika.

Ako sve radi 7+ dana stabilno:

- [ ] Obriši `public/legacy/` iz repo-a (legacy ostaje samo kao
      `legacy/index.html` arhivska referenca, više nije deployovana).
- [ ] Skini `_redirects` pravilo za `/legacy/*`.
- [ ] Razmotri brisanje cele `legacy/` reference (commit ostaje u
      git istoriji).

### Rollback (ako ide nešto totalno katastrofalno)

Najbrži rollback bez novog deploya:

1. Korisnici se ručno usmeravaju na `/legacy/` URL.
2. CF Pages → Deployments → izaberi prethodni production deploy →
   **"Rollback to this deployment"**.

Trajni rollback (vraćanje main grane):

```bash
git revert --no-edit <merge-commit-sha>
git push origin main
```

CF Pages će uraditi novi build na revert-u i production se vraća na
prethodno stanje.

## Bezbednosne odluke vredne pamćenja

1. **Nove user_role redove dodaje samo admin kroz Supabase SQL
   Editor.** UI dozvoljava samo `UPDATE` i `DELETE` postojećih.
   Razlog: dodavanje role pre nego što Auth nalog postoji = privilege
   eskalacija.
2. **RLS na `user_roles`** koristi `SECURITY DEFINER` funkcije
   (`current_user_is_admin()`, `get_my_user_roles()`) da izbegne
   beskonačnu rekurziju u policy-ima. Vidi
   `sql/migrations/enable_user_roles_rls_proper.sql` i
   `cleanup_user_roles_legacy_policies.sql`.
3. **Nikad ne logujemo password** u console.log, ne stavljamo ga u
   query parametre, ne committujemo `.env`. Supabase Auth čuva samo
   bcrypt hash; aplikacija ga nikad ne dotakne.
4. **`localStorage`/`sessionStorage` ključevi su zamrznuti** —
   bit-paritetni sa legacy-jem. Cutover ne resetuje korisničke
   teme, hub state, kadrovske cache-eve, plan cache.
