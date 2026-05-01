-- ═══════════════════════════════════════════════════════════════════════════
-- PB — aditivni CHECK constraint-i, indeksi outbox-a, eksplicitna DELETE politika
-- Idempotentno gde je praktično (IF NOT EXISTS, DROP IF EXISTS policy).
-- ═══════════════════════════════════════════════════════════════════════════

-- Datumi plana / reala (UX + integritet; postojeći loši redovi: migracija može pasti —
-- tada ručno ispraviti podatke pa ponovo pokrenuti VALIDATE / migraciju.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pb_tasks_dates_check' AND conrelid = 'public.pb_tasks'::regclass
  ) THEN
    ALTER TABLE public.pb_tasks
      ADD CONSTRAINT pb_tasks_dates_check CHECK (
        datum_pocetka_plan IS NULL
        OR datum_zavrsetka_plan IS NULL
        OR datum_zavrsetka_plan >= datum_pocetka_plan
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pb_tasks_real_dates_check' AND conrelid = 'public.pb_tasks'::regclass
  ) THEN
    ALTER TABLE public.pb_tasks
      ADD CONSTRAINT pb_tasks_real_dates_check CHECK (
        datum_pocetka_real IS NULL
        OR datum_zavrsetka_real IS NULL
        OR datum_zavrsetka_real >= datum_pocetka_real
      );
  END IF;
END $$;

-- Eksplicitno: fizičko brisanje samo admin (soft-delete i dalje preko UPDATE deleted_at)
DROP POLICY IF EXISTS pb_tasks_delete_admin_hard ON public.pb_tasks;
CREATE POLICY pb_tasks_delete_admin_hard
  ON public.pb_tasks FOR DELETE TO authenticated
  USING (public.current_user_is_admin());

GRANT DELETE ON public.pb_tasks TO authenticated;

-- Outbox: dispatch poll + dedup po zadatku/danu
CREATE INDEX IF NOT EXISTS pb_notif_log_dispatch_idx
  ON public.pb_notification_log(status, next_attempt_at)
  WHERE status IN ('pending', 'failed') AND attempts < 5;

CREATE INDEX IF NOT EXISTS pb_notif_log_dedup_idx
  ON public.pb_notification_log(related_task_id, trigger_type, created_at)
  WHERE related_task_id IS NOT NULL;
