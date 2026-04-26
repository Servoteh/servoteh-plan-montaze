-- ═══════════════════════════════════════════════════════════
-- MIGRATION: JMBG, banka, adresa, privatni telefon, kontakt za
-- hitne slučajeve — samo ADMIN vidi i menja (view + trigger).
-- Tabela `employee_children` — isto samo admin (RLS).
--
-- HR i menadžment više nemaju pristup ovim podacima.
-- Zarade (`salary_terms`, `salary_payroll`) već su admin-only u
-- starijim migracijama.
--
-- Depends on: add_kadr_employee_extended.sql, add_kadr_work_type.sql,
--             add_admin_roles.sql (current_user_is_admin).
-- Idempotentno, safe za re-run.
--
-- Napomena: direktan SELECT na tabeli `employees` i dalje vraća sve
-- kolone za sve authenticated korisnike sa SELECT policy — aplikacija
-- treba da čita preko `v_employees_safe`. Za potpuno zatvaranje REST
-- pristupa kolonama bez izmene aplikacije, razmotriti izdvajanje PII
-- u posebnu tabelu sa RLS admin-only.
-- ═══════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_user_is_admin') THEN
    RAISE EXCEPTION 'Missing current_user_is_admin(). Run add_admin_roles.sql first.';
  END IF;
END $$;

-- 0b) Kolona work_type (Faza K3.3) — view je ispod zavisi od nje; idempotentno
--     ako add_kadr_work_type.sql još nije primenjen na projektu.
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS work_type TEXT NOT NULL DEFAULT 'ugovor';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_work_type_check' AND conrelid = 'public.employees'::regclass
  ) THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_work_type_check
      CHECK (work_type IN ('ugovor','praksa','dualno','penzioner'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employees_work_type ON public.employees(work_type);

-- 1) Trigger: samo admin sme INSERT/UPDATE osetljivih kolona na employees --
CREATE OR REPLACE FUNCTION public.employees_sensitive_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.personal_id IS NOT NULL OR NEW.bank_account IS NOT NULL
       OR NEW.bank_name IS NOT NULL OR NEW.address IS NOT NULL
       OR NEW.city IS NOT NULL OR NEW.postal_code IS NOT NULL
       OR NEW.phone_private IS NOT NULL OR NEW.emergency_contact_name IS NOT NULL
       OR NEW.emergency_contact_phone IS NOT NULL
    THEN
      IF NOT public.current_user_is_admin() THEN
        RAISE EXCEPTION 'Samo administrator može da unosi lične podatke (JMBG, banka, adresa, privatni telefon, kontakt za hitne slučajeve).'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.personal_id           IS DISTINCT FROM OLD.personal_id)
  OR (NEW.bank_name             IS DISTINCT FROM OLD.bank_name)
  OR (NEW.bank_account          IS DISTINCT FROM OLD.bank_account)
  OR (NEW.address               IS DISTINCT FROM OLD.address)
  OR (NEW.city                  IS DISTINCT FROM OLD.city)
  OR (NEW.postal_code           IS DISTINCT FROM OLD.postal_code)
  OR (NEW.phone_private         IS DISTINCT FROM OLD.phone_private)
  OR (NEW.emergency_contact_name  IS DISTINCT FROM OLD.emergency_contact_name)
  OR (NEW.emergency_contact_phone IS DISTINCT FROM OLD.emergency_contact_phone)
  THEN
    IF NOT public.current_user_is_admin() THEN
      RAISE EXCEPTION 'Samo administrator može da menja lične podatke (JMBG, banka, adresa, privatni telefon, kontakt za hitne slučajeve).'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- 2) View: maska za ne-admin korisnike -----------------------------------
DROP VIEW IF EXISTS public.v_employees_safe;

CREATE VIEW public.v_employees_safe AS
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
  CASE WHEN public.current_user_is_admin() THEN e.personal_id             ELSE NULL END AS personal_id,
  CASE WHEN public.current_user_is_admin() THEN e.bank_name               ELSE NULL END AS bank_name,
  CASE WHEN public.current_user_is_admin() THEN e.bank_account            ELSE NULL END AS bank_account,
  CASE WHEN public.current_user_is_admin() THEN e.address                 ELSE NULL END AS address,
  CASE WHEN public.current_user_is_admin() THEN e.city                    ELSE NULL END AS city,
  CASE WHEN public.current_user_is_admin() THEN e.postal_code             ELSE NULL END AS postal_code,
  CASE WHEN public.current_user_is_admin() THEN e.phone_private           ELSE NULL END AS phone_private,
  CASE WHEN public.current_user_is_admin() THEN e.emergency_contact_name  ELSE NULL END AS emergency_contact_name,
  CASE WHEN public.current_user_is_admin() THEN e.emergency_contact_phone ELSE NULL END AS emergency_contact_phone
FROM public.employees e;

GRANT SELECT ON public.v_employees_safe TO authenticated;

-- Postgres 15+ (Supabase): view kao invoker — usklađeno sa fix_supabase_security_advisor_findings.sql
ALTER VIEW public.v_employees_safe SET (security_invoker = true);

-- 3) Deca zaposlenog — RLS samo admin ------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'employee_children'
  ) THEN
    RAISE NOTICE 'skip employee_children RLS: table missing (run add_kadr_employee_extended.sql)';
  ELSE
    ALTER TABLE public.employee_children ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "employee_children_select" ON public.employee_children;
    DROP POLICY IF EXISTS "employee_children_insert" ON public.employee_children;
    DROP POLICY IF EXISTS "employee_children_update" ON public.employee_children;
    DROP POLICY IF EXISTS "employee_children_delete" ON public.employee_children;

    CREATE POLICY "employee_children_select" ON public.employee_children
      FOR SELECT TO authenticated USING (public.current_user_is_admin());

    CREATE POLICY "employee_children_insert" ON public.employee_children
      FOR INSERT TO authenticated WITH CHECK (public.current_user_is_admin());

    CREATE POLICY "employee_children_update" ON public.employee_children
      FOR UPDATE TO authenticated
      USING      (public.current_user_is_admin())
      WITH CHECK (public.current_user_is_admin());

    CREATE POLICY "employee_children_delete" ON public.employee_children
      FOR DELETE TO authenticated USING (public.current_user_is_admin());
  END IF;
END $$;

COMMENT ON VIEW public.v_employees_safe IS
  'Maskira JMBG/banku/adresu/privatni telefon/kontakt za hitne slučajeve za sve osim admina.';
