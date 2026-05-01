-- ═══════════════════════════════════════════════════════════════════════════
-- PB3 — Notifikacije (outbox + config + enqueue + dispatch RPC)
-- Zavisi od: add_pb_module.sql, pb_get_load_stats (pb_load_stats_mechanical_engineering.sql),
--            auth.users, audit_row_change (opciono), pg_cron (opciono — cron blok hvata grešku).
-- Idempotentno gde je praktično.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) pb_work_reports — DELETE: kreator izveštaja ili admin (paritet sa PB3 spec)
DROP POLICY IF EXISTS pb_work_reports_delete_admin ON public.pb_work_reports;

CREATE POLICY pb_work_reports_delete_own_or_admin
  ON public.pb_work_reports FOR DELETE TO authenticated
  USING (
    public.current_user_is_admin()
    OR (
      created_by IS NOT NULL
      AND lower(trim(created_by)) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
    )
  );

-- ── 2) Outbox
CREATE TABLE IF NOT EXISTS public.pb_notification_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             TEXT NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  recipient           TEXT NOT NULL,
  recipient_user_id   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  subject             TEXT,
  body                TEXT NOT NULL,
  trigger_type        TEXT NOT NULL,
  related_task_id     UUID REFERENCES public.pb_tasks(id) ON DELETE SET NULL,
  related_employee_id UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'dead_letter')),
  error               TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  scheduled_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at     TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload             JSONB
);

COMMENT ON TABLE public.pb_notification_log IS
  'Projektni biro — outbox notifikacija; konzumira pb-notify-dispatch Edge funkcija';

CREATE INDEX IF NOT EXISTS pb_notification_log_status_idx
  ON public.pb_notification_log(status)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS pb_notification_log_scheduled_at_idx
  ON public.pb_notification_log(scheduled_at)
  WHERE status = 'pending';

ALTER TABLE public.pb_notification_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pb_notification_log_admin_all ON public.pb_notification_log;
DROP POLICY IF EXISTS pb_notification_log_own_select ON public.pb_notification_log;

CREATE POLICY pb_notification_log_admin_all
  ON public.pb_notification_log FOR ALL
  TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

CREATE POLICY pb_notification_log_own_select
  ON public.pb_notification_log FOR SELECT
  TO authenticated
  USING (recipient_user_id = auth.uid());

REVOKE ALL ON TABLE public.pb_notification_log FROM PUBLIC;
GRANT SELECT ON TABLE public.pb_notification_log TO authenticated;

-- ── 3) Config singleton
CREATE TABLE IF NOT EXISTS public.pb_notification_config (
  id                          INTEGER PRIMARY KEY DEFAULT 1
                                CHECK (id = 1),
  enabled                     BOOLEAN NOT NULL DEFAULT true,
  deadline_warning_days       INTEGER NOT NULL DEFAULT 3,
  overload_threshold_pct      INTEGER NOT NULL DEFAULT 100,
  email_recipients            TEXT[]  NOT NULL DEFAULT '{}',
  notify_on_blocked           BOOLEAN NOT NULL DEFAULT true,
  notify_on_overload          BOOLEAN NOT NULL DEFAULT true,
  notify_on_deadline_warning  BOOLEAN NOT NULL DEFAULT true,
  notify_on_deadline_overdue  BOOLEAN NOT NULL DEFAULT true,
  notify_on_no_engineer       BOOLEAN NOT NULL DEFAULT false,
  updated_at                  TIMESTAMPTZ,
  updated_by                  TEXT
);

COMMENT ON TABLE public.pb_notification_config IS
  'Singleton konfiguracija notifikacija za Projektni biro (uvek id=1)';

INSERT INTO public.pb_notification_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.pb_notification_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pb_notif_config_select ON public.pb_notification_config;
DROP POLICY IF EXISTS pb_notif_config_update ON public.pb_notification_config;

CREATE POLICY pb_notif_config_select
  ON public.pb_notification_config FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY pb_notif_config_update
  ON public.pb_notification_config FOR UPDATE
  TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

REVOKE ALL ON TABLE public.pb_notification_config FROM PUBLIC;
GRANT SELECT ON TABLE public.pb_notification_config TO authenticated;
GRANT UPDATE ON TABLE public.pb_notification_config TO authenticated;

