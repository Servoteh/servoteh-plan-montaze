-- ============================================================================
-- LOKACIJE — v2: quantity + multi-placement (jedna stavka na više lokacija)
-- ============================================================================
-- Primeni NAKON add_loc_module.sql + step2 + step3 + step5.
--
-- Šta menja u odnosu na v1:
--   1. `loc_item_placements.quantity`  NUMERIC(12,3) NOT NULL, CHECK (> 0)
--   2. `loc_location_movements.quantity`  NUMERIC(12,3) NOT NULL, CHECK (> 0)
--   3. Unique constraint menja se sa (item_ref_table, item_ref_id)
--      na (item_ref_table, item_ref_id, location_id) — ista stavka može
--      istovremeno da bude na više lokacija sa različitim količinama.
--   4. Trigger `loc_after_movement_insert` radi aritmetiku:
--          TO  += quantity   (upsert sa +=)
--          FROM -= quantity  (UPDATE; DELETE row kad padne na 0)
--   5. RPC `loc_create_movement`:
--        - uvodi obavezan `quantity` u payload-u (default 1)
--        - validira kapacitet na FROM pre INSERT-a movement-a
--        - dozvoljava ponovni INITIAL_PLACEMENT po istoj (item, location) ako se
--          radi ponovo (to je u stvari "još X komada na istu policu") — iako je
--          idiomatski to TRANSFER. Proveravamo: ako već postoji placement bilo
--          gde → zahteva TRANSFER/removal; ako ne postoji nigde → INITIAL.
--
-- Idempotentno — safe za ponovno pokretanje.
-- Napomena: nema `\set ON_ERROR_STOP` — Supabase SQL Editor ne razume psql
-- meta-komande. Ako se pokreće preko `psql`, prosleđuje se flag:
--     psql -v ON_ERROR_STOP=1 -f add_loc_v2_quantity.sql
-- ============================================================================

-- ── 1. Dodaj quantity kolone ────────────────────────────────────────────────
ALTER TABLE public.loc_item_placements
  ADD COLUMN IF NOT EXISTS quantity NUMERIC(12,3) NOT NULL DEFAULT 1;

ALTER TABLE public.loc_location_movements
  ADD COLUMN IF NOT EXISTS quantity NUMERIC(12,3) NOT NULL DEFAULT 1;

-- CHECK (> 0) — pažljivo, bez duplog dodavanja.
DO $$ BEGIN
  ALTER TABLE public.loc_item_placements
    ADD CONSTRAINT loc_item_placements_qty_pos_chk CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.loc_location_movements
    ADD CONSTRAINT loc_location_movements_qty_pos_chk CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Zameni unique constraint ─────────────────────────────────────────────
