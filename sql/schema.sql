-- ═══════════════════════════════════════════════════════════
-- SUPABASE SQL SCHEMA — Plan Montaže v5.1
-- Supabase-first, upsert-ready, with RLS
-- ═══════════════════════════════════════════════════════════
-- Bezbednosno usklađivanje (Faza 1, 2026-04-23):
--   * `has_edit_role()` više NIJE pilot „RETURN true" — proverava
--     globalne (admin/hr/menadzment/pm/leadpm) i project-specifične
--     (pm/leadpm) role iz `user_roles`. Sinhrono sa migracijom
--     `add_menadzment_full_edit_kadrovska.sql`.
--   * `user_roles` više NEMA `roles_select USING(true)` ni `roles_manage`
--     iz pilot perioda — zamenjeno read-self + admin-all + admin-write
--     politikama (sinhrono sa `enable_user_roles_rls_proper.sql` +
--     `cleanup_user_roles_legacy_policies.sql`).
--
-- Pravilo:
--   `schema.sql` mora ostati primenljiv na praznu bazu BEZ otvaranja
--   bezbednosnih rupa. Ako menjate ovaj fajl, proverite skriptom:
--     node scripts/check-schema-security-baseline.cjs
-- ═══════════════════════════════════════════════════════════

-- PROJECTS
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code TEXT NOT NULL,
  project_name TEXT NOT NULL,
  projectm TEXT DEFAULT '',
  project_deadline DATE,
  pm_email TEXT DEFAULT '',
  leadpm_email TEXT DEFAULT '',
  reminder_enabled BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_projects_code ON projects(project_code);

-- WORK PACKAGES
CREATE TABLE work_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rn_code TEXT DEFAULT '',
  rn_order INT DEFAULT 1,
  name TEXT NOT NULL,
  location TEXT DEFAULT 'Dobanovci',
  responsible_engineer_default TEXT DEFAULT '',
  montage_lead_default TEXT DEFAULT '',
  deadline DATE,
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  assembly_drawing_no TEXT NOT NULL DEFAULT '' CHECK (char_length(assembly_drawing_no) <= 120),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_wp_project ON work_packages(project_id);
CREATE UNIQUE INDEX idx_wp_rn ON work_packages(project_id, rn_code) WHERE rn_code != '';

-- PHASES
CREATE TABLE phases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_package_id UUID NOT NULL REFERENCES work_packages(id) ON DELETE CASCADE,
  phase_name TEXT NOT NULL,
  location TEXT DEFAULT 'Dobanovci',
  start_date DATE,
  end_date DATE,
  responsible_engineer TEXT DEFAULT '',
  montage_lead TEXT DEFAULT '',
  status INT DEFAULT 0 CHECK (status IN (0,1,2,3)),
  pct INT DEFAULT 0 CHECK (pct >= 0 AND pct <= 100),
  checks JSONB DEFAULT '[false,false,false,false,false,false,false,false]'::jsonb,
  blocker TEXT DEFAULT '',
  note TEXT DEFAULT '',
  phase_type TEXT DEFAULT 'mechanical' CHECK (phase_type IN ('mechanical','electrical')),
  linked_drawings JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(linked_drawings) = 'array'),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT DEFAULT ''
);
CREATE INDEX idx_phases_wp ON phases(work_package_id);
CREATE INDEX idx_phases_project ON phases(project_id);
CREATE INDEX idx_phases_status ON phases(status);
CREATE INDEX idx_phases_start ON phases(start_date) WHERE start_date IS NOT NULL;
CREATE INDEX idx_phases_phase_type ON phases(phase_type);
CREATE INDEX phases_linked_drawings_gin_idx ON phases USING gin (linked_drawings jsonb_path_ops);

