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
| `src/ui/pb/shared.js` | Modali, session state `pb_state_v1` |
| `src/services/pb.js` | REST/RPC pozivi |
| `src/styles/pb.css` | Stilovi modula |

Ruta: **`/projektni-biro`** (History API).

## Integracije

- **Projekti:** `projects` — aktivni = `status != 'archived'` (isti princip kao `loadProjektiLite`).
- **Zaposleni:** `employees` — `is_active = true` za listu inženjera.

## Otvoreno za PB2 / PB3

- Kanban tabla, Gantt, izveštaji sati (`pb_work_reports` UI), analitika, eventualna rola `pb_editor` u `user_roles`, eksplicitni PB-only editori bez šireg Kadrovska kruga.
