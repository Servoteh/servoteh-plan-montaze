# HAP Fluid — sektor (referentna lista zaposlenih)

Ažurirano: **april 2026.** (operativno: Kadrovska mreža, obračun sati, grupisanje pored `Servoteh`).

U tabeli **`public.employees`**, vrednost **`department = 'HAP Fluid'`** treba da stoji **samo** za ove zaposlene (kako su usklađeni u `full_name` obliku **Prezime Ime** u bazi):

| Red | Ime (kao u obračunskoj listi) | Uloga / napomena | `full_name` u bazi (referenca) |
|-----|------------------------------|------------------|--------------------------------|
| 1 | Dragan Elek | — | `Elek Dragan` |
| 2 | Dragoslav Bajazetov | penzioner | `Bajazetov Dragoslav` (unesiti ako fali; vidi migraciju) |
| 3 | Duško Kostić | — | `Kostic Dusko` |
| 4 | Miloš Hajnal | — | `Hajnal Milos` |
| 5 | Nebojša Lukić | — | `Lukić Nebojša` |
| 6 | Nevena Knežević | — | `Knezevic Nevena` |
| 7 | **Nikola Savić** | **komercijalista** (zamenio Petra Vaskovića) | `Savić Nikola` — `position` **Komercijalista** |
| 8 | Stefan Mirić | — | `Mirić Stefan` |
| 9 | Anđela Obrić | — | `Obric Andjela` |
| 10 | Jovan Blagojević | — | `Blagojevic Jovan` |

## Šta se više ne vodi pod HAP Fluid

- **Petar Vasković** — ne radi; **nije** na HAP listi. U bazi: `Vaskovic Petar` (ili varijanta dijakritike) — rešavati deaktivacijom (`is_active = false`) u dogovoru sa HR.
- **Janković Mihajlo** i **Radelić Uroš** bili su u starijoj uvezenoj evidenciji sa `HAP Fluid`; **nisu** na ovoj listi — sektor se u migraciji vraća na neutralni `Servoteh` (ručno proverite realan sektor ako treba drugačije).

## Plan proizvodnje (RN / predmet)

Filtar „HAP” po radnom nalogu u cache-u nije ista stvar kao sektor u `employees`. Tehnički opis: `sql/migrations/add_production_active_work_orders.sql` (npr. predmet/tekst, RN ≥ 8000).

## Kadrovska — „Firma: HAP Fluid” (mesečni pregled / grid)

U UI-ju, filter **Firma** je jednak koloni **`employees.department`**, ne tabeli uplate ili nečem trećem (`src/ui/kadrovska/gridTab.js`).

- **Janković Mihajlo** i **Radelić Uroš** su praktikanti i **ne treba** da budu u HAP listi: migracija
  `supabase/migrations/20260429120000__employees_remove_praktikanti_hap_fluid_firma.sql` ih prebacuje sa `HAP Fluid` na `Servoteh` (dijakritike u `full_name` i opciono `work_type = praksa`).
- Posle `supabase db push` (ili nalepljenja SQL u **Supabase → SQL**), u pregledu uradi **↻ Osveži** (ili ponovo učitaj stranicu).
- Ako u listi i dalje piše **HAP Fluid** za Jankovića / Radelića, migracija verovatno **nije bila uopšte pokrenuta** na bazi. Brzi ručni fix: `sql/manual/hap_fluid_ukloni_2_praktikanta_employees.sql` (nalepi u **Supabase → SQL** → *Run*), pa u app-u **↻ Osveži** na mesečnom gridu. U istom fajlu je (komentar) **fix po `id`** ako imena nisu ista.
- Aplikacija je keširala zaposlene u `localStorage` (stari `department`). Posle deploy-a sa **`plan_montaze_kadrovska_v2`** + grid poziva `ensureEmployeesLoaded(true)` vrednost se ponovo učitava sa mreže; uvek otvori mesečni grid ili Odeljenja zaposleni posle obnove builda.

## Sinhronizacija iz Excela (obračun)

U **`scripts/payroll_name_aliases.json`** postoji mapiranje koje Excel „Ime Prezime” spaja na `full_name` u bazi. Posle ažuriranja liste, ponovo generisati SQL sync ako treba: `python scripts/payroll_employee_sync.py …`