-- ── 4) pb_enqueue_notifications
CREATE OR REPLACE FUNCTION public.pb_enqueue_notifications()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_cfg         public.pb_notification_config%ROWTYPE;
  v_today       DATE := (now() AT TIME ZONE 'Europe/Belgrade')::date;
  v_enqueued    INTEGER := 0;
  v_task        RECORD;
  v_load        RECORD;
  v_n           INTEGER;
BEGIN
  SELECT * INTO v_cfg FROM public.pb_notification_config WHERE id = 1;
  IF NOT FOUND OR NOT v_cfg.enabled THEN
    RETURN 0;
  END IF;

  IF array_length(v_cfg.email_recipients, 1) IS NULL
     OR array_length(v_cfg.email_recipients, 1) = 0 THEN
    RETURN 0;
  END IF;

  FOR v_task IN
    SELECT
      t.id,
      t.naziv,
      t.status,
      t.datum_zavrsetka_plan,
      t.datum_pocetka_plan,
      t.employee_id,
      e.full_name AS engineer_name,
      p.project_code,
      p.project_name
    FROM public.pb_tasks t
    LEFT JOIN public.employees e ON t.employee_id = e.id
    LEFT JOIN public.projects  p ON t.project_id  = p.id
    WHERE t.deleted_at IS NULL
      AND t.status <> 'Završeno'::public.pb_task_status
  LOOP
    -- 1. Rok za ≤N dana
    IF v_cfg.notify_on_deadline_warning
       AND v_task.datum_zavrsetka_plan IS NOT NULL
       AND v_task.datum_zavrsetka_plan >= v_today
       AND (v_task.datum_zavrsetka_plan - v_today) <= v_cfg.deadline_warning_days
    THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'deadline_warning'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB Upozorenje: rok ističe — ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) ističe %s (%s dana).'
            || chr(10) || 'Inženjer: %s | Status: %s',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            v_task.datum_zavrsetka_plan::text,
            (v_task.datum_zavrsetka_plan - v_today)::text,
            coalesce(v_task.engineer_name, 'nije dodeljen'),
            v_task.status
          ),
          'deadline_warning',
          v_task.id,
          v_task.employee_id,
          jsonb_build_object(
            'task_id',      v_task.id,
            'task_name',    v_task.naziv,
            'project_code', v_task.project_code,
            'deadline',     v_task.datum_zavrsetka_plan,
            'days_left',    (v_task.datum_zavrsetka_plan - v_today)
          )
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;

    -- 2. Rok prošao
    IF v_cfg.notify_on_deadline_overdue
       AND v_task.datum_zavrsetka_plan IS NOT NULL
       AND v_task.datum_zavrsetka_plan < v_today
    THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'deadline_overdue'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB Kašnjenje: rok prošao — ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) nije završen.'
            || chr(10) || 'Rok je bio: %s (%s dana kašnjenja).'
            || chr(10) || 'Inženjer: %s | Status: %s',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            v_task.datum_zavrsetka_plan::text,
            (v_today - v_task.datum_zavrsetka_plan)::text,
            coalesce(v_task.engineer_name, 'nije dodeljen'),
            v_task.status
          ),
          'deadline_overdue',
          v_task.id,
          v_task.employee_id,
          jsonb_build_object(
            'task_id',      v_task.id,
            'task_name',    v_task.naziv,
            'project_code', v_task.project_code,
            'deadline',     v_task.datum_zavrsetka_plan,
            'days_late',    (v_today - v_task.datum_zavrsetka_plan)
          )
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;

    -- 3. Blokirano
    IF v_cfg.notify_on_blocked AND v_task.status = 'Blokirano' THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'task_blocked'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB Blokirano: ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) je blokiran.'
            || chr(10) || 'Inženjer: %s',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            coalesce(v_task.engineer_name, 'nije dodeljen')
          ),
          'task_blocked',
          v_task.id,
          v_task.employee_id,
          jsonb_build_object(
            'task_id',      v_task.id,
            'task_name',    v_task.naziv,
            'project_code', v_task.project_code
          )
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;

    -- 4. Počinje uskoro bez inženjera
    IF v_cfg.notify_on_no_engineer
       AND v_task.employee_id IS NULL
       AND v_task.datum_pocetka_plan IS NOT NULL
       AND v_task.datum_pocetka_plan >= v_today
       AND (v_task.datum_pocetka_plan - v_today) <= coalesce(v_cfg.deadline_warning_days, 3)
    THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'no_engineer'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB: zadatak bez inženjera — ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) počinje %s, inženjer nije dodeljen.',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            v_task.datum_pocetka_plan::text
          ),
          'no_engineer',
          v_task.id,
          NULL,
          jsonb_build_object('task_id', v_task.id, 'task_name', v_task.naziv)
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;
  END LOOP;

  -- 5. Preopterećenost (izolovano — greška u load stats ne prekida ostale tipove)
  IF v_cfg.notify_on_overload AND coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0 THEN
    BEGIN
      FOR v_load IN
        SELECT *
        FROM public.pb_get_load_stats(30)
        WHERE load_pct > v_cfg.overload_threshold_pct
      LOOP
        IF NOT EXISTS (
          SELECT 1 FROM public.pb_notification_log nl
          WHERE nl.related_employee_id = v_load.employee_id
            AND nl.trigger_type = 'overload'
            AND nl.created_at::date = v_today
        ) THEN
          INSERT INTO public.pb_notification_log
            (channel, recipient, recipient_user_id, subject, body,
             trigger_type, related_task_id, related_employee_id, payload)
          SELECT
            'email',
            trim(r.r),
            (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
            'PB Preopterećenost: ' || v_load.full_name,
            format(
              'Inženjer %s je opterećen %s%% u narednih 30 dana'
              || ' (max %sh, planirano %sh).',
              v_load.full_name,
              v_load.load_pct::text,
              v_load.max_hours::text,
              v_load.total_hours::text
            ),
            'overload',
            NULL,
            v_load.employee_id,
            jsonb_build_object(
              'employee_id', v_load.employee_id,
              'full_name',   v_load.full_name,
              'load_pct',    v_load.load_pct,
              'total_hours', v_load.total_hours,
              'max_hours',   v_load.max_hours
            )
          FROM unnest(v_cfg.email_recipients) AS r(r);
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_enqueued := v_enqueued + v_n;
        END IF;
      END LOOP;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'pb_enqueue_notifications: overload / pb_get_load_stats greška: %', SQLERRM;
    END;
  END IF;

  RETURN v_enqueued;
END;
$$;

REVOKE ALL ON FUNCTION public.pb_enqueue_notifications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pb_enqueue_notifications() TO service_role;

-- ── 5) Dispatch
CREATE OR REPLACE FUNCTION public.pb_dispatch_dequeue(batch_size INTEGER DEFAULT 10)
RETURNS SETOF public.pb_notification_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH c AS (
    SELECT id
    FROM public.pb_notification_log
    WHERE status IN ('pending', 'failed')
      AND next_attempt_at <= now()
      AND attempts < 5
    ORDER BY scheduled_at ASC
    LIMIT batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pb_notification_log n
  SET status = 'processing',
      last_attempt_at = now(),
      attempts = n.attempts + 1
  FROM c
  WHERE n.id = c.id
  RETURNING n.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_dispatch_mark_sent(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.pb_notification_log
  SET status = 'sent', sent_at = now()
  WHERE id = p_id AND status = 'processing';
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_dispatch_mark_failed(p_id UUID, p_error TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.pb_notification_log
  SET status = CASE WHEN attempts >= 5 THEN 'dead_letter' ELSE 'failed' END,
      error = p_error,
      next_attempt_at = now() + interval '30 minutes'
  WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pb_dispatch_dequeue(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pb_dispatch_mark_sent(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pb_dispatch_mark_failed(UUID, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.pb_dispatch_dequeue(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.pb_dispatch_mark_sent(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.pb_dispatch_mark_failed(UUID, TEXT) TO service_role;

-- TODO(PB4): personal notifikacije na employees.email + trigger na pb_tasks — vidi docs/pb_review_report.md F5

-- ── 6) pg_cron (best-effort — na instancama bez cron-a ignoriši grešku)
DO $cron_wrap$
BEGIN
  PERFORM cron.schedule(
    'pb-enqueue-notifications',
    '0 7 * * *',
    $job$ SELECT public.pb_enqueue_notifications(); $job$
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pb-enqueue-notifications cron skipped: %', SQLERRM;
END $cron_wrap$;
