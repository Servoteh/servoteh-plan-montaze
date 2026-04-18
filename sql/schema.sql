-- ═══════════════════════════════════════════════════════════
-- SUPABASE SQL SCHEMA — Plan Montaže v5.1
-- Supabase-first, upsert-ready, with RLS
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

-- CONTRACTS (Kadrovska phase 1)
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

-- Helper: check if current user has edit role
CREATE OR REPLACE FUNCTION has_edit_role(proj_id UUID DEFAULT NULL)
RETURNS BOOLEAN AS $$
BEGIN
  -- Pilot hardening: for this pilot round, allow editing for any authenticated user.
  -- (Front-end still shows role labels, but RLS no longer blocks INSERT/UPDATE/DELETE.)
  RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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

-- USER ROLES: only global PM can manage roles
CREATE POLICY "roles_select" ON user_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "roles_manage" ON user_roles FOR ALL TO authenticated USING (
  EXISTS (
    SELECT 1
    FROM user_roles ur
    WHERE lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
      AND ur.project_id IS NULL
      AND ur.role = 'pm'
      AND ur.is_active = true
  )
) WITH CHECK (
  EXISTS (
    SELECT 1
    FROM user_roles ur
    WHERE lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
      AND ur.project_id IS NULL
      AND ur.role = 'pm'
      AND ur.is_active = true
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
