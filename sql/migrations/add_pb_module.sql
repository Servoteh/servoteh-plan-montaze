-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: Projektni biro (PB) — tabele pb_tasks, pb_work_reports, RLS, load RPC
-- Idempotentno gde je praktično (CREATE IF NOT EXISTS, DROP IF EXISTS policy).
-- Zavisnosti: public.projects, public.employees (CI stub u sql/ci/00_bootstrap.sql),
--             public.has_edit_role, public.current_user_is_admin,
--             public.audit_row_change, public.update_updated_at
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Enum tipovi
DO $$ BEGIN
  CREATE TYPE public.pb_task_status AS ENUM (
    'Nije počelo', 'U toku', 'Pregled', 'Završeno', 'Blokirano'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.pb_task_vrsta AS ENUM (
    'Projektovanje 3D', 'Dokumentacija', 'Nabavka', 'Algoritam', 'Montaža'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.pb_prioritet AS ENUM (
    'Visok', 'Srednji', 'Nizak'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2) Tabela pb_tasks
CREATE TABLE IF NOT EXISTS public.pb_tasks (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  naziv                 TEXT NOT NULL,
  opis                  TEXT,
  problem               TEXT,
  project_id            UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  employee_id           UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  vrsta                 public.pb_task_vrsta NOT NULL DEFAULT 'Projektovanje 3D',
  prioritet             public.pb_prioritet NOT NULL DEFAULT 'Srednji',
  status                public.pb_task_status NOT NULL DEFAULT 'Nije počelo',
  datum_pocetka_plan    DATE,
  datum_zavrsetka_plan  DATE,
  datum_pocetka_real    DATE,
  datum_zavrsetka_real  DATE,
  procenat_zavrsenosti  INTEGER NOT NULL DEFAULT 0
                          CHECK (procenat_zavrsenosti BETWEEN 0 AND 100),
  norma_sati_dan        INTEGER NOT NULL DEFAULT 4
                          CHECK (norma_sati_dan BETWEEN 1 AND 7),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            TEXT,
  updated_by            TEXT,
  deleted_at            TIMESTAMPTZ
);

COMMENT ON TABLE public.pb_tasks IS
  'Projektni biro — zadaci planiranja i praćenja rada inženjera';
COMMENT ON COLUMN public.pb_tasks.norma_sati_dan IS
  'Planirani angažman po radnom danu za ovaj zadatak, max 7h';
COMMENT ON COLUMN public.pb_tasks.procenat_zavrsenosti IS
  'Subjektivna procena završenosti 0-100%';
-- TODO(PB4): opciona kolona bigtehn_rn_id (bigint → bigtehn_work_orders_cache) za drill-down na RN — vidi docs/pb_review_report.md F1
-- TODO(PB5): recurring tasks — recurrence_rule text (RRULE); cron pb_generate_recurring_tasks — vidi docs/pb_review_report.md F6

-- ── 3) Tabela pb_work_reports
CREATE TABLE IF NOT EXISTS public.pb_work_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID REFERENCES public.employees(id) ON DELETE SET NULL,
  datum        DATE NOT NULL,
  sati         NUMERIC(4,1) NOT NULL CHECK (sati > 0 AND sati <= 24),
  opis         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT
);

COMMENT ON TABLE public.pb_work_reports IS
  'Projektni biro — slobodni dnevni izveštaji sati (van planiranih zadataka)';

-- ── 4) Indeksi
CREATE INDEX IF NOT EXISTS pb_tasks_project_id_idx ON public.pb_tasks(project_id);
CREATE INDEX IF NOT EXISTS pb_tasks_employee_id_idx ON public.pb_tasks(employee_id);
CREATE INDEX IF NOT EXISTS pb_tasks_status_idx ON public.pb_tasks(status);
CREATE INDEX IF NOT EXISTS pb_tasks_deleted_at_idx ON public.pb_tasks(deleted_at)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pb_work_reports_employee_idx ON public.pb_work_reports(employee_id);
CREATE INDEX IF NOT EXISTS pb_work_reports_datum_idx ON public.pb_work_reports(datum);

-- ── 5a) updated_at trigger na pb_tasks
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION public.update_updated_at()
      RETURNS TRIGGER AS $body$
      BEGIN
        NEW.updated_at := now();
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    $fn$;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_pb_tasks_updated ON public.pb_tasks;
CREATE TRIGGER trg_pb_tasks_updated
  BEFORE UPDATE ON public.pb_tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── 5b) Audit triggeri (funkcija public.audit_row_change iz add_audit_log.sql)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'audit_row_change'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_audit_pb_tasks ON public.pb_tasks';
    EXECUTE 'CREATE TRIGGER trg_audit_pb_tasks
      AFTER INSERT OR UPDATE OR DELETE ON public.pb_tasks
      FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()';

    EXECUTE 'DROP TRIGGER IF EXISTS trg_audit_pb_work_reports ON public.pb_work_reports';
    EXECUTE 'CREATE TRIGGER trg_audit_pb_work_reports
      AFTER INSERT OR UPDATE OR DELETE ON public.pb_work_reports
      FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()';
  ELSE
    RAISE NOTICE 'pb_module: audit_row_change() missing — skip audit triggers';
  END IF;
END $$;

