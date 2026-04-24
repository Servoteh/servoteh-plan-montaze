-- ═══════════════════════════════════════════════════════════════════════
-- KADROVSKA — Tip rada zaposlenog (Faza K3.3)
--
-- Dodaje `employees.work_type` ∈ { ugovor, praksa, dualno, penzioner }.
-- "ugovor" = pun radni odnos, ima pravo na godišnji, plaćeno bolovanje,
-- praznike i slobodne dane. Ostali tipovi NEMAJU ta prava — UI ih blokira,
-- a payroll engine ih tretira kao redovne sate bez plaćenih odsustava.
--
-- Default: 'ugovor' (legacy redovi se ponašaju kao do sada).
--
-- Update-uje `v_employees_safe` da uključi `work_type` (nije osetljivo polje).
--
-- Depends on: add_kadrovska_module.sql, add_kadr_employee_extended.sql
-- Idempotentno, safe za re-run.
-- ═══════════════════════════════════════════════════════════════════════

-- 0) Sanity --------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'employees') THEN
    RAISE EXCEPTION 'Missing employees. Run add_kadrovska_module.sql first.';
  END IF;
END $$;

-- 1) Kolona work_type ----------------------------------------------------
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS work_type TEXT NOT NULL DEFAULT 'ugovor';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_work_type_check' AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_work_type_check
      CHECK (work_type IN ('ugovor','praksa','dualno','penzioner'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employees_work_type ON employees(work_type);

-- 2) v_employees_safe — dodaj work_type ----------------------------------
-- DROP+CREATE jer CREATE OR REPLACE VIEW ne dozvoljava menjanje set-a kolona.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_views WHERE viewname = 'v_employees_safe') THEN
    EXECUTE 'DROP VIEW v_employees_safe';
  END IF;
END $$;

CREATE VIEW v_employees_safe AS
SELECT
  e.id,
  e.full_name,
  e.first_name,
  e.last_name,
  e.position,
  e.department,
  e.team,
  e.phone          AS phone_work,
  e.email,
  e.hire_date,
  e.is_active,
  e.note,
  e.birth_date,
  e.gender,
  e.slava,
  e.slava_day,
  e.education_level,
  e.education_title,
  e.medical_exam_date,
  e.medical_exam_expires,
  e.work_type,
  e.created_at,
  e.updated_at,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.personal_id             ELSE NULL END AS personal_id,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.bank_name               ELSE NULL END AS bank_name,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.bank_account            ELSE NULL END AS bank_account,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.address                 ELSE NULL END AS address,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.city                    ELSE NULL END AS city,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.postal_code             ELSE NULL END AS postal_code,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.phone_private           ELSE NULL END AS phone_private,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.emergency_contact_name  ELSE NULL END AS emergency_contact_name,
  CASE WHEN public.current_user_is_hr_or_admin() THEN e.emergency_contact_phone ELSE NULL END AS emergency_contact_phone
FROM employees e;

GRANT SELECT ON v_employees_safe TO authenticated;

-- 3) Verifikacija --------------------------------------------------------
-- SELECT id, full_name, work_type FROM employees LIMIT 5;
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='v_employees_safe' AND column_name='work_type';