-- USER ROLES
CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pm','leadpm','viewer')),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (email, project_id)
);
-- Global roles have project_id = NULL
-- Project-specific roles have project_id set (audit / future use)
-- Front-end v5.1: bilo koji PM ili LeadPM u tabeli = izmene na svim projektima; samo viewer je read-only
CREATE INDEX idx_roles_email ON user_roles(email);
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_email_project_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_roles_global
ON user_roles (lower(email))
WHERE project_id IS NULL AND is_active = true;
CREATE UNIQUE INDEX IF NOT EXISTS ux_user_roles_project
ON user_roles (lower(email), project_id)
WHERE project_id IS NOT NULL AND is_active = true;

-- REMINDER LOG
CREATE TABLE reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  work_package_id UUID REFERENCES work_packages(id) ON DELETE SET NULL,
  phase_id UUID REFERENCES phases(id) ON DELETE SET NULL,
  sent_to TEXT NOT NULL,
  sent_type TEXT DEFAULT 'email',
  sent_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'sent' CHECK (status IN ('sent','failed','pending')),
  error_message TEXT DEFAULT ''
);
CREATE INDEX idx_reminder_project ON reminder_log(project_id);
CREATE INDEX idx_reminder_phase ON reminder_log(phase_id);

-- EMPLOYEES (Kadrovska module — v5.1)
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
CREATE INDEX IF NOT EXISTS idx_employees_name       ON employees(lower(full_name));
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_position   ON employees(position);
CREATE INDEX IF NOT EXISTS idx_employees_active     ON employees(is_active);
CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_email
  ON employees(lower(email))
  WHERE email IS NOT NULL AND email <> '';

-- ABSENCES (Kadrovska phase 1)
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

