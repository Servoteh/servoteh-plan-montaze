-- ============================================================================
-- ODRZAVANJE — povezivanje incidenata sa radnim nalogom + auto-kreiranje WO
-- ============================================================================
-- MORA posle: add_maint_work_orders.sql
-- ============================================================================

BEGIN;

ALTER TABLE public.maint_incidents
  ADD COLUMN IF NOT EXISTS work_order_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'maint_incidents_work_order_fk'
  ) THEN
    ALTER TABLE public.maint_incidents
      ADD CONSTRAINT maint_incidents_work_order_fk
      FOREIGN KEY (work_order_id) REFERENCES public.maint_work_orders (wo_id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_maint_incidents_work_order
  ON public.maint_incidents (work_order_id)
  WHERE work_order_id IS NOT NULL;

COMMENT ON COLUMN public.maint_incidents.work_order_id IS
  'Radni nalog povezan sa prijavom (kada postoji).';

CREATE OR REPLACE FUNCTION public.maint_incidents_autocreate_work_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_asset  uuid;
  v_wo     uuid;
  v_pri    public.maint_wo_priority;
  v_tcode  public.maint_asset_type;
  v_t      public.maint_wo_type := 'kvar';
  v_st     public.maint_wo_status := 'novi';
BEGIN
  IF NEW.severity IS NULL OR NEW.severity = 'minor' THEN
    RETURN NEW;
  END IF;
  IF NEW.severity = 'critical' THEN
    v_pri := 'p1_zastoj';
  ELSIF NEW.severity = 'major' THEN
    v_pri := 'p2_smetnja';
  ELSE
    RETURN NEW;
  END IF;

  SELECT m.asset_id, 'machine'::public.maint_asset_type
  INTO v_asset, v_tcode
  FROM public.maint_machines m
  WHERE m.machine_code = NEW.machine_code
  LIMIT 1;

  IF v_asset IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.maint_work_orders (
    type, asset_id, asset_type, source_incident_id, title, description,
    priority, status, reported_by, assigned_to, safety_marker
  ) VALUES (
    v_t, v_asset, v_tcode, NEW.id, NEW.title, NEW.description,
    v_pri, v_st, NEW.reported_by, NEW.assigned_to, false
  ) RETURNING wo_id INTO v_wo;

  UPDATE public.maint_incidents
  SET work_order_id = v_wo
  WHERE id = NEW.id;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS maint_incidents_autocreate_wo ON public.maint_incidents;
CREATE TRIGGER maint_incidents_autocreate_wo
  AFTER INSERT ON public.maint_incidents
  FOR EACH ROW EXECUTE FUNCTION public.maint_incidents_autocreate_work_order();

COMMIT;
