-- ============================================================================
-- PLAN PROIZVODNJE — G2 spremnost + lokalno HITNO + sort ključevi
-- ============================================================================
-- BigTehn cache ostaje read-only. Hitnost je lokalni MES override po RN-u.
-- View se bazira na poslednjoj G7 verziji i čuva CAM + kooperacija kolone.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.production_urgency_overrides (
  work_order_id bigint PRIMARY KEY,
  is_urgent     boolean NOT NULL DEFAULT true,
  reason        text,
  set_by        text,
  set_at        timestamptz NOT NULL DEFAULT now(),
  cleared_at    timestamptz,
  cleared_by    text
);

ALTER TABLE public.production_urgency_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "puo_read_authenticated" ON public.production_urgency_overrides;
CREATE POLICY "puo_read_authenticated"
  ON public.production_urgency_overrides FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "puo_insert_plan_edit" ON public.production_urgency_overrides;
CREATE POLICY "puo_insert_plan_edit"
  ON public.production_urgency_overrides FOR INSERT
  TO authenticated
  WITH CHECK (public.can_edit_plan_proizvodnje());

DROP POLICY IF EXISTS "puo_update_plan_edit" ON public.production_urgency_overrides;
CREATE POLICY "puo_update_plan_edit"
  ON public.production_urgency_overrides FOR UPDATE
  TO authenticated
  USING (public.can_edit_plan_proizvodnje())
  WITH CHECK (public.can_edit_plan_proizvodnje());

DROP POLICY IF EXISTS "puo_delete_never" ON public.production_urgency_overrides;
CREATE POLICY "puo_delete_never"
  ON public.production_urgency_overrides FOR DELETE
  TO authenticated
  USING (FALSE);

