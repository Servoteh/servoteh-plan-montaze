# Planiranje proizvodnje — dokumentacija

**Jedan aktuelni dokument za modul u repou.** Izvor u kodu: `src/ui/planProizvodnje/`, `src/services/planProizvodnje.js`, `src/state/auth.js`, stilovi `src/styles/planProizvodnje.css`. Baza: `sql/migrations/add_plan_proizvodnje.sql`, `add_v_production_operations.sql`, `add_plan_proizvodnje_menadzment_edit.sql`, bucket `production-drawings`.

---

## Uloga modula

**Operativni plan šinskog obrade:** prikaz otvorenih operacija iz BigTehn cache-a (radni nalozi, stavke, mašine), lokalno **raspoređivanje po mašini** (prioritet), **status** (waiting / in_progress / blocked; `completed` dolazi iz BigTehn sync-a), **šefova napomena**, **REASSIGN** operacije na drugu mašinu, **skice** (fajlovi u Storage). Podaci iz overlay tabela **ne idu nazad u BigTehn** — BigTehn ostaje izvor istine za RN/tehnologiju; ovde se vodi samo „šta šef trenutno planira na mašini”.

---

## Pristup i uloge

| Funkcija | Pravilo |
|----------|---------|
| Ulaz u modul | `canAccessPlanProizvodnje()` — **admin, leadpm, pm, menadzment, hr, viewer** (svi ulogovani sa tim ulogama u `user_roles`) |
| **Pun edit** (drag-drop, status, napomena, REASSIGN, crteži) | `canEditPlanProizvodnje()` — **admin, pm, menadzment** |
| Read-only u UI | **leadpm, hr, viewer** — badge „read-only”, servisi na write vraćaju `null` pre upita; RLS na serveru i dalje štiti |

**Baza:** RLS na `production_overlays`, `production_drawings` i bucket `production-drawings` koristi **`public.can_edit_plan_proizvodnje()`** — mora uključivati iste uloge kao UI. Migracija: `add_plan_proizvodnje_menadzment_edit.sql` (dodaje `menadzment` ako starija baza ima samo `admin`/`pm`).

**Napomena:** U `user_roles`, efektivna rola mora ispravno da uključi `menadzment` (`effectiveRoleFromMatches` u `src/services/userRoles.js`) — inače korisnik može pasti na `viewer` iako u bazi ima menadžment red.

---

## Tabovi (UI)

Modul: `sessionStorage` / hub modul **`plan-proizvodnje`**, `src/ui/planProizvodnje/index.js`.

| Tab | Svrha | Glavni fajl |
|-----|--------|-------------|
| **Po mašini** | Tabovi po **odeljenju** → lista mašina (sortirano numerički po `rj_code`) ili lista operacija; drill-down na mašinu prikazuje tabelu operacija sa drag-drop, status pill, napomenom, REASSIGN, skicama i TP modalom | `poMasiniTab.js` |
| **Zauzetost mašina** | Zbirno: otvorene operacije i planirano vreme po mašini; skok u „Po mašini” | `zauzetostTab.js` |
| **Pregled svih** | Matrica mašina × narednih radnih dana; skok u „Po mašini” | `pregledTab.js` |

