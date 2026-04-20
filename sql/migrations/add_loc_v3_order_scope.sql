-- ============================================================================
-- LOKACIJE — v3: order_no kao dimenzija (nalog × crtež × lokacija)
-- ============================================================================
-- Primeni NAKON add_loc_v2_quantity.sql.
--
-- Razlog postojanja:
--   BigTehn nalepnica nosi `BROJ_NALOGA/BROJ_CRTEŽA` (npr. `9000/1091063`).
--   Isti broj crteža može biti poručen kroz više radnih naloga i komadi iz
--   jednog naloga se NE smeju pomešati sa komadima iz drugog — ako operater
--   ugradi 150 kom. "crteža 1091063 iz naloga 9000", to ne sme da smanji
--   zalihu naloga 9001. Zato stanje vodimo po trojki:
--        (item_ref_table, item_ref_id, order_no) × location_id
--
-- Šta menja u odnosu na v2:
--   1. `loc_item_placements.order_no     TEXT NOT NULL DEFAULT ''`
--   2. `loc_location_movements.order_no  TEXT NOT NULL DEFAULT ''`
--      Prazna vrednost (`''`) je backward-compat: svi postojeći redovi i svi
--      klijenti koji još ne šalju `order_no` rade "kao pre" (jedan bucket).
--   3. Unique constraint se menja sa (item_ref_table, item_ref_id, location_id)
--      na (item_ref_table, item_ref_id, order_no, location_id).
--   4. Trigger `loc_after_movement_insert` radi aritmetiku uz `order_no`.
--   5. RPC `loc_create_movement` prihvata `order_no` iz payload-a i koristi ga
--      u svim provera­ma (already_placed, from_ambiguous, kapacitet).
--
-- Idempotentno — safe za ponovno pokretanje.
-- ============================================================================

-- ── 1. Dodaj order_no kolone ────────────────────────────────────────────────
ALTER TABLE public.loc_item_placements
  ADD COLUMN IF NOT EXISTS order_no TEXT NOT NULL DEFAULT '';

ALTER TABLE public.loc_location_movements
  ADD COLUMN IF NOT EXISTS order_no TEXT NOT NULL DEFAULT '';

/* Dužinski chk — tight limit da neko ne zalepi celu priču u `order_no`. */
DO $$ BEGIN
  ALTER TABLE public.loc_item_placements
    ADD CONSTRAINT loc_item_placements_order_no_len_chk CHECK (char_length(order_no) <= 40);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.loc_location_movements
    ADD CONSTRAINT loc_location_movements_order_no_len_chk CHECK (char_length(order_no) <= 40);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Zameni unique constraint ─────────────────────────────────────────────
