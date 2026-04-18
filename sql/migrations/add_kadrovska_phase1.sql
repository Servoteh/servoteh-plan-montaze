-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Kadrovska module — PHASE 1
-- Adds absences, work_hours, contracts tables used by the
-- Kadrovska module (Odsustva / Sati rada / Ugovori tabs).
-- Depends on: employees table (see add_kadrovska_module.sql).
-- Safe to run multiple times (idempotent).
-- ═══════════════════════════════════════════════════════════

-- Prerequisite guard: ensure employees exists ---------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'employees') THEN
    RAISE EXCEPTION 'Missing employees table. Run sql/migrations/add_kadrovska_module.sql first.';
  END IF;
END $$;

-- Shared updated_at helper (create if missing) -------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $body$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $body$ LANGUAGE plpgsql;
    $fn$;
  END IF;
END $$;

-- Shared edit role helper (create if missing) --------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'has_edit_role') THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION has_edit_role(proj_id UUID DEFAULT NULL)
      RETURNS BOOLEAN AS $body$
      BEGIN
        RETURN true;
      END;
      $body$ LANGUAGE plpgsql SECURITY DEFINER;
    $fn$;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════
-- 1) ABSENCES — Odsustva
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS absences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'godisnji'
               CHECK (type IN ('godisnji','bolovanje','slobodan','placeno','neplaceno','sluzbeno','ostalo')),
  date_from    DATE NOT NULL,
  date_to      DATE NOT NULL,
  days_count   INT,
  note         TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT absences_dates_valid CHECK (date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS idx_absences_employee ON absences(employee_id);
CREATE INDEX IF NOT EXISTS idx_absences_range    ON absences(date_from, date_to);
CREATE INDEX IF NOT EXISTS idx_absences_type     ON absences(type);

DROP TRIGGER IF EXISTS trg_absences_updated ON absences;
CREATE TRIGGER trg_absences_updated
  BEFORE UPDATE ON absences
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE absences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "absences_select" ON absences;
DROP POLICY IF EXISTS "absences_insert" ON absences;
DROP POLICY IF EXISTS "absences_update" ON absences;
DROP POLICY IF EXISTS "absences_delete" ON absences;
CREATE POLICY "absences_select" ON absences FOR SELECT TO authenticated USING (true);
CREATE POLICY "absences_insert" ON absences FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "absences_update" ON absences FOR UPDATE TO authenticated USING (has_edit_role()) WITH CHECK (has_edit_role());
CREATE POLICY "absences_delete" ON absences FOR DELETE TO authenticated USING (has_edit_role());

-- ═══════════════════════════════════════════════════════════
-- 2) WORK_HOURS — Ručni unos sati rada (osnova umesto Excel-a)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS work_hours (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date       DATE NOT NULL,
  hours           NUMERIC(5,2) NOT NULL DEFAULT 0
                  CHECK (hours >= 0 AND hours <= 24),
  overtime_hours  NUMERIC(5,2) NOT NULL DEFAULT 0
                  CHECK (overtime_hours >= 0 AND overtime_hours <= 24),
  project_ref     TEXT DEFAULT '',
  note            TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_work_hours_employee ON work_hours(employee_id);
CREATE INDEX IF NOT EXISTS idx_work_hours_date     ON work_hours(work_date);
CREATE INDEX IF NOT EXISTS idx_work_hours_emp_date ON work_hours(employee_id, work_date);

DROP TRIGGER IF EXISTS trg_work_hours_updated ON work_hours;
CREATE TRIGGER trg_work_hours_updated
  BEFORE UPDATE ON work_hours
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE work_hours ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "work_hours_select" ON work_hours;
DROP POLICY IF EXISTS "work_hours_insert" ON work_hours;
DROP POLICY IF EXISTS "work_hours_update" ON work_hours;
DROP POLICY IF EXISTS "work_hours_delete" ON work_hours;
CREATE POLICY "work_hours_select" ON work_hours FOR SELECT TO authenticated USING (true);
CREATE POLICY "work_hours_insert" ON work_hours FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "work_hours_update" ON work_hours FOR UPDATE TO authenticated USING (has_edit_role()) WITH CHECK (has_edit_role());
CREATE POLICY "work_hours_delete" ON work_hours FOR DELETE TO authenticated USING (has_edit_role());

-- ═══════════════════════════════════════════════════════════
-- 3) CONTRACTS — Ugovori i kadrovski rokovi
-- Namerno NE čuvamo platu u ovoj fazi (senzitivno, kasnije).
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_type   TEXT NOT NULL DEFAULT 'neodredjeno'
                  CHECK (contract_type IN ('neodredjeno','odredjeno','privremeno','delo','student','praksa','ostalo')),
  contract_number TEXT DEFAULT '',
  position        TEXT DEFAULT '',
  date_from       DATE,
  date_to         DATE,
  is_active       BOOLEAN DEFAULT true,
  note            TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contracts_employee ON contracts(employee_id);
CREATE INDEX IF NOT EXISTS idx_contracts_active   ON contracts(is_active);
CREATE INDEX IF NOT EXISTS idx_contracts_dateto   ON contracts(date_to);

DROP TRIGGER IF EXISTS trg_contracts_updated ON contracts;
CREATE TRIGGER trg_contracts_updated
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contracts_select" ON contracts;
DROP POLICY IF EXISTS "contracts_insert" ON contracts;
DROP POLICY IF EXISTS "contracts_update" ON contracts;
DROP POLICY IF EXISTS "contracts_delete" ON contracts;
CREATE POLICY "contracts_select" ON contracts FOR SELECT TO authenticated USING (true);
CREATE POLICY "contracts_insert" ON contracts FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "contracts_update" ON contracts FOR UPDATE TO authenticated USING (has_edit_role()) WITH CHECK (has_edit_role());
CREATE POLICY "contracts_delete" ON contracts FOR DELETE TO authenticated USING (has_edit_role());
