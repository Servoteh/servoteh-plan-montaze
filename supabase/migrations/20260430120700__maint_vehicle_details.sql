-- ============================================================================
-- Supabase: isti sadrzaj kao sql/migrations/add_maint_vehicle_details.sql
-- ============================================================================

-- ============================================================================
-- ODRŽAVANJE (CMMS) — detalji za vozila
-- ============================================================================
-- MORA posle:
--   * add_maint_assets_supertable.sql
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.maint_vehicle_details (
  asset_id                UUID PRIMARY KEY REFERENCES public.maint_assets (asset_id) ON DELETE CASCADE,
  registration_plate      TEXT,
  vin                     TEXT,
  odometer_km             INTEGER,
  fuel_type               TEXT,
  registration_expires_at DATE,
  insurance_expires_at    DATE,
  service_due_at          DATE,
  service_interval_km     INTEGER,
  next_service_mileage_km INTEGER,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by              UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT maint_vehicle_odometer_nonnegative CHECK (odometer_km IS NULL OR odometer_km >= 0),
  CONSTRAINT maint_vehicle_service_interval_nonnegative CHECK (service_interval_km IS NULL OR service_interval_km >= 0),
  CONSTRAINT maint_vehicle_next_service_nonnegative CHECK (next_service_mileage_km IS NULL OR next_service_mileage_km >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_vehicle_details_registration
  ON public.maint_vehicle_details (upper(registration_plate))
  WHERE registration_plate IS NOT NULL AND length(trim(registration_plate)) > 0;

CREATE INDEX IF NOT EXISTS idx_maint_vehicle_details_registration_due
  ON public.maint_vehicle_details (registration_expires_at);

CREATE INDEX IF NOT EXISTS idx_maint_vehicle_details_service_due
  ON public.maint_vehicle_details (service_due_at);

DROP TRIGGER IF EXISTS maint_vehicle_details_touch_updated ON public.maint_vehicle_details;
CREATE TRIGGER maint_vehicle_details_touch_updated
  BEFORE UPDATE ON public.maint_vehicle_details
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public.maint_vehicle_details_guard()
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
      AND a.asset_type = 'vehicle'::public.maint_asset_type
  ) THEN
    RAISE EXCEPTION 'maint_vehicle_details.asset_id must reference a vehicle asset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS maint_vehicle_details_guard_biu ON public.maint_vehicle_details;
CREATE TRIGGER maint_vehicle_details_guard_biu
  BEFORE INSERT OR UPDATE ON public.maint_vehicle_details
  FOR EACH ROW EXECUTE FUNCTION public.maint_vehicle_details_guard();

ALTER TABLE public.maint_vehicle_details ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_vehicle_details_select ON public.maint_vehicle_details;
CREATE POLICY maint_vehicle_details_select ON public.maint_vehicle_details
  FOR SELECT USING (public.maint_asset_visible(asset_id));

DROP POLICY IF EXISTS maint_vehicle_details_insert ON public.maint_vehicle_details;
CREATE POLICY maint_vehicle_details_insert ON public.maint_vehicle_details
  FOR INSERT WITH CHECK (
    public.maint_asset_visible(asset_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('chief', 'admin')
    )
  );

DROP POLICY IF EXISTS maint_vehicle_details_update ON public.maint_vehicle_details;
CREATE POLICY maint_vehicle_details_update ON public.maint_vehicle_details
  FOR UPDATE USING (
    public.maint_asset_visible(asset_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('chief', 'admin')
    )
  )
  WITH CHECK (public.maint_asset_visible(asset_id));

GRANT SELECT, INSERT, UPDATE ON public.maint_vehicle_details TO authenticated;
GRANT EXECUTE ON FUNCTION public.maint_vehicle_details_guard() TO authenticated;

COMMIT;
