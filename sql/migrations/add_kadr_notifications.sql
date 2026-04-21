-- ═══════════════════════════════════════════════════════════════════════════
-- KADROVSKA — NOTIFIKACIJE (Faza K4, „WhatsApp upozorenja")
--
-- Pokriva sledeće alert tipove:
--   • medical_expiring  — ističe lekarski pregled (employees.medical_exam_expires)
--   • contract_expiring — ističe ugovor o radu (contracts.date_to)
--   • birthday          — rođendan zaposlenog (opciono)
--   • work_anniversary  — godišnjica zaposlenja (opciono)
--
-- Arhitektura identična `maint_notification_log`:
--   1. Singleton `kadr_notification_config` red sa pragom (lead_time_days) i
--      primaocima (WhatsApp brojevi + email adrese).
--   2. `kadr_notification_log` outbox sa status flow: queued → sent / failed.
--   3. Funkcija `kadr_schedule_hr_reminders()` — plpgsql, SECURITY DEFINER,
--      skenira employees + contracts i enqueue-uje redove (deduplicira po
--      (related_entity_type, related_entity_id, scheduled_at::date)).
--   4. `pg_cron` job svaki dan u 07:00 poziva schedule funkciju.
--   5. Dispatch RPC-ovi (`kadr_dispatch_dequeue`, `kadr_dispatch_mark_sent`,
--      `kadr_dispatch_mark_failed`) — samo service_role, edge funkcija ih zove.
--
-- Ovaj fajl je idempotentan, može da se re-run-uje.
--
-- Depends on: add_kadrovska_module.sql, add_kadr_employee_extended.sql,
--            add_admin_roles.sql, update_updated_at().
-- ═══════════════════════════════════════════════════════════════════════════

-- 0) Sanity --------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename='employees') THEN
    RAISE EXCEPTION 'Missing employees. Run add_kadrovska_module.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename='contracts') THEN
    RAISE EXCEPTION 'Missing contracts. Run add_kadrovska_phase1.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='current_user_is_hr_or_admin') THEN
    RAISE EXCEPTION 'Missing current_user_is_hr_or_admin(). Run add_kadr_employee_extended.sql first.';
  END IF;
END $$;

-- 1) Config (singleton) -------------------------------------------------
CREATE TABLE IF NOT EXISTS kadr_notification_config (
  id                   INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled              BOOLEAN NOT NULL DEFAULT true,
  /* Koliko dana pre isteka treba generisati upozorenje */
  medical_lead_days    INT NOT NULL DEFAULT 30,
  contract_lead_days   INT NOT NULL DEFAULT 30,
  /* Rođendan / godišnjica — uključeno = kreira se red na sam dan */
  birthday_enabled           BOOLEAN NOT NULL DEFAULT false,
  work_anniversary_enabled   BOOLEAN NOT NULL DEFAULT false,
  /* Primalac — WhatsApp brojevi u E.164 formatu (bez + i razmaka, npr. 381601234567);
     niz, kanal se bira po redu: ako ima phones → WhatsApp, ako ima emails → i email. */
  whatsapp_recipients  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  email_recipients     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  /* Meta */
  updated_at           TIMESTAMPTZ DEFAULT now(),
  updated_by           TEXT
);

-- Osigurava da uvek postoji 1 red
INSERT INTO kadr_notification_config (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_kadr_notification_config_updated ON kadr_notification_config;
CREATE TRIGGER trg_kadr_notification_config_updated
  BEFORE UPDATE ON kadr_notification_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE kadr_notification_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kadr_cfg_select_hr"  ON kadr_notification_config;
DROP POLICY IF EXISTS "kadr_cfg_update_hr"  ON kadr_notification_config;

CREATE POLICY "kadr_cfg_select_hr" ON kadr_notification_config
  FOR SELECT TO authenticated
  USING (public.current_user_is_hr_or_admin());

CREATE POLICY "kadr_cfg_update_hr" ON kadr_notification_config
  FOR UPDATE TO authenticated
  USING      (public.current_user_is_hr_or_admin())
  WITH CHECK (public.current_user_is_hr_or_admin());

-- 2) Outbox log ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS kadr_notification_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel              TEXT NOT NULL DEFAULT 'whatsapp',   -- 'whatsapp' | 'email' | 'sms'
  recipient            TEXT NOT NULL,
  subject              TEXT,
  body                 TEXT NOT NULL DEFAULT '',
  /* Vezivanje — za dedup + audit trail */
  related_entity_type  TEXT NOT NULL,
  /* 'employee_medical' | 'employee_contract' | 'employee_birthday' | 'employee_anniversary' */
  related_entity_id    TEXT,                                -- uuid employee-ja ili contract-a (TEXT radi generičnosti)
  employee_id          UUID REFERENCES employees(id) ON DELETE CASCADE,
  notification_type    TEXT NOT NULL,
  /* Lifecycle */
  status               TEXT NOT NULL DEFAULT 'queued',     -- 'queued' | 'sent' | 'failed' | 'canceled'
  scheduled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts             INT NOT NULL DEFAULT 0,
  last_attempt_at      TIMESTAMPTZ,
  sent_at              TIMESTAMPTZ,
  error                TEXT,
  /* Free JSONB za template/worker-specific payload */
  payload              JSONB DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

