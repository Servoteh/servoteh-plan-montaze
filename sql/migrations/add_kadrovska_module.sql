-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Kadrovska module — first operational phase
-- Adds `employees` table used by the Kadrovska module in index.html.
-- Safe to run multiple times (idempotent).
-- ═══════════════════════════════════════════════════════════

-- 1) Table ---------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL,
  position    TEXT DEFAULT '',
  department  TEXT DEFAULT '',
  phone       TEXT DEFAULT '',
  email       TEXT DEFAULT '',
  hire_date   DATE,
  is_active   BOOLEAN DEFAULT true,
  note        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 2) Indexes -------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_employees_name       ON employees(lower(full_name));
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_position   ON employees(position);
CREATE INDEX IF NOT EXISTS idx_employees_active     ON employees(is_active);
CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_email
  ON employees(lower(email))
  WHERE email IS NOT NULL AND email <> '';

-- 3) updated_at trigger -------------------------------------
-- Reuses update_updated_at() defined in schema.sql. If the function
-- does not exist yet (fresh DB without schema.sql), create it.
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

DROP TRIGGER IF EXISTS trg_employees_updated ON employees;
CREATE TRIGGER trg_employees_updated
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 4) Row Level Security -------------------------------------
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

-- Mirrors the pattern used for projects/work_packages/phases:
--   * any authenticated user can SELECT
--   * INSERT / UPDATE / DELETE allowed through has_edit_role()
-- (In the current pilot hardening round, has_edit_role() returns true
-- for any authenticated user; tighten later if needed.)
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

DROP POLICY IF EXISTS "employees_select" ON employees;
DROP POLICY IF EXISTS "employees_insert" ON employees;
DROP POLICY IF EXISTS "employees_update" ON employees;
DROP POLICY IF EXISTS "employees_delete" ON employees;

CREATE POLICY "employees_select"
  ON employees FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "employees_insert"
  ON employees FOR INSERT
  TO authenticated
  WITH CHECK (has_edit_role());

CREATE POLICY "employees_update"
  ON employees FOR UPDATE
  TO authenticated
  USING (has_edit_role())
  WITH CHECK (has_edit_role());

CREATE POLICY "employees_delete"
  ON employees FOR DELETE
  TO authenticated
  USING (has_edit_role());

-- 5) (Optional) seed — uncomment to prefill a couple of rows --
-- INSERT INTO employees (full_name, position, department) VALUES
--   ('Dejan Ćirković',    'Odg. inženjer',  'Montaža'),
--   ('Miloš Oreščanin',   'Vođa montaže',   'Montaža')
-- ON CONFLICT DO NOTHING;
