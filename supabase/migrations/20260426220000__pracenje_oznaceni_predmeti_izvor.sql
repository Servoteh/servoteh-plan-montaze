-- =============================================================================
-- Izvor za „aktivne predmete" u Praćenju: ručno obeleženi (whitelist), ne
-- distinct item_id iz v_active_bigtehn_work_orders.
-- Tabela: production.pracenje_oznaceni_predmeti
-- Ažurirano: get_aktivni_predmeti, set_predmet_prioritet, shift_predmet_prioritet
-- Novo: pracenje_oznaci_predmet, pracenje_ukloni_oznaku (admin)
-- =============================================================================

CREATE TABLE IF NOT EXISTS production.pracenje_oznaceni_predmeti (
  predmet_item_id integer PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id)
);

COMMENT ON TABLE production.pracenje_oznaceni_predmeti IS
  'Predmeti koje ekipa uključuje u ekran 1 Praćenja. Nezavisno od MES liste aktivnih RN-ova.';

CREATE INDEX IF NOT EXISTS pracenje_oznaceni_predmeti_created_at_idx
  ON production.pracenje_oznaceni_predmeti (created_at DESC);

ALTER TABLE production.pracenje_oznaceni_predmeti ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pracenje_oznaceni_select_authenticated ON production.pracenje_oznaceni_predmeti;
CREATE POLICY pracenje_oznaceni_select_authenticated
  ON production.pracenje_oznaceni_predmeti FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS pracenje_oznaceni_insert_admin ON production.pracenje_oznaceni_predmeti;
CREATE POLICY pracenje_oznaceni_insert_admin
  ON production.pracenje_oznaceni_predmeti FOR INSERT
  TO authenticated
  WITH CHECK (public.current_user_is_admin());

DROP POLICY IF EXISTS pracenje_oznaceni_delete_admin ON production.pracenje_oznaceni_predmeti;
CREATE POLICY pracenje_oznaceni_delete_admin
  ON production.pracenje_oznaceni_predmeti FOR DELETE
  TO authenticated
  USING (public.current_user_is_admin());

GRANT SELECT, INSERT, DELETE ON production.pracenje_oznaceni_predmeti TO authenticated;

