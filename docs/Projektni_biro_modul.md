# Projektni biro (PB) — modul

## Svrha

Interni alat za planiranje i praćenje inženjerskih zadataka po projektima: rokovi, dodela na `employees`, procena završenosti i opterećenje tima u prozoru od ~30 radnih dana.

## Uloge i RLS

| Uloga / atribut | `pb_tasks` | `pb_work_reports` |
|-----------------|------------|---------------------|
| **admin** | Čitanje + `pb_can_edit_tasks()` za pisanje | SELECT / INSERT / UPDATE / DELETE sve (admin); brisanje tuđih moguće |
| **leadpm**, **pm**, **menadzment** (globalno u `user_roles`) | Čitanje + `pb_can_edit_tasks()` | SELECT / INSERT / UPDATE sve redove |
| **Rukovodstvo inženjeringa** (*) | Čitanje + `pb_can_edit_tasks()` ako ima ulogu | SELECT / INSERT / UPDATE sve redove |
| **Ostali sa `pb_can_edit_tasks()`** (npr. **hr**) | Čitanje + pisanje | Samo **svoji** redovi (INSERT/UPDATE/DELETE po `employee_id` = svoj `employees.id`) |
| **viewer** (bez edit prava) | Samo čitanje zadataka | Samo čitanje **svojih** redova ako postoji `employees` red za JWT email; inače prazno |

(*) **Rukovodstvo inženjeringa** — određuje se po **`sub_departments.name`** (seed u `add_kadr_org_structure.sql`: tačno **„Rukovodstvo inženjeringa“**), preko `employees.sub_department_id`, ne po `user_roles`.

**Detalji PB4:** helper funkcije `pb_current_user_can_see_all_reports()`, `pb_current_employee_id()`, politike `pb_work_reports_*` u `sql/migrations/add_pb4_rls_and_agg.sql`.

### Starija matrica (PB1–PB3)

| Akcija | Ko |
|--------|-----|
| Čitanje hub i modula | Svi prijavljeni |
| Čitanje `pb_tasks` / load RPC | `authenticated`, redovi sa `deleted_at IS NULL` |
| INSERT / UPDATE `pb_tasks` | `pb_can_edit_tasks()` |
| DELETE `pb_work_reports` (pre PB4) | Autor ili admin — zamenjeno PB4 politikama |

## Tabele

- **`pb_tasks`** — glavni plan zadataka (FK na `projects`, `employees`). Enum-i: `pb_task_status`, `pb_task_vrsta`, `pb_prioritet`. Kolone `created_by` / `updated_by` puni klijent (email).
- **`pb_work_reports`** — slobodni dnevni izveštaji sati van planiranih zadataka (`datum`, `sati`, `opis`, `created_by`).
- **`pb_notification_log`** — outbox email/WhatsApp notifikacija (status `pending` → `processing` → `sent` / `failed` / `dead_letter`).
- **`pb_notification_config`** — singleton (`id = 1`) pragovi i liste primalaca.

## RPC

