-- ═══════════════════════════════════════════════════════════
-- SUPABASE DATA MODEL — Plan Montaže v5.0
-- project → work_packages → phases
-- ═══════════════════════════════════════════════════════════

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code TEXT NOT NULL,
  project_name TEXT NOT NULL,
  projectm TEXT DEFAULT '',
  project_deadline TEXT DEFAULT '',
  pm_email TEXT DEFAULT '',
  leadpm_email TEXT DEFAULT '',
  reminder_enabled BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE work_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rn_code TEXT DEFAULT '',
  rn_order INT DEFAULT 1,
  name TEXT NOT NULL,
  location TEXT DEFAULT 'Dobanovci',
  responsible_engineer_default TEXT DEFAULT '',
  montage_lead_default TEXT DEFAULT '',
  deadline TEXT DEFAULT '',
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

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
  checks JSONB DEFAULT '[false,false,false,false,false,false,false,false]',
  blocker TEXT DEFAULT '',
  note TEXT DEFAULT '',
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT DEFAULT ''
);

CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('pm', 'leadpm', 'viewer')),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  UNIQUE (email, project_id)
);

CREATE TABLE reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  work_package_id UUID REFERENCES work_packages(id) ON DELETE SET NULL,
  phase_id UUID REFERENCES phases(id) ON DELETE SET NULL,
  sent_to TEXT NOT NULL,
  sent_type TEXT DEFAULT 'email',
  sent_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'sent',
  error_message TEXT DEFAULT ''
);

-- Indexes
CREATE INDEX idx_wp_project ON work_packages(project_id);
CREATE INDEX idx_phases_wp ON phases(work_package_id);
CREATE INDEX idx_phases_project ON phases(project_id);
CREATE INDEX idx_phases_status ON phases(status);
CREATE INDEX idx_phases_start ON phases(start_date);
CREATE INDEX idx_user_roles_email ON user_roles(email);
CREATE INDEX idx_reminder_project ON reminder_log(project_id);

-- RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pm_leadpm_all" ON projects FOR ALL
  USING (auth.jwt()->>'role' IN ('pm', 'leadpm'));
CREATE POLICY "viewer_read_projects" ON projects FOR SELECT
  USING (auth.jwt()->>'role' = 'viewer');

CREATE POLICY "pm_leadpm_wp" ON work_packages FOR ALL
  USING (auth.jwt()->>'role' IN ('pm', 'leadpm'));
CREATE POLICY "viewer_read_wp" ON work_packages FOR SELECT
  USING (auth.jwt()->>'role' = 'viewer');

CREATE POLICY "pm_leadpm_phases" ON phases FOR ALL
  USING (auth.jwt()->>'role' IN ('pm', 'leadpm'));
CREATE POLICY "viewer_read_phases" ON phases FOR SELECT
  USING (auth.jwt()->>'role' = 'viewer');
