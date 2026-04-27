-- =============================================================================
-- Supabase: mirror of sql/migrations/add_maint_work_orders.sql (source of truth).
-- =============================================================================

-- ============================================================================
-- ODRŽAVANJE (CMMS) — radni nalozi (maint_work_orders) + pomoćne tabele
-- ============================================================================
-- MORA posle: add_maint_assets_supertable.sql (asset_id, maint_asset_type).
-- Povezivanje incidenata: posebna migracija link_maint_incidents_to_wo.sql
--
-- U jednoj transakciji. Idempotentno gde je praktično (IF NOT EXISTS enum vrednosti).
-- ============================================================================

BEGIN;

-- Pretpostavka: public.maint_assets (i maint_asset_type) iz add_maint_assets_supertable.sql.
-- Redosled migracija: add_maintenance_module -> add_maint_machines_catalog -> add_maint_machine_responsible -> add_maint_locations -> add_maint_assets_supertable -> ova (vidi sql/ci/migrations.txt).
DO $$ BEGIN
  IF to_regclass('public.maint_assets') IS NULL THEN
    RAISE EXCEPTION
      'Tabela public.maint_assets ne postoji. Prvo primeni: add_maintenance_module, add_maint_machines_catalog, add_maint_machine_responsible, add_maint_locations, add_maint_assets_supertable (vidi sql/ci/migrations.txt).'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- CI ne učitava add_maint_machine_hard_delete.sql — osiguraj helper (idempotentno).
CREATE OR REPLACE FUNCTION public.maint_is_erp_admin_or_management()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.is_active = true
      AND ur.project_id IS NULL
      AND lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
      AND lower(ur.role::text) IN ('admin', 'menadzment')
  );
$$;
REVOKE ALL ON FUNCTION public.maint_is_erp_admin_or_management() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.maint_is_erp_admin_or_management() TO authenticated;