-- ── 6) Helper za RLS pisanje (paritet sa has_edit_role; bez nove user_roles vrednosti)
--      Napomena: spec je spomenuo pb_editor — user_roles se NE menja ovom migracijom.
CREATE OR REPLACE FUNCTION public.pb_can_edit_tasks()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.current_user_is_admin() OR public.has_edit_role();
$$;

REVOKE ALL ON FUNCTION public.pb_can_edit_tasks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pb_can_edit_tasks() TO authenticated;

-- ── 7) RLS pb_tasks
ALTER TABLE public.pb_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pb_tasks_select_authenticated ON public.pb_tasks;
DROP POLICY IF EXISTS pb_tasks_insert_editors ON public.pb_tasks;
DROP POLICY IF EXISTS pb_tasks_update_editors ON public.pb_tasks;

CREATE POLICY pb_tasks_select_authenticated
  ON public.pb_tasks FOR SELECT TO authenticated
  USING (deleted_at IS NULL);

CREATE POLICY pb_tasks_insert_editors
  ON public.pb_tasks FOR INSERT TO authenticated
  WITH CHECK (public.pb_can_edit_tasks());

CREATE POLICY pb_tasks_update_editors
  ON public.pb_tasks FOR UPDATE TO authenticated
  USING (public.pb_can_edit_tasks())
  WITH CHECK (public.pb_can_edit_tasks());

-- ── 8) RLS pb_work_reports
ALTER TABLE public.pb_work_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pb_work_reports_select_authenticated ON public.pb_work_reports;
DROP POLICY IF EXISTS pb_work_reports_insert_editors ON public.pb_work_reports;
DROP POLICY IF EXISTS pb_work_reports_update_editors ON public.pb_work_reports;
DROP POLICY IF EXISTS pb_work_reports_delete_admin ON public.pb_work_reports;

CREATE POLICY pb_work_reports_select_authenticated
  ON public.pb_work_reports FOR SELECT TO authenticated
  USING (true);

CREATE POLICY pb_work_reports_insert_editors
  ON public.pb_work_reports FOR INSERT TO authenticated
  WITH CHECK (public.pb_can_edit_tasks());

CREATE POLICY pb_work_reports_update_editors
  ON public.pb_work_reports FOR UPDATE TO authenticated
  USING (public.pb_can_edit_tasks())
  WITH CHECK (public.pb_can_edit_tasks());

CREATE POLICY pb_work_reports_delete_admin
  ON public.pb_work_reports FOR DELETE TO authenticated
  USING (public.current_user_is_admin());

-- ── 9) GRANT (PostgREST)
REVOKE ALL ON TABLE public.pb_tasks FROM PUBLIC;
REVOKE ALL ON TABLE public.pb_work_reports FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.pb_tasks TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pb_work_reports TO authenticated;

-- ── 10) RPC pb_get_load_stats
CREATE OR REPLACE FUNCTION public.pb_get_load_stats(window_days INTEGER DEFAULT 30)
RETURNS TABLE (
  employee_id   UUID,
  full_name     TEXT,
  total_hours   NUMERIC,
  max_hours     NUMERIC,
  load_pct      INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today     DATE := CURRENT_DATE;
  v_end       DATE := CURRENT_DATE + window_days;
  v_workdays  INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_workdays
  FROM generate_series(v_today, v_end, '1 day'::interval) AS gs(d)
  WHERE EXTRACT(DOW FROM gs.d) NOT IN (0, 6);

  RETURN QUERY
  SELECT
    e.id AS employee_id,
    e.full_name,
    COALESCE(SUM(
      LEAST(t.norma_sati_dan, 7) *
      (
        SELECT COUNT(*)::INTEGER
        FROM generate_series(
          GREATEST(t.datum_pocetka_plan, v_today),
          LEAST(t.datum_zavrsetka_plan, v_end),
          '1 day'::interval
        ) AS gs2(d)
        WHERE EXTRACT(DOW FROM gs2.d) NOT IN (0, 6)
      )
    ), 0)::NUMERIC AS total_hours,
    (v_workdays * 7)::NUMERIC AS max_hours,
    CASE WHEN v_workdays * 7 > 0 THEN
      ROUND(
        COALESCE(SUM(
          LEAST(t.norma_sati_dan, 7) *
          (
            SELECT COUNT(*)::INTEGER
            FROM generate_series(
              GREATEST(t.datum_pocetka_plan, v_today),
              LEAST(t.datum_zavrsetka_plan, v_end),
              '1 day'::interval
            ) AS gs3(d)
            WHERE EXTRACT(DOW FROM gs3.d) NOT IN (0, 6)
          )
        ), 0) * 100 / (v_workdays * 7)
      )::INTEGER
    ELSE 0 END AS load_pct
  FROM public.employees e
  LEFT JOIN public.pb_tasks t ON
    t.employee_id = e.id
    AND t.status <> 'Završeno'::public.pb_task_status
    AND t.deleted_at IS NULL
    AND t.datum_pocetka_plan IS NOT NULL
    AND t.datum_zavrsetka_plan IS NOT NULL
    AND t.datum_zavrsetka_plan >= v_today
    AND t.datum_pocetka_plan <= v_end
  WHERE e.is_active = TRUE
  GROUP BY e.id, e.full_name
  ORDER BY load_pct DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.pb_get_load_stats(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pb_get_load_stats(INTEGER) TO authenticated;