Pomoćni moduli: **`departments.js`** (single source of truth za tabove odeljenja u „Po mašini" — kod-based filter `rj_code` / `effective_machine_code` prefiks), **`drawingManager.js`** (upload/lista/signed URL za `production-drawings`), **`techProcedureModal.js`** (detalji operacije / BigTehn kontekst gde je predviđeno).

### Tabovi „Po mašini" (v2)

Tab → filter (vidi `src/ui/planProizvodnje/departments.js` za autoritativan spisak):

| # | Tab | Tip | Filter |
|---|-----|-----|--------|
| 1 | Sve | dropdown | — (legacy: dropdown mašine + operacije) |
| 2 | Glodanje | lista mašina → drill-down | `rj_code` prefiks `3` (uključuje borverke `3.21`, `3.22`) |
| 3 | Struganje | lista mašina → drill-down | `rj_code` prefiks `2` |
| 4 | Brušenje | lista mašina → drill-down | `rj_code` prefiks `6` |
| 5 | Erodiranje | lista mašina → drill-down | `rj_code` prefiks `10` |
| 6 | Ažistiranje | lista operacija | `effective_machine_code = '8.2'` (exact) |
| 7 | Sečenje i savijanje | lista operacija | `effective_machine_code` prefiks `1` ili `4` |
| 8 | Bravarsko | lista operacija | `opis_rada` ILIKE `bravar` ili `zavariv` (bez dijakritike) |
| 9 | Farbanje i površinska zaštita | lista operacija | `effective_machine_code` prefiks `5` |
| 10 | CAM programiranje | lista operacija | `effective_machine_code` prefiks `17` |
| 11 | Ostalo | mašine bez kategorije + operacije bez kategorije | safety bucket |

Drag-drop reorder (`shift_sort_order`) dostupan je SAMO u single-machine kontekstu (Sve dropdown + drill-down u machines tabu) — operacioni tabovi prikazuju mešavinu mašina, pa je drag onemogućen.

---

## Servisni sloj (`planProizvodnje.js`)

- **Čitanje:** `loadMachines()`, `loadOperationsForMachine(machineCode)`, `loadOperationsForDept(dept)` (v2 — operacije po odeljenju za operacione tabove i „Ostalo"), `loadAllOpenOperations()` — iz `bigtehn_*_cache` i view-a **`v_production_operations`**.
- **Pisanje overlay-a:** `upsertOverlay()`, `reorderOverlays()` — `production_overlays` (PostgREST UPSERT po `(work_order_id, line_id)`).
- **Crteži:** upload preko Storage API + metapodaci u `production_drawings`; signed URL za prikaz (bucket nije javan).
- **Pomoćno:** `fetchBigtehnOpSnapshotByRnAndTp`, `fetchBigtehnWorkOrdersByIds` — za nalepnice / Lokacije integraciju; `rokUrgencyClass`, `plannedSeconds`, itd.

Lokalni statusi u UI konstantama: `LOCAL_STATUSES`, ciklus `STATUS_CYCLE_NEXT` (`waiting` → `in_progress` → `blocked` → …).

---

## Baza podataka

### Tabele (Sprint F.1)

- **`production_overlays`** — po jedan red po paru `(work_order_id, line_id)`: `shift_sort_order`, `local_status`, `shift_note`, `assigned_machine_code` (REASSIGN), `archived_at` / razlog arhive kada RN završi.
- **`production_drawings`** — metapodaci fajlova vezana za operaciju.

### View

- **`v_production_operations`** — denormalizovan spoj linija RN-a, RN headera, kupca, mašine, overlay-a, tech routing agregata, broja crteža; kolona **`effective_machine_code`** = `COALESCE(assigned_machine_code, original_machine_code)`.

Redosled migracija (tipično):

```text
add_plan_proizvodnje.sql              # tabele + RLS + can_edit_plan_proizvodnje + bucket
add_v_production_operations.sql       # view (zavisi od cache tabela + overlays + drawings)
add_plan_proizvodnje_menadzment_edit.sql   # proširenje can_edit_plan_proizvodnje za menadzment
```

BigTehn cache i bridge sync nisu u ovom fajlu — zavise od ostalih migracija/workera (`bigtehn_work_orders_cache`, `bigtehn_work_order_lines_cache`, …).

---

## Stilovi i putanje

- **`src/styles/planProizvodnje.css`** — uvezen u `main.js`.
- Deep link: **`/plan-proizvodnje`** → `appPaths.js` mapira na modul `plan-proizvodnje`.

---

## Lokalni storage (UX)

- Poslednja izabrana mašina: `plan-proizvodnje:last-machine` (`localStorage`).
- Poslednje izabrano odeljenje (tab) u „Po mašini": `plan-proizvodnje:last-department` (v2). Skok iz „Zauzetosti" / „Pregleda svih" automatski upisuje slug taba kome mašina pripada (`findDeptForMachineCode`), pa „Po mašini" otvara odgovarajući tab + drill-down.
- Tabovi „Zauzetost” / „Pregled”: filter/sort ključevi u `zauzetostTab.js` / `pregledTab.js` (prefiks `plan-proizvodnje:`).

---

## Hub

`moduleHub.js` — kartica „Planiranje proizvodnje”; CTA tekst zavisi od `canEditPlanProizvodnje()` (Otvori vs Pregled read-only).

---

## Konvencije

- Sve upise u overlay proveravaju **`canEditPlanProizvodnje()`** pre mrežnog poziva.
- Uloge iz **`user_roles`**, ne iz JWT `app_metadata`.

---

## Istorija razvoja (kratko, iz komentara u kodu)

- **F.1** — šema, overlay, Storage bucket, osnovni servis.
- **F.2** — tab „Po mašini”: tabela, drag-drop, status, napomena, REASSIGN, refresh.
- **F.3** — „Zauzetost mašina” i „Pregled svih” (agregacije na klijentu iz `loadAllOpenOperations()` širokog fetch-a).
- **F.4** — skice (`production_drawings` + `drawingManager`), signed URL.
- **F.5** — refactor „Po mašini" u tab-po-odeljenju sa drill-down listom mašina (kod-based filter `rj_code` / `effective_machine_code` prefiks); operacioni tabovi (Ažistiranje, Sečenje+savijanje, Bravarsko, Farbanje+PZ, CAM); name-match samo za Bravarsko; `Ostalo` safety bucket.

Detaljni sprint checklist u zaglavlju `index.js` može biti zastareo u odnosu na stvarno stanje — ova sekcija služi kao orijentacija, ne kao PM artefakt.
