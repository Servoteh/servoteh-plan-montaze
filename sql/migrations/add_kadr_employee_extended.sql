-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Kadrovska — Extended employee profile (Faza K2)
-- Proširuje `employees` sa kompletnim ličnim/kadrovskim podacima
-- koje traži formular Nikole Mrkajića:
--   * razdvojeno ime/prezime, JMBG, pol, datum rođenja (auto iz JMBG),
--     adresa, banka + br. računa, privatni telefon, kontakt osobe,
--     krsna slava, stručna sprema, lekarski pregled, tim.
-- Dodaje `employee_children` (ime + datum rođenja).
-- Dodaje `vacation_entitlements` + view `v_vacation_balance`.
-- Proširuje CHECK na `absences.type` i `work_hours.absence_code`:
--   - 'sluzbeni' (bilo je 'sluzbeno' u absences već) → dosledno
--   - 'placeno' + razlog (rodjenje|svadba|smrt|selidba|ostalo)
--   - 'slava' → krsna slava (dan posta + slavski dan)
-- Uvodi maskiranje osetljivih podataka: view `v_employees_safe` +
-- helper `current_user_is_hr_or_admin()`. Za ne-HR korisnike,
-- JMBG, banka, adresa, privatni telefon i kontakt osoba su maskirani.
-- TRIGGER sprečava da ne-HR korisnik menja osetljiva polja.
--
-- Depends on: add_kadrovska_module.sql, add_kadrovska_phase1.sql,
--             add_attendance_grid.sql, add_admin_roles.sql.
-- Idempotentno, safe za re-run.
-- ═══════════════════════════════════════════════════════════

-- 0) Sanity checks --------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'employees') THEN
    RAISE EXCEPTION 'Missing employees table. Run add_kadrovska_module.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'absences') THEN
    RAISE EXCEPTION 'Missing absences table. Run add_kadrovska_phase1.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'work_hours') THEN
    RAISE EXCEPTION 'Missing work_hours table. Run add_kadrovska_phase1.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'user_roles') THEN
    RAISE EXCEPTION 'Missing user_roles table. Run add_admin_roles.sql first.';
  END IF;
END $$;

-- 1) HR/Admin helper (SECURITY DEFINER, bez rekurzije na RLS) ------------
-- Vraća TRUE ako je trenutni JWT user aktivan admin ILI hr.
CREATE OR REPLACE FUNCTION public.current_user_is_hr_or_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND role IN ('admin','hr')
      AND is_active = TRUE
  );
$$;
REVOKE ALL    ON FUNCTION public.current_user_is_hr_or_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_hr_or_admin() TO   authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_is_hr_or_admin() TO   anon;

-- 2) Proširenje tabele employees -----------------------------------------
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS first_name                TEXT,
  ADD COLUMN IF NOT EXISTS last_name                 TEXT,
  ADD COLUMN IF NOT EXISTS personal_id               TEXT,   -- JMBG (13 cifara)
  ADD COLUMN IF NOT EXISTS birth_date                DATE,
  ADD COLUMN IF NOT EXISTS gender                    TEXT,   -- 'M' / 'Z'
  ADD COLUMN IF NOT EXISTS address                   TEXT,
  ADD COLUMN IF NOT EXISTS city                      TEXT,
  ADD COLUMN IF NOT EXISTS postal_code               TEXT,
  ADD COLUMN IF NOT EXISTS bank_name                 TEXT,
  ADD COLUMN IF NOT EXISTS bank_account              TEXT,   -- format "xxx-xxxxxxxxxxxxx-xx"
  ADD COLUMN IF NOT EXISTS phone_private             TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_name    TEXT,
  ADD COLUMN IF NOT EXISTS emergency_contact_phone   TEXT,
  ADD COLUMN IF NOT EXISTS slava                     TEXT,   -- npr. "Sveti Nikola"
  ADD COLUMN IF NOT EXISTS slava_day                 TEXT,   -- MMDD za podsetnik
  ADD COLUMN IF NOT EXISTS education_level           TEXT,   -- I..VIII ili SSS/VS/VSS
  ADD COLUMN IF NOT EXISTS education_title           TEXT,   -- npr. "Dipl. maš. inž."
  ADD COLUMN IF NOT EXISTS medical_exam_date         DATE,   -- kad je poslednji pregled
  ADD COLUMN IF NOT EXISTS medical_exam_expires      DATE,   -- kad ističe
  ADD COLUMN IF NOT EXISTS team                      TEXT;

