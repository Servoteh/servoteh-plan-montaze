-- ═══════════════════════════════════════════════════════════════════════════
-- RBAC — Opcija A: managed_departments + nove role (magacioner, cnc_operater)
--
-- Dodaje:
--   1) managed_departments TEXT[] na user_roles — NULL = neograničen pristup
--   2) Proširuje CHECK constraint za role sa 'magacioner' i 'cnc_operater'
--
-- Idempotentno — bezbedno za re-run.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) managed_departments kolona
ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS managed_departments TEXT[] DEFAULT NULL;

COMMENT ON COLUMN user_roles.managed_departments IS
  'Odeljenja nad kojima korisnik ima scope (odobravanje odmora, pregled kadrovske itd.). '
  'NULL = neograničen pristup (admin, COO, HR). '
  'Popunjen niz = filtrira employees.department u RLS/UI.';

-- 2) Proširi CHECK constraint za role
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_role_allowed'
       AND conrelid = 'user_roles'::regclass
  ) THEN
    ALTER TABLE user_roles DROP CONSTRAINT user_roles_role_allowed;
  END IF;

  ALTER TABLE user_roles
    ADD CONSTRAINT user_roles_role_allowed
    CHECK (role IN (
      'admin',
      'menadzment',
      'leadpm',
      'pm',
      'hr',
      'magacioner',
      'cnc_operater',
      'viewer'
    ));
END $$;

-- 3) Helper funkcija: vrati managed_departments za trenutnog korisnika
--    Vraća NULL ako korisnik nema ograničenje (= vidi sve).
CREATE OR REPLACE FUNCTION public.current_user_managed_departments()
RETURNS TEXT[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ur.managed_departments
    FROM user_roles ur
   WHERE ur.user_id = auth.uid()
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.current_user_managed_departments() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_managed_departments() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_managed_departments() TO service_role;