-- WORK_HOURS (Kadrovska phase 1 — ručni unos umesto Excel-a)
-- Extended for the Mesečni grid (Excel-like) editor:
--   field_hours   = terenski rad
--   absence_code  = go|bo|sp|np|sl|pr (when set, hours = 0)
-- UNIQUE(employee_id, work_date) enables PostgREST upsert
-- (Prefer: resolution=merge-duplicates) for batch saves.
CREATE TABLE IF NOT EXISTS work_hours (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date       DATE NOT NULL,
  hours           NUMERIC(5,2) NOT NULL DEFAULT 0
                  CHECK (hours >= 0 AND hours <= 24),
  overtime_hours  NUMERIC(5,2) NOT NULL DEFAULT 0
                  CHECK (overtime_hours >= 0 AND overtime_hours <= 24),
  field_hours     NUMERIC(5,2) NOT NULL DEFAULT 0
                  CHECK (field_hours >= 0 AND field_hours <= 24),
  absence_code    TEXT
                  CHECK (absence_code IS NULL OR absence_code IN ('go','bo','sp','np','sl','pr')),
  project_ref     TEXT DEFAULT '',
  note            TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT work_hours_emp_date_uq UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_work_hours_employee  ON work_hours(employee_id);
CREATE INDEX IF NOT EXISTS idx_work_hours_date      ON work_hours(work_date);
CREATE INDEX IF NOT EXISTS idx_work_hours_emp_date  ON work_hours(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_work_hours_date_only ON work_hours(work_date);

-- CONTRACTS (Kadrovska phase 1)
-- Business rules: date_from is mandatory, date_to optional (NULL = open-ended),
-- and when date_to is present it must be >= date_from.
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_type   TEXT NOT NULL DEFAULT 'neodredjeno'
                  CHECK (contract_type IN ('neodredjeno','odredjeno','privremeno','delo','student','praksa','ostalo')),
  contract_number TEXT DEFAULT '',
  position        TEXT DEFAULT '',
  date_from       DATE NOT NULL,
  date_to         DATE,
  is_active       BOOLEAN DEFAULT true,
  note            TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT contracts_dates_valid CHECK (date_to IS NULL OR date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS idx_contracts_employee ON contracts(employee_id);
CREATE INDEX IF NOT EXISTS idx_contracts_active   ON contracts(is_active);
CREATE INDEX IF NOT EXISTS idx_contracts_dateto   ON contracts(date_to);

-- ═══════════════════════════════════════════════════════════
-- UPDATED_AT TRIGGER (auto-update timestamp)
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_wp_updated BEFORE UPDATE ON work_packages FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_phases_updated BEFORE UPDATE ON phases FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_employees_updated ON employees;
CREATE TRIGGER trg_employees_updated BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_absences_updated ON absences;
CREATE TRIGGER trg_absences_updated BEFORE UPDATE ON absences FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_work_hours_updated ON work_hours;
CREATE TRIGGER trg_work_hours_updated BEFORE UPDATE ON work_hours FOR EACH ROW EXECUTE FUNCTION update_updated_at();
DROP TRIGGER IF EXISTS trg_contracts_updated ON contracts;
CREATE TRIGGER trg_contracts_updated BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ═══════════════════════════════════════════════════════════
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE phases ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE absences ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════
-- Helper: has_edit_role()
--
-- TRUE za:
--   * globalnu rolu (project_id IS NULL): admin / hr / menadzment / pm / leadpm
--   * project-specifičnu rolu pm / leadpm na zadatom `proj_id`
-- FALSE inače (uključujući viewer i nepoznatu/odjavljenu sesiju).
--
-- Sinhrono sa migracijom add_menadzment_full_edit_kadrovska.sql i
-- src/state/auth.js → canEdit() / canEditKadrovska(). Bilo koja izmena
-- ovde zahteva i izmenu te migracije + JS helpera.
--
-- Bezbedno: SECURITY DEFINER + SET search_path da spreči hijack, ali
-- bez recursive RLS poziva (čita user_roles direktno iz public schema).
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.has_edit_role(proj_id UUID DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  auth_email TEXT := lower(coalesce(auth.jwt()->>'email', ''));
BEGIN
  IF auth_email = '' THEN
    RETURN false;
  END IF;

  -- Globalna rola.
  IF EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  lower(email) = auth_email
      AND  project_id IS NULL
      AND  role IN ('admin','hr','menadzment','pm','leadpm')
      AND  is_active = true
  ) THEN
    RETURN true;
  END IF;

  -- Project-specifična rola (samo pm/leadpm; admin/hr/menadzment se daje
  -- isključivo globalno — ne mešamo per-project menadžment koncept).
  IF proj_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  lower(email) = auth_email
      AND  project_id = proj_id
      AND  role IN ('pm','leadpm')
      AND  is_active = true
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

-- PROJECTS: everyone can read, PM/LeadPM can write
CREATE POLICY "projects_select" ON projects FOR SELECT TO authenticated USING (true);
CREATE POLICY "projects_insert" ON projects FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "projects_update" ON projects FOR UPDATE TO authenticated USING (has_edit_role(id)) WITH CHECK (has_edit_role(id));
CREATE POLICY "projects_delete" ON projects FOR DELETE TO authenticated USING (has_edit_role(id));

-- WORK PACKAGES
CREATE POLICY "wp_select" ON work_packages FOR SELECT TO authenticated USING (true);
CREATE POLICY "wp_insert" ON work_packages FOR INSERT TO authenticated WITH CHECK (has_edit_role(project_id));
CREATE POLICY "wp_update" ON work_packages FOR UPDATE TO authenticated USING (has_edit_role(project_id)) WITH CHECK (has_edit_role(project_id));
CREATE POLICY "wp_delete" ON work_packages FOR DELETE TO authenticated USING (has_edit_role(project_id));

-- PHASES
CREATE POLICY "phases_select" ON phases FOR SELECT TO authenticated USING (true);
CREATE POLICY "phases_insert" ON phases FOR INSERT TO authenticated WITH CHECK (has_edit_role(project_id));
CREATE POLICY "phases_update" ON phases FOR UPDATE TO authenticated USING (has_edit_role(project_id)) WITH CHECK (has_edit_role(project_id));
CREATE POLICY "phases_delete" ON phases FOR DELETE TO authenticated USING (has_edit_role(project_id));

-- ═══════════════════════════════════════════════════════════
-- USER ROLES — ne-rekurzivne RLS politike
--
-- Sinhrono sa migracijama enable_user_roles_rls_proper.sql i
-- cleanup_user_roles_legacy_policies.sql. NE SME se vraćati na
-- pilot `roles_select USING(true)` — to bi otvorilo ceo `user_roles`
-- registar svakom autentifikovanom korisniku.
--
-- Politike:
--   user_roles_read_self       — svako vidi SVOJ red (po email iz JWT)
--   user_roles_read_admin_all  — admin vidi sve (preko SECURITY DEFINER helper-a)
--   user_roles_admin_write     — INSERT/UPDATE/DELETE: samo admin
--
-- `current_user_is_admin()` helper se kreira u
-- enable_user_roles_rls_proper.sql; ovde ga referenciramo defanzivno
-- preko EXISTS check-a na user_roles (nema rekurzije jer je politika
-- `read_self` već dovoljno permisivna za sopstveni admin red).
-- ═══════════════════════════════════════════════════════════

ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

-- Read-self: svako autentifikovan vidi svoj red, bez podupita iz user_roles.
CREATE POLICY "user_roles_read_self" ON user_roles
  FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(auth.jwt()->>'email', '')));

-- Read-all-admin: admin vidi ceo registar.
CREATE POLICY "user_roles_read_admin_all" ON user_roles
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM   public.user_roles ur
      WHERE  lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
        AND  ur.project_id IS NULL
        AND  ur.role = 'admin'
        AND  ur.is_active = true
    )
  );

