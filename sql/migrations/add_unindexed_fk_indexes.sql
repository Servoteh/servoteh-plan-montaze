-- ═══════════════════════════════════════════════════════════════════════
-- PERFORMANCE — Pokrivajući indeksi za sve nepokrivene foreign key-eve
--
-- Generisano iz Supabase Performance Advisor lint `unindexed_foreign_keys`
-- (25 tabela u public schemi). Bez ovih indeksa:
--   * UPDATE/DELETE na referenciranoj tabeli radi seq scan po FK koloni
--     (lockovi, sporo brisanje korisnika/lokacija/projekata, itd.)
--   * JOIN-ovi u kadrovskoj/odrzavanju/lokacijama gube index lookup
--   * RLS politike koje filtriraju po FK-u (npr. user_roles.project_id)
--     skaliraju se kvadratno s brojem redova
--
-- Sve `CREATE INDEX IF NOT EXISTS` — idempotentno, safe za re-run.
-- Koristimo `CONCURRENTLY` da bismo izbegli zaključavanje pisanja na
-- produkciji. NAPOMENA: CONCURRENTLY ne sme da bude unutar transakcije
-- pa ovaj fajl ne sme biti wrap-ovan u BEGIN/COMMIT.
-- ═══════════════════════════════════════════════════════════════════════

-- akcioni_plan
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_akcioni_plan_tema_id
  ON public.akcioni_plan (tema_id);

-- bigtehn cache
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bigtehn_workers_cache_department_id
  ON public.bigtehn_workers_cache (department_id);

-- loc_item_placements
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_item_placements_last_movement_id
  ON public.loc_item_placements (last_movement_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_item_placements_placed_by
  ON public.loc_item_placements (placed_by);

-- loc_location_movements
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_location_movements_approved_by
  ON public.loc_location_movements (approved_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_location_movements_correction_of_movement_id
  ON public.loc_location_movements (correction_of_movement_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_location_movements_from_location_id
  ON public.loc_location_movements (from_location_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_location_movements_moved_by
  ON public.loc_location_movements (moved_by);

-- loc_locations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_locations_created_by
  ON public.loc_locations (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_loc_locations_updated_by
  ON public.loc_locations (updated_by);

-- maint_checks
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_checks_performed_by
  ON public.maint_checks (performed_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_checks_updated_by
  ON public.maint_checks (updated_by);

-- maint_incident_events
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_incident_events_actor
  ON public.maint_incident_events (actor);

-- maint_incidents
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_incidents_reported_by
  ON public.maint_incidents (reported_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_incidents_updated_by
  ON public.maint_incidents (updated_by);

-- maint_machine_files / notes / status_override
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_machine_files_uploaded_by
  ON public.maint_machine_files (uploaded_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_machine_notes_author
  ON public.maint_machine_notes (author);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_machine_status_override_set_by
  ON public.maint_machine_status_override (set_by);

-- maint_machines + deletion log
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_machines_updated_by
  ON public.maint_machines (updated_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_machines_deletion_log_deleted_by
  ON public.maint_machines_deletion_log (deleted_by);

-- maint_notification_log
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_notification_log_recipient_user_id
  ON public.maint_notification_log (recipient_user_id);

-- maint_tasks
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_tasks_created_by
  ON public.maint_tasks (created_by);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_maint_tasks_updated_by
  ON public.maint_tasks (updated_by);

-- reminder_log
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reminder_log_work_package_id
  ON public.reminder_log (work_package_id);

-- user_roles
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_roles_project_id
  ON public.user_roles (project_id);

-- ───────────────────────────────────────────────────────────────────────
-- Bonus: Advisor je takođe javio duplicate index na public.work_hours.
-- `idx_work_hours_date` i `idx_work_hours_date_only` su identični.
-- Ostavljamo ovde zakomentarisano da timski review odluči koji se DROP-uje:
--
-- DROP INDEX IF EXISTS public.idx_work_hours_date_only;
-- ───────────────────────────────────────────────────────────────────────
