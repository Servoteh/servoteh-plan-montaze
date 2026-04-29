-- Faza 1 performansi: ne računati v_production_operations_effective za sve RN linije u bazi
-- pa tek onda filtrirati na mašinu. Prvo mali skup (line_id, work_order_id) gde je efektivna
-- mašina = param, zatim LATERAL po jednoj liniji — predikat se spušta na osnovni scan.
-- Indeksi pomažu grana l.machine_code = mc i o.assigned_machine_code = mc.

CREATE INDEX IF NOT EXISTS bwolc_machine_code_work_order_id_idx
  ON public.bigtehn_work_order_lines_cache (machine_code, work_order_id);

CREATE INDEX IF NOT EXISTS po_assigned_machine_lookup_idx
  ON public.production_overlays (assigned_machine_code, work_order_id, line_id)
  WHERE assigned_machine_code IS NOT NULL;

CREATE OR REPLACE FUNCTION public.plan_pp_open_ops_for_machine(p_machine_code text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
SET statement_timeout TO '180s'
AS $$
DECLARE
  mc text;
BEGIN
  mc := btrim(p_machine_code);
  IF mc = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT to_jsonb(s)
  FROM (
    SELECT e.*
    FROM (
      SELECT l.id AS line_id, l.work_order_id
      FROM public.bigtehn_work_order_lines_cache l
      INNER JOIN public.v_active_bigtehn_work_orders wo
        ON wo.id = l.work_order_id
       AND wo.is_mes_active IS TRUE
      LEFT JOIN public.production_overlays o
        ON o.work_order_id = l.work_order_id
       AND o.line_id = l.id
      WHERE COALESCE(o.assigned_machine_code, l.machine_code) = mc
    ) lc
    INNER JOIN LATERAL (
      SELECT *
      FROM public.v_production_operations_effective e0
      WHERE e0.line_id = lc.line_id
        AND e0.work_order_id = lc.work_order_id
    ) e ON TRUE
    WHERE e.is_done_in_bigtehn IS FALSE
      AND e.rn_zavrsen IS FALSE
      AND e.is_cooperation_effective IS FALSE
      AND (e.local_status IS NULL OR e.local_status <> 'completed')
      AND e.overlay_archived_at IS NULL
  ) s
  ORDER BY
    s.shift_sort_order ASC NULLS LAST,
    s.auto_sort_bucket ASC NULLS LAST,
    s.rok_izrade ASC NULLS LAST,
    s.prioritet_bigtehn ASC NULLS LAST
  LIMIT 2500;
END;
$$;

COMMENT ON FUNCTION public.plan_pp_open_ops_for_machine(text) IS
  'Plan proizvodnje: otvorene operacije po mašini (jsonb). Faza 1: sužen skup linija pa LATERAL po v_production_operations_effective radi pushdown predikata.';

GRANT EXECUTE ON FUNCTION public.plan_pp_open_ops_for_machine(text) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_pp_open_ops_for_machine(text) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