-- 3) Gender CHECK ---------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_gender_check' AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_gender_check
      CHECK (gender IS NULL OR gender IN ('M','Z'));
  END IF;
END $$;

-- 4) JMBG format check (13 cifara) --------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_personal_id_check' AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_personal_id_check
      CHECK (personal_id IS NULL OR personal_id ~ '^[0-9]{13}$');
  END IF;
END $$;

-- 5) Slava day format (MMDD) --------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'employees_slava_day_check' AND conrelid = 'employees'::regclass
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_slava_day_check
      CHECK (slava_day IS NULL OR slava_day ~ '^[0-9]{4}$');
  END IF;
END $$;

-- 6) Backfill first_name/last_name iz full_name (best effort) -----------
--    Izvlači ime (reč pre poslednjeg razmaka) i prezime (poslednja reč).
--    Samo za redove gde oba polja još nisu popunjena.
UPDATE employees
SET    first_name = BTRIM(regexp_replace(full_name, '\s+\S+$', '')),
       last_name  = BTRIM(regexp_replace(full_name, '^.*\s+(\S+)$', '\1'))
WHERE  (first_name IS NULL OR first_name = '')
  AND  (last_name IS NULL OR last_name = '')
  AND  full_name IS NOT NULL
  AND  full_name <> ''
  AND  full_name LIKE '% %';

-- Za jednorečna imena: samo first_name
UPDATE employees
SET    first_name = full_name
WHERE  (first_name IS NULL OR first_name = '')
  AND  full_name IS NOT NULL
  AND  full_name <> ''
  AND  full_name NOT LIKE '% %';

-- 7) Indeksi ---------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_employees_first_name
  ON employees(lower(first_name)) WHERE first_name IS NOT NULL AND first_name <> '';
CREATE INDEX IF NOT EXISTS idx_employees_last_name
  ON employees(lower(last_name))  WHERE last_name IS NOT NULL AND last_name <> '';
CREATE INDEX IF NOT EXISTS idx_employees_team
  ON employees(team)              WHERE team IS NOT NULL AND team <> '';
CREATE INDEX IF NOT EXISTS idx_employees_birth_date
  ON employees(birth_date)        WHERE birth_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_med_expires
  ON employees(medical_exam_expires)
  WHERE medical_exam_expires IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_personal_id
  ON employees(personal_id)
  WHERE personal_id IS NOT NULL AND personal_id <> '';

-- 8) Trigger: ne-HR korisnik NE sme da menja osetljiva polja -------------
--    (SELECT maskiramo preko view-a u koraku 12; ovde štitimo UPDATE/INSERT.)
CREATE OR REPLACE FUNCTION employees_sensitive_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Samo na UPDATE proveravamo izmene; na INSERT traži HR/admin ako polje nije prazno
  IF TG_OP = 'INSERT' THEN
    IF NEW.personal_id IS NOT NULL OR NEW.bank_account IS NOT NULL
       OR NEW.bank_name IS NOT NULL OR NEW.address IS NOT NULL
       OR NEW.city IS NOT NULL OR NEW.postal_code IS NOT NULL
       OR NEW.phone_private IS NOT NULL OR NEW.emergency_contact_name IS NOT NULL
       OR NEW.emergency_contact_phone IS NOT NULL
    THEN
      IF NOT public.current_user_is_hr_or_admin() THEN
        RAISE EXCEPTION 'Samo admin ili HR mogu da unose lične podatke (JMBG, banka, adresa, privatni telefon).'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: proveri da li su osetljiva polja menjana
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
    IF NOT public.current_user_is_hr_or_admin() THEN
      RAISE EXCEPTION 'Samo admin ili HR mogu da menjaju lične podatke (JMBG, banka, adresa, privatni telefon).'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_employees_sensitive_guard ON employees;
CREATE TRIGGER trg_employees_sensitive_guard
  BEFORE INSERT OR UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION employees_sensitive_guard();

