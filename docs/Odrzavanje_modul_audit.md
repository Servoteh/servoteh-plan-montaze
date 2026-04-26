# Audit — modul „Održavanje mašina“ (pre CMMS evolucije)

**Repo:** `servoteh-plan-montaze`  
**Datum:** 2026-04-26  
**Svrha:** Faza 1.1 (Sprint 1.1) — zabeleženo stanje pre uvođenja `maint_assets` / `maint_work_orders` i nove navigacije. **Dokumentacija; nije deo same CMMS implementacije.**

**Lokacija UI koda:** `src/ui/odrzavanjeMasina/` (instrukcija pominje `src/ui/maintenance/` — taj folder u repou ne postoji). Javni URL i dalje koristi **`/maintenance/...`** (`src/lib/appPaths.js`).

Kanonik za kolone / enum: `docs/SUPABASE_PUBLIC_SCHEMA.md`.

---

## Postojeća šema

### Tabele (1 rečenica)

| Tabela | Svrha |
|--------|--------|
| `maint_user_profiles` | Profil održavanja po korisniku: uloga, dodeljene mašine, kanali, aktivan. |
| `maint_tasks` | Šabloni preventivnih zadataka po `machine_code` (interval, ozbiljnost, grace). |
| `maint_checks` | Urađene kontrole (veza na šablon, mašina, rezultat, izvršilac). |
| `maint_incidents` | Prijave kvara (mašina, ozbiljnost, status toka, dodela, rešenje). |
| `maint_incident_events` | Događaji / istorija promena na incidentu. |
| `maint_machine_notes` | Beleške po mašini (pin, soft delete). |
| `maint_machine_status_override` | Ručni operativni status po `machine_code` (validnost, razlog). |
| `maint_notification_log` | Notifikacioni outbox + istorija (kanal, primalac, retry, payload, veze). |
| `maint_machines` | Lokalni katalog mašina (PK `machine_code`, meta, arhiva, izvor). |
| `maint_locations` | Hijerarhija lokacija za CMMS (Faza 1.2+); `add_maint_locations.sql`. |
| `maint_assets` | Supertype sredstava (mašine 1:1 preko `maint_machines.asset_id`); `add_maint_assets_supertable.sql`. |
| `maint_machine_files` | Metapodaci fajlova; binari u Storage bucket-u `maint-machine-files`. |
| `maint_machines_deletion_log` | Audit nakon `maint_machine_delete_hard`. |

### Pogledi

| View | Svrha |
|------|--------|
| `v_maint_machine_last_check` | Poslednja kontrola po (task, mašina). |
| `v_maint_task_due_dates` | Naredni `next_due_at` po šablonu. |
| `v_maint_machine_current_status` | Agregat statusa po mašini (evoluirao kroz migracije: BigTeh cache, zatim `maint_machines` + incidenti + rokovi; vidi `add_maint_machines_catalog`, `add_maint_hide_no_procedure`). |
| `v_maint_machines_importable` | Kandidati iz `bigtehn_machines_cache` za uvoz u `maint_machines`. |
| `v_maint_machines_with_responsible` | Katalog + dodela odgovornog (`add_maint_machine_responsible.sql`). |

### Enum tipovi i vrednosti

| Enum | Vrednosti |
|------|------------|
| `maint_maint_role` | `operator`, `technician`, `chief`, `management`, `admin` |
| `maint_interval_unit` | `hours`, `days`, `weeks`, `months` |
| `maint_task_severity` | `normal`, `important`, `critical` |
| `maint_check_result` | `ok`, `warning`, `fail`, `skipped` |
| `maint_incident_severity` | `minor`, `major`, `critical` |
| `maint_incident_status` | `open`, `acknowledged`, `in_progress`, `awaiting_parts`, `resolved`, `closed` |
| `maint_operational_status` | `running`, `degraded`, `down`, `maintenance` |
| `maint_asset_type` | `machine`, `vehicle`, `it`, `facility` (supertype; mašine = 1:1 preko `maint_machines`) |
| `maint_notification_channel` | `telegram`, `email`, `in_app`, `whatsapp` (vrednost `whatsapp` u `add_maint_notifications_plan.sql`) |
| `maint_notification_status` | `queued`, `sent`, `failed` |