-- ---------------------------------------------------------------------------
-- get_aktivni_predmeti: baza = pracenje_oznaceni_predmeti
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION production.get_aktivni_predmeti()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, production, pg_temp
AS $$
  WITH base AS (
    SELECT o.predmet_item_id::integer AS item_id
    FROM production.pracenje_oznaceni_predmeti o
  ),
  joined AS (
    SELECT
      b.item_id,
      i.broj_predmeta,
      i.naziv_predmeta,
      COALESCE(
        NULLIF(trim(both ' ' FROM c.name), ''),
        NULLIF(trim(both ' ' FROM c.short_name), ''),
        ''
      ) AS customer_name,
      p.sort_priority,
      COALESCE(rc.root_count, 0)::integer AS broj_root_rn
    FROM base b
    INNER JOIN public.bigtehn_items_cache i ON i.id = b.item_id
    LEFT JOIN public.bigtehn_customers_cache c ON c.id = i.customer_id
    LEFT JOIN production.predmet_prioritet p ON p.predmet_item_id = b.item_id
    LEFT JOIN public.v_bigtehn_rn_root_count rc ON rc.predmet_item_id = b.item_id::bigint
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
          'sort_priority', r.sort_priority,
          'broj_root_rn', r.broj_root_rn,
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
  'Lista predmeta u Praćenju: oni u pracenje_oznaceni_predmeti, sort: '
  'sort_priority ASC NULLS LAST, broj_predmeta ASC; redni_broj 1..N.';

-- ---------------------------------------------------------------------------
-- set_predmet_prioritet: samo za već obeležene
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION production.set_predmet_prioritet(
  p_item_id integer,
  p_sort_priority integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, production, pg_temp
AS $$
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_sort_priority < 0 THEN
    RAISE EXCEPTION 'sort_priority must be >= 0' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM production.pracenje_oznaceni_predmeti w WHERE w.predmet_item_id = p_item_id
  ) THEN
    RAISE EXCEPTION 'predmet nije u listi obeleženih za praćenje' USING ERRCODE = '23514';
  END IF;

  INSERT INTO production.predmet_prioritet (predmet_item_id, sort_priority, updated_by, updated_at)
  VALUES (p_item_id, p_sort_priority, auth.uid(), now())
  ON CONFLICT (predmet_item_id) DO UPDATE SET
    sort_priority = EXCLUDED.sort_priority,
    updated_by = auth.uid(),
    updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- shift_predmet_prioritet: redosled među pracenje_oznaceni_predmeti
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION production.shift_predmet_prioritet(
  p_item_id integer,
  p_direction text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, production, pg_temp
AS $$
DECLARE
  dir text := lower(trim(p_direction));
  items integer[];
  pos int;
  n int;
  neighbor_pos int;
  tmp int;
  i int;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF dir NOT IN ('up', 'down') THEN
    RAISE EXCEPTION 'invalid direction' USING ERRCODE = '22000';
  END IF;

  SELECT coalesce(array_agg(sub.item_id ORDER BY sub.sp NULLS LAST, sub.bp ASC NULLS LAST), ARRAY[]::integer[])
  INTO items
  FROM (
    SELECT
      b.item_id,
      p.sort_priority AS sp,
      i.broj_predmeta AS bp
    FROM (
      SELECT o.predmet_item_id::integer AS item_id
      FROM production.pracenje_oznaceni_predmeti o
    ) b
    INNER JOIN public.bigtehn_items_cache i ON i.id = b.item_id
    LEFT JOIN production.predmet_prioritet p ON p.predmet_item_id = b.item_id
  ) sub;

  n := coalesce(array_length(items, 1), 0);
  IF n = 0 THEN
    RETURN;
  END IF;

  pos := array_position(items, p_item_id);
  IF pos IS NULL THEN
    RETURN;
  END IF;

  neighbor_pos := pos + CASE WHEN dir = 'up' THEN -1 ELSE 1 END;
  IF neighbor_pos < 1 OR neighbor_pos > n THEN
    RETURN;
  END IF;

  tmp := items[pos];
  items[pos] := items[neighbor_pos];
  items[neighbor_pos] := tmp;

  FOR i IN 1..n LOOP
    INSERT INTO production.predmet_prioritet (predmet_item_id, sort_priority, updated_by, updated_at)
    VALUES (items[i], i - 1, auth.uid(), now())
    ON CONFLICT (predmet_item_id) DO UPDATE SET
      sort_priority = EXCLUDED.sort_priority,
      updated_by = auth.uid(),
      updated_at = now();
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Admin: uključi / isključi predmet
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION production.pracenje_oznaci_predmet(p_item_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, production, pg_temp
AS $$
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_item_id IS NULL OR p_item_id <= 0 THEN
    RAISE EXCEPTION 'invalid p_item_id' USING ERRCODE = '22000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bigtehn_items_cache i WHERE i.id = p_item_id) THEN
    RAISE EXCEPTION 'nepoznat predmet (nema u bigtehn_items_cache)' USING ERRCODE = '22000';
  END IF;

  INSERT INTO production.pracenje_oznaceni_predmeti (predmet_item_id, created_by, created_at)
  VALUES (p_item_id, auth.uid(), now())
  ON CONFLICT (predmet_item_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION production.pracenje_ukloni_oznaku(p_item_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, production, pg_temp
AS $$
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_item_id IS NULL OR p_item_id <= 0 THEN
    RAISE EXCEPTION 'invalid p_item_id' USING ERRCODE = '22000';
  END IF;

  DELETE FROM production.predmet_prioritet WHERE predmet_item_id = p_item_id;
  DELETE FROM production.pracenje_oznaceni_predmeti WHERE predmet_item_id = p_item_id;
END;
$$;

GRANT EXECUTE ON FUNCTION production.pracenje_oznaci_predmet(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION production.pracenje_ukloni_oznaku(integer) TO authenticated;

-- Public (PostgREST)
CREATE OR REPLACE FUNCTION public.pracenje_oznaci_predmet(p_item_id integer)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.pracenje_oznaci_predmet(p_item_id);
$$;

CREATE OR REPLACE FUNCTION public.pracenje_ukloni_oznaku(p_item_id integer)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.pracenje_ukloni_oznaku(p_item_id);
$$;

GRANT EXECUTE ON FUNCTION public.pracenje_oznaci_predmet(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pracenje_ukloni_oznaku(integer) TO authenticated;

NOTIFY pgrst, 'reload schema';
