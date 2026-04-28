-- Fix: sum(komada) na KK liniji može biti >> komada_total zbog višestrukih prijava,
-- pa je skoro svaki RN izgledao „pun“ i nestajao iz plana. Uslov sada:
-- raw_sum >= komada_total AND raw_sum <= komada_total * 1.5

DROP VIEW IF EXISTS public.v_production_operations_effective CASCADE;

DROP VIEW IF EXISTS public.v_production_operations CASCADE;

CREATE VIEW public.v_production_operations
WITH (security_invoker = true) AS
SELECT
  s_inner.*,
  COALESCE(g4.is_rework, false) AS is_rework,
  COALESCE(g4.is_scrap, false) AS is_scrap,
  COALESCE(g4.rework_pieces, 0::numeric) AS rework_pieces,
  COALESCE(g4.scrap_pieces, 0::numeric) AS scrap_pieces,
  COALESCE(g4.rework_scrap_count, 0::bigint) AS rework_scrap_count,
  (
    s_inner.komada_total IS NOT NULL
    AND s_inner.komada_total > 0
    AND COALESCE(fc.final_control_raw_sum, 0::numeric) >= s_inner.komada_total::numeric
    AND COALESCE(fc.final_control_raw_sum, 0::numeric)
      <= s_inner.komada_total::numeric * 1.5
  ) AS plan_rn_final_control_done
FROM (
  SELECT v.*, wo.item_id::integer AS item_id
  FROM public.v_production_operations_pre_g4 v
  INNER JOIN public.v_active_bigtehn_work_orders wo ON wo.id = v.work_order_id
) s_inner
LEFT JOIN LATERAL (
  SELECT
    bool_or(c.quality_type_id = 1) AS is_rework,
    bool_or(c.quality_type_id = 2) AS is_scrap,
    COALESCE(sum(c.pieces) FILTER (WHERE c.quality_type_id = 1), 0::numeric) AS rework_pieces,
    COALESCE(sum(c.pieces) FILTER (WHERE c.quality_type_id = 2), 0::numeric) AS scrap_pieces,
    count(*)::bigint AS rework_scrap_count
  FROM public.bigtehn_rework_scrap_cache c
  WHERE c.work_order_id = s_inner.work_order_id AND c.operacija = s_inner.operacija
) g4 ON true
LEFT JOIN LATERAL (
  SELECT COALESCE((
    SELECT sum(t.komada)::numeric
    FROM public.bigtehn_work_order_lines_cache l
    INNER JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
    INNER JOIN public.bigtehn_tech_routing_cache t
      ON t.work_order_id = l.work_order_id
     AND t.operacija = l.operacija
     AND t.machine_code IS NOT DISTINCT FROM l.machine_code
     AND t.is_completed IS TRUE
    WHERE l.work_order_id = s_inner.work_order_id
      AND production._pracenje_line_is_final_control(
        l.machine_code,
        m.name,
        COALESCE(m.no_procedure, false)
      )
  ), 0::numeric) AS final_control_raw_sum
) fc ON true;

COMMENT ON VIEW public.v_production_operations IS
  'Plan: pre_g4 + G4 + item_id; plan_rn_final_control_done = KK pokriva lot, suma umerena (nema duplih).';

COMMENT ON COLUMN public.v_production_operations.plan_rn_final_control_done IS
  'TRUE ako suma KK prijava >= komada_total i <= komada_total×1.5.';

GRANT SELECT ON public.v_production_operations TO authenticated;
REVOKE SELECT ON public.v_production_operations FROM anon;

CREATE VIEW public.v_production_operations_effective
WITH (security_invoker = true) AS
SELECT ops.*
FROM public.v_production_operations ops
WHERE EXISTS (
  SELECT 1
  FROM production.predmet_aktivacija pa
  WHERE pa.predmet_item_id = ops.item_id
    AND pa.je_aktivan IS TRUE
)
AND COALESCE(ops.plan_rn_final_control_done, false) IS NOT TRUE;

COMMENT ON VIEW public.v_production_operations_effective IS
  'v_production_operations + predmet aktivacija + isključeni RN posle završne kontrole (plan).';

GRANT SELECT ON public.v_production_operations_effective TO authenticated;
REVOKE SELECT ON public.v_production_operations_effective FROM anon;

NOTIFY pgrst, 'reload schema';
