-- ============================================================================
-- Supabase: isti sadrzaj kao sql/migrations/add_maint_documents.sql
-- ============================================================================

-- ============================================================================
-- ODRŽAVANJE (CMMS) — polimorfni registar dokumenata
-- ============================================================================
-- MORA posle:
--   * add_maint_assets_supertable.sql
--   * add_maint_work_orders.sql
--   * extend_maint_incidents_assets.sql
--   * add_maint_machine_files.sql (Storage bucket maint-machine-files)
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'maint_document_entity_type') THEN
    CREATE TYPE public.maint_document_entity_type AS ENUM ('asset', 'work_order', 'incident', 'preventive_task');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.maint_documents (
  document_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     public.maint_document_entity_type NOT NULL,
  entity_id       UUID NOT NULL,
  asset_id        UUID REFERENCES public.maint_assets (asset_id) ON DELETE SET NULL,
  wo_id           UUID REFERENCES public.maint_work_orders (wo_id) ON DELETE SET NULL,
  incident_id     UUID REFERENCES public.maint_incidents (id) ON DELETE SET NULL,
  preventive_task_id UUID REFERENCES public.maint_tasks (id) ON DELETE SET NULL,
  file_name       TEXT NOT NULL,
  storage_path    TEXT NOT NULL UNIQUE,
  mime_type       TEXT,
  size_bytes      BIGINT,
  category        TEXT,
  description     TEXT,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by     UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT maint_documents_file_name_nonempty CHECK (length(trim(file_name)) > 0),
  CONSTRAINT maint_documents_storage_path_nonempty CHECK (length(trim(storage_path)) > 0),
  CONSTRAINT maint_documents_entity_match CHECK (
    (entity_type = 'asset' AND asset_id = entity_id)
    OR (entity_type = 'work_order' AND wo_id = entity_id)
    OR (entity_type = 'incident' AND incident_id = entity_id)
    OR (entity_type = 'preventive_task' AND preventive_task_id = entity_id)
  )
);

CREATE INDEX IF NOT EXISTS idx_maint_documents_asset
  ON public.maint_documents (asset_id, uploaded_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maint_documents_wo
  ON public.maint_documents (wo_id, uploaded_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maint_documents_incident
  ON public.maint_documents (incident_id, uploaded_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maint_documents_task
  ON public.maint_documents (preventive_task_id, uploaded_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.maint_documents IS
  'Polimorfni CMMS dokumenti za assete, radne naloge, incidente i preventivne taskove. Binarni sadržaj je u privatnom Storage bucket-u maint-machine-files.';

CREATE OR REPLACE FUNCTION public.maint_document_visible(
  p_entity_type public.maint_document_entity_type,
  p_asset_id UUID,
  p_wo_id UUID,
  p_incident_id UUID,
  p_preventive_task_id UUID
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_asset_id IS NOT NULL THEN public.maint_asset_visible(p_asset_id)
    WHEN p_wo_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM public.maint_work_orders w
      WHERE w.wo_id = p_wo_id
        AND public.maint_wo_row_visible(w.asset_id, w.assigned_to, w.reported_by)
    )
    WHEN p_incident_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM public.maint_incidents i
      WHERE i.id = p_incident_id
        AND public.maint_incident_row_visible(i.machine_code, i.asset_id)
    )
    WHEN p_preventive_task_id IS NOT NULL THEN EXISTS (
      SELECT 1 FROM public.maint_tasks t
      JOIN public.maint_machines m ON m.machine_code = t.machine_code
      WHERE t.id = p_preventive_task_id
        AND public.maint_asset_visible(m.asset_id)
    )
    ELSE false
  END;
$$;

GRANT EXECUTE ON FUNCTION public.maint_document_visible(
  public.maint_document_entity_type, uuid, uuid, uuid, uuid
) TO authenticated;

ALTER TABLE public.maint_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_documents_select ON public.maint_documents;
CREATE POLICY maint_documents_select ON public.maint_documents
  FOR SELECT USING (
    public.maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id)
  );

DROP POLICY IF EXISTS maint_documents_insert ON public.maint_documents;
CREATE POLICY maint_documents_insert ON public.maint_documents
  FOR INSERT WITH CHECK (
    uploaded_by = auth.uid()
    AND public.maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('operator', 'technician', 'chief', 'admin')
    )
  );

DROP POLICY IF EXISTS maint_documents_update ON public.maint_documents;
CREATE POLICY maint_documents_update ON public.maint_documents
  FOR UPDATE USING (
    public.maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('chief', 'admin')
      OR (
        uploaded_by = auth.uid()
        AND uploaded_at > now() - interval '24 hours'
        AND public.maint_profile_role() IN ('operator', 'technician')
      )
    )
  )
  WITH CHECK (
    public.maint_document_visible(entity_type, asset_id, wo_id, incident_id, preventive_task_id)
  );

GRANT SELECT, INSERT, UPDATE ON public.maint_documents TO authenticated;

COMMIT;
