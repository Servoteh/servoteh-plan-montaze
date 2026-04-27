# Audit modula „Održavanje mašina” (stanje repozitorijuma)

**Repo:** `servoteh-plan-montaze`  
**Datum audita:** 2026-04-27  
**Svrha:** Ulazna tačka za CMMS evoluciju (`Odrzavanje_modul_Cursor_instrukcija.md`). Samo čitanje koda/migracija — bez izmena šeme ili aplikacije.

---

## Postojeća šema

### Tabele (kratko)

| Tabela | Svrha |
|--------|--------|
| `maint_user_profiles` | Jedan red po korisniku: `maint_maint_role`, dodeljene `machine_code[]`, Telegram/phone, aktivnost. |
| `maint_machines` | Autoritativni katalog mašina (ime, tip, proizvođač, model, serijski, lokacija, odgovorni, arhiva, izvor). |
| `maint_machines_deletion_log` | Audit kompletnog reda pre trajnog brisanja mašine. |
| `maint_tasks` | Šabloni preventivnih kontrola po `machine_code` (interval, severity, uloga, grace). |
| `maint_checks` | Evidencija izvršenih kontrola (veza na task, rezultat, priloge). |
| `maint_incidents` | Prijave kvarova (naslov, severity, status, dodela, prilozi, downtime). |
| `maint_incident_events` | Istorija promena (status, dodela, komentari) na incidentu. |
| `maint_machine_status_override` | Ručni operativni status (npr. pauza/održavanje) sa razlogom i rokom. |
| `maint_machine_notes` | Beleške uz mašinu (pin, soft delete). |
| `maint_machine_files` | Metapodaci fajlova u Storage bucket-u `maint-machine-files`. |
| `maint_notification_log` | Outbox notifikacija (kanal, primalac, body, status, retry polja, payload). |
| `maint_locations` | Hijerarhija lokacija (parent, code, name, `location_type`, aktivno) — migracija `add_maint_locations.sql`. |
| `maint_assets` | CMMS supertype: `asset_code`, `asset_type`, status, FK lokacija/odgovorni, `qr_token`, itd. — migracija `add_maint_assets_supertable.sql`. Veza: `maint_machines.asset_id` → `maint_assets`. |

**Napomena:** `docs/SUPABASE_PUBLIC_SCHEMA.md` je ažuriran 2026-04-27 za `maint_assets`, `maint_locations`, radne naloge i `work_order_id` na incidentima (usklađeno sa migracijama).

**U repozitorijumu (2026):** `add_maint_work_orders.sql`, `link_maint_incidents_to_wo.sql` — `maint_work_orders` + child tabele, veza sa incidentima. **Još nema:** polimorfni `maint_documents` (Sprint 2+).

### Enum tipovi i vrednosti

(prema `add_maintenance_module.sql` + `add_maint_notifications_plan.sql` i `docs/SUPABASE_PUBLIC_SCHEMA.md`)

| Enum | Vrednosti |
|------|------------|
| `maint_maint_role` | `operator`, `technician`, `chief`, `management`, `admin` |
| `maint_interval_unit` | `hours`, `days`, `weeks`, `months` |
| `maint_task_severity` | `normal`, `important`, `critical` |
| `maint_check_result` | `ok`, `warning`, `fail`, `skipped` |
| `maint_incident_severity` | `minor`, `major`, `critical` |
| `maint_incident_status` | `open`, `acknowledged`, `in_progress`, `awaiting_parts`, `resolved`, `closed` |
| `maint_operational_status` | `running`, `degraded`, `down`, `maintenance` |
| `maint_notification_channel` | `telegram`, `email`, `in_app`, `whatsapp` (whatsapp dodat migracijom) |
| `maint_notification_status` | `queued`, `sent`, `failed` |
| `maint_asset_type` | `machine`, `vehicle`, `it`, `facility` (`add_maint_assets_supertable.sql`) |

### Pregledi (views)