-- 9) employee_children ---------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_children (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  first_name   TEXT NOT NULL,
  birth_date   DATE,
  note         TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_children_emp
  ON employee_children(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_children_birth
  ON employee_children(birth_date) WHERE birth_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_employee_children_updated ON employee_children;
CREATE TRIGGER trg_employee_children_updated
  BEFORE UPDATE ON employee_children
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE employee_children ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "employee_children_select" ON employee_children;
DROP POLICY IF EXISTS "employee_children_insert" ON employee_children;
DROP POLICY IF EXISTS "employee_children_update" ON employee_children;
DROP POLICY IF EXISTS "employee_children_delete" ON employee_children;
-- Deca se tretiraju kao lični podatak → SELECT samo za HR/admin.
-- Ostali mogu samo da vide broj dece preko count agregata iz view-a (po potrebi).
CREATE POLICY "employee_children_select" ON employee_children
  FOR SELECT TO authenticated USING (public.current_user_is_hr_or_admin());
CREATE POLICY "employee_children_insert" ON employee_children
  FOR INSERT TO authenticated WITH CHECK (public.current_user_is_hr_or_admin());
CREATE POLICY "employee_children_update" ON employee_children
  FOR UPDATE TO authenticated
  USING      (public.current_user_is_hr_or_admin())
  WITH CHECK (public.current_user_is_hr_or_admin());
CREATE POLICY "employee_children_delete" ON employee_children
  FOR DELETE TO authenticated USING (public.current_user_is_hr_or_admin());

-- 10) vacation_entitlements ---------------------------------------------
--     Po godini i zaposlenom: koliko dana mu pripada i koliko je preneo
--     iz prošle godine. Default 20 radnih dana.
CREATE TABLE IF NOT EXISTS vacation_entitlements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year                INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  days_total          INT  NOT NULL DEFAULT 20 CHECK (days_total >= 0 AND days_total <= 365),
  days_carried_over   INT  NOT NULL DEFAULT 0  CHECK (days_carried_over >= 0 AND days_carried_over <= 365),
  note                TEXT DEFAULT '',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT vacation_entitlements_uniq UNIQUE (employee_id, year)
);
CREATE INDEX IF NOT EXISTS idx_vacation_entitlements_year
  ON vacation_entitlements(year);

DROP TRIGGER IF EXISTS trg_vacation_entitlements_updated ON vacation_entitlements;
CREATE TRIGGER trg_vacation_entitlements_updated
  BEFORE UPDATE ON vacation_entitlements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE vacation_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vac_ent_select" ON vacation_entitlements;
DROP POLICY IF EXISTS "vac_ent_insert" ON vacation_entitlements;
DROP POLICY IF EXISTS "vac_ent_update" ON vacation_entitlements;
DROP POLICY IF EXISTS "vac_ent_delete" ON vacation_entitlements;
-- Entitlementi nisu strogo osetljivi (nema JMBG); svi authenticated čitaju,
-- pišu samo oni koji mogu da uređuju kadrovsku (svi osim viewer-a).
CREATE POLICY "vac_ent_select" ON vacation_entitlements
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "vac_ent_insert" ON vacation_entitlements
  FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "vac_ent_update" ON vacation_entitlements
  FOR UPDATE TO authenticated
  USING      (has_edit_role())
  WITH CHECK (has_edit_role());
CREATE POLICY "vac_ent_delete" ON vacation_entitlements
  FOR DELETE TO authenticated USING (has_edit_role());

-- 11) v_vacation_balance ------------------------------------------------
--     Agregira iskorišćeni godišnji odmor po zaposlenom po godini.
--     Koristi `absences` gde type='godisnji' i `work_hours` gde absence_code='go'.
--     Napomena: `absences.days_count` je autoritativan kada je popunjen.
--     Ako nije, uzima se inclusive broj dana između date_from i date_to.
CREATE OR REPLACE VIEW v_vacation_balance AS
WITH abs_days AS (
  SELECT a.employee_id,
         EXTRACT(YEAR FROM a.date_from)::int AS year,
         SUM(
           COALESCE(
             a.days_count,
             (a.date_to - a.date_from + 1)
           )
         )::int AS used_days
  FROM   absences a
  WHERE  a.type = 'godisnji'
  GROUP  BY a.employee_id, EXTRACT(YEAR FROM a.date_from)
),
grid_days AS (
  SELECT wh.employee_id,
         EXTRACT(YEAR FROM wh.work_date)::int AS year,
         COUNT(*)::int AS used_days
  FROM   work_hours wh
  WHERE  wh.absence_code = 'go'
  GROUP  BY wh.employee_id, EXTRACT(YEAR FROM wh.work_date)
),
used AS (
  -- Spoji oba izvora; koristi GREATEST jer su isti entitet duplo moguć
  -- (grid pravi per-day zapise koji mogu ili ne moraju da korespondiraju sa `absences`).
  -- Biramo veću cifru kao konzervativnu procenu iskorišćenog.
  SELECT COALESCE(a.employee_id, g.employee_id) AS employee_id,
         COALESCE(a.year, g.year)              AS year,
         GREATEST(COALESCE(a.used_days,0), COALESCE(g.used_days,0)) AS used_days
  FROM   abs_days a
  FULL OUTER JOIN grid_days g
    ON a.employee_id = g.employee_id AND a.year = g.year
)
SELECT
  e.id                                  AS employee_id,
  COALESCE(v.year, u.year)              AS year,
  COALESCE(v.days_total, 20)            AS days_total,
  COALESCE(v.days_carried_over, 0)      AS days_carried_over,
  COALESCE(u.used_days, 0)              AS days_used,
  (COALESCE(v.days_total, 20)
    + COALESCE(v.days_carried_over, 0)
    - COALESCE(u.used_days, 0))         AS days_remaining
