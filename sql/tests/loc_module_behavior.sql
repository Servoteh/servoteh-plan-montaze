-- ============================================================================
-- pgTAP: behavior testovi za triggere modula Lokacije.
-- ============================================================================
-- Ne testira RPC loc_create_movement jer on zahteva auth.uid() (potrebni
-- seed-ovani auth korisnici u dedicated test instanci). Testira se putanja
-- kroz same triggere na INSERT/UPDATE tabelâ.
--
-- Sve promene se rollback-uju na kraju (BEGIN/ROLLBACK u blokovima).

BEGIN;
SET search_path = public, extensions;

SELECT plan(11);

-- ── 1) Root lokacija: depth=0, path_cached = code ──────────────────────
DO $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.loc_locations (location_code, name, location_type)
  VALUES ('TEST-ROOT', 'Test root', 'WAREHOUSE') RETURNING id INTO v_id;
  PERFORM set_config('test.root_id', v_id::text, true);
END $$;

-- NB: `depth` je SMALLINT u produkciji — cast u integer da pgTAP `is()` nadje
-- polimorfno preklapanje (is(smallint,integer,unknown) ne postoji).
SELECT is(
  (SELECT depth::integer FROM public.loc_locations WHERE location_code = 'TEST-ROOT'),
  0,
  'root lokacija ima depth=0'
);
-- `path_cached` se gradi od `name` (ne `location_code`) i koristi ' › '
-- separator (U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK sa razmacima).
SELECT is(
  (SELECT path_cached FROM public.loc_locations WHERE location_code = 'TEST-ROOT'),
  'Test root',
  'path_cached root-a = name'
);

-- ── 2) Dete nasleđuje path + depth inkrementiran ───────────────────────
DO $$
DECLARE
  v_root uuid := current_setting('test.root_id')::uuid;
  v_child uuid;
BEGIN
  INSERT INTO public.loc_locations (location_code, name, location_type, parent_id)
  VALUES ('TEST-CHILD', 'Test child', 'RACK', v_root) RETURNING id INTO v_child;
  PERFORM set_config('test.child_id', v_child::text, true);
END $$;

SELECT is(
  (SELECT depth::integer FROM public.loc_locations WHERE location_code = 'TEST-CHILD'),
  1,
  'dete depth=1'
);
SELECT is(
  (SELECT path_cached FROM public.loc_locations WHERE location_code = 'TEST-CHILD'),
  'Test root ' || chr(8250) || ' Test child',
  'dete path_cached = root › child'
);

-- ── 3) Case-insensitive unique: ne može duplikat u drugom case-u ───────
SELECT throws_ok(
  $$INSERT INTO public.loc_locations (location_code, name, location_type) VALUES ('test-root', 'dup', 'WAREHOUSE')$$,
  '23505',
  NULL,
  'duplikat po lower(location_code) baca unique violation'
);

-- ── 4) Cycle detection: parent_id = self ili descendant baca exception ─
SELECT throws_ok(
  format(
    $$UPDATE public.loc_locations SET parent_id = id WHERE id = %L$$,
    current_setting('test.root_id')::uuid
  ),
  NULL,
  NULL,
  'parent_id = self → cycle guard exception'
);

SELECT throws_ok(
  format(
    $$UPDATE public.loc_locations SET parent_id = %L WHERE id = %L$$,
    current_setting('test.child_id')::uuid,
    current_setting('test.root_id')::uuid
  ),
  NULL,
  NULL,
  'parent_id = descendant → cycle guard exception'
);

-- ── 5) Promena parent-a recomputes path descendenata ───────────────────
DO $$
DECLARE
  v_alt uuid;
  v_child uuid := current_setting('test.child_id')::uuid;
BEGIN
  INSERT INTO public.loc_locations (location_code, name, location_type)
  VALUES ('TEST-ALT', 'Alt root', 'WAREHOUSE') RETURNING id INTO v_alt;
  PERFORM set_config('test.alt_id', v_alt::text, true);
  UPDATE public.loc_locations SET parent_id = v_alt WHERE id = v_child;
END $$;

SELECT is(
  (SELECT path_cached FROM public.loc_locations WHERE location_code = 'TEST-CHILD'),
  'Alt root ' || chr(8250) || ' Test child',
  'path_cached se updateuje po promeni roditelja'
);

-- ── 6) Movement insert kreira placement (trigger loc_after_movement_insert) ─
-- Napomena: insert direktno u loc_location_movements zaobilazi RPC (i RLS),
-- što pgTAP dozvoljava jer rolluje transakciju. `moved_by` je NOT NULL u
-- produkcionoj šemi (RPC ga popunjava iz auth.uid()) — za trigger test je
-- dovoljno proslediti fiksni dummy UUID.
DO $$
DECLARE
  v_loc uuid := current_setting('test.alt_id')::uuid;
  v_user uuid := '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  INSERT INTO public.loc_location_movements
    (item_ref_table, item_ref_id, to_location_id, movement_type, movement_reason, moved_by)
  VALUES
    ('parts', 'pgtap-item-1', v_loc, 'INITIAL_PLACEMENT', 'pgtap test', v_user);
END $$;

SELECT ok(
  EXISTS(
    SELECT 1 FROM public.loc_item_placements
    WHERE item_ref_table = 'parts' AND item_ref_id = 'pgtap-item-1'
  ),
  'INITIAL_PLACEMENT kreira red u loc_item_placements'
);

-- ── 7) Sync queue dobija event ─────────────────────────────────────────
SELECT ok(
  EXISTS(
    SELECT 1 FROM public.loc_sync_outbound_events
     WHERE payload->>'item_ref_id' = 'pgtap-item-1'
  ),
  'movement upis kreira red u loc_sync_outbound_events'
);

-- ── 8) TRANSFER kad placement već postoji ne baca izuzetak na trigger-u ─
DO $$
DECLARE
  v_loc uuid := current_setting('test.alt_id')::uuid;
  v_user uuid := '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  INSERT INTO public.loc_location_movements
    (item_ref_table, item_ref_id, from_location_id, to_location_id, movement_type, moved_by)
  VALUES
    ('parts', 'pgtap-item-1', v_loc, v_loc, 'TRANSFER', v_user);
END $$;

SELECT pass('TRANSFER posle INITIAL_PLACEMENT ne baca na trigger-u');

SELECT * FROM finish();
ROLLBACK;
