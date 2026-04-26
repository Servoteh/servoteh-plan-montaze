-- =============================================================================
-- Supabase: isti sadržaj kao `sql/migrations/add_maint_locations.sql` (izvor u repo-u).
-- =============================================================================
-- ============================================================================
-- ODRŽAVANJE (CMMS) — hijerarhija lokacija
-- ============================================================================
-- Zavisi od: `add_maintenance_module.sql` (touch_updated_at), `auth.users`.
-- Pokreni posle postojećeg održavanja steka, pre `add_maint_assets_supertable.sql`.
--
-- Idempotentno (IF NOT EXISTS / OR REPLACE gde ima smisla).
-- ============================================================================

BEGIN;

-- ── Tabela ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maint_locations (
  location_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_location_id  UUID REFERENCES public.maint_locations (location_id) ON DELETE SET NULL,
  location_type       TEXT NOT NULL DEFAULT 'lokacija',
  code                TEXT,
  name                TEXT NOT NULL,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT maint_locations_name_nonempty CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_maint_locations_parent
  ON public.maint_locations (parent_location_id)
  WHERE parent_location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_maint_locations_active
  ON public.maint_locations (active) WHERE active = TRUE;

COMMENT ON TABLE public.maint_locations IS
  'Hijerarhija lokacija za CMMS (mašine, vozila, IT, objekti).';

DROP TRIGGER IF EXISTS maint_locations_touch_updated ON public.maint_locations;
CREATE TRIGGER maint_locations_touch_updated
  BEFORE UPDATE ON public.maint_locations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── RLS (paritet sa čitanjem kataloga — floor read; pisanje chief/admin) ─
ALTER TABLE public.maint_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_locations_select ON public.maint_locations;
CREATE POLICY maint_locations_select ON public.maint_locations
  FOR SELECT USING (public.maint_has_floor_read_access());

DROP POLICY IF EXISTS maint_locations_insert ON public.maint_locations;
CREATE POLICY maint_locations_insert ON public.maint_locations
  FOR INSERT WITH CHECK (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_locations_update ON public.maint_locations;
CREATE POLICY maint_locations_update ON public.maint_locations
  FOR UPDATE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  )
  WITH CHECK (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_locations_delete ON public.maint_locations;
CREATE POLICY maint_locations_delete ON public.maint_locations
  FOR DELETE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.maint_locations TO authenticated;

COMMIT;
