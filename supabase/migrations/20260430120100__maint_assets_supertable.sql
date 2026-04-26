-- =============================================================================
-- Supabase: isti sadržaj kao `sql/migrations/add_maint_assets_supertable.sql` (izvor u repo-u).
-- =============================================================================
-- ============================================================================
-- ODRZAVANJE (CMMS) -- sredstvo (supertype) + veza kataloga masina
-- ============================================================================
-- MORA pre ovoga: add_maint_locations.sql, add_maint_machines_catalog.sql
--   i add_maint_machine_responsible.sql (za kolonu responsible_user_id).
-- ============================================================================

BEGIN;

DO $$ BEGIN
  CREATE TYPE public.maint_asset_type AS ENUM ('machine', 'vehicle', 'it', 'facility');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.maint_assets (
  asset_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code            TEXT NOT NULL,
  asset_type            public.maint_asset_type NOT NULL,
  name                  TEXT NOT NULL,
  status                public.maint_operational_status NOT NULL DEFAULT 'running',
  location_id            UUID REFERENCES public.maint_locations (location_id) ON DELETE SET NULL,
  responsible_user_id   UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  manufacturer         TEXT,
  model                  TEXT,
  serial_number         TEXT,
  date_of_purchase      DATE,
  warranty_until         DATE,
  supplier               TEXT,
  qr_token               TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  notes                  TEXT,
  CONSTRAINT maint_assets_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT maint_assets_code_nonempty CHECK (length(trim(asset_code)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_assets_asset_code_lower
  ON public.maint_assets (lower(asset_code));

CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_assets_qr_token
  ON public.maint_assets (qr_token);

CREATE INDEX IF NOT EXISTS idx_maint_assets_type_active
  ON public.maint_assets (asset_type) WHERE active = TRUE AND archived_at IS NULL;

COMMENT ON TABLE public.maint_assets IS
  'CMMS supertype. Masine: 1:1 preko maint_machines.asset_id.';

DROP TRIGGER IF EXISTS maint_assets_touch_updated ON public.maint_assets;
CREATE TRIGGER maint_assets_touch_updated
  BEFORE UPDATE ON public.maint_assets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Vidljivost (mašine preko postojećeg maint_machine_visible)
CREATE OR REPLACE FUNCTION public.maint_asset_visible(p_asset_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.maint_assets a
    WHERE a.asset_id = p_asset_id
      AND (
        (
          a.asset_type = 'machine'
          AND EXISTS (
            SELECT 1
            FROM public.maint_machines m
            WHERE m.asset_id = a.asset_id
              AND public.maint_machine_visible(m.machine_code)
          )
        )
        OR (
          a.asset_type <> 'machine'
          AND (
            public.maint_has_floor_read_access()
            OR public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'management', 'admin')
          )
        )
      )
  );
$$;

COMMENT ON FUNCTION public.maint_asset_visible IS
  'Mašine: maint_machine_visible. Ostali tipovi: floor/menadžment/šef.';

GRANT EXECUTE ON FUNCTION public.maint_asset_visible(uuid) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'maint_machines'
      AND column_name = 'asset_id'
  ) THEN
    ALTER TABLE public.maint_machines
      ADD COLUMN asset_id uuid REFERENCES public.maint_assets (asset_id) ON DELETE RESTRICT;
  END IF;
END $$;

INSERT INTO public.maint_assets (
  asset_code,
  asset_type,
  name,
  status,
  location_id,
  responsible_user_id,
  manufacturer,
  model,
  serial_number,
  notes,
  active,
  archived_at,
  qr_token,
  created_at,
  updated_at
)
SELECT
  m.machine_code,
  'machine'::public.maint_asset_type,
  m.name,
  'running'::public.maint_operational_status,
  NULL,
  m.responsible_user_id,
  m.manufacturer,
  m.model,
  m.serial_number,
  m.notes,
  (m.archived_at IS NULL),
  m.archived_at,
  gen_random_uuid()::text,
  m.created_at,
  m.updated_at
FROM public.maint_machines m
WHERE NOT EXISTS (
  SELECT 1 FROM public.maint_assets a
  WHERE lower(a.asset_code) = lower(m.machine_code)
    AND a.asset_type = 'machine'
);

UPDATE public.maint_machines mm
SET asset_id = a.asset_id
FROM public.maint_assets a
WHERE lower(a.asset_code) = lower(mm.machine_code)
  AND a.asset_type = 'machine'
  AND mm.asset_id IS NULL;

DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*)::int INTO n FROM public.maint_machines WHERE asset_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'maint_assets backfill: % redova u maint_machines bez asset_id', n
      USING ERRCODE = 'P0001';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS maint_machines_asset_id_key
  ON public.maint_machines (asset_id);

ALTER TABLE public.maint_machines
  ALTER COLUMN asset_id SET NOT NULL;

ALTER TABLE public.maint_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_assets_select ON public.maint_assets;
CREATE POLICY maint_assets_select ON public.maint_assets
  FOR SELECT USING (public.maint_asset_visible(asset_id));

DROP POLICY IF EXISTS maint_assets_insert ON public.maint_assets;
CREATE POLICY maint_assets_insert ON public.maint_assets
  FOR INSERT WITH CHECK (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_assets_update ON public.maint_assets;
CREATE POLICY maint_assets_update ON public.maint_assets
  FOR UPDATE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  )
  WITH CHECK (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_assets_delete ON public.maint_assets;
CREATE POLICY maint_assets_delete ON public.maint_assets
  FOR DELETE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.maint_assets TO authenticated;

-- Novi unos u katalog bez asset_id: automatski kreira red u maint_assets (SECURITY DEFINER mimo RLS).
CREATE OR REPLACE FUNCTION public.maint_machines_ensure_asset()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NEW.asset_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT a.asset_id INTO v_id
  FROM public.maint_assets a
  WHERE lower(a.asset_code) = lower(NEW.machine_code)
    AND a.asset_type = 'machine'
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    NEW.asset_id := v_id;
    RETURN NEW;
  END IF;
  INSERT INTO public.maint_assets (
    asset_code,
    asset_type,
    name,
    status,
    responsible_user_id,
    manufacturer,
    model,
    serial_number,
    notes,
    active,
    archived_at,
    qr_token,
    created_at,
    updated_at
  ) VALUES (
    NEW.machine_code,
    'machine',
    NEW.name,
    'running',
    NEW.responsible_user_id,
    NEW.manufacturer,
    NEW.model,
    NEW.serial_number,
    NEW.notes,
    (NEW.archived_at IS NULL),
    NEW.archived_at,
    gen_random_uuid()::text,
    COALESCE(NEW.created_at, now()),
    COALESCE(NEW.updated_at, now())
  )
  RETURNING asset_id INTO v_id;
  NEW.asset_id := v_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maint_machines_ensure_asset ON public.maint_machines;
CREATE TRIGGER maint_machines_ensure_asset
  BEFORE INSERT ON public.maint_machines
  FOR EACH ROW EXECUTE FUNCTION public.maint_machines_ensure_asset();


COMMIT;
