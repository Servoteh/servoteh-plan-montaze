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
| **Po mašini** | Izbor mašine (`rj_code`), tabela operacija, drag-drop redosled, status pill, napomena, REASSIGN, otvaranje skica i TP modala. Iznad dropdown-a je red tabova odeljenja (Sve, Glodanje, Struganje, Borverci, Ažistiranje, Sečenje, Bravarsko, Farbanje, Površinska zaštita, Ostalo) koji filtrira listu mašina. Mapiranje BigTehn naziva odeljenja (`bigtehn_departments_cache.name`) na tab-ove je u `src/ui/planProizvodnje/departments.js` (case-insensitive, bez dijakritike; svaki no-match pada u `Ostalo`). | `poMasiniTab.js` |
| **Zauzetost mašina** | Zbirno: otvorene operacije i planirano vreme po mašini; skok u „Po mašini” | `zauzetostTab.js` |
| **Pregled svih** | Matrica mašina × narednih radnih dana; skok u „Po mašini” | `pregledTab.js` |

Pomoćni moduli: **`drawingManager.js`** (upload/lista/signed URL za `production-drawings`), **`techProcedureModal.js`** (detalji operacije / BigTehn kontekst gde je predviđeno).

---

## Servisni sloj (`planProizvodnje.js`)

- **Čitanje:** `loadMachines()`, `loadOperationsForMachine(machineCode)`, `loadAllOpenOperations()` — iz `bigtehn_*_cache` i view-a **`v_production_operations`**.
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
- Poslednje izabrano odeljenje u tabu „Po mašini”: `plan-proizvodnje:last-department` (`localStorage`) — slug iz `DEPARTMENTS` u `src/ui/planProizvodnje/departments.js` (npr. `sve`, `glodanje`, `ostalo`). Skok iz „Zauzetost” / „Pregled” u „Po mašini” automatski upisuje slug odeljenja izabrane mašine kako bi se tab vizuelno refleksovao.
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

Detaljni sprint checklist u zaglavlju `index.js` može biti zastareo u odnosu na stvarno stanje — ova sekcija služi kao orijentacija, ne kao PM artefakt.
