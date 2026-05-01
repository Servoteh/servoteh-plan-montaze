# Projektni biro (PB) — modul

## Svrha

Interni alat za planiranje i praćenje inženjerskih zadataka po projektima: rokovi, dodela na `employees`, procena završenosti i opterećenje tima u prozoru od ~30 radnih dana.

## Uloge i RLS

| Akcija | Ko |
|--------|-----|
| Čitanje hub i modula | Svi prijavljeni |
| Čitanje `pb_tasks` / load RPC | `authenticated`, redovi sa `deleted_at IS NULL` |
| INSERT / UPDATE `pb_tasks`, `pb_work_reports` | `current_user_is_admin()` ili `has_edit_role()` (isto kao Kadrovska edit krug — PM/LeadPM/Menadžment/HR/admin). Implementacija u DB: `pb_can_edit_tasks()`. |
| DELETE `pb_work_reports` | Samo admin (`current_user_is_admin()`). |
| „Brisanje“ zadatka | Soft delete: `deleted_at` (nema DELETE politike na `pb_tasks`). |

**Napomena:** Posebna rola `pb_editor` nije uvedena u Sprint 1 jer je zabranjeno menjati `user_roles` bez posebne migracije širenja CHECK constraint-a.

## Tabele

- **`pb_tasks`** — glavni plan zadataka (FK na `projects`, `employees`). Enum-i: `pb_task_status`, `pb_task_vrsta`, `pb_prioritet`. Kolone `created_by` / `updated_by` puni klijent (email).
- **`pb_work_reports`** — placeholder za PB3 (slobodni dnevni sati van planiranih zadataka).

## RPC

- **`pb_get_load_stats(window_days integer DEFAULT 30)`** — agregat opterećenja po aktivnom zaposlenom (`SECURITY DEFINER`, `SET search_path = public, pg_temp`). `GRANT EXECUTE` samo `authenticated`.

## UI

| Fajl | Uloga |
|------|--------|
| `src/ui/pb/index.js` | Shell: projekat dropdown, chip filter inženjera, tab traka, FAB |
| `src/ui/pb/planTab.js` | Plan: statistike, alarmi, load meter, filteri, kartice / tabela |
| `src/ui/pb/kanbanTab.js` | Kanban: kolone po statusu, brza promena statusa, „+“ po koloni |
| `src/ui/pb/ganttTab.js` | Gantt: vremenska osa po inženjeru, plan vs real |
| `src/ui/pb/shared.js` | Modali, session state `pb_state_v1` |
| `src/services/pb.js` | REST/RPC pozivi (`quickUpdatePbTaskStatus` za Kanban) |
| `src/styles/pb.css` | Stilovi modula |

Ruta: **`/projektni-biro`** (History API).

### Kanban tab

Pet kolona: Nije počelo, U toku, Pregled, Blokirano, Završeno. Deljivi filteri sa modulom: projekat, inženjer, pretraga naziva, checkbox „Prikaži završene“ (iz Plan taba, sinhronizovano preko `pb_state_v1`). Filteri status/vrsta/prioritet iz Plan taba se u Kanbanu ne koriste. Kolona Završeno podrazumevano prikazuje samo završene zadatke čiji je datum završetka (real ili plan) u poslednjih 10 dana; link na dnu vodi na Plan sa uključenim „Prikaži završene“. Sa kartice: brza promena statusa (PATCH preko `quickUpdatePbTaskStatus`), „+“ otvara novi zadatak sa statusom kolone.

### Gantt tab

Opseg: od prvog dana izabranog meseca do kraja narednog meseca (~60 dana). Navigacija mesec ±, dugme „Danas“ skroluje horizontalno do današnjeg dana. Grupisanje po inženjeru (abecedno), na dnu „Bez inženjera“. Trake po `datum_pocetka_plan`–`datum_zavrsetka_plan`; ispod, ako postoje realni datumi, zelena traka ostvarenog perioda. Vertikalna linija „danas“. Klik na traku ili naziv zadatka otvara isti editor kao Plan. Drag-and-drop datuma nije u PB2.

## Integracije

- **Projekti:** `projects` — aktivni = `status != 'archived'` (isti princip kao `loadProjektiLite`).
- **Zaposleni:** `employees` — `is_active = true` za listu inženjera.

## Otvorena pitanja za PB3 / PB4

- **Izveštaji:** `pb_work_reports` UI (slobodni unos sati, kalendar).
- **Analiza** po projektu.
- Alarm notifikacije (email / WhatsApp).
- Opcioni **PB4:** drag-and-drop izmena datuma u Gantt prikazu.