### RPC / funkcije (šta rade)

| Ime | Uloga |
|-----|--------|
| `maint_is_erp_admin` | Da li je korisnik globalni ERP `admin` (`user_roles`). |
| `maint_is_erp_admin_or_management` | Admin ili `menadzment` (npr. hard delete). |
| `maint_has_floor_read_access` | Široki read po fabričkim ulogama (admin, pm, leadpm, menadzment). |
| `maint_profile_role` / `maint_assigned_machine_codes` | Trenutna održavarska uloga i dodela mašina. |
| `maint_machine_visible` | Vidljivost `machine_code` (operator samo dodeljene; viši nivoi šire). |
| `maint_assignable_users` | Lista za padajući izbor dodele. |
| `maint_can_close_incident` | Ko sme zatvaranje incidenta (ERP admin ili chief/admin održavanja). |
| `maint_enqueue_notification` | Upis u outbox; koristi se iz triggera (zaobilazak `INSERT` policy = false). |
| `maint_incidents_enqueue_notify` | Posle incidenata — queue (major/critical) prema pravilima u migraciji. |
| `maint_dispatch_dequeue` / `maint_dispatch_fanout` / `maint_dispatch_mark_sent` / `maint_dispatch_mark_failed` | Edge worker: batch, fanout stuba, označavanje uspeha/neuspeha. |
| `maint_notification_retry` | Vraćanje `failed` u `queued` (chief/admin). |
| `maint_machines_import_from_cache` | Masovni uvoz kataloga iz `bigtehn_machines_cache`. |
| `maint_machine_rename` | Atomski rename `machine_code` u svim `maint_*` tabelama. |
| `maint_machine_delete_hard` | Trajno brisanje mašine + `maint_machines_deletion_log`. |

**Migracije** (pored `add_maintenance_module.sql`): 15 fajlova u `sql/migrations/` sa prefiksom `add_maint_` (tačan spisak: `Get-ChildItem … -Filter 'add_maint*.sql'`). Kratak sadržaj: katalog i view-ovi; `no_procedure` filter; `responsible_user_id`; fajlovi + RLS; menadžment čitanje; incidenti audit/close; `maint_assignable_users`; RLS/menadžment paritet + import/retry/rename; outbox, enqueue, telefon, trigger; kanal `whatsapp`; dispatch RPC; `maint_notification_retry`; hard delete; poseban `add_maint_machine_rename_rpc` (poredenje sa `add_maint_rls_menadzment_paritet` u produkciji — koji `CREATE OR REPLACE` je zadnji).

---

## Postojeće rute i stranice

Izvor: `src/lib/appPaths.js` (`parsePath`), `src/ui/odrzavanjeMasina/index.js` (subnav).

| Ruta (path) | `section` (router) | UI / fajl | Kratak opis |
|-------------|----------------------|-----------|-------------|
| `/maintenance` | `dashboard` | `odrzavanjeMasina/index.js` | Pregled (KPI, lista prioriteta, prečice). |
| `/maintenance/machines` | `machines` | isti | Operativna lista mašina, filteri (status, rok, incident, „moje”). |
| `/maintenance/board` | `board` | isti (Rokovi) | Pregled rokova / „Rokovi” (koristi `v_maint_task_due_dates` i slično). |
| `/maintenance/notifications` | `notifications` | `maintNotificationsTab.js` | Istorija / retry notifikacija. |
| `/maintenance/catalog` | `catalog` | `maintCatalogTab.js` | Admin katalog, uvoz, hard delete, rename. |
| `/maintenance/machines/:code` | `machine` + `machineCode` | `index.js` (detalj) | Tabovi: Pregled, Zadaci, Istorija, Napomene, Dokumenta, Šabloni; modali: incident, override, zadaci. |

