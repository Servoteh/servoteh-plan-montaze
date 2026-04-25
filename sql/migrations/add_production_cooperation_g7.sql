-- ============================================================================
-- PLAN PROIZVODNJE — G7 kooperacija
-- ============================================================================
-- Auto-kooperacija se vodi eksplicitnom lookup tabelom. BigTehn cache ostaje
-- read-only, a ručno slanje u kooperaciju živi u production_overlays.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.production_auto_cooperation_groups (
  rj_group_code text PRIMARY KEY,
  group_label   text NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  added_by      text,
  removed_at    timestamptz,
  removed_by    text,
  notes         text
);

ALTER TABLE public.production_auto_cooperation_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pacg_read_authenticated" ON public.production_auto_cooperation_groups;
CREATE POLICY "pacg_read_authenticated"
  ON public.production_auto_cooperation_groups FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "pacg_insert_admin" ON public.production_auto_cooperation_groups;
CREATE POLICY "pacg_insert_admin"
  ON public.production_auto_cooperation_groups FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_is_admin());

DROP POLICY IF EXISTS "pacg_update_admin" ON public.production_auto_cooperation_groups;
CREATE POLICY "pacg_update_admin"
  ON public.production_auto_cooperation_groups FOR UPDATE
  TO authenticated
  USING (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

DROP POLICY IF EXISTS "pacg_delete_never" ON public.production_auto_cooperation_groups;
CREATE POLICY "pacg_delete_never"
  ON public.production_auto_cooperation_groups FOR DELETE
  TO authenticated
  USING (FALSE);

INSERT INTO public.production_auto_cooperation_groups (rj_group_code, group_label, added_by, notes)
VALUES
  ('2.10',  'Uslužno struganje', 'system:g7-seed', 'Potvrđeno u G7 fazi A'),
  ('3.9.1', 'Uslužno glodanje',  'system:g7-seed', 'Potvrđeno u G7 fazi A'),
  ('9.0',   'Kooperacija',       'system:g7-seed', 'Potvrđeno od korisnika 2026-04-25')
ON CONFLICT (rj_group_code) DO UPDATE
SET
  group_label = EXCLUDED.group_label,
  notes       = EXCLUDED.notes,
  removed_at  = NULL,
  removed_by  = NULL;

ALTER TABLE public.production_overlays
  ADD COLUMN IF NOT EXISTS cooperation_status text NOT NULL DEFAULT 'none'
    CHECK (cooperation_status IN ('none','external','external_in_progress','external_done')),
  ADD COLUMN IF NOT EXISTS cooperation_partner text,
  ADD COLUMN IF NOT EXISTS cooperation_set_by text,
  ADD COLUMN IF NOT EXISTS cooperation_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS cooperation_expected_return date;

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
  END                                                   AS cooperation_source

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
LEFT JOIN public.bigtehn_drawings_cache    bd
  ON bd.drawing_no = wo.broj_crteza
 AND bd.removed_at IS NULL;

GRANT SELECT ON public.production_auto_cooperation_groups TO authenticated;
GRANT SELECT ON public.v_production_operations TO authenticated;
REVOKE SELECT ON public.v_production_operations FROM anon;

COMMENT ON TABLE public.production_auto_cooperation_groups IS
  'Eksplicitna lista BigTehn RJ grupa koje se automatski vode kao kooperacija u Planiranju proizvodnje.';

COMMENT ON VIEW public.v_production_operations IS
  'Denormalizovan pregled operacija za Planiranje proizvodnje. Vraća samo ručno aktivne MES RN-ove, CAM status i G7 kooperacija status.';
