-- ============================================================================
-- FIX: maint_incidents INSERT RLS + audit trigger SECURITY DEFINER
-- ============================================================================
-- Problemi koje ispravlja:
--   1) add_maint_rls_menadzment_paritet.sql je prepisao INSERT politiku za
--      maint_incidents i vratio maint_machine_visible(machine_code) umesto
--      maint_incident_row_visible(machine_code, asset_id) — konzistenost sa
--      SELECT politikom je bila narušena.
--   2) Ista politika nije uključivala maint_has_floor_read_access() u role-čeku,
--      pa ERP korisnici sa ulogom 'pm'/'leadpm' koji mogu da vide mašine
--      nisu mogli da prijave kvar (INSERT 403).
--   3) Trigger maint_incidents_audit koristio SECURITY INVOKER — INSERT u
--      maint_incident_events prolazio kroz RLS za tekućeg korisnika i mogao
--      je da padne u edge-case scenarijima, rušeći celu transakciju.
-- ============================================================================

-- ── 1) Ispravi INSERT politiku ────────────────────────────────────────────────
DROP POLICY IF EXISTS maint_incidents_insert ON public.maint_incidents;
CREATE POLICY maint_incidents_insert ON public.maint_incidents
  FOR INSERT WITH CHECK (
    reported_by = auth.uid()
    AND public.maint_incident_row_visible(machine_code, asset_id)
    AND (
      public.maint_is_erp_admin_or_management()
      OR public.maint_has_floor_read_access()
      OR public.maint_profile_role() IN ('operator', 'technician', 'chief', 'admin')
    )
  );

-- ── 2) Audit trigger: SECURITY DEFINER da zaobiđe RLS na maint_incident_events ─
CREATE OR REPLACE FUNCTION public.maint_incidents_log_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
BEGIN
  v_actor := auth.uid();

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.maint_incident_events (incident_id, actor, event_type, from_value, to_value, comment)
    VALUES (NEW.id, v_actor, 'created', NULL, NEW.status::text, NULL);
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.maint_incident_events (incident_id, actor, event_type, from_value, to_value, comment)
    VALUES (NEW.id, v_actor, 'status_change', OLD.status::text, NEW.status::text, NULL);
  END IF;

  IF OLD.assigned_to IS DISTINCT FROM NEW.assigned_to THEN
    INSERT INTO public.maint_incident_events (incident_id, actor, event_type, from_value, to_value, comment)
    VALUES (
      NEW.id,
      v_actor,
      'assigned',
      OLD.assigned_to::text,
      NEW.assigned_to::text,
      NULL
    );
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.maint_incidents_log_changes() IS
  'Audit za maint_incidents: INSERT -> "created", UPDATE -> status/assigned. SECURITY DEFINER da trigger uvek može upisati event bez RLS blokade.';
