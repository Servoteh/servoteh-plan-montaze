-- ============================================================================
-- Praćenje proizvodnje — izveštaj po predmetu / sklopu + korisničke napomene
-- Jedan read RPC za ekran + Excel + PDF; napomene u production šemi sa RLS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Finalna kontrola: ista logika za BigTehn linije (prioritet: KK / 8.3 / naziv)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION production._pracenje_line_is_final_control(
  p_machine_code text,
  p_machine_name text,
  p_no_procedure boolean
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, production, pg_temp
AS $$
  SELECT
    (p_machine_code IS NOT NULL AND p_machine_code ~ '^8\.3')
    OR (
      COALESCE(p_no_procedure, false)
      AND COALESCE(p_machine_name, '') ~* '(zavr|final|zav\.\s*kontr|zavrsna|kontrol)'
    );
$$;

COMMENT ON FUNCTION production._pracenje_line_is_final_control(text, text, boolean) IS
  'Heuristika završne kontrole na BigTehn stavci: RJ 8.3* ili no_procedure mašina sa nazivom kontrole.';

-- ----------------------------------------------------------------------------
-- Tabela napomena (stabilan ključ: predmet_item_id + bigtehn_rn_id)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production.pracenje_proizvodnje_napomene (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  predmet_item_id integer NOT NULL,
  bigtehn_rn_id bigint NOT NULL,
  rn_id uuid REFERENCES production.radni_nalog(id) ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pracenje_nap_unique_predmet_rn UNIQUE (predmet_item_id, bigtehn_rn_id)
);

CREATE INDEX IF NOT EXISTS pracenje_nap_predmet_idx
  ON production.pracenje_proizvodnje_napomene (predmet_item_id);

COMMENT ON TABLE production.pracenje_proizvodnje_napomene IS
  'Korisničke napomene po čvoru stabla RN (BigTehn IDRN); ne piše se u BigTehn cache.';

ALTER TABLE production.pracenje_proizvodnje_napomene ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pracenje_nap_select_auth ON production.pracenje_proizvodnje_napomene;
CREATE POLICY pracenje_nap_select_auth
  ON production.pracenje_proizvodnje_napomene FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS pracenje_nap_insert_managers ON production.pracenje_proizvodnje_napomene;
CREATE POLICY pracenje_nap_insert_managers
  ON production.pracenje_proizvodnje_napomene FOR INSERT
  TO authenticated
  WITH CHECK (public.can_manage_predmet_aktivacija());

DROP POLICY IF EXISTS pracenje_nap_update_managers ON production.pracenje_proizvodnje_napomene;
CREATE POLICY pracenje_nap_update_managers
  ON production.pracenje_proizvodnje_napomene FOR UPDATE
  TO authenticated
  USING (public.can_manage_predmet_aktivacija())
  WITH CHECK (public.can_manage_predmet_aktivacija());

DROP POLICY IF EXISTS pracenje_nap_delete_managers ON production.pracenje_proizvodnje_napomene;
CREATE POLICY pracenje_nap_delete_managers
  ON production.pracenje_proizvodnje_napomene FOR DELETE
  TO authenticated
  USING (public.can_manage_predmet_aktivacija());

GRANT SELECT, INSERT, UPDATE, DELETE ON production.pracenje_proizvodnje_napomene TO authenticated;

-- ----------------------------------------------------------------------------
-- Upsert napomene (samo admin + menadžment)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION production.upsert_pracenje_proizvodnje_napomena(
  p_predmet_item_id integer,
  p_bigtehn_rn_id bigint,
  p_note text,
  p_rn_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, production, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_note text := coalesce(p_note, '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Moraš biti ulogovan' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_manage_predmet_aktivacija() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_predmet_item_id IS NULL OR p_predmet_item_id <= 0 OR p_bigtehn_rn_id IS NULL OR p_bigtehn_rn_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan predmet ili RN' USING ERRCODE = '22000';
  END IF;

  INSERT INTO production.pracenje_proizvodnje_napomene (
    predmet_item_id, bigtehn_rn_id, rn_id, note, created_by, updated_by
  )
  VALUES (
    p_predmet_item_id, p_bigtehn_rn_id, p_rn_id, v_note, auth.uid(), auth.uid()
  )
  ON CONFLICT (predmet_item_id, bigtehn_rn_id) DO UPDATE SET
    note = EXCLUDED.note,
    rn_id = COALESCE(EXCLUDED.rn_id, production.pracenje_proizvodnje_napomene.rn_id),
    updated_by = auth.uid(),
    updated_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION production.upsert_pracenje_proizvodnje_napomena(integer, bigint, text, uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- Glavni izveštaj (read-only, bez ensure_radni_nalog)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION production.get_predmet_pracenje_izvestaj(
  p_predmet_item_id integer,
  p_root_rn_id bigint DEFAULT NULL,
  p_lot_qty integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, production, core, pg_temp
AS $$
DECLARE
  v_lot int := CASE
    WHEN p_lot_qty IS NULL OR p_lot_qty <= 0 THEN 12
    ELSE least(greatest(p_lot_qty, 1), 100000)
  END;
  v_item public.bigtehn_items_cache%ROWTYPE;
  v_customer_name text := '';
  v_root jsonb := NULL;
  v_rows jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_generated timestamptz := now();
BEGIN
  IF p_predmet_item_id IS NULL OR p_predmet_item_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan predmet_item_id' USING ERRCODE = '22000';
  END IF;

  SELECT * INTO v_item FROM public.bigtehn_items_cache i WHERE i.id = p_predmet_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Predmet % nije u kešu', p_predmet_item_id USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE(
    nullif(trim(both ' ' FROM c.name), ''),
    nullif(trim(both ' ' FROM c.short_name), ''),
    ''
  )
  INTO v_customer_name
  FROM public.bigtehn_customers_cache c
  WHERE c.id = v_item.customer_id;

  IF p_root_rn_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'node_id', s.rn_id,
      'naziv', coalesce(nullif(trim(both ' ' FROM w.naziv_dela), ''), w.ident_broj::text),
      'broj_crteza', coalesce(nullif(trim(both ' ' FROM w.broj_crteza::text), ''), ''),
      'tip', CASE WHEN s.nivo <= 0 THEN 'sklop' ELSE 'podsklop' END
    )
    INTO v_root
    FROM public.v_bigtehn_rn_struktura s
    INNER JOIN public.bigtehn_work_orders_cache w ON w.id = s.rn_id
    WHERE s.predmet_item_id = p_predmet_item_id::bigint
      AND s.rn_id = p_root_rn_id
    LIMIT 1;
    IF v_root IS NULL THEN
      RAISE EXCEPTION 'Koren RN % nije u strukturi predmeta %', p_root_rn_id, p_predmet_item_id
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  WITH
  nodes AS (
    SELECT s.predmet_item_id, s.root_rn_id, s.rn_id, s.parent_rn_id, s.nivo, s.broj_komada, s.path_idrn
    FROM public.v_bigtehn_rn_struktura s
    WHERE s.predmet_item_id = p_predmet_item_id::bigint
      AND p_root_rn_id IS NULL

    UNION ALL

    SELECT d.predmet_item_id, d.root_rn_id, d.rn_id, d.parent_rn_id, d.nivo, d.broj_komada, d.path_idrn
    FROM (
      WITH RECURSIVE descendants AS (
        SELECT s0.predmet_item_id, s0.root_rn_id, s0.rn_id, s0.parent_rn_id, s0.nivo, s0.broj_komada, s0.path_idrn
        FROM public.v_bigtehn_rn_struktura s0
        WHERE s0.predmet_item_id = p_predmet_item_id::bigint
          AND s0.rn_id = p_root_rn_id
        UNION ALL
        SELECT s1.predmet_item_id, s1.root_rn_id, s1.rn_id, s1.parent_rn_id, s1.nivo, s1.broj_komada, s1.path_idrn
        FROM public.v_bigtehn_rn_struktura s1
        INNER JOIN descendants dx ON s1.parent_rn_id = dx.rn_id
          AND s1.predmet_item_id = dx.predmet_item_id
          AND s1.root_rn_id = dx.root_rn_id
      )
      SELECT * FROM descendants
    ) d
    WHERE p_root_rn_id IS NOT NULL
  ),
  nodes_dedup AS (
    SELECT DISTINCT ON (rn_id) *
    FROM nodes
    ORDER BY rn_id, nivo
  ),
  wo_join AS (
    SELECT
      n.*,
      w.ident_broj,
      w.broj_crteza,
      w.naziv_dela,
      w.materijal,
      w.dimenzija_materijala,
      w.komada,
      w.rok_izrade,
      w.status_rn,
      w.datum_unosa,
      w.napomena AS wo_napomena
    FROM nodes_dedup n
    INNER JOIN public.bigtehn_work_orders_cache w ON w.id = n.rn_id
  ),
  parent_wo AS (
    SELECT
      j.*,
      pw.broj_crteza AS parent_broj_crteza
    FROM wo_join j
    LEFT JOIN public.bigtehn_work_orders_cache pw ON pw.id = j.parent_rn_id
  ),
  rn_local AS (
    SELECT r.id AS rn_uuid, r.legacy_idrn::bigint AS bigtehn_id
    FROM production.radni_nalog r
    WHERE r.legacy_idrn IS NOT NULL
  ),
  line_agg AS (
    SELECT
      l.work_order_id,
      jsonb_agg(
        jsonb_build_object(
          'operation_id', l.id::text,
          'redosled', l.prioritet,
          'naziv', l.operacija::text,
          'masina', coalesce(m.name, l.machine_code, ''),
          'planned_qty', wc.komada,
          'completed_qty', COALESCE(tr.sum_kom, 0),
          'completed_at', tr.last_fin,
          'is_final_control', production._pracenje_line_is_final_control(
            l.machine_code, m.name, m.no_procedure
          ),
          'kontrola_status', CASE
            WHEN production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
            THEN CASE
              WHEN COALESCE(tr.sum_kom_done, 0) > 0 THEN 'urađeno'
              ELSE 'nije prijavljeno'
            END
            ELSE ''
          END
        )
        ORDER BY l.prioritet NULLS LAST, l.id
      ) AS operations,
      bool_or(production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)) AS has_final_line
    FROM public.bigtehn_work_order_lines_cache l
    INNER JOIN nodes_dedup nd ON nd.rn_id = l.work_order_id
    INNER JOIN public.bigtehn_work_orders_cache wc ON wc.id = l.work_order_id
    LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(sum(t.komada) FILTER (WHERE t.is_completed), 0)::numeric AS sum_kom_done,
        COALESCE(sum(t.komada), 0)::numeric AS sum_kom,
        max(t.finished_at) FILTER (WHERE t.is_completed) AS last_fin
      FROM public.bigtehn_tech_routing_cache t
      WHERE t.work_order_id = l.work_order_id
        AND t.operacija = l.operacija
        AND t.machine_code IS NOT DISTINCT FROM l.machine_code
    ) tr ON true
    GROUP BY l.work_order_id
  ),
  final_qty_bt AS (
    SELECT
      pw3.rn_id,
      COALESCE((
        SELECT sum(t.komada)::numeric
        FROM public.bigtehn_work_order_lines_cache l
        INNER JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
        INNER JOIN public.bigtehn_tech_routing_cache t
          ON t.work_order_id = l.work_order_id
         AND t.operacija = l.operacija
         AND t.machine_code IS NOT DISTINCT FROM l.machine_code
         AND t.is_completed IS TRUE
        WHERE l.work_order_id = pw3.rn_id
          AND production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
      ), NULL) AS zavrsena_bigtehn
    FROM parent_wo pw3
  ),
  final_qty_local AS (
    SELECT
      rl.bigtehn_id AS rn_id,
      (
        SELECT vpp.prijavljeno_komada
        FROM production.tp_operacija tp
        INNER JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id = tp.id
        LEFT JOIN core.work_center wc ON wc.id = tp.work_center_id
        LEFT JOIN core.odeljenje od ON od.id = wc.odeljenje_id
        WHERE tp.radni_nalog_id = rl.rn_uuid
          AND (
            od.kod = 'KK'
            OR tp.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)'
          )
        ORDER BY
          CASE WHEN od.kod = 'KK' THEN 0 ELSE 1 END,
          tp.prioritet ASC NULLS LAST
        LIMIT 1
      ) AS zavrsena_local
    FROM rn_local rl
  ),
  ops_local AS (
    SELECT
      rl.bigtehn_id AS rn_id,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'operation_id', tp.id::text,
            'redosled', tp.prioritet,
            'naziv', tp.naziv,
            'masina', coalesce(wc.kod, ''),
            'planned_qty', coalesce(vpp.planirano_komada, rnp.kolicina_plan),
            'completed_qty', coalesce(vpp.prijavljeno_komada, 0),
            'completed_at', vpp.poslednja_prijava_at,
            'is_final_control',
              (od.kod = 'KK' OR tp.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)'),
            'kontrola_status', vpp.auto_status::text
          )
          ORDER BY tp.prioritet NULLS LAST, tp.operacija_kod
        )
        FROM production.tp_operacija tp
        INNER JOIN production.radni_nalog_pozicija rnp ON rnp.id = tp.radni_nalog_pozicija_id
        LEFT JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id = tp.id
        LEFT JOIN core.work_center wc ON wc.id = tp.work_center_id
        LEFT JOIN core.odeljenje od ON od.id = wc.odeljenje_id
        WHERE tp.radni_nalog_id = rl.rn_uuid
      ), '[]'::jsonb) AS operations,
      EXISTS (
        SELECT 1
        FROM production.tp_operacija tp2
        LEFT JOIN core.work_center wc2 ON wc2.id = tp2.work_center_id
        LEFT JOIN core.odeljenje od2 ON od2.id = wc2.odeljenje_id
        WHERE tp2.radni_nalog_id = rl.rn_uuid
          AND (
            od2.kod = 'KK'
            OR tp2.naziv ~* '(zavr|final|zav\.?\s*kontr|zavrsna|kontrol)'
          )
      ) AS has_final_line
    FROM rn_local rl
  ),
  merged AS (
    SELECT
      pw.rn_id,
      pw.parent_rn_id,
      pw.nivo,
      pw.broj_komada,
      pw.path_idrn,
      pw.ident_broj,
      pw.broj_crteza,
      pw.naziv_dela,
      pw.materijal,
      pw.dimenzija_materijala,
      pw.komada,
      pw.rok_izrade,
      pw.status_rn,
      pw.datum_unosa,
      pw.wo_napomena,
      pw.parent_broj_crteza,
      rl.rn_uuid,
      CASE
        WHEN rl.rn_uuid IS NOT NULL THEN coalesce(ol.operations, '[]'::jsonb)
        ELSE coalesce(la.operations, '[]'::jsonb)
      END AS operations,
      CASE
        WHEN rl.rn_uuid IS NOT NULL THEN coalesce(ol.has_final_line, false)
        ELSE coalesce(la.has_final_line, false)
      END AS has_final_line,
      CASE
        WHEN rl.rn_uuid IS NOT NULL AND fl.zavrsena_local IS NOT NULL THEN fl.zavrsena_local
        WHEN fb.zavrsena_bigtehn IS NOT NULL THEN fb.zavrsena_bigtehn
        ELSE NULL
      END AS zavrsena_kolicina,
      nap.note AS korisnicka_napomena
    FROM parent_wo pw
    LEFT JOIN rn_local rl ON rl.bigtehn_id = pw.rn_id
    LEFT JOIN line_agg la ON la.work_order_id = pw.rn_id
    LEFT JOIN ops_local ol ON ol.rn_id = pw.rn_id
    LEFT JOIN final_qty_bt fb ON fb.rn_id = pw.rn_id
    LEFT JOIN final_qty_local fl ON fl.rn_id = pw.rn_id
    LEFT JOIN production.pracenje_proizvodnje_napomene nap
      ON nap.predmet_item_id = p_predmet_item_id
     AND nap.bigtehn_rn_id = pw.rn_id
  ),
  with_calc AS (
    SELECT
      m.*,
      CASE
        WHEN m.broj_komada IS NOT NULL AND m.broj_komada > 0 THEN m.broj_komada::numeric
        ELSE NULL
      END AS qty_per_assembly,
      CASE
        WHEN m.broj_komada IS NOT NULL AND m.broj_komada > 0
        THEN (m.broj_komada::numeric * v_lot)
        ELSE NULL
      END AS required_for_lot,
      EXISTS (
        SELECT 1
        FROM public.bigtehn_drawings_cache d
        WHERE d.removed_at IS NULL
          AND d.drawing_no = nullif(trim(both ' ' FROM split_part(m.broj_crteza::text, '_', 1)), '')
      ) AS has_crtez_file
    FROM merged m
  ),
  rows_json AS (
    SELECT jsonb_agg(
      jsonb_build_object(
        'row_id', p_predmet_item_id::text || ':' || w.rn_id::text,
        'node_id', w.rn_id,
        'parent_node_id', w.parent_rn_id,
        'level', w.nivo,
        'sort_order', row_number() OVER (
          PARTITION BY w.parent_rn_id, w.root_rn_id
          ORDER BY w.ident_broj ASC NULLS LAST
        ),
        'tip_reda', 'rn',
        'naziv_pozicije', coalesce(nullif(trim(both ' ' FROM w.naziv_dela), ''), w.ident_broj::text),
        'broj_crteza', coalesce(nullif(trim(both ' ' FROM w.broj_crteza::text), ''), ''),
        'broj_sklopnog_crteza', coalesce(nullif(trim(both ' ' FROM w.parent_broj_crteza::text), ''), ''),
        'crtez_url', NULL,
        'sklop_url', NULL,
        'crtez_drawing_no', nullif(trim(both ' ' FROM split_part(w.broj_crteza::text, '_', 1)), ''),
        'sklop_drawing_no', nullif(trim(both ' ' FROM split_part(w.parent_broj_crteza::text, '_', 1)), ''),
        'has_crtez_file', w.has_crtez_file,
        'has_skop_crtez_file', EXISTS (
          SELECT 1 FROM public.bigtehn_drawings_cache d
          WHERE d.removed_at IS NULL
            AND w.parent_broj_crteza IS NOT NULL
            AND d.drawing_no = nullif(trim(both ' ' FROM split_part(w.parent_broj_crteza::text, '_', 1)), '')
        ),
        'rn_id', w.rn_uuid,
        'rn_broj', w.ident_broj::text,
        'qty_per_assembly', w.qty_per_assembly,
        'lansirana_kolicina', w.komada,
        'required_for_lot', w.required_for_lot,
        'zavrsena_kolicina', w.zavrsena_kolicina,
        'raspolozivo_za_montazu', w.zavrsena_kolicina,
        'kompletirano_za_lot', CASE
          WHEN w.required_for_lot IS NULL OR w.zavrsena_kolicina IS NULL THEN NULL
          ELSE least(w.zavrsena_kolicina, w.required_for_lot)
        END,
        'datum_lansiranja_tp', (w.datum_unosa AT TIME ZONE 'UTC')::date,
        'datum_izrade', (w.rok_izrade AT TIME ZONE 'UTC')::date,
        'masinska_obrada_status', (
          SELECT string_agg(
            coalesce(m.name, l.machine_code) || ': ' ||
            CASE WHEN COALESCE(tr.done, 0) > 0 THEN 'urađeno' ELSE 'otvoreno' END,
            '; ' ORDER BY l.prioritet NULLS LAST
          )
          FROM public.bigtehn_work_order_lines_cache l
          LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(t.komada) FILTER (WHERE t.is_completed), 0)::numeric AS done
            FROM public.bigtehn_tech_routing_cache t
            WHERE t.work_order_id = l.work_order_id
              AND t.operacija = l.operacija
              AND t.machine_code IS NOT DISTINCT FROM l.machine_code
          ) tr ON true
          WHERE l.work_order_id = w.rn_id
            AND coalesce(m.no_procedure, false) IS FALSE
          LIMIT 4
        ),
        'povrsinska_zastita_status', (
          SELECT string_agg(
            coalesce(m.name, l.machine_code) || ': ' ||
            CASE WHEN COALESCE(tr.done, 0) > 0 THEN 'urađeno' ELSE 'otvoreno' END,
            '; ' ORDER BY l.prioritet NULLS LAST
          )
          FROM public.bigtehn_work_order_lines_cache l
          LEFT JOIN public.bigtehn_machines_cache m ON m.rj_code = l.machine_code
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(t.komada) FILTER (WHERE t.is_completed), 0)::numeric AS done
            FROM public.bigtehn_tech_routing_cache t
            WHERE t.work_order_id = l.work_order_id
              AND t.operacija = l.operacija
              AND t.machine_code IS NOT DISTINCT FROM l.machine_code
          ) tr ON true
          WHERE l.work_order_id = w.rn_id
            AND coalesce(m.no_procedure, false) IS TRUE
            AND NOT production._pracenje_line_is_final_control(l.machine_code, m.name, m.no_procedure)
          LIMIT 4
        ),
        'materijal', coalesce(w.materijal, ''),
        'dimenzije', coalesce(w.dimenzija_materijala, ''),
        'sistemska_napomena', coalesce(w.wo_napomena, ''),
        'korisnicka_napomena', coalesce(w.korisnicka_napomena, ''),
        'statusi', jsonb_build_object(
          'kasni', CASE
            WHEN w.rok_izrade IS NULL THEN false
            WHEN (w.rok_izrade AT TIME ZONE 'UTC')::date < (current_timestamp AT TIME ZONE 'Europe/Belgrade')::date
              AND coalesce(w.zavrsena_kolicina, 0) < coalesce(w.komada, 0)
            THEN true
            ELSE false
          END,
          'nema_tp', CASE
            WHEN w.broj_crteza IS NULL OR trim(both ' ' FROM w.broj_crteza::text) = '' THEN true
            ELSE false
          END,
          'nema_crtez', NOT w.has_crtez_file,
          'nema_zavrsnu_kontrolu', NOT w.has_final_line,
          'nije_kompletirano', CASE
            WHEN w.komada IS NULL THEN false
            WHEN coalesce(w.zavrsena_kolicina, 0) < w.komada THEN true
            ELSE false
          END,
          'nema_rn', w.rn_uuid IS NULL
        ),
        'operations', w.operations
      )
      ORDER BY w.root_rn_id, w.path_idrn
    ) AS arr
    FROM with_calc w
  )
  SELECT coalesce(arr, '[]'::jsonb) INTO v_rows FROM rows_json;

  SELECT jsonb_build_object(
    'total_rows', (SELECT count(*)::int FROM jsonb_array_elements(v_rows)),
    'total_lansirano', (
      SELECT coalesce(sum((e->>'lansirana_kolicina')::numeric), 0) FROM jsonb_array_elements(v_rows) e
    ),
    'total_zavrseno', (
      SELECT coalesce(sum((e->>'zavrsena_kolicina')::numeric), 0) FROM jsonb_array_elements(v_rows) e
      WHERE e ? 'zavrsena_kolicina' AND e->>'zavrsena_kolicina' IS NOT NULL
    ),
    'count_nije_kompletirano', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nije_kompletirano')::boolean IS TRUE
    ),
    'count_nema_tp', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nema_tp')::boolean IS TRUE
    ),
    'count_nema_crtez', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nema_crtez')::boolean IS TRUE
    ),
    'count_nema_zavrsnu_kontrolu', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'nema_zavrsnu_kontrolu')::boolean IS TRUE
    ),
    'count_kasni', (
      SELECT count(*)::int FROM jsonb_array_elements(v_rows) e
      WHERE (e->'statusi'->>'kasni')::boolean IS TRUE
    )
  ) INTO v_summary;

  RETURN jsonb_build_object(
    'predmet', jsonb_build_object(
      'item_id', v_item.id,
      'broj_predmeta', coalesce(v_item.broj_predmeta, ''),
      'naziv_predmeta', coalesce(v_item.naziv_predmeta, ''),
      'komitent', v_customer_name,
      'rok_zavrsetka', to_jsonb(v_item.rok_zavrsetka)
    ),
    'root', v_root,
    'lot_qty', v_lot,
    'generated_at', to_jsonb(v_generated),
    'rows', v_rows,
    'summary', v_summary
  );
END;
$$;

GRANT EXECUTE ON FUNCTION production.get_predmet_pracenje_izvestaj(integer, bigint, integer) TO authenticated;

COMMENT ON FUNCTION production.get_predmet_pracenje_izvestaj(integer, bigint, integer) IS
  'Jedan payload za ekran/Excel/PDF praćenja po predmetu; read-only, bez ensure_radni_nalog.';

-- ----------------------------------------------------------------------------
-- Public wrappers (PostgREST)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_predmet_pracenje_izvestaj(
  p_predmet_item_id integer,
  p_root_rn_id bigint DEFAULT NULL,
  p_lot_qty integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.get_predmet_pracenje_izvestaj(p_predmet_item_id, p_root_rn_id, p_lot_qty);
$$;

CREATE OR REPLACE FUNCTION public.upsert_pracenje_proizvodnje_napomena(
  p_predmet_item_id integer,
  p_bigtehn_rn_id bigint,
  p_note text,
  p_rn_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.upsert_pracenje_proizvodnje_napomena(
    p_predmet_item_id, p_bigtehn_rn_id, p_note, p_rn_id
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_predmet_pracenje_izvestaj(integer, bigint, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pracenje_proizvodnje_napomena(integer, bigint, text, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