-- Stari: (item_ref_table, item_ref_id, location_id).
-- Novi:  (item_ref_table, item_ref_id, order_no, location_id).
DO $$ BEGIN
  ALTER TABLE public.loc_item_placements DROP CONSTRAINT loc_item_placements_item_loc_uq;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.loc_item_placements
    ADD CONSTRAINT loc_item_placements_item_order_loc_uq
      UNIQUE (item_ref_table, item_ref_id, order_no, location_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Pomoćni indeks za history filter po nalogu (samo ne-prazne vrednosti).
CREATE INDEX IF NOT EXISTS loc_location_movements_order_no_idx
  ON public.loc_location_movements (order_no)
  WHERE order_no <> '';

CREATE INDEX IF NOT EXISTS loc_item_placements_order_no_idx
  ON public.loc_item_placements (order_no)
  WHERE order_no <> '';

-- ── 3. Prepiši trigger da razdvaja stanje po order_no ───────────────────────
CREATE OR REPLACE FUNCTION public.loc_after_movement_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn_trig$
DECLARE
  pl_status  public.loc_placement_status_enum;
  v_remain   NUMERIC(12,3);
BEGIN
  IF NEW.movement_type IN ('SEND_TO_SERVICE', 'SEND_TO_FIELD') THEN
    pl_status := 'IN_TRANSIT'::public.loc_placement_status_enum;
  ELSE
    pl_status := 'ACTIVE'::public.loc_placement_status_enum;
  END IF;

  /* TO lokacija: upsert po (table, id, order_no, location). */
  IF NEW.to_location_id IS NOT NULL THEN
    INSERT INTO public.loc_item_placements (
      item_ref_table, item_ref_id, order_no, location_id, placement_status,
      quantity, last_movement_id, placed_at, placed_by, notes
    ) VALUES (
      NEW.item_ref_table, NEW.item_ref_id, COALESCE(NEW.order_no, ''),
      NEW.to_location_id, pl_status,
      NEW.quantity, NEW.id, NEW.moved_at, NEW.moved_by, NULL
    )
    ON CONFLICT (item_ref_table, item_ref_id, order_no, location_id) DO UPDATE SET
      quantity = public.loc_item_placements.quantity + EXCLUDED.quantity,
      placement_status = EXCLUDED.placement_status,
      last_movement_id = EXCLUDED.last_movement_id,
      placed_at = EXCLUDED.placed_at,
      placed_by = EXCLUDED.placed_by,
      updated_at = now();
  END IF;

  /* FROM lokacija: oduzmi qty iz istog (table, id, order_no) bucket-a.
   *
   * NAPOMENA: Supabase SQL Editor ne tolerise `SELECT ... INTO var` u funk-
   * cijskim telima — zato koristimo skalarni subquery assignment (=).
   * Kapacitet se validira u RPC-u pre inserta; row-level locking Postgresa
   * serijalizuje paralelne UPDATE/DELETE nad istim placement redom. */
  IF NEW.from_location_id IS NOT NULL THEN
    v_remain := (
      SELECT lp.quantity - NEW.quantity
        FROM public.loc_item_placements lp
       WHERE lp.item_ref_table = NEW.item_ref_table
         AND lp.item_ref_id    = NEW.item_ref_id
         AND lp.order_no       = COALESCE(NEW.order_no, '')
         AND lp.location_id    = NEW.from_location_id
    );

    IF v_remain IS NULL THEN
      RAISE EXCEPTION 'loc_after_movement_insert: missing placement on from_location (item=%/%, order=%, loc=%)',
        NEW.item_ref_table, NEW.item_ref_id, COALESCE(NEW.order_no, ''), NEW.from_location_id;
    ELSIF v_remain <= 0 THEN
      DELETE FROM public.loc_item_placements
       WHERE item_ref_table = NEW.item_ref_table
         AND item_ref_id    = NEW.item_ref_id
         AND order_no       = COALESCE(NEW.order_no, '')
         AND location_id    = NEW.from_location_id;
    ELSE
      UPDATE public.loc_item_placements
         SET quantity = v_remain,
             last_movement_id = NEW.id,
             updated_at = now()
       WHERE item_ref_table = NEW.item_ref_table
         AND item_ref_id    = NEW.item_ref_id
         AND order_no       = COALESCE(NEW.order_no, '')
         AND location_id    = NEW.from_location_id;
    END IF;
  END IF;

  /* Sync outbound event — dodajemo i order_no u payload da MSSQL strana može
   * da ga prenese u sp_ApplyLocationEvent kad stigne do implementacije. */
  INSERT INTO public.loc_sync_outbound_events (
    id, source_table, source_record_id, target_procedure, payload, status
  ) VALUES (
    NEW.id,
    'loc_location_movements',
    NEW.id,
    'dbo.sp_ApplyLocationEvent',
    jsonb_build_object(
      'event_uuid', NEW.id::text,
      'item_ref_table', NEW.item_ref_table,
      'item_ref_id', NEW.item_ref_id,
      'order_no', COALESCE(NEW.order_no, ''),
      'from_location_code', (SELECT llfc.location_code FROM public.loc_locations AS llfc WHERE llfc.id = NEW.from_location_id),
      'to_location_code',   (SELECT lltc.location_code FROM public.loc_locations AS lltc WHERE lltc.id = NEW.to_location_id),
      'movement_type', NEW.movement_type::text,
      'quantity', NEW.quantity,
      'moved_at', to_jsonb(NEW.moved_at),
      'moved_by', NEW.moved_by::text,
      'note', NEW.note
    ),
    'PENDING'::public.loc_sync_status_enum
  );

  RETURN NEW;
END;
$fn_trig$;

-- ── 4. Prepiši loc_create_movement RPC ──────────────────────────────────────
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
  v_to         UUID;
  v_from       UUID;
  v_mtype      public.loc_movement_type_enum;
  v_uid        UUID;
  v_qty        NUMERIC(12,3);
  v_avail      NUMERIC(12,3);
  v_existing_any BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  v_item_table := nullif(trim(payload->>'item_ref_table'), '');
  v_item_id    := nullif(trim(payload->>'item_ref_id'), '');
  /* order_no: uvek TEXT; prazan string znači "bez naloga" (backward-compat). */
  v_order      := COALESCE(trim(payload->>'order_no'), '');
  v_mtype      := (payload->>'movement_type')::public.loc_movement_type_enum;

  v_qty := coalesce((payload->>'quantity')::numeric, 1);
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_quantity');
  END IF;

  IF char_length(v_order) > 40 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_order_no');
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

  /* TO lokacija mora biti aktivna. */
  IF NOT EXISTS (
    SELECT 1 FROM public.loc_locations loc_chk
    WHERE loc_chk.id = v_to AND loc_chk.is_active
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_to_location');
  END IF;

  /* Postoji li placement za TAČNO (table, id, order_no) par bilo gde? */
  v_existing_any := EXISTS (
    SELECT 1 FROM public.loc_item_placements lp
     WHERE lp.item_ref_table = v_item_table
       AND lp.item_ref_id    = v_item_id
       AND lp.order_no       = v_order
  );

  IF v_mtype = 'INITIAL_PLACEMENT' THEN
    /* Dozvoljeno samo ako ovaj (crtež, nalog) par nije nigde. Komad iz istog
     * naloga koji je već smešten → koristi TRANSFER; dodavanje još komada iz
     * istog naloga → INVENTORY_ADJUSTMENT. */
    IF v_existing_any THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_placed');
    END IF;
    v_from := NULL;
  ELSIF v_mtype = 'INVENTORY_ADJUSTMENT' THEN
    v_from := NULL;
  ELSE
    /* TRANSFER/ASSIGN/RETURN/SCRAP — potrebno je from. Ako nije prosleđen i
     * ima tačno jedan placement za taj (crtež, nalog), automatski pogodimo. */
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

    /* Kapacitet FROM lokacije za TAJ nalog (ne mešamo naloge!). */
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

  RETURN (
    WITH ins AS (
      INSERT INTO public.loc_location_movements (
        item_ref_table, item_ref_id, order_no, from_location_id, to_location_id,
        movement_type, movement_reason, quantity, note, moved_at, moved_by
      ) VALUES (
        v_item_table,
        v_item_id,
        v_order,
        v_from,
        v_to,
        v_mtype,
        nullif(trim(payload->>'movement_reason'), ''),
        v_qty,
        nullif(trim(payload->>'note'), ''),
        coalesce((payload->>'moved_at')::timestamptz, now()),
        v_uid
      )
      RETURNING id
    )
    SELECT jsonb_build_object('ok', true, 'id', ins.id) FROM ins
  );
EXCEPTION
  WHEN others THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception', 'detail', SQLERRM);
END;
$fn_cm$;

GRANT EXECUTE ON FUNCTION public.loc_create_movement(jsonb) TO authenticated;

-- ── 5. Sanity check ─────────────────────────────────────────────────────────
DO $sanity$
DECLARE
  v_has_pl_order BOOLEAN;
  v_has_mv_order BOOLEAN;
  v_has_uniq     BOOLEAN;
BEGIN
  v_has_pl_order := EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='loc_item_placements' AND column_name='order_no'
  );
  v_has_mv_order := EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='loc_location_movements' AND column_name='order_no'
  );
  v_has_uniq := EXISTS(
    SELECT 1 FROM pg_constraint
     WHERE conname='loc_item_placements_item_order_loc_uq'
  );

  IF NOT (v_has_pl_order AND v_has_mv_order AND v_has_uniq) THEN
    RAISE EXCEPTION 'loc v3 migration sanity failed: pl_order=%, mv_order=%, uniq=%',
      v_has_pl_order, v_has_mv_order, v_has_uniq;
  END IF;

  RAISE NOTICE 'loc v3 migration applied OK (order_no kolone + (item,id,order,loc) unique).';
END
$sanity$;