- **`pb_get_load_stats(window_days integer DEFAULT 30)`** — agregat opterećenja po aktivnom zaposlenom (`SECURITY DEFINER`, `SET search_path = public, pg_temp`). `GRANT EXECUTE` samo `authenticated`. **Load meter u UI-ju:** samo zaposleni iz pododeljenja **„Mašinsko projektovanje“** unutar odeljenja **„Inženjering i projektovanje“** (`employees.sub_department_id`); ako FK nije podešen, fallback na tekstualno `employees.department` koje sadrži „projektovanje“ i („mašinsko“ ili „masinski“).
- **`pb_get_mechanical_projecting_engineers()`** — `TABLE(id, full_name, department, email)` lista aktivnih zaposlenih za **isti skup** kao load meter (filter čipovi „Projektanti“ i padajuća lista inženjera u modau). `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `GRANT EXECUTE` `authenticated`.
- **`pb_enqueue_notifications()`** — puni `pb_notification_log` iz `pb_tasks` + `pb_get_load_stats` prema config-u. **`GRANT EXECUTE` samo `service_role`** (cron).
- **`pb_dispatch_dequeue(batch_size)`**, **`pb_dispatch_mark_sent(id)`**, **`pb_dispatch_mark_failed(id, error)`** — za Edge worker; samo **`service_role`**.

### PB4 — dodatni RPC i helper-i (`sql/migrations/add_pb4_rls_and_agg.sql`)

Produkcija (Supabase): migracija **primljena** na projekat (isti SQL kao u repou).

- **`pb_current_employee_id()`** — UUID iz `employees` za JWT email (`SECURITY DEFINER`).
- **`pb_engineering_lead_by_subdept()`** — da li je zaposleni u pododeljenju čije je ime „Rukovodstvo inženjeringa“ (join `sub_departments`).
- **`pb_current_user_can_see_all_reports()`** — admin ili globalni leadpm/pm/menadzment ili rukovodstvo pododeljenja.
- **`pb_get_work_report_summary(p_date_from date, p_date_to date, p_employee_id uuid DEFAULT NULL)`** — agregat za Izveštaji obračun (`report_count`, `total_hours` po zaposlenom), ista pravila vidljivosti kao RLS.

### Notifikacije (PB3)

- **Tipovi:** `deadline_warning`, `deadline_overdue`, `no_engineer`, `overload`, `task_blocked` (vrednosti u koloni `trigger_type`).
- **Edge:** `supabase/functions/pb-notify-dispatch` — batch dequeue, Resend za `channel=email`, WhatsApp preskočen (označeno sent). Poziv sa **service_role** JWT; header **`X-Audit-Actor`** se loguje.
- **pg_cron:** u migraciji `cron.schedule('pb-enqueue-notifications', '0 7 * * *', …)` — ako `cron` ekstenzija ne postoji, blok preskočen (`NOTICE`). Na Supabase proveriti duplikat job-a pre primene.

## UI

| Fajl | Uloga |
|------|--------|
| `src/ui/pb/index.js` | Shell: tabovi uključujući Izveštaji, Analiza, ⚙ Podešavanja (admin) |
| `src/ui/pb/planTab.js` | Plan: statistike, alarmi, load meter, filteri, kartice / tabela |
| `src/ui/pb/kanbanTab.js` | Kanban |
| `src/ui/pb/ganttTab.js` | Gantt |
| `src/ui/pb/izvestajiTab.js` | Kalendar, unos `pb_work_reports`, obračun |
| `src/ui/pb/analizaTab.js` | Dashboard po projektu, problemi |
| `src/ui/pb/podesavanjaTab.js` | Admin: `pb_notification_config` |
| `src/ui/pb/izvestajiObracun.js` | Helpers za filter/sume (deljeno sa testovima) |
| `src/ui/pb/shared.js` | Modali, session state `pb_state_v1` |
| `src/services/pb.js` | REST/RPC |
| `src/styles/pb.css` | Stilovi modula |

Ruta: **`/projektni-biro`** (History API).

### Izveštaji tab

Mesečni kalendar (indikator sati po danu), forma za izabrani dan (inženjer, sati 0.5–12, opis, opcioni Web Speech API), lista unosa za dan. **Učitavanje:** REST `getPbWorkReports` samo za **tekući prikazani mesec** (datum od–do). **Obračun po periodu:** RPC **`pb_get_work_report_summary`** (server-side agregat).

### Analiza tab

Selektor projekta (samo projekti koji imaju bar jedan zadatak), četiri kartice statistike, timeline najraniji–najkasniji plan datumi, breakdown po inženjeru, sortirana lista zadataka, sekcija aktivnih problema ako `problem` nije prazan.

### Kanban tab

Pet kolona: Nije počelo, U toku, Pregled, Blokirano, Završeno. Deljivi filteri sa modulom: projekat, inženjer, pretraga naziva, checkbox „Prikaži završene“ (iz Plan taba, sinhronizovano preko `pb_state_v1`). Filteri status/vrsta/prioritet iz Plan taba se u Kanbanu ne koriste. Kolona Završeno podrazumevano prikazuje samo završene zadatke čiji je datum završetka (real ili plan) u poslednjih 10 dana; link na dnu vodi na Plan sa uključenim „Prikaži završene“. Sa kartice: brza promena statusa (PATCH preko `quickUpdatePbTaskStatus`), „+“ otvara novi zadatak sa statusom kolone.

### Gantt tab

Opseg: od prvog dana izabranog meseca do kraja narednog meseca (~60 dana). Navigacija mesec ±, dugme „Danas“ skroluje horizontalno do današnjeg dana. Grupisanje po inženjeru (abecedno), na dnu „Bez inženjera“. Trake po `datum_pocetka_plan`–`datum_zavrsetka_plan`; ispod, ako postoje realni datumi, zelena traka ostvarenog perioda. Vertikalna linija „danas“. Klik na traku ili naziv zadatka otvara isti editor kao Plan. **PB4:** delegacija klikova na korenski `root` + `AbortController` (bez akumulacije listenera). Drag-and-drop datuma nije u PB2.

## Integracije

- **Projekti:** `projects` — aktivni = `status != 'archived'` (isti princip kao `loadProjektiLite`).
- **Zaposleni:** `employees` — `is_active = true` za listu inženjera.

## Potencijalni sledeći feature-i (nakon PB4)

- Drag-and-drop izmena datuma u Gantt prikazu.
- WhatsApp kanal u dispatch-u (trenutno skip).
- Dnevni/nedeljni rezime email po inženjeru.
- Export plana u PDF ili Excel.
- Integracija RN brojeva iz BigTehn-a kao projekti.
