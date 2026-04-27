-- ============================================================================
-- Supabase: isti sadrzaj kao sql/migrations/add_maint_facility_details.sql
-- ============================================================================

-- ============================================================================
-- ODRŽAVANJE (CMMS) — detalji za objekte / facility sredstva
-- ============================================================================
-- MORA posle:
--   * add_maint_assets_supertable.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.maint_facility_details (
  asset_id                    UUID PRIMARY KEY REFERENCES public.maint_assets (asset_id) ON DELETE CASCADE,
  facility_type               TEXT,
  floor_area_m2               NUMERIC(12, 2),
  floor_or_zone               TEXT,
  criticality                 TEXT,
  inspection_due_at           DATE,
  fire_safety_due_at          DATE,
  service_contract            TEXT,
  service_provider            TEXT,
  last_inspection_at          DATE,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT maint_facility_area_nonnegative CHECK (floor_area_m2 IS NULL OR floor_area_m2 >= 0),
  CONSTRAINT maint_facility_criticality_valid CHECK (
    criticality IS NULL OR criticality IN ('low', 'medium', 'high', 'critical')
  )
);

CREATE INDEX IF NOT EXISTS idx_maint_facility_inspection_due
  ON public.maint_facility_details (inspection_due_at);

CREATE INDEX IF NOT EXISTS idx_maint_facility_fire_safety_due
  ON public.maint_facility_details (fire_safety_due_at);

CREATE INDEX IF NOT EXISTS idx_maint_facility_criticality
  ON public.maint_facility_details (criticality);

DROP TRIGGER IF EXISTS maint_facility_details_touch_updated ON public.maint_facility_details;
CREATE TRIGGER maint_facility_details_touch_updated
  BEFORE UPDATE ON public.maint_facility_details
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.maint_facility_details_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.maint_assets a
    WHERE a.asset_id = NEW.asset_id
      AND a.asset_type = 'facility'::public.maint_asset_type
  ) THEN
    RAISE EXCEPTION 'maint_facility_details.asset_id must reference a facility asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maint_facility_details_guard_biu ON public.maint_facility_details;
CREATE TRIGGER maint_facility_details_guard_biu
  BEFORE INSERT OR UPDATE ON public.maint_facility_details
  FOR EACH ROW EXECUTE FUNCTION public.maint_facility_details_guard();

ALTER TABLE public.maint_facility_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_facility_details_select ON public.maint_facility_details;
CREATE POLICY maint_facility_details_select ON public.maint_facility_details
  FOR SELECT USING (public.maint_asset_visible(asset_id));

DROP POLICY IF EXISTS maint_facility_details_insert ON public.maint_facility_details;
CREATE POLICY maint_facility_details_insert ON public.maint_facility_details
  FOR INSERT WITH CHECK (
    public.maint_asset_visible(asset_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('chief', 'admin')
    )
  );

DROP POLICY IF EXISTS maint_facility_details_update ON public.maint_facility_details;
CREATE POLICY maint_facility_details_update ON public.maint_facility_details
  FOR UPDATE USING (
    public.maint_asset_visible(asset_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('chief', 'admin')
    )
  )
  WITH CHECK (public.maint_asset_visible(asset_id));

GRANT SELECT, INSERT, UPDATE ON public.maint_facility_details TO authenticated;
GRANT EXECUTE ON FUNCTION public.maint_facility_details_guard() TO authenticated;

COMMIT;