**Moduli po fajlu** (`src/ui/odrzavanjeMasina/`):  
- `index.js` — shell, navigacija, dashboard, lista mašina, detalj mašine, wiring.  
- `maintDialogs.js` — modali: potvrda kontrole, prijava kvara.  
- `maintTasksTab.js` — šabloni / rokovi zadataka (CRUD gde dozvoljeno).  
- `maintIncidentDialog.js` — detalj incidenta, timeline.  
- `maintOverrideDialog.js` — override operativnog statusa.  
- `maintCatalogTab.js` — katalog, uvoz, brisanje, rename.  
- `maintNotificationsTab.js` — notifikacioni outbox.  
- `maintFilesTab.js` — dokumenta uz mašinu (Storage).

---

## `src/services/maintenance.js` — API (PostgREST + RPC)

Sve kroz `sbReq` (Supabase REST) osim gde je eksplicitno `rpc/...` ili Storage `fetch`.

- **Pregled / statusi:** `fetchMaintMachineStatuses` → `v_maint_machine_current_status`; `fetchMaintTaskDueDates` → `v_maint_task_due_dates`; `fetchMaintMachineLastChecks` → `maint_checks`.  
- **Profili:** `fetchMaintUserProfile`, `fetchAllMaintProfiles`, `insertMaintProfile`, `patchMaintProfile`.  
- **Šabloni (tasks):** `fetchMaintTasksForMachine`, `fetchMaintTasksForMachineAll`, `insertMaintTask`, `patchMaintTask`, `deleteMaintTask`.  
- **Kontrole:** `insertMaintCheck`, `fetchMaintChecksForMachine`.  
- **Incidenti:** `insertMaintIncident`, `fetchMaintIncidentsForMachine`, `fetchIncidentById`, `fetchIncidentEvents`, `insertMaintIncidentEvent`, `patchMaintIncident`, `fetchAssignableMaintUsers` → `rpc/maint_assignable_users`.  
- **Napomene / override:** `fetchMaintMachineNotes`, `insertMaintMachineNote`, `patchMaintMachineNote`, `fetchMaintMachineOverride`, `upsertMaintMachineOverride`, `deleteMaintMachineOverride`.  
- **Katalog `maint_machines`:** `fetchMaintMachines`, `fetchMaintMachine`, `insertMaintMachine`, `patchMaintMachine`, `archiveMaintMachine`, `restoreMaintMachine`, `fetchMaintMachinesImportable`, `fetchMaintMachineResponsibles`, `fetchMaintMachineResponsibleFor`, `isMaintResponsibleFeatureAvailable`, `renameMaintMachine` → `maint_machine_rename`, `importMaintMachinesFromCache` → `maint_machines_import_from_cache`, `deleteMaintMachineHard` → `maint_machine_delete_hard` (+ Storage brisanje), `fetchMaintMachineDeletionLog`, `fetchMaintMachineFilesCounts`.  
- **BigTeh read-only:** `fetchBigtehnMachineNames`, `fetchBigtehnMachineRow`.  
- **Notifikacije:** `fetchMaintNotifications`, `retryMaintNotification` → `maint_notification_retry`.  
- **Dokumenti:** `fetchMaintMachineFiles`, `uploadMaintMachineFile`, `getMaintMachineFileSignedUrl`, `deleteMaintMachineFile`, `patchMaintMachineFile` (bucket `maint-machine-files`).

---

## Edge: `supabase/functions/maint-notify-dispatch`

- Periodičan (cron) worker: poziva `maint_dispatch_dequeue` sa service role.  
- Za „stub” red (`recipient = 'pending'`) zove `maint_dispatch_fanout` — račva na primaoce (profil + telefon) prema pravilu u SQL-u.  
- Za `channel = whatsapp` šalje Meta Graph API ako su tokeni; u suprotnom DRY-RUN. Ostali kanali trenutno DRY-RUN, pa `mark_sent`.  
- **Napomena:** u ovom fajlu **nema** `X-Audit-Actor` headera na `fetch` ka RPC; projektna smernica zahteva proveru pri proširenjum evo funkcija sa service role.  

**Pomoćni workeri u `workers/`:** nema održavarskog specifičnog workera; pipeline je u Edge + SQL.

