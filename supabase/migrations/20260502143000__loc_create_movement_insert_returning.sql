-- loc_create_movement: PG ne dozvoljava data-modifying CTE unutar RETURN (...)
-- skalarnog izraza — "WITH clause containing a data-modifying statement must be
-- at the top level". Zamenjeno sa INSERT ... RETURNING INTO + RETURN jsonb.

CREATE OR REPLACE FUNCTION public.loc_create_movement(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn_cm$
DECLARE
  v_item_table TEXT;
  v_item_id    TEXT;
  v_order      TEXT;
  v_drawing    TEXT;
  v_to         UUID;
  v_from       UUID;
  v_mtype      public.loc_movement_type_enum;
  v_uid        UUID;
  v_qty        NUMERIC(12,3);
  v_avail      NUMERIC(12,3);
  v_existing_any BOOLEAN;
  v_new_id     UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  v_item_table := nullif(trim(payload->>'item_ref_table'), '');
  v_item_id    := nullif(trim(payload->>'item_ref_id'), '');
  v_order      := COALESCE(trim(payload->>'order_no'), '');
  v_drawing    := COALESCE(trim(payload->>'drawing_no'), '');
  v_mtype      := (payload->>'movement_type')::public.loc_movement_type_enum;

  v_qty := coalesce((payload->>'quantity')::numeric, 1);
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_quantity');
  END IF;

  IF char_length(v_order) > 40 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_order_no');
  END IF;
  IF char_length(v_drawing) > 40 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_drawing_no');
  END IF;

  IF payload ? 'to_location_id' AND nullif(trim(payload->>'to_location_id'), '') IS NOT NULL THEN
    v_to := (payload->>'to_location_id')::uuid;
  END IF;
  IF payload ? 'from_location_id' AND nullif(trim(payload->>'from_location_id'), '') IS NOT NULL THEN
    v_from := (payload->>'from_location_id')::uuid;
  END IF;

  IF v_item_table IS NULL OR v_item_id IS NULL OR v_to IS NULL OR v_mtype IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_fields');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.loc_locations loc_chk
    WHERE loc_chk.id = v_to AND loc_chk.is_active
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_to_location');
  END IF;

  v_existing_any := EXISTS (
    SELECT 1 FROM public.loc_item_placements lp
     WHERE lp.item_ref_table = v_item_table
       AND lp.item_ref_id    = v_item_id
       AND lp.order_no       = v_order
  );

  IF v_mtype = 'INITIAL_PLACEMENT' THEN
    IF v_existing_any THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_placed');
    END IF;
    v_from := NULL;
  ELSIF v_mtype = 'INVENTORY_ADJUSTMENT' THEN
    v_from := NULL;
  ELSE
    IF v_from IS NULL THEN
      DECLARE
        v_cnt INTEGER;
      BEGIN
        v_cnt := (
          SELECT count(*)::int
            FROM public.loc_item_placements lp
           WHERE lp.item_ref_table = v_item_table
             AND lp.item_ref_id    = v_item_id
             AND lp.order_no       = v_order
        );
        IF v_cnt = 0 THEN
          RETURN jsonb_build_object('ok', false, 'error', 'no_current_placement');
        ELSIF v_cnt > 1 THEN
          RETURN jsonb_build_object('ok', false, 'error', 'from_ambiguous');
        END IF;
        v_from := (
          SELECT lp.location_id
            FROM public.loc_item_placements lp
           WHERE lp.item_ref_table = v_item_table
             AND lp.item_ref_id    = v_item_id
             AND lp.order_no       = v_order
           LIMIT 1
        );
      END;
    END IF;

    v_avail := (
      SELECT lp.quantity
        FROM public.loc_item_placements lp
       WHERE lp.item_ref_table = v_item_table
         AND lp.item_ref_id    = v_item_id
         AND lp.order_no       = v_order
         AND lp.location_id    = v_from
       LIMIT 1
    );

    IF v_avail IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'from_has_no_placement');
    END IF;
    IF v_qty > v_avail THEN
      RETURN jsonb_build_object(
        'ok', false, 'error', 'insufficient_quantity',
        'available', v_avail, 'requested', v_qty
      );
    END IF;
  END IF;

  INSERT INTO public.loc_location_movements (
    item_ref_table, item_ref_id, order_no, drawing_no,
    from_location_id, to_location_id,
    movement_type, movement_reason, quantity, note, moved_at, moved_by
  ) VALUES (
    v_item_table,
    v_item_id,
    v_order,
    v_drawing,
    v_from,
    v_to,
    v_mtype,
    nullif(trim(payload->>'movement_reason'), ''),
    v_qty,
    nullif(trim(payload->>'note'), ''),
    coalesce((payload->>'moved_at')::timestamptz, now()),
    v_uid
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object('ok', true, 'id', v_new_id);
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception', 'detail', SQLERRM);
END;
$fn_cm$;

COMMENT ON FUNCTION public.loc_create_movement(jsonb) IS
  'Kreira loc_location_movements red; INSERT RETURNING INTO (bez DML u WITH u RETURN).';
