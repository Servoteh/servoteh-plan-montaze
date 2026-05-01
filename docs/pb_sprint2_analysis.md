# PB Sprint 2 — analiza (pre implementacije)

## A1. `src/ui/pb/index.js` i `shared.js`

- **Tabovi:** HTML u `paintChrome()`: `<nav class="pb-tabs">` sa dugmadima `data-pb-tab="plan"|kanban|gantt|izvestaji|analiza`. Kontejner sadržaja: **`#pbTabBody`** (`<main id="pbTabBody" class="pb-tab-body">`).
- **Switch:** Nema odvojene funkcije `switchTab()` — klik na `.pb-tab-btn` postavlja `state.activeTab`, `savePbState(state)`, zatim `paintChrome()` + **`mountActiveTab()`**.
- **PB1:** Za kanban/gantt je bio **placeholder** „Coming soon” u `mountActiveTab()`.

## A2. `planTab.js`

- **Filtri:** Lokalni objekat `filters` (`search`, `status`, `vrsta`, `prioritet`, `showDone`, `problemOnly`). **`filtered()`** poziva `filterTasks(ctx.tasks, filters)`.
- **Podaci:** Iz **`ctx.tasks`** (učitano u `index.js` preko `getPbTasks` sa filterom projekat/inženjer).
- **Render:** Jedan `paint()` koji puni **`innerHTML`** (kartice + tabela).

## A3. `src/services/pb.js`

- **`getPbTasks`:** Mapira `project_code`, `project_name`, `engineer_name` sa embeda.
- **`updatePbTask(id, data)`:** PATCH na `pb_tasks`, `sanitizeTaskPayload`, `updated_by` iz sesije.
- Za PB2: **`quickUpdatePbTaskStatus`** — tanak PATCH samo `status` + `updated_by`; pri grešci prava → toast (HTTP status iz odgovora).

## A4. CSS

- Modul koristi **`src/styles/pb.css`** i legacy token-e (`--accent`, `--border`, `--surface`, `--text`, `--status-done`, itd.). Nove sekcije: Kanban kolone, Gantt grid — isti tokeni, bez novog „design sistema”.