- `v_maint_machine_current_status` — agregat statusa/prioriteta po mašini (override, incidenti, rokovi); filtriranje `no_procedure` u `add_maint_hide_no_procedure.sql`.
- `v_maint_machine_last_check` — poslednja kontrola po mašini.
- `v_maint_machines_importable` — mašine iz cache-a koje mogu u katalog.
- `v_maint_machines_with_responsible` — katalog + odgovorni.
- `v_maint_task_due_dates` — sledeći rok po šablonu zadatka.

### RPC i ponašanje (SECURITY DEFINER gde nije drugačije naznačeno)

| Funkcija | Kratak opis |
|----------|-------------|
| `maint_is_erp_admin` | Da li je JWT korisnik globalni ERP `admin` (`user_roles`). |
| `maint_is_erp_admin_or_management` | Admin ili ERP menadžment — šire ovlašćenja (katalog, brisanje, itd.). |
| `maint_has_floor_read_access` | Pregled fabrike: admin, pm, leadpm, menadžment. |
| `maint_profile_role` / `maint_assigned_machine_codes` | Trenutna maint uloga i dodela mašina. |
| `maint_machine_visible(machine_code)` | Da li korisnik sme da vidi mašinu (operator samo dodeljene, ostali šire). |
| `maint_assignable_users` | Lista profila za dodelu incidenta. |
| `maint_can_close_incident` | Ko sme zatvaranje (evoluiralo kroz `add_maint_incidents_policies_v2` / `add_maint_rls_menadzment_paritet` — trenutno u skladu sa paritetom admin/menadžment/šef). |
| `maint_machine_rename` | Atomski rename `machine_code` kroz sve `maint_*` tabele (ne dira BigTehn cache / production_overlays). |
| `maint_machine_delete_hard` | Trajno brisanje + log. |
| `maint_machines_import_from_cache` | Uvoz kataloga iz `bigtehn_machines_cache`. |
| `maint_notification_retry` | Vraćanje failed reda u queue. |
| `maint_enqueue_notification` / `maint_incidents_enqueue_notify` | Enqueue u outbox (trigger na incidente major/critical). |
| `maint_dispatch_dequeue` / `maint_dispatch_fanout` / `maint_dispatch_mark_sent` / `maint_dispatch_mark_failed` | Edge worker batch za slanje. |
| `maint_asset_visible(asset_id)` | Vidljivost asseta: mašine preko `maint_machine_visible`, ostali tipovi širi krug. |
| `maint_machines_ensure_asset` | Osigurava `asset_id` pri unosu u `maint_machines` (migracija `add_maint_assets_supertable.sql`). |

Izvor imena migracija za generisanu matricu: `docs/RBAC_MATRIX.md` (funkcije `maint_*`).

### Migracije `sql/migrations/add_maint*.sql` (i osnovna)

| Fajl | Sadržaj (rezime) |
|------|------------------|
| `add_maintenance_module.sql` | Inicijal: enumi, `maint_user_profiles`, `maint_tasks`/`maint_checks`/`maint_incidents`/events, override, notes, notifikacioni log, bazični helperi, RLS, view-ovi. |
| `add_maint_hide_no_procedure.sql` | Filtar `no_procedure` u `v_maint_machine_current_status`. |
| `add_maint_machines_catalog.sql` | Tabela `maint_machines` kao autoritativan katalog. |
| `add_maint_machine_responsible.sql` | `responsible_user_id` (UX filter „Moje”). |
| `add_maint_machine_files.sql` | `maint_machine_files` + Storage politike, bucket. |
| `add_maint_files_menadzment.sql` | Insert fajlova i za ERP `menadzment`. |
| `add_maint_machine_hard_delete.sql` | Hard delete RPC + `maint_machines_deletion_log` + `maint_is_erp_admin_or_management`. |
| `add_maint_machine_rename_rpc.sql` | `maint_machine_rename`. |
| `add_maint_assignable_users_rpc.sql` | `maint_assignable_users`. |
| `add_maint_incidents_audit_trigger.sql` | Trigger logovanja promena u `maint_incident_events`. |
| `add_maint_incidents_policies_v2.sql` | Pooštravanje zatvaranja + automatski `created` događaj. |
| `add_maint_rls_menadzment_paritet.sql` | RLS i RPC paritet sa ERP menadžmentom, `maint_can_close_incident`, import, retry, itd. |
| `add_maint_notification_outbox.sql` | Outbox kolone, `maint_enqueue_notification`, trigger queue na incidente. |
| `add_maint_notify_dispatch_rpc.sql` | RPC-ovi za Edge worker. |
| `add_maint_notifications_plan.sql` | `whatsapp` u enum kanala. |
| `add_maint_notification_retry.sql` | `maint_notification_retry`. |
| `add_maint_locations.sql` | `maint_locations` + RLS. |
| `add_maint_assets_supertable.sql` | `maint_assets`, `maint_asset_type`, `maint_machines.asset_id`, backfill, `maint_asset_visible`, `maint_machines_ensure_asset`, RLS. |

