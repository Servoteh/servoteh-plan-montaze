-- ============================================================================
-- LOKACIJE — RPC: loc_tps_for_predmet (v3)
-- ----------------------------------------------------------------------------
-- Verzija 3: dve izmene u odnosu na v2 + MES aktivni RN filter:
--
-- 1) PREFIX MATCH umesto „contains" za p_tp_no i p_drawing_no.
--    Razlog: u sistemu sklopova brojevi predstavljaju hijerarhiju
--    (npr. TP "10" je sklop, "100/101" su podsklopovi, "1014/1015" su
--    pojedinačni crteži). Korisnik kuca prefiks i očekuje da vidi sve
--    pod-strukture iza tog prefiksa, NE da pretražuje pun tekst.
--      • Unos "10"  → TP-ovi koji počinju sa 10  (10, 100, 1002, 101, 1014…)
--      • Unos "101" → TP-ovi koji počinju sa 101 (101, 1014, 1015…)
--    ILIKE i dalje (case-insensitive) jer crteži mogu imati slovne sufikse.
--
-- 2) Novo polje u rezultatu: `has_pdf` (boolean).
--    LEFT JOIN sa `bigtehn_drawings_cache` na `broj_crteza` (gde
--    `removed_at IS NULL` i `storage_path IS NOT NULL`). U UI se koristi
--    za prikaz PDF ikonice pored broja crteža (klik otvara signed URL
--    preko `openDrawingPdf` iz `services/drawings.js`).
--
-- 3) Pregled koristi `v_active_bigtehn_work_orders` — ručnu MES listu
--    aktivnih RN-ova. `p_only_open` ostaje u signaturi radi kompatibilnosti,
--    ali se BigTehn `status_rn` više ne koristi kao aktivni filter.
--
-- Idempotentno: drop ako postoji bilo koja od ranijih signatura, pa CREATE
-- iste signature kao v2 (parametri se nisu menjali — samo semantika
-- match-a + dodato izlazno polje). Bez izmena drugih objekata.
-- ============================================================================

DROP FUNCTION IF EXISTS public.loc_tps_for_predmet(bigint, boolean, boolean, int, int);
DROP FUNCTION IF EXISTS public.loc_tps_for_predmet(bigint, boolean, boolean, text, text, text, int, int);