FROM employees e
FULL OUTER JOIN vacation_entitlements v ON v.employee_id = e.id
FULL OUTER JOIN used u
       ON u.employee_id = e.id
      AND (v.year IS NULL OR u.year = v.year);

GRANT SELECT ON v_vacation_balance TO authenticated;

-- 12) v_employees_safe — maskirani view za ne-HR korisnike --------------
--     SECURITY INVOKER (default) → poštuje RLS na employees (svi vide).
--     CASE maskira osetljiva polja ako user nije HR/admin.
CREATE OR REPLACE VIEW v_employees_safe AS
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
  e.created_at,
  e.updated_at,
  -- Osetljiva polja — vidljiva samo HR/admin; ostali dobijaju NULL
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

-- 13) absences proširenje: 'slava', 'placeno' + paid_reason -------------
--     Originalni CHECK je bio:
--        (type IN ('godisnji','bolovanje','slobodan','placeno','neplaceno','sluzbeno','ostalo'))
--     Zadržavamo postojeće, dodajemo 'slava' i pomoćnu kolonu paid_reason.
ALTER TABLE absences
  ADD COLUMN IF NOT EXISTS paid_reason TEXT;

DO $$
BEGIN
  -- Drop stari CHECK i ponovo ga postavi sa proširenom listom
  BEGIN
    ALTER TABLE absences DROP CONSTRAINT IF EXISTS absences_type_check;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  -- Novi named CHECK
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'absences_type_check_v2' AND conrelid = 'absences'::regclass
  ) THEN
    ALTER TABLE absences
      ADD CONSTRAINT absences_type_check_v2
      CHECK (type IN ('godisnji','bolovanje','slobodan','placeno','neplaceno','sluzbeno','slava','ostalo'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'absences_paid_reason_check' AND conrelid = 'absences'::regclass
  ) THEN
    ALTER TABLE absences
      ADD CONSTRAINT absences_paid_reason_check
      CHECK (paid_reason IS NULL OR paid_reason IN ('rodjenje','svadba','smrt','selidba','ostalo'));
  END IF;
END $$;

-- 14) work_hours.absence_code proširen (dodaj 'sv' = slava, 'pl' = plaćeno)
--     Stare vrednosti su: go,bo,sp,np,sl,pr. 'sp' je nejasno interpretiran —
--     od sada ga tretiramo kao SLUŽBENI PUT (u UI-u).
--     'pr' ostaje kao PRAZNIK; dodajemo 'sv' za krsnu slavu i 'pl' za plaćeno
--     odsustvo (razlog se ne evidentira u gridu, samo u `absences`).
DO $$
BEGIN
  BEGIN
    ALTER TABLE work_hours DROP CONSTRAINT IF EXISTS work_hours_absence_code_check;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_hours_absence_code_check_v2' AND conrelid = 'work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_absence_code_check_v2
      CHECK (absence_code IS NULL OR absence_code IN ('go','bo','sp','np','sl','pr','sv','pl'));
  END IF;
END $$;

-- 15) Verifikacija -------------------------------------------------------
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name='employees'
-- ORDER BY ordinal_position;
--
-- SELECT * FROM v_employees_safe LIMIT 3;
-- SELECT * FROM v_vacation_balance WHERE year = EXTRACT(YEAR FROM now())::int;