### pgTAP testovi (`sql/tests/`)

- Postoji: `sql/tests/security_maint_assets_rls.sql` — RLS uključen na `maint_assets`, postojanje politika `maint_assets_select` / `maint_assets_insert`, helper `maint_machines_ensure_asset`.  
- Postoji: `security_maint_work_orders_rls.sql` (strukturni pgTAP). Ostali `security_*.sql` fajlovi nisu specifični za održavanje osim asseta.

---

## Postojeće rute i stranice

**Izvor ruta:** `src/lib/appPaths.js` (`pathnameToRoute`) + render u `src/ui/router.js` (kind `maintenance` → `renderMaintenanceShell` iz `src/ui/odrzavanjeMasina/index.js`).

| Ruta | `section` | Fajl / handler | Opis |
|------|-------------|----------------|------|
| `/maintenance` | `dashboard` | `odrzavanjeMasina/index.js` → `renderPanel` | Pregled (KPI, prioriteti, kratke liste, linkovi). |
| `/maintenance/machines` | `machines` | isti | Operativna lista mašina (task-first, filteri). |
| `/maintenance/board` | `board` | isti | „Rokovi” — board kolone overdue/danas/nedelja. |
| `/maintenance/notifications` | `notifications` | `maintNotificationsTab.js` | Istorija / retry notifikacija. |
| `/maintenance/catalog` | `catalog` | `maintCatalogTab.js` | Katalog mašina (CRUD, uvoz, odgovorni, rename, hard delete). |
| `/maintenance/locations` | `locations` | `maintLocationsTab.js` | Upravljanje `maint_locations`. |
| `/maintenance/machines/:machineCode` | `machine` | `index.js` + tabovi | Detalj mašine: tabovi Pregled, Zadaci, Istorija, Napomene, Dokumenta, Šabloni; modali iz `maintDialogs.js`, `maintIncidentDialog.js`, `maintOverrideDialog.js`, `maintTasksTab.js`, `maintFilesTab.js`. |

**Dodatno:** `src/ui/podesavanja/maintProfilesTab.js` — održavanski profili u modulu Podešavanja (nije ispod `/maintenance` URL-a).

**Napomena:** Modul u kodu je folder **`src/ui/odrzavanjeMasina/`**, ne `src/ui/maintenance/`.

---

## Postojeće reusable komponente

- **Nema** centralnog `src/ui/components/` sa Button/Modal wrapperima u ovom repou — održavanje koristi **string HTML** + `kadrovska-*` / `mnt-*` klase u istom fajlu (`index.js` i tab-*.js), zajedno sa `showToast`, `escHtml` (`src/lib/dom.js`), temom (`src/lib/theme.js`).
- **Dijalozi / „komponente” unutar modula:**
  - `maintDialogs.js` — `openReportIncidentModal` (Prijavi kvar), `openConfirmCheckModal` (potvrda kontrole).
  - `maintIncidentDialog.js` — detalj incidenta, izmene u skladu sa RLS.
  - `maintOverrideDialog.js` — override operativnog statusa.
  - `maintTasksTab.js` / `maintFilesTab.js` / `maintCatalogTab.js` / `maintLocationsTab.js` / `maintNotificationsTab.js` — render funkcije + modali specifični za tab.

Props su uglavnom **kontekst** (`machineCode`, `prof`, `onRefresh`), ne props objekat kao u React-u.

---

## Postojeći RLS model