-- Zavisi od add_maint_assets_supertable.sql; ovde idempotentno ako import ide samo ovaj fajl.
DO $$ BEGIN
  CREATE TYPE public.maint_asset_type AS ENUM ('machine', 'vehicle', 'it', 'facility');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Enum tipovi (WO) ──────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.maint_wo_type AS ENUM (
    'kvar', 'preventiva', 'inspekcija', 'servis', 'administrativni'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.maint_wo_priority AS ENUM (
    'p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.maint_wo_status AS ENUM (
    'novi', 'potvrden', 'dodeljen', 'u_radu', 'ceka_deo', 'ceka_dobavljaca',
    'ceka_korisnika', 'kontrola', 'zavrsen', 'otkazan'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Brojač brojeva po godini (atomski UPDATE u okviru triger-a)
CREATE TABLE IF NOT EXISTS public.maint_wo_number_counter (
  year        INT PRIMARY KEY,
  last_value  INT NOT NULL DEFAULT 0
);

-- ── Glavna tabela ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maint_work_orders (
  wo_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_number                TEXT,
  type                     public.maint_wo_type NOT NULL,
  asset_id                 UUID NOT NULL REFERENCES public.maint_assets (asset_id) ON DELETE RESTRICT,
  asset_type               public.maint_asset_type NOT NULL,
  source_incident_id       UUID,
  source_preventive_task_id UUID REFERENCES public.maint_tasks (id) ON DELETE SET NULL,
  title                    TEXT NOT NULL,
  description              TEXT,
  priority                 public.maint_wo_priority NOT NULL,
  safety_marker            BOOLEAN NOT NULL DEFAULT false,
  status                   public.maint_wo_status NOT NULL DEFAULT 'novi',
  reported_by              UUID NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  assigned_to              UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  due_at                   TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  downtime_from            TIMESTAMPTZ,
  downtime_to              TIMESTAMPTZ,
  labor_minutes            INT,
  cost_total               NUMERIC(10, 2),
  closure_comment          TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by               UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT maint_wo_title_nonempty CHECK (length(trim(title)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_wo_wo_number
  ON public.maint_work_orders (wo_number)
  WHERE wo_number IS NOT NULL AND length(btrim(wo_number)) > 0;

CREATE INDEX IF NOT EXISTS idx_maint_wo_asset ON public.maint_work_orders (asset_id);
CREATE INDEX IF NOT EXISTS idx_maint_wo_status ON public.maint_work_orders (status);
CREATE INDEX IF NOT EXISTS idx_maint_wo_due ON public.maint_work_orders (due_at);
CREATE INDEX IF NOT EXISTS idx_maint_wo_source_incident ON public.maint_work_orders (source_incident_id);
CREATE INDEX IF NOT EXISTS idx_maint_wo_assigned ON public.maint_work_orders (assigned_to);

COMMENT ON TABLE public.maint_work_orders IS
  'Operativni radni nalog (CMMS). Povezivanje sa incidentom: source_incident_id + link kolona na incidentu.';

-- FK na incidente — kolona work_order_id na incidentu dolazi u link_maint_incidents_to_wo.sql
ALTER TABLE public.maint_work_orders
  DROP CONSTRAINT IF EXISTS maint_wo_source_incident_fk;
ALTER TABLE public.maint_work_orders
  ADD CONSTRAINT maint_wo_source_incident_fk
  FOREIGN KEY (source_incident_id) REFERENCES public.maint_incidents (id) ON DELETE SET NULL;

-- ── Pomoć: vidljivost reda (paritet: asset + dodela + self reported) ───────
CREATE OR REPLACE FUNCTION public.maint_wo_row_visible(
  p_asset_id   UUID,
  p_assigned   UUID,
  p_reported   UUID
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_assigned IS NOT NULL AND p_assigned = auth.uid()
      OR p_reported IS NOT NULL AND p_reported = auth.uid()
      OR public.maint_asset_visible(p_asset_id);
$$;

COMMENT ON FUNCTION public.maint_wo_row_visible IS
  'WO SELECT: dodela/prijavio ili vidljiv asset.';

-- ── Broj NNNNN: WO-YYYY-NNNNN (DEFINER: upis u brojač mimo RLS) ───────────
CREATE OR REPLACE FUNCTION public.maint_work_orders_assign_wo_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  y   INT;
  n   INT;
  lbl TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF NEW.wo_number IS NOT NULL AND length(btrim(NEW.wo_number)) > 0 THEN
    RETURN NEW;
  END IF;
  y := EXTRACT(YEAR FROM COALESCE(NEW.created_at, now()))::INT;

  INSERT INTO public.maint_wo_number_counter (year, last_value)
  VALUES (y, 1)
  ON CONFLICT (year) DO UPDATE
  SET last_value = public.maint_wo_number_counter.last_value + 1
  RETURNING last_value INTO n;

  lbl := lpad(n::text, 5, '0');
  NEW.wo_number := 'WO-' || y::text || '-' || lbl;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maint_wo_biu_wo_number ON public.maint_work_orders;
CREATE TRIGGER maint_wo_biu_wo_number
  BEFORE INSERT ON public.maint_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.maint_work_orders_assign_wo_number();

DROP TRIGGER IF EXISTS maint_wo_touch_updated ON public.maint_work_orders;
CREATE TRIGGER maint_wo_touch_updated
  BEFORE UPDATE ON public.maint_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── Deo, sati, događaji ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maint_wo_parts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id      UUID NOT NULL REFERENCES public.maint_work_orders (wo_id) ON DELETE CASCADE,
  part_name  TEXT NOT NULL,
  quantity   NUMERIC(12, 4),
  unit       TEXT,
  unit_cost  NUMERIC(10, 2),
  supplier   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.maint_wo_labor (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id         UUID NOT NULL REFERENCES public.maint_work_orders (wo_id) ON DELETE CASCADE,
  technician_id UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  minutes       INT,
  notes         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.maint_wo_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id      UUID NOT NULL REFERENCES public.maint_work_orders (wo_id) ON DELETE CASCADE,
  actor      UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  comment    TEXT
);

CREATE INDEX IF NOT EXISTS idx_maint_wo_events_wo ON public.maint_wo_events (wo_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_maint_wo_parts_wo ON public.maint_wo_parts (wo_id);
CREATE INDEX IF NOT EXISTS idx_maint_wo_labor_wo ON public.maint_wo_labor (wo_id);

-- ── Audit: promene statusa / dodele / prioriteta (DEFINER — uvek upis) ────
CREATE OR REPLACE FUNCTION public.maint_wo_log_field_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  u uuid;
BEGIN
  u := auth.uid();
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.maint_wo_events (wo_id, actor, at, event_type, from_value, to_value, comment)
    VALUES (NEW.wo_id, u, now(), 'status_change', OLD.status::text, NEW.status::text, NULL);
  END IF;
  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    INSERT INTO public.maint_wo_events (wo_id, actor, at, event_type, from_value, to_value, comment)
    VALUES (NEW.wo_id, u, now(), 'assigned_change', OLD.assigned_to::text, NEW.assigned_to::text, NULL);
  END IF;
  IF OLD.priority IS DISTINCT FROM NEW.priority THEN
    INSERT INTO public.maint_wo_events (wo_id, actor, at, event_type, from_value, to_value, comment)
    VALUES (NEW.wo_id, u, now(), 'priority_change', OLD.priority::text, NEW.priority::text, NULL);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maint_wo_audit_fields ON public.maint_work_orders;
CREATE TRIGGER maint_wo_audit_fields
  BEFORE UPDATE ON public.maint_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.maint_wo_log_field_changes();

-- ── RLS: maint_work_orders ────────────────────────────────────────────────
ALTER TABLE public.maint_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maint_wo_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maint_wo_labor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maint_wo_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maint_wo_number_counter ENABLE ROW LEVEL SECURITY;
-- Brojač: samo definer u triggeru; korisnici ne čitaju direktno
ALTER TABLE public.maint_wo_number_counter FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_wo_num_counter_deny ON public.maint_wo_number_counter;
CREATE POLICY maint_wo_num_counter_deny ON public.maint_wo_number_counter
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS maint_wo_select ON public.maint_work_orders;
CREATE POLICY maint_wo_select ON public.maint_work_orders
  FOR SELECT USING (public.maint_wo_row_visible(asset_id, assigned_to, reported_by));

DROP POLICY IF EXISTS maint_wo_insert ON public.maint_work_orders;
CREATE POLICY maint_wo_insert ON public.maint_work_orders
  FOR INSERT WITH CHECK (
    reported_by = auth.uid()
    AND public.maint_asset_visible(asset_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('operator', 'technician', 'chief', 'admin')
    )
  );

DROP POLICY IF EXISTS maint_wo_update ON public.maint_work_orders;
CREATE POLICY maint_wo_update ON public.maint_work_orders
  FOR UPDATE USING (
    public.maint_wo_row_visible(asset_id, assigned_to, reported_by)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('technician', 'chief', 'admin')
    )
  )
  WITH CHECK (public.maint_wo_row_visible(asset_id, assigned_to, reported_by));

DROP POLICY IF EXISTS maint_wo_delete ON public.maint_work_orders;
CREATE POLICY maint_wo_delete ON public.maint_work_orders
  FOR DELETE USING (
    public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

-- ── RLS: child (isti vid kao parent WO) ──────────────────────────────────
DROP POLICY IF EXISTS maint_wo_parts_all ON public.maint_wo_parts;
CREATE POLICY maint_wo_parts_all ON public.maint_wo_parts
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = maint_wo_parts.wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = maint_wo_parts.wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
        AND (
          public.maint_is_erp_admin_or_management()
          OR public.maint_profile_role() IN ('technician', 'chief', 'admin')
        )
    )
  );

DROP POLICY IF EXISTS maint_wo_labor_all ON public.maint_wo_labor;
CREATE POLICY maint_wo_labor_all ON public.maint_wo_labor
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = maint_wo_labor.wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = maint_wo_labor.wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
        AND (
          public.maint_is_erp_admin_or_management()
          OR public.maint_profile_role() IN ('technician', 'chief', 'admin')
        )
    )
  );

DROP POLICY IF EXISTS maint_wo_events_select ON public.maint_wo_events;
CREATE POLICY maint_wo_events_select ON public.maint_wo_events
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = maint_wo_events.wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
    )
  );

DROP POLICY IF EXISTS maint_wo_events_write ON public.maint_wo_events;
CREATE POLICY maint_wo_events_write ON public.maint_wo_events
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = maint_wo_events.wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
        AND (
          public.maint_is_erp_admin_or_management()
          OR public.maint_profile_role() IN ('technician', 'chief', 'admin')
        )
    )
  );

-- Ručni komentar na event (UPDATE brisan soft — za sada nema)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maint_work_orders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maint_wo_parts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maint_wo_labor TO authenticated;
GRANT SELECT, INSERT ON public.maint_wo_events TO authenticated;

-- Brojač nema GRANT; trigger koristi vlasništvo tabela (bypass) — u CI ok

GRANT EXECUTE ON FUNCTION public.maint_wo_row_visible(uuid, uuid, uuid) TO authenticated;

COMMIT;