---

## Postojeći RLS model (sažetak)

- **Baza pristupa mašinama** koristi `maint_machine_visible(machine_code)` (operator ograničen; chief/technician/management/admin + široki ERP read gde definisano).  
- **Profili:** korisnik vidi svoj red; update admin/samo-svoj gde dozvoljeno u migracijama.  
- **Tasks:** read ako je mašina vidljiva; pisanje chief/admin (+ ERP admin).  
- **Checks:** insert kao `performed_by = auth.uid()`; update pod uslovom uloga.  
- **Incidents:** insert sa ulogom operator/tehničar/chief/admin; update tehničar/chief/admin; zatvaranje ograničeno `maint_can_close_incident` (v2).  
- **Notification log:** `SELECT` za chief/management/admin; `INSERT` kroz policy `false` za običan korisnik — stvarni upisi preko triggera / `maint_enqueue_notification` / service role.

Detalj mapiran u migracijama; **generisana matrica:** `docs/RBAC_MATRIX.md` (sekcija funkcija `maint_*`).

**pgTAP:** u `sql/tests/` trenutno **nema** `security_maint_*.sql` (za razliku od smernice u `Odrzavanje_modul_Cursor_instrukcija.md`); postoje `security_user_roles_rls.sql`, `security_audit_log.sql`, itd.

---

## Postojeće reusable „komponente”

- **`src/ui/components/`** — u repou **nema** odvojenog seta (0 `.js` fajlova). Održavanje koristi inline HTML, klase `mnt-*` u `src/styles/maintenance.css` (i delom `legacy.css`), i module u `odrzavanjeMasina/`.  
- **Ponavljajući obrasci:** modali u `maintDialogs*`, `maintIncidentDialog`, tabovi u `index.js` po `?tab=`.

---

## Mapping na novi model (predlog, visok nivo)

| Staro (trenutno) | Novo (CMMS Faza 1) |
|------------------|-------------------|
| `maint_machines` + `machine_code` svuda | `maint_assets` (supertype) + `asset_id` + 1:1 `maint_machines` kao ekstenzija mašine |
| `maint_incidents` | Ostaje; dodatak `work_order_id` / link ka WO |
| `maint_tasks` (DB ime) | Isto u DB; UI „Preventiva” |
| `maint_machine_files` | Paralelno sa `maint_documents` (polimorfno), backfill, bez brisanja stare tabele |
| Nema | `maint_work_orders`, `maint_wo_*`, `maint_locations` |
| `maint_notification_log` + Edge | Ne menjati u Sprintu 1 prema smernici; WO fanout kasnije |

---

## Rizici

- **Notifikacioni pipeline** — zavistan od triggera na `maint_incidents`, RPC dispatch-a i Edge; izmene `maint_incidents` ili redosleda migracija mogu poremetiti slanje.  
- **`v_maint_machine_current_status`** zavistan od kataloga i pravila; svaka promena view-a menja Pregled i sortiranje.  
- **Dva izvora šifre mašine** — `bigtehn_machines_cache` vs `maint_machines`; uvođenje `asset_id` zahteva pažljiv backfill.  
- **Nema automatskog pgTAP-a za RLS održavanja** — regresija dozvola moguća neprimećeno.  
- **Router** — nova navigacija mora sačuvati deep link-ove; `parsePath` u `appPaths.js` treba proširiti, ne polomiti postojeće.

---

## Pitanja / nedoumice (za produkt)

1. **„Zalihe i dobavljači”** u glavnom meniju Faze 1 ili odložiti (kao u sekciji 15 instrukcije).  
2. **Bezbednost:** poseban `safety_marker` na WO ili proširenje prioriteta.  
3. **Duple definicije** `maint_machine_rename` između `add_maint_rls_menadzment_paritet` i `add_maint_machine_rename_rpc` — u produkciji proveriti koji je zadnji `CREATE OR REPLACE`.  
4. **X-Audit-Actor** na `maint-notify-dispatch` — uskladiti sa ostalim Edge funkcijama.
