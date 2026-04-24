-- ═══════════════════════════════════════════════════════════════════════
-- KADROVSKA — Mesečni obračun v2 (Faza K3.3)
--
-- Proširuje `salary_payroll` punim setom polja koja zahteva nova
-- kalkulacija (FE u `src/services/payrollCalc.js`):
--
--   * compensation_model (snapshot iz salary_terms)
--   * fond_sati_meseca
--   * redovan_rad_sati          — redovan radni sati u okviru fonda
--   * prekovremeni_sati          — preko fonda
--   * praznik_placeni_sati       — neradni a plaćeni dani-praznici (samo ugovor)
--   * praznik_rad_sati           — sati rada NA praznik (uvećan koef.)
--   * godisnji_sati              — godišnji odmor (samo ugovor)
--   * slobodni_dani_sati         — plaćeni slobodni dani (samo ugovor)
--   * bolovanje_65_sati          — obično bolovanje (65%)
--   * bolovanje_100_sati         — povreda na radu / održavanje trudnoće
--   * dve_masine_sati            — sati rada na 2 mašine (uvećan koef.)
--   * teren_u_zemlji_count       — broj dana terena u zemlji
--   * teren_u_inostranstvu_count — broj dana terena u inostranstvu
--   * payable_hours              — total „efektivnih" sati za obračun
--   * ukupna_zarada              — finalna zarada (RSD)
--   * prvi_deo                   — akontacija (kopira advance_amount za nove
--                                  modele, ili first_part_amount za dva_dela)
--   * preostalo_za_isplatu       — ukupna_zarada − prvi_deo
--   * warnings                   — JSONB niz upozorenja
--                                  [{code:'no_salary_terms', message:'…'}, …]
--
-- Postojeći trigger `salary_payroll_compute_totals` se PRESERVA — radi
-- i dalje na legacy poljima (fixed_salary, hours_worked, hourly_rate,
-- transport_rsd, per_diem_*). Nova polja su nezavisna i upisuje ih FE
-- nakon kalkulacije u `payrollCalc.js` (single source of truth).
--
-- Update RPC `kadr_payroll_init_month`:
--   - snapshot-uje `compensation_model` iz v_employee_current_salary
--   - postavlja `warnings` na ['no_salary_terms'] ako zaposleni nema aktivne
--     uslove zarade
--
-- Update view `v_salary_payroll_month` da uključi nova polja + work_type.
--
-- Depends on: add_kadr_salary_payroll.sql, add_kadr_work_type.sql,
--             add_kadr_salary_terms_v2.sql
-- Idempotentno, safe za re-run.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'salary_payroll') THEN
    RAISE EXCEPTION 'Missing salary_payroll. Run add_kadr_salary_payroll.sql first.';
  END IF;
END $$;

-- 1) Nova polja na salary_payroll ---------------------------------------
ALTER TABLE salary_payroll
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

-- 2) Constraints ---------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='salary_payroll_v2_comp_model_chk'
                   AND conrelid='salary_payroll'::regclass) THEN
    ALTER TABLE salary_payroll
      ADD CONSTRAINT salary_payroll_v2_comp_model_chk
      CHECK (compensation_model IS NULL
             OR compensation_model IN ('fiksno','dva_dela','satnica'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='salary_payroll_v2_nonneg_chk'
                   AND conrelid='salary_payroll'::regclass) THEN
    ALTER TABLE salary_payroll
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
  ON salary_payroll(compensation_model);

-- 3) View v_salary_payroll_month ----------------------------------------
DROP VIEW IF EXISTS v_salary_payroll_month;

CREATE VIEW v_salary_payroll_month AS
SELECT
  p.*,
  e.full_name   AS employee_name,
  e.position    AS employee_position,
  e.department  AS employee_department,
  e.is_active   AS employee_active,
  e.work_type   AS employee_work_type
FROM salary_payroll p
JOIN employees e ON e.id = p.employee_id;

GRANT SELECT ON v_salary_payroll_month TO authenticated;

-- 4) RPC update: kadr_payroll_init_month --------------------------------
-- Snapshot-uje compensation_model i postavlja warning ako nema aktivnih
-- uslova zarade. Idempotentno — postojeći redovi se ne diraju.
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
    INSERT INTO salary_payroll (
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
    FROM employees e
    LEFT JOIN v_employee_current_salary s ON s.employee_id = e.id
    WHERE e.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM salary_payroll p
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

-- 5) Verifikacija --------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='salary_payroll'
--    AND column_name IN ('compensation_model','fond_sati_meseca',
--        'redovan_rad_sati','payable_hours','ukupna_zarada','warnings');
--
-- SELECT kadr_payroll_init_month(2026, 4);
