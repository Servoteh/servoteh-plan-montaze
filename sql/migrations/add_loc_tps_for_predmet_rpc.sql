-- ============================================================================
-- LOKACIJE — RPC: loc_tps_for_predmet
-- ----------------------------------------------------------------------------
-- Vraća sve tehnološke postupke (RN-ove) iz `bigtehn_work_orders_cache`
-- koji pripadaju jednom predmetu (`bigtehn_items_cache.id`), sa LEFT JOIN-om
-- ka aktuelnim placement-ima (`loc_item_placements`) i lokacijama
-- (`loc_locations`).
--
-- Pravila:
--   • Jedan red po (TP × placement). Ako TP nema placement → 1 red sa
--     praznim location_*. Ako TP ima placement-e na više polica/regala →
--     onoliko redova koliko ima placement-a (po zahtevu korisnika: nemoj
--     sabirati količine na više lokacija u jedan red).
--   • Po default-u skriva TP-ove čiji su SVI placement-i na lokaciji tipa
--     `ASSEMBLY` (UGRADJENO) ili `SCRAPPED` (OTPISANO) — to su završene
--     stavke koje više nisu u radu.
--   • `p_include_assembled = true` → vraća i ugrađene/otpisane TP-ove
--     (checkbox „Prikaži i ugrađene/otpisane" u UI).
--   • `p_only_open = true` (default) → samo TP-ovi sa `status_rn = false`
--     (otvoreni RN-ovi u BigTehn-u). `p_only_open = false` → svi.
--   • Security: SECURITY INVOKER + auth.uid() guard + loc_auth_roles().
--
-- Idempotentno (CREATE OR REPLACE iste signature). Bez izmena postojećih
-- tabela ili RPC-ova.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.loc_tps_for_predmet(
  p_item_id bigint,
  p_only_open boolean DEFAULT true,
  p_include_assembled boolean DEFAULT false,
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
      w.zakljucano    AS zakljucano,
      w.revizija      AS revizija,
      w.rok_izrade    AS rok_izrade,
      w.modified_at   AS wo_modified_at,
      split_part(w.ident_broj, '/', 1) AS predmet_no,
      NULLIF(split_part(w.ident_broj, '/', 2), '') AS tp_no
    FROM public.bigtehn_work_orders_cache w
    WHERE w.item_id = p_item_id
      AND (NOT p_only_open OR w.status_rn IS NOT TRUE)
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
  -- Markiraj TP-ove kod kojih su SVI postojeći placement-i na ASSEMBLY/SCRAPPED.
  -- Takvi su „završeni" i kriju se po default-u (osim ako p_include_assembled = true).
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
      wo.zakljucano,
      wo.revizija,
      wo.rok_izrade,
      wo.wo_modified_at,
      wo.predmet_no,
      wo.tp_no,
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
      -- Suma na lokaciji preko svih placement-a istog (predmet/tp). Ako bude
      -- razlika sa komada_rn → korisniku je vidljivo „raspoređeno X / RN Y".
      SUM(COALESCE(p.qty_on_location, 0)) OVER (PARTITION BY wo.work_order_id) AS qty_total_placed
    FROM wos wo
    LEFT JOIN placements p ON p.work_order_id = wo.work_order_id
    LEFT JOIN wo_state st ON st.work_order_id = wo.work_order_id
  ),
  filt AS (
    SELECT *
    FROM joined j
    WHERE
      -- 1) Sakrij čitav TP ako su SVI placement-i na ASSEMBLY/SCRAPPED i nije tražen include_assembled.
      (
        p_include_assembled
        OR j.placements_total = 0                       -- nema placement-a → ostaje (prazna lokacija)
        OR j.placements_active > 0                      -- ima bar jedan aktivan placement → ostaje
      )
      -- 2) Sakrij pojedinačni red ako je placement na ASSEMBLY/SCRAPPED i nije tražen include_assembled.
      AND (
        p_include_assembled
        OR j.placement_id IS NULL
        OR COALESCE(j.location_type, 'SHELF') NOT IN ('ASSEMBLY', 'SCRAPPED')
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

COMMENT ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, int, int) IS
  'Lokacije: svi TP-ovi (RN) za jedan Predmet, sa LEFT JOIN-om ka loc_item_placements. '
  'Po default-u skriva TP-ove čiji su SVI placement-i na ASSEMBLY/SCRAPPED. '
  'Multi-row split: 1 red po (TP × placement). SECURITY INVOKER + loc_auth_roles().';

REVOKE ALL ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, int, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.loc_tps_for_predmet(bigint, boolean, boolean, int, int) TO authenticated;