- **Izvor u dokumentaciji:** `docs/RBAC_MATRIX.md` trenutno listira **pomoćne funkcije** (`maint_*` RPC), ne punu tabelu politika po tabeli. Detaljna pravila su u **migracijama** (npr. `add_maint_rls_menadzment_paritet.sql`, `add_maint_assets_supertable.sql`, `add_maint_locations.sql`).
- **Pojedinačno (sažetak ponašanja):**
  - Vidljivost mašina: `maint_machine_visible` / `maint_has_floor_read_access` i uloga iz `maint_user_profiles` (operator vidi dodeljene `machine_code`).
  - Incidenti: čitanje/pisanje u zavisnosti od uloge; zatvaranje kroz `maint_can_close_incident` (i ERP admin/menadžment gde je prošireno).
  - `maint_notification_log`: korisnički INSERT uglavnom zabranjen; enqueue preko triggera + `maint_enqueue_notification` (DEFINER).
  - `maint_assets`: RLS + `maint_asset_visible` (pgTAP: `security_maint_assets_rls.sql`).
  - `maint_locations`: čitanje floor read; pisanje chief/admin (i ERP admin).

Za precizan matrix po tabeli, pratiti migracije ili regenerisati dokumentaciju posle `npm run gen:rbac-matrix` (ako se proširuje da uključuje politike).

---

## Mapping na novi model (predlog)

| Staro / trenutno | Predlog (CMMS) |
|------------------|----------------|
| `maint_incidents` | Ostaje; `work_order_id` → `maint_work_orders` (migracija `link_maint_incidents_to_wo.sql`). |
| `maint_tasks` | Ostaje; UI „Preventiva”; proširenja (checklist, auto WO) po planu. |
| `maint_machines` | Ostaje kao **extension**; već `asset_id` → `maint_assets` (type `machine`). |
| `maint_assets` + `maint_locations` | Supertype + lokacije — već uvedeno; vozila/IT/facility kao nove extension tabele. |
| `maint_machine_files` | Zadržati; `maint_documents` polimorfno pored (backfill, bez brisanja starih). |
| `maint_incident_events` | Istorija incidenta; timeline može uključiti i `maint_wo_events` kasnije. |
| `maint_work_orders` + `maint_wo_*` | Uvedeno u `add_maint_work_orders.sql`; UI Kanban sledeći sprint. |

---

## Rizici

1. **Dupla izvora istine za šifru:** i dalje `machine_code` u incidentima/taskovima; `asset_code` na `maint_assets` mora ostati usklađen (rename RPC za mašine već postoji; za asset nivo — planirati `maint_asset_rename`).
2. **Notifikacioni pipeline:** zavisi od triggera na `maint_incidents` + outbox + Edge `maint-notify-dispatch`. Bilo koja izmena severity→queue mora ostati kompatibilna; fanout očekuje stub redove.
3. **Edge worker:** trenutno `rpc()` šalje samo `apikey` + `Authorization: Bearer` service role — **nema** `X-Audit-Actor` u implementaciji u `supabase/functions/maint-notify-dispatch/index.ts` (proveriti očekivanja iz projektnih instrukcija pri refaktoru).
4. **Dokumentacija šeme:** `SUPABASE_PUBLIC_SCHEMA.md` (2026-04-27) uključuje CMMS assets/locations/WO; `sql/schema.sql` i dalje ne sadrži ceo održavanski stek — namerno (migracije su izvor za produ).
5. **UI pristup modulu:** `canAccessMaintenance()` u `router.js` je samo **ulogovan + online** — fine-grained kontrola je na RLS / `maint_user_profiles` u servisima.
6. **Zavisnost od cache-a:** `fetchBigtehnMachineNames`, import iz cache — `bigtehn_machines_cache` ne sme se polomiti u syncu (crvena linija u instrukciji).

---

## Edge / worker

- **`supabase/functions/maint-notify-dispatch/index.ts`:** worker za raspored (cron). Koristi `maint_dispatch_dequeue` → po redu `maint_dispatch_fanout` (stub) ili slanje (WhatsApp ako su secreti; inače DRY-RUN) → `maint_dispatch_mark_sent` / `maint_dispatch_mark_failed` sa eksponencijalnim backoff-om.
- **`workers/`:** nema održavanskog workera; postoji `loc-sync-mssql` i sl. (van scope-a održavanja).

