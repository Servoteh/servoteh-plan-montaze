# Kadrovska — dokumentacija

**Jedini aktuelni dokument za modul u repou.** Tehnički detalji kolona i RLS: `sql/migrations/add_kadrovska_*.sql`, `add_kadr_*.sql`. Kod: `src/ui/kadrovska/`, `src/state/kadrovska.js`, `src/state/auth.js`.

---

## Uloga modula

Interna **kadrovska evidencija**: zaposleni, odsustva, godišnji odmor, mesečni grid sati, pojedinačni sati, ugovori, izveštaji. **Zarade** (uslovi + mesečni obračun) i povezani podaci su **strogo za admina**. **Notifikacije** (HR alerti — email/WhatsApp) su integrisane preko Supabase Edge funkcije i baze.

Stack modula: **Vite + vanilla JS** (bez React-a), REST preko `sbReq`, keš u `localStorage` / `sessionStorage` gde je označeno u kodu.

---

## Ko sme šta (uloge)

Izvor: `src/state/auth.js` + `src/ui/kadrovska/shared.js` + tabovi (`canEditKadrovska`, `canEditKadrovskaGrid`, …).

| Rola | Ulaz u modul | Tabovi | CRUD zaposleni / odsustva / GO / ugovori | Mesečni grid (sati) | Zarade |
|------|----------------|--------|------------------------------------------|---------------------|--------|
| **admin** | da | svi uključujući Zarade | da | da | da |
| **hr** | da | svi osim Zarade | da | da | ne |
| **leadpm**, **pm** | da | svi osim Zarade | da | da | ne |
| **menadzment** | da | **samo „Mesečni grid"** (ostali tabovi skriveni) | ne (read-only na ostalo nije dostupno jer nema tabova) | da | ne |
| **viewer** | obično ne; ako nema `canAccessKadrovska` — nema pristup | — | — | — | ne |

Osetljiva polja zaposlenog (JMBG, adresa, račun, deca, …): **`isHrOrAdmin()`** — praktično **HR ili admin** u UI.

---

## Tabovi i fajlovi

Aktivni tab modula: **`SESSION_KEYS.KADR_TAB`** → `plan_montaze_kadr_active_tab_v1`. Pri **svakom ulasku** u modul UI forsira **Mesečni grid** kao početni tab (`index.js`).

| Tab | Sadržaj | UI | Servisi (tipično) |
|-----|---------|-----|-------------------|
| Zaposleni | CRUD, filteri, osetljiva polja po pravu | `employeesTab.js` | `employees.js`, `kadrovska.js`, `employeeChildren.js` |
| Odsustva | Tipovi odsustva, kalendari | `absencesTab.js` | `absences.js` |
| Godišnji odmor | Entitlementi, saldo, štampa rešenja | `vacationTab.js` | `vacation.js` |
| Mesečni grid | Excel-like unos sati/odsustava po danima | `gridTab.js` | `grid.js` |
| Sati (pojedinačno) | Detaljni unos sati | `workHoursTab.js` | `workHours.js` |
| Ugovori | Ugovori o radu | `contractsTab.js` | `contracts.js` |
| **Zarade** | Samo admin; sub-tabovi **Uslovi** / **Mesečni obračun** (`pm_salary_subtab`) | `salaryTab.js`, `salaryPayrollTab.js` | `salary.js`, `salaryPayroll.js` |
| Notifikacije | Konfiguracija + log queue, skeniranje | `hrNotificationsTab.js` | `hrNotifications.js` |
| Izveštaji | Demografija, GO, deca, … | `reportsTab.js` | više servisa + agregacije |

Zajednički UI: **`shared.js`** (header, tab strip, opcije zaposlenih), **`comingSoon.js`** za rezervisana mesta ako ih još nema.

---

## Faze u bazi (migracije — redosled)

Primeni u Supabase SQL Editoru **redom zavisnosti** (komentari u fajlovima su autoritativni ako nešto pukne).

```text
add_kadrovska_module.sql          # employees
add_kadrovska_phase1.sql         # absences, work_hours, contracts
add_kadrovska_phase1_rules.sql   # pravila na contracts (date_from, …)
add_kadr_employee_extended.sql   # K2: proširenje employees, deca, GO (vacation_entitlements, view salda)
add_kadr_salary_terms.sql        # K3: salary_terms, v_employee_current_salary, RLS admin
add_kadr_salary_payroll.sql      # K3.2: salary_payroll, kadr_payroll_init_month, view obračuna
add_kadr_notifications.sql       # K4: kadr_notification_config, kadr_notification_log, cron/dispatch
```

Zavisnosti izvan ovog lanca (npr. `user_roles`, `add_admin_roles.sql`) moraju već postojati ako migracija to zahteva.

---

## Deploy (kratko)

### SQL

Pokreni migracije iz sekcije iznad. Verifikacija (primeri):

```sql
SELECT count(*) FROM salary_terms;
SELECT count(*) FROM salary_payroll;
SELECT * FROM kadr_notification_config LIMIT 1;
```

### pg_cron / raspored

Migracija notifikacija može registrovati dnevni job (`kadr_schedule_hr_reminders_daily`). Ako **pg_cron** nije uključen: Dashboard → Extensions, ili **Scheduled Triggers** / eksterni cron koji poziva `SELECT public.kadr_schedule_hr_reminders();`.

### Edge funkcija `hr-notify-dispatch`

```bash
supabase functions deploy hr-notify-dispatch --no-verify-jwt
```

Secrets (opciono — bez njih često **DRY-RUN**): `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANG`, `RESEND_API_KEY`, `RESEND_FROM`, `HR_DISPATCH_BATCH`. Detalji i template tekst: `supabase/functions/hr-notify-dispatch/README.md`.

Cron za dispatch (npr. svakih 5 min): HTTP POST na URL funkcije sa **service role** ključem (vidi raniji deploy vodič u git istoriji ako treba pun primer).

### Frontend

`npm ci && npm run build` — artefakti u `dist/` za Cloudflare Pages ili drugi hosting.

### Brzi E2E checklist

1. **HR**: vidi Kadrovsku, nema tab **Zarade**; može unos u grid / zaposlene (po pravilima iznad).
2. **Admin**: vidi **Zarade** — uslov + (opciono) pripremi mesec obračuna, Excel export.
3. **Menadžment**: samo **Mesečni grid**, bez ostalih tabova.
4. Notifikacije: podešavanja + „Skeniraj sada”; proveri log / Edge logs.

---

## Rollback

Ne vraćati produkciju bez potrebe. Za ručni rollback SQL (DROP funkcija/tabela po fazama) koristi **git istoriju** migracija i eventualno reverz komentare na dnu `add_kadr_*.sql` fajlova ako postoje.

---

## Konvencije

- Uloge iz **`user_roles`**; efektivna rola kroz `effectiveRoleFromMatches` u `src/services/userRoles.js`.
- **`STORAGE_KEYS` / `SESSION_KEYS`** u `src/lib/constants.js` — ne menjaj ključeve bez namere (kompatibilnost keša).