CREATE OR REPLACE VIEW public.v_production_operations
WITH (security_invoker = true) AS
SELECT
  l.id                                                  AS line_id,
  l.work_order_id                                       AS work_order_id,
  l.operacija                                           AS operacija,
  l.opis_rada                                           AS opis_rada,
  l.alat_pribor                                         AS alat_pribor,
  l.machine_code                                        AS original_machine_code,
  COALESCE(o.assigned_machine_code, l.machine_code)     AS effective_machine_code,
  l.tpz                                                 AS tpz_min,
  l.tk                                                  AS tk_min,
  l.prioritet                                           AS prioritet_bigtehn,

  wo.ident_broj                                         AS rn_ident_broj,
  wo.broj_crteza                                        AS broj_crteza,
  wo.naziv_dela                                         AS naziv_dela,
  wo.materijal                                          AS materijal,
  wo.dimenzija_materijala                               AS dimenzija_materijala,
  wo.komada                                             AS komada_total,
  wo.rok_izrade                                         AS rok_izrade,
  wo.status_rn                                          AS rn_zavrsen,
  wo.zakljucano                                         AS rn_zakljucano,
  wo.napomena                                           AS rn_napomena,

  c.id                                                  AS customer_id,
  c.name                                                AS customer_name,
  c.short_name                                          AS customer_short,

  m.name                                                AS original_machine_name,
  COALESCE(m.no_procedure, FALSE)                       AS is_non_machining,

  o.id                                                  AS overlay_id,
  o.shift_sort_order                                    AS shift_sort_order,
  o.local_status                                        AS local_status,
  o.shift_note                                          AS shift_note,
  o.assigned_machine_code                               AS assigned_machine_code,
  o.archived_at                                         AS overlay_archived_at,
  o.archived_reason                                     AS overlay_archived_reason,
  o.updated_at                                          AS overlay_updated_at,
  o.updated_by                                          AS overlay_updated_by,
  o.created_at                                          AS overlay_created_at,
  o.created_by                                          AS overlay_created_by,

  COALESCE(tr.komada_done, 0)                           AS komada_done,
  COALESCE(tr.real_seconds, 0)                          AS real_seconds,
  COALESCE(tr.is_done, FALSE)                           AS is_done_in_bigtehn,
  tr.last_finished_at                                   AS last_finished_at,
  tr.prijava_count                                      AS prijava_count,

  COALESCE(d.drawings_count, 0)                         AS drawings_count,

  (bd.drawing_no IS NOT NULL)                           AS has_bigtehn_drawing,
  bd.storage_path                                       AS bigtehn_drawing_path,
  bd.size_bytes                                         AS bigtehn_drawing_size,

  wo.is_mes_active                                      AS is_mes_active,

  COALESCE(o.cam_ready, FALSE)                          AS cam_ready,
  o.cam_ready_at                                        AS cam_ready_at,
  o.cam_ready_by                                        AS cam_ready_by,

  m.rj_code                                             AS rj_group_code,
  m.name                                                AS rj_group_label,
  COALESCE(o.cooperation_status, 'none')                AS cooperation_status,
  o.cooperation_partner                                 AS cooperation_partner,
  o.cooperation_set_by                                  AS cooperation_set_by,
  o.cooperation_set_at                                  AS cooperation_set_at,
  o.cooperation_expected_return                         AS cooperation_expected_return,
  (g.rj_group_code IS NOT NULL)                         AS is_cooperation_auto,
  (COALESCE(o.cooperation_status, 'none') <> 'none')    AS is_cooperation_manual,
  (
    g.rj_group_code IS NOT NULL
    OR COALESCE(o.cooperation_status, 'none') <> 'none'
  )                                                     AS is_cooperation_effective,
  CASE
    WHEN g.rj_group_code IS NOT NULL
     AND COALESCE(o.cooperation_status, 'none') <> 'none' THEN 'auto+manual'
    WHEN g.rj_group_code IS NOT NULL THEN 'auto'
    WHEN COALESCE(o.cooperation_status, 'none') <> 'none' THEN 'manual'
    ELSE 'none'
  END                                                   AS cooperation_source,

  (prev_block.operacija IS NULL)                        AS is_ready_for_processing,
  CASE
    WHEN prev_any.operacija IS NULL THEN 'none'
    WHEN prev_block.operacija IS NULL THEN 'completed'
    WHEN COALESCE(prev_block.komada_done, 0) > 0 THEN 'in_progress'
    ELSE 'not_started'
  END                                                   AS previous_operation_status,
  COALESCE(prev_block.operacija, prev_any.operacija)    AS previous_operation_operacija,
  COALESCE(prev_block.machine_code, prev_any.machine_code)
                                                          AS previous_operation_machine_code,
  (u.work_order_id IS NOT NULL)                         AS is_urgent,
  u.reason                                              AS urgency_reason,
  CASE
    WHEN COALESCE(o.local_status, 'waiting') = 'blocked' THEN 7
    WHEN u.work_order_id IS NOT NULL
     AND prev_block.operacija IS NULL
     AND COALESCE(o.local_status, 'waiting') = 'in_progress' THEN 1
    WHEN u.work_order_id IS NOT NULL
     AND prev_block.operacija IS NULL
     AND COALESCE(o.local_status, 'waiting') = 'waiting' THEN 2
    WHEN u.work_order_id IS NOT NULL
     AND prev_block.operacija IS NOT NULL THEN 3
    WHEN u.work_order_id IS NULL
     AND COALESCE(o.local_status, 'waiting') = 'in_progress' THEN 4
    WHEN u.work_order_id IS NULL
     AND prev_block.operacija IS NULL
     AND COALESCE(o.local_status, 'waiting') = 'waiting' THEN 5
    WHEN u.work_order_id IS NULL
     AND prev_block.operacija IS NOT NULL
     AND COALESCE(o.local_status, 'waiting') = 'waiting' THEN 6
    ELSE 8
  END                                                   AS auto_sort_bucket

