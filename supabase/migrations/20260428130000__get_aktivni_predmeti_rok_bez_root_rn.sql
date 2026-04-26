-- Lista aktivnih predmeta: + rok_zavrsetka iz bigtehn_items_cache; bez broj_root_rn (uklonjena kolona u UI).

CREATE OR REPLACE FUNCTION production.get_aktivni_predmeti()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, production, pg_temp
AS $$
  WITH filtered AS (
    SELECT pa.predmet_item_id AS item_id
    FROM production.predmet_aktivacija pa
    WHERE pa.je_aktivan IS TRUE
  ),
  joined AS (
    SELECT
      f.item_id,
      i.broj_predmeta,
      i.naziv_predmeta,
      i.rok_zavrsetka,
      COALESCE(
        NULLIF(trim(both ' ' FROM c.name), ''),
        NULLIF(trim(both ' ' FROM c.short_name), ''),
        ''
      ) AS customer_name,
      p.sort_priority
    FROM filtered f
    INNER JOIN public.bigtehn_items_cache i ON i.id = f.item_id
    LEFT JOIN public.bigtehn_customers_cache c ON c.id = i.customer_id
    LEFT JOIN production.predmet_prioritet p ON p.predmet_item_id = f.item_id
  ),
  ranked AS (
    SELECT
      j.*,
      row_number() OVER (
        ORDER BY j.sort_priority ASC NULLS LAST, j.broj_predmeta ASC NULLS LAST
      )::integer AS redni_broj
    FROM joined j
  )
  SELECT COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'item_id', r.item_id,
          'broj_predmeta', COALESCE(r.broj_predmeta, ''),
          'naziv_predmeta', COALESCE(r.naziv_predmeta, ''),
          'customer_name', COALESCE(r.customer_name, ''),
          'rok_zavrsetka', to_jsonb(r.rok_zavrsetka),
          'sort_priority', r.sort_priority,
          'redni_broj', r.redni_broj
        )
        ORDER BY r.sort_priority ASC NULLS LAST, r.broj_predmeta ASC NULLS LAST
      )
      FROM ranked r
    ),
    '[]'::jsonb
  );
$$;

COMMENT ON FUNCTION production.get_aktivni_predmeti() IS
  'Aktivni predmeti: predmet_aktivacija.je_aktivan; polja uklj. rok_zavrsetka iz bigtehn_items_cache; sort prioritet, broj predmeta.';

NOTIFY pgrst, 'reload schema';
