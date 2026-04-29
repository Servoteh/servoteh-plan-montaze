-- Kadrovska K3.3 — kompletno za Supabase: salary_terms v2, salary_payroll v2,
-- v_employee_current_salary, v_salary_payroll_month, work_hours.absence_subtype,
-- kadr_holidays (+ seed 2025–2027), trigger salary_payroll_compute_totals (ukupna_zarada).
-- Idempotentno gde je moguće (IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- ── salary_terms v2 ─────────────────────────────────────────────────────
ALTER TABLE public.salary_terms
  ADD COLUMN IF NOT EXISTS compensation_model         TEXT,
  ADD COLUMN IF NOT EXISTS fixed_amount               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fixed_transport_component  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fixed_extra_hour_rate      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_part_amount          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_hour_rate            NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_transport_amount     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_transport_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terrain_domestic_rate      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terrain_foreign_rate       NUMERIC(10, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'salary_terms_compensation_model_chk'
                   AND conrelid = 'public.salary_terms'::regclass) THEN
    ALTER TABLE public.salary_terms
      ADD CONSTRAINT salary_terms_compensation_model_chk
      CHECK (compensation_model IS NULL
             OR compensation_model IN ('fiksno','dva_dela','satnica'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'salary_terms_v2_nonneg_chk'
                   AND conrelid = 'public.salary_terms'::regclass) THEN
    ALTER TABLE public.salary_terms
      ADD CONSTRAINT salary_terms_v2_nonneg_chk
      CHECK (fixed_amount >= 0
             AND fixed_transport_component >= 0
             AND fixed_extra_hour_rate >= 0
             AND first_part_amount >= 0
             AND split_hour_rate >= 0
             AND split_transport_amount >= 0
             AND hourly_transport_amount >= 0
             AND terrain_domestic_rate >= 0
             AND terrain_foreign_rate >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_salary_terms_comp_model
  ON public.salary_terms(compensation_model);

DROP VIEW IF EXISTS public.v_employee_current_salary;

CREATE VIEW public.v_employee_current_salary AS
SELECT DISTINCT ON (st.employee_id)
  st.employee_id,
  st.id                            AS salary_term_id,
  st.salary_type,
  st.compensation_model,
  st.effective_from,
  st.effective_to,
  st.amount,
  st.amount_type,
  st.currency,
  st.hourly_rate,
  st.transport_allowance_rsd,
  st.per_diem_rsd,
  st.per_diem_eur,
  st.fixed_amount,
  st.fixed_transport_component,
  st.fixed_extra_hour_rate,
  st.first_part_amount,
  st.split_hour_rate,
  st.split_transport_amount,
  st.hourly_transport_amount,
  st.terrain_domestic_rate,
  st.terrain_foreign_rate,
  st.contract_ref,
  st.note,
  st.updated_at
FROM public.salary_terms st
WHERE st.effective_from <= CURRENT_DATE
  AND (st.effective_to IS NULL OR st.effective_to >= CURRENT_DATE)
ORDER BY st.employee_id, st.effective_from DESC;

GRANT SELECT ON public.v_employee_current_salary TO authenticated;

-- ── salary_payroll v2 + view ───────────────────────────────────────────
ALTER TABLE public.salary_payroll
  ADD COLUMN IF NOT EXISTS compensation_model         TEXT,
  ADD COLUMN IF NOT EXISTS fond_sati_meseca           NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS redovan_rad_sati           NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prekovremeni_sati          NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS praznik_placeni_sati       NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS praznik_rad_sati           NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS godisnji_sati              NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS slobodni_dani_sati         NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bolovanje_65_sati          NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bolovanje_100_sati         NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dve_masine_sati            NUMERIC(8, 2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS teren_u_zemlji_count       INT            NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS teren_u_inostranstvu_count INT            NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payable_hours              NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ukupna_zarada              NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prvi_deo                   NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preostalo_za_isplatu       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS warnings                   JSONB          NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='salary_payroll_v2_comp_model_chk'
                   AND conrelid='public.salary_payroll'::regclass) THEN
    ALTER TABLE public.salary_payroll
      ADD CONSTRAINT salary_payroll_v2_comp_model_chk
      CHECK (compensation_model IS NULL
             OR compensation_model IN ('fiksno','dva_dela','satnica'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='salary_payroll_v2_nonneg_chk'
                   AND conrelid='public.salary_payroll'::regclass) THEN
    ALTER TABLE public.salary_payroll
      ADD CONSTRAINT salary_payroll_v2_nonneg_chk
      CHECK (fond_sati_meseca >= 0
             AND redovan_rad_sati >= 0
             AND prekovremeni_sati >= 0
             AND praznik_placeni_sati >= 0
             AND praznik_rad_sati >= 0
             AND godisnji_sati >= 0
             AND slobodni_dani_sati >= 0
             AND bolovanje_65_sati >= 0
             AND bolovanje_100_sati >= 0
             AND dve_masine_sati >= 0
             AND teren_u_zemlji_count >= 0
             AND teren_u_inostranstvu_count >= 0
             AND payable_hours >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_salary_payroll_comp_model
  ON public.salary_payroll(compensation_model);

DROP VIEW IF EXISTS public.v_salary_payroll_month;

CREATE VIEW public.v_salary_payroll_month AS
SELECT
  p.*,
  e.full_name   AS employee_name,
  e.position    AS employee_position,
  e.department  AS employee_department,
  e.is_active   AS employee_active,
  e.work_type   AS employee_work_type
FROM public.salary_payroll p
JOIN public.employees e ON e.id = p.employee_id;

GRANT SELECT ON public.v_salary_payroll_month TO authenticated;

-- ── work_hours.absence_subtype ─────────────────────────────────────────
ALTER TABLE public.work_hours
  ADD COLUMN IF NOT EXISTS absence_subtype TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='work_hours_absence_subtype_chk'
                   AND conrelid='public.work_hours'::regclass) THEN
    ALTER TABLE public.work_hours
      ADD CONSTRAINT work_hours_absence_subtype_chk
      CHECK (absence_subtype IS NULL
             OR absence_subtype IN ('obicno','povreda_na_radu','odrzavanje_trudnoce'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='work_hours_subtype_consistency_chk'
                   AND conrelid='public.work_hours'::regclass) THEN
    ALTER TABLE public.work_hours
      ADD CONSTRAINT work_hours_subtype_consistency_chk
      CHECK (absence_subtype IS NULL OR absence_code = 'bo');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_work_hours_subtype ON public.work_hours(absence_subtype)
  WHERE absence_subtype IS NOT NULL;

-- ── RPC kadr_payroll_init_month ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.kadr_payroll_init_month(
  p_year INT,
  p_month INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn_init$
DECLARE
  v_count INT := 0;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'invalid month %', p_month;
  END IF;

  WITH ins AS (
    INSERT INTO public.salary_payroll (
      employee_id, period_year, period_month,
      salary_type, compensation_model,
      fixed_salary, hourly_rate,
      transport_rsd, per_diem_rsd, per_diem_eur,
      status, warnings
    )
    SELECT
      e.id, p_year, p_month,
      COALESCE(s.salary_type, 'ugovor'),
      s.compensation_model,
      CASE WHEN COALESCE(s.salary_type,'ugovor') IN ('ugovor','dogovor')
           THEN COALESCE(s.amount, 0) ELSE 0 END,
      CASE WHEN s.salary_type = 'satnica'
           THEN COALESCE(s.amount, 0) ELSE 0 END,
      COALESCE(s.transport_allowance_rsd, 0),
      COALESCE(s.per_diem_rsd, 0),
      COALESCE(s.per_diem_eur, 0),
      'draft',
      CASE
        WHEN s.employee_id IS NULL
          THEN '[{"code":"no_salary_terms","message":"Zaposleni nema aktivne uslove zarade — obračun je 0."}]'::jsonb
        WHEN s.compensation_model IS NULL
          THEN '[{"code":"no_compensation_model","message":"Aktivni uslov zarade nema definisan tip zarade (compensation_model)."}]'::jsonb
        ELSE '[]'::jsonb
      END
    FROM public.employees e
    LEFT JOIN public.v_employee_current_salary s ON s.employee_id = e.id
    WHERE e.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM public.salary_payroll p
         WHERE p.employee_id = e.id
           AND p.period_year = p_year
           AND p.period_month = p_month
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM ins;

  RETURN v_count;
END;
$fn_init$;

REVOKE ALL ON FUNCTION public.kadr_payroll_init_month(int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kadr_payroll_init_month(int, int) TO authenticated;

-- ── Trigger totals (prefer ukupna_zarada from FE K3.3) ─────────────────
CREATE OR REPLACE FUNCTION public.salary_payroll_compute_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public
AS $$
DECLARE
  v_base NUMERIC(14, 2);
BEGIN
  IF NEW.ukupna_zarada IS NOT NULL AND NEW.ukupna_zarada > 0 THEN
    NEW.total_rsd := NEW.ukupna_zarada;
  ELSIF NEW.salary_type = 'satnica' THEN
    v_base := COALESCE(NEW.hours_worked, 0) * COALESCE(NEW.hourly_rate, 0);
    NEW.total_rsd := v_base
                   + COALESCE(NEW.transport_rsd, 0)
                   + COALESCE(NEW.per_diem_rsd, 0) * COALESCE(NEW.domestic_days, 0);
  ELSE
    v_base := COALESCE(NEW.fixed_salary, 0);
    NEW.total_rsd := v_base
                   + COALESCE(NEW.transport_rsd, 0)
                   + COALESCE(NEW.per_diem_rsd, 0) * COALESCE(NEW.domestic_days, 0);
  END IF;

  NEW.total_eur := COALESCE(NEW.per_diem_eur, 0) * COALESCE(NEW.foreign_days, 0);
  NEW.second_part_rsd := NEW.total_rsd - COALESCE(NEW.advance_amount, 0);
  RETURN NEW;
END;
$$;

-- ── kadr_holidays ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kadr_holidays (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date DATE NOT NULL,
  name         TEXT NOT NULL,
  is_workday   BOOLEAN NOT NULL DEFAULT false,
  note         TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT kadr_holidays_date_unique UNIQUE (holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_kadr_holidays_date ON public.kadr_holidays(holiday_date);
CREATE INDEX IF NOT EXISTS idx_kadr_holidays_year
  ON public.kadr_holidays((EXTRACT(YEAR FROM holiday_date)::int));

DROP TRIGGER IF EXISTS trg_kadr_holidays_updated ON public.kadr_holidays;
CREATE TRIGGER trg_kadr_holidays_updated
  BEFORE UPDATE ON public.kadr_holidays
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.kadr_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kadr_holidays_select" ON public.kadr_holidays;
DROP POLICY IF EXISTS "kadr_holidays_insert_admin" ON public.kadr_holidays;
DROP POLICY IF EXISTS "kadr_holidays_update_admin" ON public.kadr_holidays;
DROP POLICY IF EXISTS "kadr_holidays_delete_admin" ON public.kadr_holidays;

CREATE POLICY "kadr_holidays_select" ON public.kadr_holidays
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "kadr_holidays_insert_admin" ON public.kadr_holidays
  FOR INSERT TO authenticated WITH CHECK (public.current_user_is_admin());

CREATE POLICY "kadr_holidays_update_admin" ON public.kadr_holidays
  FOR UPDATE TO authenticated
  USING      (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

CREATE POLICY "kadr_holidays_delete_admin" ON public.kadr_holidays
  FOR DELETE TO authenticated USING (public.current_user_is_admin());

-- Seed 2025
INSERT INTO public.kadr_holidays (holiday_date, name) VALUES
  (DATE '2025-01-01', 'Nova godina (1. dan)'),
  (DATE '2025-01-02', 'Nova godina (2. dan)'),
  (DATE '2025-01-07', 'Božić'),
  (DATE '2025-02-15', 'Sretenje – Dan državnosti (1. dan)'),
  (DATE '2025-02-16', 'Sretenje – Dan državnosti (2. dan)'),
  (DATE '2025-02-17', 'Sretenje – prenosno'),
  (DATE '2025-04-18', 'Veliki petak'),
  (DATE '2025-04-19', 'Velika subota'),
  (DATE '2025-04-20', 'Vaskrs'),
  (DATE '2025-04-21', 'Vaskršnji ponedeljak'),
  (DATE '2025-05-01', 'Praznik rada (1. dan)'),
  (DATE '2025-05-02', 'Praznik rada (2. dan)'),
  (DATE '2025-11-11', 'Dan primirja u Prvom svetskom ratu')
ON CONFLICT (holiday_date) DO NOTHING;

-- Seed 2026
INSERT INTO public.kadr_holidays (holiday_date, name) VALUES
  (DATE '2026-01-01', 'Nova godina (1. dan)'),
  (DATE '2026-01-02', 'Nova godina (2. dan)'),
  (DATE '2026-01-07', 'Božić'),
  (DATE '2026-02-15', 'Sretenje – Dan državnosti (1. dan)'),
  (DATE '2026-02-16', 'Sretenje – Dan državnosti (2. dan)'),
  (DATE '2026-02-17', 'Sretenje – prenosno (15.02. nedelja)'),
  (DATE '2026-04-10', 'Veliki petak'),
  (DATE '2026-04-11', 'Velika subota'),
  (DATE '2026-04-12', 'Vaskrs'),
  (DATE '2026-04-13', 'Vaskršnji ponedeljak'),
  (DATE '2026-05-01', 'Praznik rada (1. dan)'),
  (DATE '2026-05-02', 'Praznik rada (2. dan)'),
  (DATE '2026-11-11', 'Dan primirja u Prvom svetskom ratu')
ON CONFLICT (holiday_date) DO NOTHING;

-- Seed 2027
INSERT INTO public.kadr_holidays (holiday_date, name) VALUES
  (DATE '2027-01-01', 'Nova godina (1. dan)'),
  (DATE '2027-01-02', 'Nova godina (2. dan)'),
  (DATE '2027-01-07', 'Božić'),
  (DATE '2027-02-15', 'Sretenje – Dan državnosti (1. dan)'),
  (DATE '2027-02-16', 'Sretenje – Dan državnosti (2. dan)'),
  (DATE '2027-04-30', 'Veliki petak'),
  (DATE '2027-05-01', 'Praznik rada (1. dan) / Velika subota'),
  (DATE '2027-05-02', 'Vaskrs / Praznik rada (2. dan)'),
  (DATE '2027-05-03', 'Vaskršnji ponedeljak – prenosno'),
  (DATE '2027-11-11', 'Dan primirja u Prvom svetskom ratu')
ON CONFLICT (holiday_date) DO NOTHING;
