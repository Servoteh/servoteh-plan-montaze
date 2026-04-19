-- ============================================================================
-- PLAN PROIZVODNJE — VIEW v_production_operations
-- ============================================================================
-- Pokreni JEDNOM u Supabase SQL Editoru.
--
-- Šta radi: spaja 5 tabela u jedan denormalizovani snapshot za UI:
--   bigtehn_work_order_lines_cache (l)   — operacije RN-a (po stavkama)
--   bigtehn_work_orders_cache       (wo)  — parent RN (rok, naziv dela, kupac)
--   bigtehn_customers_cache         (c)   — naziv kupca
--   bigtehn_machines_cache          (m)   — naziv mašine + flag is_non_machining
--   production_overlays             (o)   — lokalni override (status, sort, napomena, REASSIGN)
--   bigtehn_tech_routing_cache      (tr)  — agregat (urađeno komada, stvarno vreme, is_completed)
--   production_drawings             (d)   — broj aktivnih skica/slika za operaciju (Sprint F.4)
--
-- Ključne izvedene kolone:
--   effective_machine_code  = COALESCE(o.assigned_machine_code, l.machine_code)
--                             — REASSIGN-aware "na kojoj mašini je operacija TRENUTNO"
--   is_done_in_bigtehn      = postoji bilo koja prijava sa ZavrsenPostupak=true
--                             u tTehPostupak (autoritativni signal kompletiranja)
--   komada_done             = SUM(Komada) iz prijava — uvek <= komada_total iz RN-a
--   real_seconds            = SUM(PrnTimer) — stvarno vreme rada (sekundama)
--
-- Filteri za UI (typically u Service sloju):
--   WHERE effective_machine_code = '<rj_code>'
--     AND is_done_in_bigtehn = FALSE
--     AND (local_status IS NULL OR local_status <> 'completed')
--     AND overlay_archived_at IS NULL
--   ORDER BY shift_sort_order ASC NULLS LAST,
--            rok_izrade ASC NULLS LAST,
--            prioritet_bigtehn ASC
--
-- RLS: View nasleđuje politike svojih baznih tabela. Sve cache tabele
-- već imaju "read for authenticated" policy, pa view automatski radi za
-- bilo kog authenticated korisnika.
-- ============================================================================

CREATE OR REPLACE VIEW public.v_production_operations AS
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

  COALESCE(d.drawings_count, 0)                         AS drawings_count
FROM public.bigtehn_work_order_lines_cache l
LEFT JOIN public.bigtehn_work_orders_cache  wo
  ON wo.id = l.work_order_id
LEFT JOIN public.bigtehn_customers_cache    c
  ON c.id = wo.customer_id
LEFT JOIN public.bigtehn_machines_cache     m
  ON m.rj_code = l.machine_code
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
  -- Sprint F.4: broj AKTIVNIH skica (deleted_at IS NULL) za ovu operaciju.
  SELECT COUNT(*) AS drawings_count
  FROM public.production_drawings pd
  WHERE pd.work_order_id = l.work_order_id
    AND pd.line_id       = l.id
    AND pd.deleted_at IS NULL
) d ON TRUE;

-- View je automatski selectable za authenticated zbog RLS na baznim tabelama.
-- Eksplicitan GRANT za sigurnost (PostgREST treba EXECUTE/SELECT permission):
GRANT SELECT ON public.v_production_operations TO authenticated;
GRANT SELECT ON public.v_production_operations TO anon;

-- ============================================================================
-- Smoke test (opciono, odkomentariši):
-- ============================================================================
-- SELECT effective_machine_code,
--        COUNT(*)                        AS otvoreno,
--        COUNT(*) FILTER (WHERE rok_izrade <= NOW() + INTERVAL '7 days') AS hitno
-- FROM v_production_operations
-- WHERE NOT is_done_in_bigtehn
--   AND (local_status IS NULL OR local_status <> 'completed')
--   AND overlay_archived_at IS NULL
--   AND NOT rn_zavrsen
-- GROUP BY effective_machine_code
-- ORDER BY otvoreno DESC NULLS LAST
-- LIMIT 20;