-- Stari: (item_ref_table, item_ref_id) — "stavka je na TAČNO JEDNOJ lokaciji"
-- Novi:  (item_ref_table, item_ref_id, location_id) — može na više njih.
DO $$ BEGIN
  ALTER TABLE public.loc_item_placements DROP CONSTRAINT loc_item_placements_item_uq;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.loc_item_placements
    ADD CONSTRAINT loc_item_placements_item_loc_uq UNIQUE (item_ref_table, item_ref_id, location_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Prepiši trigger da radi aritmetiku ───────────────────────────────────
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

  /* TO: upsert sa sabiranjem. */
  IF NEW.to_location_id IS NOT NULL THEN
    INSERT INTO public.loc_item_placements (
      item_ref_table, item_ref_id, location_id, placement_status,
      quantity, last_movement_id, placed_at, placed_by, notes
    ) VALUES (
      NEW.item_ref_table, NEW.item_ref_id, NEW.to_location_id, pl_status,
      NEW.quantity, NEW.id, NEW.moved_at, NEW.moved_by, NULL
    )
    ON CONFLICT (item_ref_table, item_ref_id, location_id) DO UPDATE SET
      quantity = public.loc_item_placements.quantity + EXCLUDED.quantity,
      placement_status = EXCLUDED.placement_status,
      last_movement_id = EXCLUDED.last_movement_id,
      placed_at = EXCLUDED.placed_at,
      placed_by = EXCLUDED.placed_by,
      updated_at = now();
  END IF;

  /* FROM: oduzmi qty. Ako bi posle toga ostalo 0 (ili manje), DELETE umesto
   * UPDATE — CHECK(quantity > 0) inače pada.
   *
   * NAPOMENA: Supabase SQL Editor ne tolerise `SELECT ... INTO var` u funk-
   * cijskim telima — zato koristimo skalarni subquery assignment (=).
   * Advisory row lock preskačemo: RPC `loc_create_movement` validira kapacitet,
   * a Postgres row-level locking serijalizuje paralelne UPDATE/DELETE nad
   * istim placement redom. */
  IF NEW.from_location_id IS NOT NULL THEN
    v_remain := (
      SELECT lp.quantity - NEW.quantity
        FROM public.loc_item_placements lp
       WHERE lp.item_ref_table = NEW.item_ref_table
         AND lp.item_ref_id    = NEW.item_ref_id
         AND lp.location_id    = NEW.from_location_id
    );

    IF v_remain IS NULL THEN
      RAISE EXCEPTION 'loc_after_movement_insert: missing placement on from_location (item=%/%, loc=%)',
        NEW.item_ref_table, NEW.item_ref_id, NEW.from_location_id;
    ELSIF v_remain <= 0 THEN
      DELETE FROM public.loc_item_placements
       WHERE item_ref_table = NEW.item_ref_table
         AND item_ref_id    = NEW.item_ref_id
         AND location_id    = NEW.from_location_id;
    ELSE
      UPDATE public.loc_item_placements
         SET quantity = v_remain,
             last_movement_id = NEW.id,
             updated_at = now()
       WHERE item_ref_table = NEW.item_ref_table
         AND item_ref_id    = NEW.item_ref_id
         AND location_id    = NEW.from_location_id;
    END IF;
  END IF;

  /* Sync outbound event — sada uključuje i quantity u payload-u. */
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
      'from_location_code', (SELECT llfc.location_code FROM public.loc_locations AS llfc WHERE llfc.id = NEW.from_location_id),
      'to_location_code', (SELECT lltc.location_code FROM public.loc_locations AS lltc WHERE lltc.id = NEW.to_location_id),
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
  v_mtype      := (payload->>'movement_type')::public.loc_movement_type_enum;

  /* Quantity: default 1 (za kompatibilnost sa v1 klijentima). Validacija > 0. */
  v_qty := coalesce((payload->>'quantity')::numeric, 1);
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_quantity');
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

  /* Da li stavka već postoji BILO GDE u placement tabeli? */
  v_existing_any := EXISTS (
    SELECT 1 FROM public.loc_item_placements lp
     WHERE lp.item_ref_table = v_item_table
       AND lp.item_ref_id    = v_item_id
  );

  IF v_mtype = 'INITIAL_PLACEMENT' THEN
    /* Dozvoljeno samo ako stavka nije nigde — inače je ovo TRANSFER ili
     * "dodaj još na istu policu" (za to koristimo INVENTORY_ADJUSTMENT). */
    IF v_existing_any THEN
      RETURN jsonb_build_object('ok', false, 'error', 'already_placed');
    END IF;
    v_from := NULL;
  ELSIF v_mtype = 'INVENTORY_ADJUSTMENT' THEN
    /* Dodavanje komada bez from — npr. popis je pokazao više nego što je bilo.
     * Dozvoljeno i bez postojećeg placement-a. */
    v_from := NULL;
  ELSE
    /* TRANSFER/ASSIGN/RETURN/SCRAP itd. — moraš da znaš from.
     * Fallback: dopuštamo samo ako postoji TAČNO JEDAN placement. Koristimo
     * scalar subquery + brojač jer Supabase SQL editor parser ne voli
     * `SELECT ... INTO STRICT` unutar funkcije. */
    IF v_from IS NULL THEN
      DECLARE
        v_cnt INTEGER;
      BEGIN
        v_cnt := (
          SELECT count(*)::int
            FROM public.loc_item_placements lp
           WHERE lp.item_ref_table = v_item_table
             AND lp.item_ref_id    = v_item_id
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
           LIMIT 1
        );
      END;
    END IF;

    /* Provera kapaciteta na FROM lokaciji. */
    v_avail := (
      SELECT lp.quantity
        FROM public.loc_item_placements lp
       WHERE lp.item_ref_table = v_item_table
         AND lp.item_ref_id    = v_item_id
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
        item_ref_table, item_ref_id, from_location_id, to_location_id,
        movement_type, movement_reason, quantity, note, moved_at, moved_by
      ) VALUES (
        v_item_table,
        v_item_id,
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
  v_has_qty_pl  BOOLEAN;
  v_has_qty_mv  BOOLEAN;
  v_has_uniq    BOOLEAN;
BEGIN
  v_has_qty_pl := EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='loc_item_placements' AND column_name='quantity'
  );
  v_has_qty_mv := EXISTS(
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='loc_location_movements' AND column_name='quantity'
  );
  v_has_uniq := EXISTS(
    SELECT 1 FROM pg_constraint
     WHERE conname='loc_item_placements_item_loc_uq'
  );

  IF NOT (v_has_qty_pl AND v_has_qty_mv AND v_has_uniq) THEN
    RAISE EXCEPTION 'loc v2 migration sanity failed: qty_pl=%, qty_mv=%, uniq=%',
      v_has_qty_pl, v_has_qty_mv, v_has_uniq;
  END IF;

  RAISE NOTICE 'loc v2 migration applied OK (qty kolone + (item,id,loc) unique constraint).';
END
$sanity$;