-- Write: samo admin može INSERT/UPDATE/DELETE.
CREATE POLICY "user_roles_admin_write" ON user_roles
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM   public.user_roles ur
      WHERE  lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
        AND  ur.project_id IS NULL
        AND  ur.role = 'admin'
        AND  ur.is_active = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM   public.user_roles ur
      WHERE  lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
        AND  ur.project_id IS NULL
        AND  ur.role = 'admin'
        AND  ur.is_active = true
    )
  );

-- REMINDER LOG: PM/LeadPM can read/write
CREATE POLICY "reminder_select" ON reminder_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "reminder_insert" ON reminder_log FOR INSERT TO authenticated WITH CHECK (has_edit_role(project_id));
CREATE POLICY "reminder_update" ON reminder_log FOR UPDATE TO authenticated USING (has_edit_role(project_id)) WITH CHECK (has_edit_role(project_id));

-- EMPLOYEES (Kadrovska): everyone auth can read, PM/LeadPM can write
CREATE POLICY "employees_select" ON employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "employees_insert" ON employees FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "employees_update" ON employees FOR UPDATE TO authenticated USING (has_edit_role()) WITH CHECK (has_edit_role());
CREATE POLICY "employees_delete" ON employees FOR DELETE TO authenticated USING (has_edit_role());

-- ABSENCES / WORK_HOURS / CONTRACTS (Kadrovska phase 1)
CREATE POLICY "absences_select" ON absences FOR SELECT TO authenticated USING (true);
CREATE POLICY "absences_insert" ON absences FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "absences_update" ON absences FOR UPDATE TO authenticated USING (has_edit_role()) WITH CHECK (has_edit_role());
CREATE POLICY "absences_delete" ON absences FOR DELETE TO authenticated USING (has_edit_role());

CREATE POLICY "work_hours_select" ON work_hours FOR SELECT TO authenticated USING (true);
CREATE POLICY "work_hours_insert" ON work_hours FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "work_hours_update" ON work_hours FOR UPDATE TO authenticated USING (has_edit_role()) WITH CHECK (has_edit_role());
CREATE POLICY "work_hours_delete" ON work_hours FOR DELETE TO authenticated USING (has_edit_role());

CREATE POLICY "contracts_select" ON contracts FOR SELECT TO authenticated USING (true);
CREATE POLICY "contracts_insert" ON contracts FOR INSERT TO authenticated WITH CHECK (has_edit_role());
CREATE POLICY "contracts_update" ON contracts FOR UPDATE TO authenticated USING (has_edit_role()) WITH CHECK (has_edit_role());
CREATE POLICY "contracts_delete" ON contracts FOR DELETE TO authenticated USING (has_edit_role());