CREATE OR REPLACE FUNCTION public.loc_tps_for_predmet(
  p_item_id bigint,
  p_only_open boolean DEFAULT true,
  p_include_assembled boolean DEFAULT false,
  p_tp_no text DEFAULT NULL,
  p_drawing_no text DEFAULT NULL,
  p_location_filter text DEFAULT NULL,
  p_limit int DEFAULT 200,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_off int := GREATEST(COALESCE(p_offset, 0), 0);
  v_loc_filter text := LOWER(NULLIF(TRIM(COALESCE(p_location_filter, '')), ''));
  v_tp text := NULLIF(TRIM(COALESCE(p_tp_no, '')), '');
  v_dr text := NULLIF(TRIM(COALESCE(p_drawing_no, '')), '');
  res jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;
  IF cardinality(public.loc_auth_roles()) = 0 THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;
  IF p_item_id IS NULL THEN
    RETURN '{"total":0,"rows":[]}'::jsonb;
  END IF;
  IF v_loc_filter IS NOT NULL AND v_loc_filter NOT IN ('all', 'with', 'without') THEN
    v_loc_filter := NULL;
  END IF;

  WITH wos AS (
    SELECT
      w.id            AS work_order_id,
      w.item_id       AS item_id,
      w.ident_broj    AS wo_ident_broj,
      w.broj_crteza   AS wo_broj_crteza,
      w.naziv_dela    AS naziv_dela,
      w.materijal     AS materijal,
      w.dimenzija_materijala AS dimenzija_materijala,
      w.jedinica_mere AS jedinica_mere,
      w.komada        AS komada_rn,
      w.tezina_neobr  AS tezina_neobr,
      w.tezina_obr    AS tezina_obr,
      w.status_rn     AS status_rn,
      w.is_mes_active AS is_mes_active,
      w.zakljucano    AS zakljucano,
      w.revizija      AS revizija,
      w.rok_izrade    AS rok_izrade,
      w.modified_at   AS wo_modified_at,
      split_part(w.ident_broj, '/', 1) AS predmet_no,
      NULLIF(split_part(w.ident_broj, '/', 2), '') AS tp_no
    FROM public.v_active_bigtehn_work_orders w
    WHERE w.item_id = p_item_id
      AND w.is_mes_active IS TRUE
      -- v3: PREFIX match (LIKE 'X%') umesto „contains" — semantika hijerarhije sklopova.
      AND (v_tp IS NULL OR NULLIF(split_part(w.ident_broj, '/', 2), '') ILIKE v_tp || '%')
      AND (v_dr IS NULL OR w.broj_crteza ILIKE v_dr || '%')
  ),
  -- v3: postoji li PDF za broj crteža? Distinct po drawing_no jer u cache-u
  -- može biti više revizija — dovoljno je da bar jedna ima storage_path.
  draw_idx AS (
    SELECT DISTINCT d.drawing_no
    FROM public.bigtehn_drawings_cache d
    WHERE d.removed_at IS NULL
      AND d.storage_path IS NOT NULL
      AND d.drawing_no IN (SELECT DISTINCT wo.wo_broj_crteza FROM wos wo WHERE wo.wo_broj_crteza IS NOT NULL)
  ),
  placements AS (
    SELECT
      wo.work_order_id,
      pl.id            AS placement_id,
      pl.location_id   AS location_id,
      loc.location_code AS location_code,
      loc.name         AS location_name,
      loc.path_cached  AS location_path,
      loc.location_type AS location_type,
      loc.capacity_note AS shelf_note,
      pl.quantity      AS qty_on_location,
      pl.placement_status::text AS placement_status,
      pl.updated_at    AS placement_updated_at,
      pl.order_no      AS placement_order_no,
      pl.item_ref_id   AS placement_item_ref_id,
      pl.drawing_no    AS placement_drawing_no
    FROM wos wo
    LEFT JOIN public.loc_item_placements pl
      ON pl.quantity > 0
     AND (
       (pl.order_no = wo.predmet_no AND pl.item_ref_id = wo.tp_no)
       OR (pl.drawing_no IS NOT NULL AND wo.wo_broj_crteza IS NOT NULL
           AND trim(pl.drawing_no) = trim(wo.wo_broj_crteza))
     )
    LEFT JOIN public.loc_locations loc ON loc.id = pl.location_id
  ),
  wo_state AS (
    SELECT
      wo.work_order_id,
      COUNT(p.placement_id) FILTER (WHERE p.placement_id IS NOT NULL) AS placements_total,
      COUNT(p.placement_id) FILTER (
        WHERE p.placement_id IS NOT NULL
          AND COALESCE(p.location_type, 'SHELF') NOT IN ('ASSEMBLY', 'SCRAPPED')
      ) AS placements_active
    FROM wos wo
    LEFT JOIN placements p ON p.work_order_id = wo.work_order_id
    GROUP BY wo.work_order_id
  ),
  joined AS (
    SELECT
      wo.work_order_id,
      wo.wo_ident_broj,
      wo.wo_broj_crteza,
      wo.naziv_dela,
      wo.materijal,
      wo.dimenzija_materijala,
      wo.jedinica_mere,
      wo.komada_rn,
      wo.tezina_neobr,
      wo.tezina_obr,
      wo.status_rn,
      wo.is_mes_active,
      wo.zakljucano,
      wo.revizija,
      wo.rok_izrade,
      wo.wo_modified_at,
      wo.predmet_no,
      wo.tp_no,
      (di.drawing_no IS NOT NULL) AS has_pdf,
      st.placements_total,
      st.placements_active,
      p.placement_id,
      p.location_id,
      p.location_code,
      p.location_name,
      p.location_path,
      p.location_type,
      p.shelf_note,
      p.qty_on_location,
      p.placement_status,
      p.placement_updated_at,
      SUM(COALESCE(p.qty_on_location, 0)) OVER (PARTITION BY wo.work_order_id) AS qty_total_placed
    FROM wos wo
    LEFT JOIN placements p ON p.work_order_id = wo.work_order_id
    LEFT JOIN wo_state st ON st.work_order_id = wo.work_order_id
    LEFT JOIN draw_idx di ON di.drawing_no = wo.wo_broj_crteza
  ),
  filt AS (
    SELECT *
    FROM joined j
    WHERE
      (
        p_include_assembled
        OR j.placements_total = 0
        OR j.placements_active > 0
      )
      AND (
        p_include_assembled
        OR j.placement_id IS NULL
        OR COALESCE(j.location_type, 'SHELF') NOT IN ('ASSEMBLY', 'SCRAPPED')
      )
      AND (
        v_loc_filter IS NULL OR v_loc_filter = 'all'
        OR (v_loc_filter = 'with'    AND j.placement_id IS NOT NULL)
        OR (v_loc_filter = 'without' AND j.placement_id IS NULL)
      )
  )
  SELECT jsonb_build_object(
    'total', (SELECT COUNT(*)::bigint FROM filt),
    'rows', COALESCE((
      SELECT jsonb_agg(to_jsonb(t))
      FROM (
        SELECT * FROM filt
        ORDER BY
          wo_ident_broj ASC,
          location_code NULLS LAST,
          placement_id NULLS FIRST
        LIMIT v_lim OFFSET v_off
      ) t
    ), '[]'::jsonb)
  )
  INTO res;

  RETURN COALESCE(res, '{"total":0,"rows":[]}'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, text, text, text, int, int) IS
  'Lokacije v3: TP-ovi za jedan Predmet, sa LEFT JOIN-om ka loc_item_placements. '
  'PREFIX match na p_tp_no/p_drawing_no (hijerarhija sklopova). '
  'Polje has_pdf (boolean) iz bigtehn_drawings_cache. '
  'Vraća samo ručno aktivne MES RN-ove iz v_active_bigtehn_work_orders. '
  'Multi-row split: 1 red po (TP × placement). SECURITY INVOKER + loc_auth_roles().';

REVOKE ALL ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, text, text, text, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, text, text, text, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, text, text, text, int, int) TO authenticated;