-- Constraint na status i channel
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='kadr_notif_status_chk'
                 AND conrelid='kadr_notification_log'::regclass) THEN
    ALTER TABLE kadr_notification_log
      ADD CONSTRAINT kadr_notif_status_chk
      CHECK (status IN ('queued','sent','failed','canceled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='kadr_notif_channel_chk'
                 AND conrelid='kadr_notification_log'::regclass) THEN
    ALTER TABLE kadr_notification_log
      ADD CONSTRAINT kadr_notif_channel_chk
      CHECK (channel IN ('whatsapp','email','sms'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='kadr_notif_type_chk'
                 AND conrelid='kadr_notification_log'::regclass) THEN
    ALTER TABLE kadr_notification_log
      ADD CONSTRAINT kadr_notif_type_chk
      CHECK (notification_type IN (
        'medical_expiring', 'contract_expiring',
        'birthday', 'work_anniversary'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_kadr_notif_status
  ON kadr_notification_log(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_kadr_notif_emp
  ON kadr_notification_log(employee_id);
-- Napomena: `scheduled_at::date` nije IMMUTABLE (zavisi od TimeZone GUC-a)
-- pa ga NE možemo staviti u expression-based index. Btree nad plain
-- `scheduled_at` + (tip, entity_id, type) je dovoljan — dedup upiti će
-- koristiti range scan po danu (today .. today+1 day).
DROP INDEX IF EXISTS idx_kadr_notif_dedup;
CREATE INDEX IF NOT EXISTS idx_kadr_notif_dedup
  ON kadr_notification_log(related_entity_type, related_entity_id, notification_type, scheduled_at);

DROP TRIGGER IF EXISTS trg_kadr_notif_updated ON kadr_notification_log;
CREATE TRIGGER trg_kadr_notif_updated
  BEFORE UPDATE ON kadr_notification_log
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: HR/admin vide sve; niko drugi.
-- Insert/update ide isključivo kroz SECURITY DEFINER funkcije (service role).
ALTER TABLE kadr_notification_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kadr_notif_select_hr" ON kadr_notification_log;
DROP POLICY IF EXISTS "kadr_notif_update_hr" ON kadr_notification_log;
DROP POLICY IF EXISTS "kadr_notif_delete_hr" ON kadr_notification_log;

CREATE POLICY "kadr_notif_select_hr" ON kadr_notification_log
  FOR SELECT TO authenticated
  USING (public.current_user_is_hr_or_admin());

-- HR/admin sme ručno da cancel-uje red (status → 'canceled')
CREATE POLICY "kadr_notif_update_hr" ON kadr_notification_log
  FOR UPDATE TO authenticated
  USING      (public.current_user_is_hr_or_admin())
  WITH CHECK (public.current_user_is_hr_or_admin());

CREATE POLICY "kadr_notif_delete_hr" ON kadr_notification_log
  FOR DELETE TO authenticated
  USING (public.current_user_is_hr_or_admin());

-- 3) Schedule funkcija — pravi queued redove za predstojeće događaje ----
--
-- Deduplikuje se preko jedinstvene kombinacije (related_entity_type,
-- related_entity_id, notification_type, scheduled_at::date). Ako je red
-- već upisan istog dana, ne kreira se drugi.
--
-- Kreira po jedan red POTEMPLAT-U za svaki WhatsApp broj i email iz
-- config-a. Ako nema podešenih primalaca, ne kreira ništa (ali logira).
CREATE OR REPLACE FUNCTION public.kadr_schedule_hr_reminders()
RETURNS TABLE(
  scheduled_count INT,
  skipped_count   INT,
  config_missing  BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn_sched$
DECLARE
  /* Skalarne varijable umesto %ROWTYPE — Supabase SQL Editor parser
   * pogrešno prepoznaje `SELECT * INTO v_cfg ... ` kao CTAS i pokušava
   * da tretira v_cfg kao tabelu (42P01). Skalarni subquery assignment-i
   * su verifikovan obrazac u codebase-u (videti loc_mark_sync_failed). */
  v_enabled         boolean;
  v_med_lead        int;
  v_con_lead        int;
  v_bday_enabled    boolean;
  v_ann_enabled     boolean;
  v_wa_recipients   text[];
  v_em_recipients   text[];
  v_scheduled       int := 0;
  v_skipped         int := 0;
BEGIN
  v_enabled       := (SELECT enabled                   FROM public.kadr_notification_config WHERE id = 1);
  v_med_lead      := (SELECT medical_lead_days         FROM public.kadr_notification_config WHERE id = 1);
  v_con_lead      := (SELECT contract_lead_days        FROM public.kadr_notification_config WHERE id = 1);
  v_bday_enabled  := (SELECT birthday_enabled          FROM public.kadr_notification_config WHERE id = 1);
  v_ann_enabled   := (SELECT work_anniversary_enabled  FROM public.kadr_notification_config WHERE id = 1);
  v_wa_recipients := (SELECT whatsapp_recipients       FROM public.kadr_notification_config WHERE id = 1);
  v_em_recipients := (SELECT email_recipients          FROM public.kadr_notification_config WHERE id = 1);

  IF v_enabled IS NULL OR NOT v_enabled THEN
    scheduled_count := 0;
    skipped_count   := 0;
    config_missing  := true;
    RETURN NEXT;
    RETURN;
  END IF;

  IF array_length(v_wa_recipients, 1) IS NULL
     AND array_length(v_em_recipients, 1) IS NULL THEN
    scheduled_count := 0;
    skipped_count   := 0;
    config_missing  := true;
    RETURN NEXT;
    RETURN;
  END IF;

  /* -- A) Medical expiring ------------------------------------------- */
  WITH medical_due AS (
    SELECT e.id AS emp_id,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           e.medical_exam_expires AS due_date,
           (e.medical_exam_expires - CURRENT_DATE) AS days_left
      FROM employees e
     WHERE e.is_active = true
       AND e.medical_exam_expires IS NOT NULL
       AND e.medical_exam_expires <= CURRENT_DATE + v_med_lead
       AND e.medical_exam_expires >= CURRENT_DATE  -- ne šaljemo za već istekle
  ),
  wa_targets AS (
    SELECT unnest(v_wa_recipients) AS recipient, 'whatsapp'::text AS channel
  ),
  em_targets AS (
    SELECT unnest(v_em_recipients) AS recipient, 'email'::text AS channel
  ),
  all_targets AS (
    SELECT * FROM wa_targets UNION ALL SELECT * FROM em_targets
  ),
  candidates AS (
    SELECT md.emp_id, md.emp_name, md.due_date, md.days_left,
           t.recipient, t.channel
      FROM medical_due md
      CROSS JOIN all_targets t
  ),
  to_insert AS (
    SELECT c.* FROM candidates c
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = 'medical_expiring'
          AND n.related_entity_id = c.emp_id::text
          AND n.recipient = c.recipient
          AND n.scheduled_at::date = CURRENT_DATE
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      channel, recipient,
      format('Lekarski istice — %s', emp_name),
      format(E'Zaposleni *%s*: lekarski pregled istice %s (za %s dana).',
             emp_name, to_char(due_date, 'DD.MM.YYYY'), days_left),
      'employee_medical', emp_id::text, emp_id,
      'medical_expiring', 'queued', now(), now(),
      jsonb_build_object(
        'employee_name', emp_name,
        'due_date', due_date,
        'days_left', days_left
      )
    FROM to_insert
    RETURNING 1
  )
  SELECT count(*) INTO v_scheduled FROM ins;

  /* -- B) Contract expiring ----------------------------------------- */
  WITH contracts_due AS (
    SELECT c.id AS contract_id, c.employee_id,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           c.date_to AS due_date,
           (c.date_to - CURRENT_DATE) AS days_left
      FROM contracts c
      JOIN employees e ON e.id = c.employee_id
     WHERE e.is_active = true
       AND c.is_active = true
       AND c.date_to IS NOT NULL
       AND c.date_to <= CURRENT_DATE + v_con_lead
       AND c.date_to >= CURRENT_DATE
  ),
  wa_targets AS (
    SELECT unnest(v_wa_recipients) AS recipient, 'whatsapp'::text AS channel
  ),
  em_targets AS (
    SELECT unnest(v_em_recipients) AS recipient, 'email'::text AS channel
  ),
  all_targets AS (
    SELECT * FROM wa_targets UNION ALL SELECT * FROM em_targets
  ),
  candidates AS (
    SELECT cd.contract_id, cd.employee_id, cd.emp_name, cd.due_date, cd.days_left,
           t.recipient, t.channel
      FROM contracts_due cd
      CROSS JOIN all_targets t
  ),
  to_insert AS (
    SELECT c.* FROM candidates c
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = 'contract_expiring'
          AND n.related_entity_id = c.contract_id::text
          AND n.recipient = c.recipient
          AND n.scheduled_at::date = CURRENT_DATE
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      channel, recipient,
      format('Ugovor istice — %s', emp_name),
      format(E'Ugovor o radu za *%s* istice %s (za %s dana).',
             emp_name, to_char(due_date, 'DD.MM.YYYY'), days_left),
      'employee_contract', contract_id::text, employee_id,
      'contract_expiring', 'queued', now(), now(),
      jsonb_build_object(
        'employee_name', emp_name,
        'due_date', due_date,
        'days_left', days_left,
        'contract_id', contract_id
      )
    FROM to_insert
    RETURNING 1
  )
  SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;

  /* -- C) Birthday (ako je uključeno) --------------------------------- */
  IF v_bday_enabled THEN
    WITH birthdays_today AS (
      SELECT e.id AS emp_id,
             COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
             e.birth_date
        FROM employees e
       WHERE e.is_active = true
         AND e.birth_date IS NOT NULL
         AND to_char(e.birth_date, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
    ),
    wa_targets AS (
      SELECT unnest(v_wa_recipients) AS recipient, 'whatsapp'::text AS channel
    ),
    em_targets AS (
      SELECT unnest(v_em_recipients) AS recipient, 'email'::text AS channel
    ),
    all_targets AS (
      SELECT * FROM wa_targets UNION ALL SELECT * FROM em_targets
    ),
    candidates AS (
      SELECT bd.*, t.recipient, t.channel
        FROM birthdays_today bd
        CROSS JOIN all_targets t
    ),
    to_insert AS (
      SELECT c.* FROM candidates c
       WHERE NOT EXISTS (
         SELECT 1 FROM kadr_notification_log n
          WHERE n.notification_type = 'birthday'
            AND n.related_entity_id = c.emp_id::text
            AND n.recipient = c.recipient
            AND n.scheduled_at::date = CURRENT_DATE
       )
    ),
    ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body,
        related_entity_type, related_entity_id, employee_id,
        notification_type, status, scheduled_at, next_attempt_at, payload
      )
      SELECT
        channel, recipient,
        format('Rodjendan — %s', emp_name),
        format(E'Danas je rodjendan zaposlenog *%s*. Srecan rodjendan!', emp_name),
        'employee_birthday', emp_id::text, emp_id,
        'birthday', 'queued', now(), now(),
        jsonb_build_object('employee_name', emp_name, 'birth_date', birth_date)
      FROM to_insert
      RETURNING 1
    )
    SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;
  END IF;

  /* -- D) Work anniversary (ako je uključeno) -------------------------- */
  IF v_ann_enabled THEN
    WITH anniversaries_today AS (
      SELECT e.id AS emp_id,
             COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
             e.hire_date,
             EXTRACT(YEAR FROM AGE(CURRENT_DATE, e.hire_date))::int AS years_worked
        FROM employees e
       WHERE e.is_active = true
         AND e.hire_date IS NOT NULL
         AND to_char(e.hire_date, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
         AND e.hire_date < CURRENT_DATE
    ),
    wa_targets AS (
      SELECT unnest(v_wa_recipients) AS recipient, 'whatsapp'::text AS channel
    ),
    em_targets AS (
      SELECT unnest(v_em_recipients) AS recipient, 'email'::text AS channel
    ),
    all_targets AS (
      SELECT * FROM wa_targets UNION ALL SELECT * FROM em_targets
    ),
    candidates AS (
      SELECT ann.*, t.recipient, t.channel
        FROM anniversaries_today ann
        CROSS JOIN all_targets t
    ),
    to_insert AS (
      SELECT c.* FROM candidates c
       WHERE NOT EXISTS (
         SELECT 1 FROM kadr_notification_log n
          WHERE n.notification_type = 'work_anniversary'
            AND n.related_entity_id = c.emp_id::text
            AND n.recipient = c.recipient
            AND n.scheduled_at::date = CURRENT_DATE
       )
    ),
    ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body,
        related_entity_type, related_entity_id, employee_id,
        notification_type, status, scheduled_at, next_attempt_at, payload
      )
      SELECT
        channel, recipient,
        format('Godisnjica — %s (%s god.)', emp_name, years_worked),
        format(E'Zaposleni *%s* danas slavi *%s godina* rada u firmi.', emp_name, years_worked),
        'employee_anniversary', emp_id::text, emp_id,
        'work_anniversary', 'queued', now(), now(),
        jsonb_build_object('employee_name', emp_name, 'years_worked', years_worked, 'hire_date', hire_date)
      FROM to_insert
      RETURNING 1
    )
    SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;
  END IF;

  scheduled_count := v_scheduled;
  skipped_count   := v_skipped;
  config_missing  := false;
  RETURN NEXT;
END;
$fn_sched$;

REVOKE ALL ON FUNCTION public.kadr_schedule_hr_reminders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kadr_schedule_hr_reminders() TO service_role;

-- Autorizovana ruta za HR/admin — da ručno mogu da pokrenu schedule iz UI-ja
CREATE OR REPLACE FUNCTION public.kadr_trigger_schedule_hr_reminders()
RETURNS TABLE(scheduled_count INT, skipped_count INT, config_missing BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn_trig$
BEGIN
  IF NOT public.current_user_is_hr_or_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.kadr_schedule_hr_reminders();
END;
$fn_trig$;

REVOKE ALL ON FUNCTION public.kadr_trigger_schedule_hr_reminders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kadr_trigger_schedule_hr_reminders() TO authenticated;

-- 4) Dispatch RPC-ovi (edge worker koristi service_role JWT) -----------
CREATE OR REPLACE FUNCTION public.kadr_dispatch_dequeue(
  p_batch_size   INT DEFAULT 25,
  p_max_attempts INT DEFAULT 8
)
RETURNS SETOF public.kadr_notification_log
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn_deq$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id
      FROM public.kadr_notification_log
     WHERE status IN ('queued', 'failed')
       AND next_attempt_at <= now()
       AND attempts < p_max_attempts
     ORDER BY next_attempt_at ASC, created_at ASC
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.kadr_notification_log n
     SET attempts        = n.attempts + 1,
         last_attempt_at = now(),
         status          = 'queued'
   FROM picked p
  WHERE n.id = p.id
  RETURNING n.*;
END;
$fn_deq$;

CREATE OR REPLACE FUNCTION public.kadr_dispatch_mark_sent(p_ids UUID[])
RETURNS INT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn_ms$
  WITH upd AS (
    UPDATE public.kadr_notification_log
       SET status  = 'sent',
           sent_at = now(),
           error   = NULL
     WHERE id = ANY (p_ids)
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$fn_ms$;

CREATE OR REPLACE FUNCTION public.kadr_dispatch_mark_failed(
  p_id          UUID,
  p_error       TEXT,
  p_backoff_sec INT DEFAULT 300
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $fn_mf$
  UPDATE public.kadr_notification_log
     SET status          = 'failed',
         error           = LEFT(COALESCE(p_error, ''), 1000),
         next_attempt_at = now() + make_interval(secs => GREATEST(p_backoff_sec, 30))
   WHERE id = p_id;
$fn_mf$;

REVOKE ALL ON FUNCTION public.kadr_dispatch_dequeue(int,int)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kadr_dispatch_mark_sent(uuid[])        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kadr_dispatch_mark_failed(uuid,text,int) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.kadr_dispatch_dequeue(int,int)         TO service_role;
GRANT EXECUTE ON FUNCTION public.kadr_dispatch_mark_sent(uuid[])        TO service_role;
GRANT EXECUTE ON FUNCTION public.kadr_dispatch_mark_failed(uuid,text,int) TO service_role;

-- 5) pg_cron: svaki dan u 07:00 (server time) ---------------------------
-- Opciono — pokreni SAMO ako je pg_cron extension dostupan. Supabase ga
-- nudi na plaćenim planovima. Ako nije dostupan, preskoči ovu sekciju
-- i zakaži preko externog scheduler-a (GitHub Actions / Vercel Cron itd.).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    /* Obriši prethodni job ako postoji (idempotent) */
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'kadr_schedule_hr_reminders_daily';
    PERFORM cron.schedule(
      'kadr_schedule_hr_reminders_daily',
      '0 7 * * *',
      $cron$SELECT public.kadr_schedule_hr_reminders();$cron$
    );
    RAISE NOTICE 'pg_cron job scheduled: kadr_schedule_hr_reminders_daily @ 07:00';
  ELSE
    RAISE NOTICE 'pg_cron not installed — schedule manually via external cron';
  END IF;
END $$;

-- 6) Verifikacija -------------------------------------------------------
-- SELECT * FROM kadr_notification_config;
-- SELECT count(*), status FROM kadr_notification_log GROUP BY status;
-- SELECT * FROM kadr_trigger_schedule_hr_reminders();  -- ručni test
