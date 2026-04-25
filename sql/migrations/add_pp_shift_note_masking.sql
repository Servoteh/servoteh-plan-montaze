-- ============================================================================
-- F.6 PILOT HARDENING — H-1: maskovanje shift_note za neovlaš ćene uloge
-- ============================================================================
-- Pre ove migracije, RLS na `production_overlays` dozvoljava SELECT svim
-- 'authenticated' korisnicima. To znači da `viewer` ili `hr` može preko
-- direktnog REST upita pročitati napomene šefova mašinske obrade
-- (`shift_note`) — slobodan tekst koji često sadrži poslovno-osetljive
-- informacije ("kupac kasni s plaćanjem", "kovačnica zafrknula", itd.).
--
-- Strategija remedijacije:
--   - NE menjamo SELECT politiku na production_overlays (postojeći RN
--     pregled mora ostati pristupačan svima — sortiranje, status, hitno).
--   - Menjamo VIEW v_production_operations — kolona `shift_note` se
--     vraća kao NULL ako trenutni korisnik nema can_edit_plan_proizvodnje().
--   - Ko ipak hoće direktan SELECT iz production_overlays (admin tooling)
--     i dalje radi sve, ali REST app-flow (sav UI ide kroz
--     v_production_operations) je sad očišćen.
--
-- Prednost ovog pristupa:
--   - Zero-touch klijent: poMasiniTab.js već renderuje shift_note kroz
--     escHtml — ako je NULL, prikazuje '—' (već postojeća logika).
--   - Pregledni: jedna tačka istine je VIEW.
--
-- Idempotentno: CREATE OR REPLACE VIEW iste signature.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_production_operations AS
SELECT
  l.id AS line_id,
  l.work_order_id,
  l.operacija,
  l.opis_rada,
  l.alat_pribor,
  l.machine_code AS original_machine_code,
  COALESCE(o.assigned_machine_code, l.machine_code) AS effective_machine_code,
  l.tpz AS tpz_min,
  l.tk AS tk_min,
  l.prioritet AS prioritet_bigtehn,
  wo.ident_broj AS rn_ident_broj,
  wo.broj_crteza,
  wo.naziv_dela,
  wo.materijal,
  wo.dimenzija_materijala,
  wo.komada AS komada_total,
  wo.rok_izrade,
  wo.status_rn AS rn_zavrsen,
  wo.zakljucano AS rn_zakljucano,
  wo.napomena AS rn_napomena,
  c.id AS customer_id,
  c.name AS customer_name,
  c.short_name AS customer_short,
  m.name AS original_machine_name,
  COALESCE(m.no_procedure, false) AS is_non_machining,
  o.id AS overlay_id,
  o.shift_sort_order,
  o.local_status,
  -- F.6 (H-1): shift_note se vraća kao NULL za uloge bez edit-prava
  -- (viewer, hr). Šefovi mašinske obrade i admin/leadpm/pm/menadzment
  -- vide pun tekst.
  CASE
    WHEN public.can_edit_plan_proizvodnje() THEN o.shift_note
    ELSE NULL
  END AS shift_note,
  o.assigned_machine_code,
  o.archived_at AS overlay_archived_at,
  o.archived_reason AS overlay_archived_reason,
  o.updated_at AS overlay_updated_at,
  o.updated_by AS overlay_updated_by,
  o.created_at AS overlay_created_at,
  o.created_by AS overlay_created_by,
  COALESCE(tr.komada_done, 0::bigint) AS komada_done,
  COALESCE(tr.real_seconds, 0::bigint) AS real_seconds,
  COALESCE(tr.is_done, false) AS is_done_in_bigtehn,
  tr.last_finished_at,
  tr.prijava_count,
  COALESCE(d.drawings_count, 0::bigint) AS drawings_count,
  (bd.drawing_no IS NOT NULL) AS has_bigtehn_drawing,
  bd.storage_path AS bigtehn_drawing_path,
  bd.size_bytes AS bigtehn_drawing_size
FROM bigtehn_work_order_lines_cache l
LEFT JOIN bigtehn_work_orders_cache wo ON wo.id = l.work_order_id
LEFT JOIN bigtehn_customers_cache c ON c.id = wo.customer_id
LEFT JOIN bigtehn_machines_cache m ON m.rj_code = l.machine_code
LEFT JOIN production_overlays o
  ON o.work_order_id = l.work_order_id AND o.line_id = l.id
LEFT JOIN LATERAL (
  SELECT sum(t.komada) AS komada_done,
         sum(t.prn_timer_seconds) AS real_seconds,
         bool_or(t.is_completed) AS is_done,
         max(t.finished_at) AS last_finished_at,
         count(*) AS prijava_count
  FROM bigtehn_tech_routing_cache t
  WHERE t.work_order_id = l.work_order_id AND t.operacija = l.operacija
) tr ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS drawings_count
  FROM production_drawings pd
  WHERE pd.work_order_id = l.work_order_id
    AND pd.line_id = l.id
    AND pd.deleted_at IS NULL
) d ON true
LEFT JOIN bigtehn_drawings_cache bd
  ON bd.drawing_no = wo.broj_crteza AND bd.removed_at IS NULL;

COMMENT ON VIEW public.v_production_operations IS
  'F.6 (H-1): shift_note maskovan kao NULL za uloge bez can_edit_plan_proizvodnje() '
  '(viewer, hr). Ostala polja netaknuta.';

-- Permisije: view nasleđuje SECURITY INVOKER + radi sa RLS politikom
-- baznih tabela; ne menjamo GRANT-ove (već su postavljeni u
-- add_v_production_operations.sql).
GRANT SELECT ON public.v_production_operations TO authenticated;
GRANT SELECT ON public.v_production_operations TO anon;