FROM public.bigtehn_work_order_lines_cache l
INNER JOIN public.v_active_bigtehn_work_orders wo
  ON wo.id = l.work_order_id
 AND wo.is_mes_active IS TRUE
LEFT JOIN public.bigtehn_customers_cache    c
  ON c.id = wo.customer_id
LEFT JOIN public.bigtehn_machines_cache     m
  ON m.rj_code = l.machine_code
LEFT JOIN public.production_auto_cooperation_groups g
  ON g.rj_group_code = m.rj_code
 AND g.removed_at IS NULL
LEFT JOIN public.production_overlays        o
  ON o.work_order_id = l.work_order_id
 AND o.line_id       = l.id
LEFT JOIN public.production_urgency_overrides u
  ON u.work_order_id = l.work_order_id
 AND u.is_urgent IS TRUE
 AND u.cleared_at IS NULL
LEFT JOIN LATERAL (
  SELECT
    SUM(t.komada)                AS komada_done,
    SUM(t.prn_timer_seconds)     AS real_seconds,
    BOOL_OR(t.is_completed)      AS is_done,
    MAX(t.finished_at)           AS last_finished_at,
    COUNT(*)                     AS prijava_count
  FROM public.bigtehn_tech_routing_cache t
  WHERE t.work_order_id = l.work_order_id
    AND t.operacija     = l.operacija
) tr ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS drawings_count
  FROM public.production_drawings pd
  WHERE pd.work_order_id = l.work_order_id
    AND pd.line_id       = l.id
    AND pd.deleted_at IS NULL
) d ON TRUE
LEFT JOIN LATERAL (
  SELECT
    l2.operacija,
    l2.machine_code,
    l2.prioritet,
    COALESCE(t2.komada_done, 0) AS komada_done
  FROM public.bigtehn_work_order_lines_cache l2
  LEFT JOIN LATERAL (
    SELECT SUM(t.komada) AS komada_done
    FROM public.bigtehn_tech_routing_cache t
    WHERE t.work_order_id = l2.work_order_id
      AND t.operacija     = l2.operacija
  ) t2 ON TRUE
  WHERE l2.work_order_id = l.work_order_id
    AND l2.prioritet < l.prioritet
  ORDER BY l2.prioritet DESC, l2.operacija DESC
  LIMIT 1
) prev_any ON TRUE
LEFT JOIN LATERAL (
  SELECT
    l2.operacija,
    l2.machine_code,
    l2.prioritet,
    COALESCE(t2.komada_done, 0) AS komada_done
  FROM public.bigtehn_work_order_lines_cache l2
  LEFT JOIN LATERAL (
    SELECT SUM(t.komada) AS komada_done
    FROM public.bigtehn_tech_routing_cache t
    WHERE t.work_order_id = l2.work_order_id
      AND t.operacija     = l2.operacija
  ) t2 ON TRUE
  WHERE l2.work_order_id = l.work_order_id
    AND l2.prioritet < l.prioritet
    AND COALESCE(t2.komada_done, 0) < COALESCE(wo.komada, 0)
  ORDER BY l2.prioritet DESC, l2.operacija DESC
  LIMIT 1
) prev_block ON TRUE
LEFT JOIN public.bigtehn_drawings_cache    bd
  ON bd.drawing_no = wo.broj_crteza
 AND bd.removed_at IS NULL;

GRANT SELECT ON public.production_urgency_overrides TO authenticated;
GRANT SELECT ON public.v_production_operations TO authenticated;
REVOKE SELECT ON public.v_production_operations FROM anon;

COMMENT ON TABLE public.production_urgency_overrides IS
  'Lokalni MES HITNO override po radnom nalogu za Planiranje proizvodnje. BigTehn cache se ne menja.';

COMMENT ON VIEW public.v_production_operations IS
  'Denormalizovan pregled operacija za Planiranje proizvodnje. Uključuje MES aktivne RN-ove, CAM, kooperaciju, G2 spremnost i lokalno HITNO.';
