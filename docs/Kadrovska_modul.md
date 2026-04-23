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
| Mesečni grid | Excel-like unos sati/odsustava po danima; iznad tabele pretraga po imenu (klijent-side, sessionStorage) | `gridTab.js` | `grid.js` |
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

# ── Faza K3.3 — Tip rada / Tip zarade / Praznici / Mesečni payroll ────
add_kadr_work_type.sql           # employees.work_type ∈ ugovor|praksa|dualno|penzioner; v_employees_safe
add_kadr_holidays.sql            # tabela kadr_holidays + RLS + seed RS praznika za 2026 i 2027
add_kadr_salary_terms_v2.sql     # salary_terms.compensation_model + 9 polja iznosa po modelu (fiksno/dva_dela/satnica + teren)
add_kadr_absence_subtype.sql     # absences.absence_subtype + slobodan_reason; work_hours.absence_subtype (CHECK)
add_kadr_payroll_v2.sql          # salary_payroll: compensation_model + 15 obračunatih polja + warnings JSONB; updated view + RPC
```

> **Faza K3.3 — redosled primene:** `add_kadr_work_type.sql` → `add_kadr_holidays.sql` → `add_kadr_salary_terms_v2.sql` → `add_kadr_absence_subtype.sql` → `add_kadr_payroll_v2.sql`. Sve migracije su **aditivne i idempotentne**.

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

---

## Faza K3.3 — Tip rada, Tip zarade i Mesečni obračun

### Tip rada (`employees.work_type`)

| Vrednost      | Pravo na godišnji / slobodne dane / plaćeni praznici / plaćeno bolovanje |
|---------------|---------------------------------------------------------------------------|
| `ugovor`      | **DA** (puna prava) |
| `praksa`      | **NE** |
| `dualno`      | **NE** |
| `penzioner`   | **NE** |

UI: obavezno polje u modalu „Zaposleni" (`employeesTab.js`). Validacije se izvršavaju u:
- `absencesTab.js` (preko `validateAbsenceForWorkType()`),
- `gridTab.js` (toast i `cell-error` ako se pokuša upis `go/bo/sp/sl` za nedozvoljen tip rada),
- `payrollCalc.sanitizeHoursForWorkType()` (sat-kategorije se nuluju i upisuje warning).

### Tip zarade (`salary_terms.compensation_model`)

| Model       | Glavna polja u `salary_terms` | Formula |
|-------------|--------------------------------|---------|
| `fiksno`    | `fixed_amount`, `fixed_transport_component` (info), `fixed_extra_hour_rate` | **Ukupno = `fixed_amount` + `fixed_extra_hour_rate` × (prekov + praznik_rad + 2_mašine)** |
| `dva_dela`  | `first_part_amount`, `split_hour_rate`, `split_transport_amount` | **Ukupno = `first_part_amount` + `split_hour_rate` × payable_hours + `split_transport_amount`** |
| `satnica`   | `hourly_rate`, `hourly_transport_amount` | **Ukupno = `hourly_rate` × payable_hours + `hourly_transport_amount`** |

**Teren** (svuda): `terrain_domestic_rate × dani_u_zemlji` → RSD; `terrain_foreign_rate × dani_ino` → EUR (zaseban total).

**Bolovanje (svi modeli osim fiksno):** sati × satnica, gde se obično bolovanje ponderiše sa **0.65**, povreda na radu / održavanje trudnoće sa **1.00**. U `fiksno` modelu, ovi sati ne dodaju ništa preko `fixed_amount`.

**Rad na praznik / 2 mašine — `dva_dela` & `satnica`:** plaćeni su po **istoj ugovorenoj satnici** (`split_hour_rate` ili `hourly_rate`), ne primenjuje se nikakav dodatni koeficijent.

Heuristika za legacy redove: ako `compensation_model` nije postavljen, `payrollCalc.deriveCompensationModel()` mapira `salary_type='satnica' → 'satnica'`, `'ugovor'/'dogovor' → 'fiksno'`. UI „Zarade" preporučuje da se eksplicitno izabere model.

### Praznici (`kadr_holidays`)

Centralna tabela praznika sa CRUD-om (admin). Korišćena u:
- `payrollCalc.computeMonthlyFond()` — fond sati meseca,
- `salaryPayroll.aggregateHoursForEmployee()` — automatsko prepoznavanje rada/odsustva na praznik.

Seed: **RS praznici za 2026. i 2027. godinu** (`add_kadr_holidays.sql`). Za naredne godine treba samo `INSERT` u istu tabelu (ili UI modul kasnije).

### Single source of truth — `src/services/payrollCalc.js`

Sve formule žive u jednom modulu — pure funkcije bez I/O. Pokrivene `tests/services/payrollCalc.test.js` (14 testova, **6 acceptance scenarija + 8 edge case-eva**). UI, recompute i Excel export pozivaju isti `computeEarnings()`, što garantuje da se brojevi ne razilaze između prikaza i izveštaja.

### Mesečni obračun — UX (`Zarade → Mesečni obračun`)

1. **„+ Pripremi mesec"** → `kadr_payroll_init_month(y,m)` RPC — kreira draft red po aktivnom zaposlenom sa snimkom uslova.
2. **„⚙ Preračunaj iz sati"** (Faza K3.3) → `salaryPayroll.recomputeMonth(y,m)` agregira `work_hours` + `absences` + `kadr_holidays` i poziva `payrollCalc.computeEarnings()` za svaki red. Upisuje 15 obračunatih polja i `warnings` (JSONB).
3. **„📊 Excel"** → izvozi sve kolone uključujući `Sati za isplatu`, `Ukupna zarada`, `Preostalo za isplatu`, `Upozorenja`.

Negativan `Preostalo za isplatu` se prikazuje crveno i generiše warning u `warnings`.

### Izveštaji (Faza K3.3)

`reportsTab.js` ima dva nova sub-taba:

- **📋 Izveštaj o odsustvima** — filteri: mesec + tip (uključujući bolovanje subtype `obicno/povreda_na_radu/odrzavanje_trudnoce`). Excel kolone: `Zaposleni / Odeljenje / Tip rada / Tip odsustva / Detalj / Od / Do / Dana u mesecu / Napomena`.
- **💰 Obračun zarada** *(samo admin)* — agregat svih redova `salary_payroll` za izabrani mesec po formulama K3.3. Excel kolone: `Zaposleni / Odeljenje / Tip rada / Tip zarade (model) / Fond sati / Redovan / Prekov. / Praznik plaćeni / Praznik rad / Godišnji / Slobodni / Bolovanje 65% / Bolovanje 100% / 2 mašine / Sati za isplatu / Ukupna zarada / I deo / Preostalo / Tereni dom. (dani) / Tereni ino (dani) / Status / Upozorenja`.

### Mesečni grid — bolovanje subtype

Šifre u `Redovni` ćeliji:
- `bo` = obično bolovanje (65%)
- `bop` = povreda na radu (100%)
- `bot` = održavanje trudnoće (100%)

Internal storage: `work_hours.absence_code='bo'` + `absence_subtype ∈ {obicno|povreda_na_radu|odrzavanje_trudnoce}` (CHECK).

### Slobodan dan — strukturisan razlog

Modal „Odsustva" za tip `slobodan` traži obavezan `slobodan_reason ∈ {brak, rodjenje_deteta, selidba, smrt_clana_porodice, dobrovoljno_davanje_krvi, ostalo}`. Polje `note` ostaje za slobodan tekst.