---

## `src/services/maintenance.js` — API (Supabase REST / RPC)

Glavni pozivi: view `v_maint_machine_current_status`, tabele `maint_*`, `bigtehn_machines_cache`, Storage bucket `maint-machine-files`, RPC-ovi imenovani u `maintenance.js` (`renameMaintMachine`, `deleteMaintMachineHard`, `importMaintMachinesFromCache`, `retryMaintNotification`, itd.). Kompletan spisak izvoznih funkcija: `fetchMaintMachineStatuses`, `fetchMaintMachineLastChecks`, `fetchMaintMachineLastIncidents`, `fetchBigtehnMachineNames`, `fetchMaintUserProfile`, `fetchMaintTasksForMachine(All)`, `insertMaintTask`, `patchMaintTask`, `deleteMaintTask`, `fetchMaintChecksForMachine`, `fetchMaintIncidentsForMachine`, `fetchBigtehnMachineRow`, `fetchAllMaintProfiles`, `insertMaintProfile`, `patchMaintProfile`, `insertMaintCheck`, `insertMaintIncident`, `insertMaintIncidentEvent`, `fetchIncidentById`, `fetchIncidentEvents`, `patchMaintIncident`, `fetchAssignableMaintUsers`, `fetchMaintTaskDueDates`, `fetchMaintMachineNotes`, `insertMaintMachineNote`, `patchMaintMachineNote`, `fetchMaintMachineOverride`, `upsertMaintMachineOverride`, `deleteMaintMachineOverride`, `fetchMaintMachines`, `fetchMaintMachine`, `isMaintResponsibleFeatureAvailable`, `fetchMaintMachineResponsibleFor`, `fetchMaintMachineResponsibles`, `insertMaintMachine`, `patchMaintMachine`, `archiveMaintMachine`, `restoreMaintMachine`, `fetchMaintMachinesImportable`, `deleteMaintMachineHard`, `fetchMaintMachineDeletionLog`, `fetchMaintMachineFilesCounts`, `renameMaintMachine`, `importMaintMachinesFromCache`, `fetchMaintNotifications`, `retryMaintNotification`, `fetchMaintMachineFiles`, `uploadMaintMachineFile`, `getMaintMachineFileSignedUrl`, `deleteMaintMachineFile`, `patchMaintMachineFile`, `fetchMaintLocations`, `insertMaintLocation`, `patchMaintLocation`.

---

## `src/state/auth.js` — pomoćne funkcije (relevantno)

- `canEdit`, `isAdmin`, `isAdminOrMenadzment`, `maintHasFloorReadAccess` — korišćenje u UI održavanja za ERP admin/menadžment i široko čitanje; **nema** posebnog `isMaintChief` — uloga „chief” dolazi iz **`maint_user_profiles`** (npr. `canManageMaintTasks` u `maintTasksTab.js`).

---

## Pitanja / nedoumice

1. **Zalihe i dobavljači** u glavnom meniju Faze 1 ili odlaganje? (instrukcija traži potvrdu korisnika.)
2. **Bezbednost kvara:** zasebno polje `safety_marker` vs peti prioritet? (instrukcija preporučuje marker.)
3. **`X-Audit-Actor`:** da li treba uvesti u `maint-notify-dispatch` odmah pri sledećem diranju, ili ostaje samo za nove worker-e?
4. **Puna regeneracija** iz žive baze (npr. SQL skripta / `supabase db dump`) po potrebi — ručni baseline u `SUPABASE_PUBLIC_SCHEMA.md` je ažuriran za CMMS; `check:schema-baseline` i dalje cilja `sql/schema.sql`.
5. **Produkcija:** primeniti `add_maint_work_orders.sql` i `link_maint_incidents_to_wo.sql` redom (već u `sql/ci/migrations.txt` za CI).

---

*Kraj audita. Sledeći korak pre izmena: saglasnost korisnika, zatim Sprint 1.2+ po `Odrzavanje_modul_Cursor_instrukcija.md`.*
