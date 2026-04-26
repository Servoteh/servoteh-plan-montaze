-- ============================================================================
-- TEST: bigtehn_rn_components_cache + v_bigtehn_rn_struktura + v_bigtehn_rn_root_count
-- ============================================================================
-- Pokrenuti nakon migracije 20260426120000__bigtehn_rn_components_cache_init.sql
-- i postojanjem v_active_bigtehn_work_orders / production_active_work_orders.
--
-- Tri predmeta (item_id):
--   A — jedan root RN, nema dece u tRNKomponente
--   B — jedan root, tri direktna deteta
--   C — jedan root, dva deteta; jedan pod-RN ima još dva pod-podsklopa
--
-- RN id-evi (bigtehn_work_orders_cache.id) su u opsegu 200080xxx; komponente 400xxx.
-- ============================================================================

BEGIN;

-- Predmeti
INSERT INTO public.bigtehn_items_cache (id, broj_predmeta, naziv_predmeta, opis, synced_at)
VALUES
  (810100, 'STR-TEST-A', 'RN struktura test A', '1 root, bez komponenti', now()),
  (810101, 'STR-TEST-B', 'RN struktura test B', '1 root, 3 deteta nivoa 1', now()),
  (810102, 'STR-TEST-C', 'RN struktura test C', '1 root, 2+2 nivoa 2', now())
ON CONFLICT (id) DO UPDATE SET
  naziv_predmeta = EXCLUDED.naziv_predmeta,
  opis = EXCLUDED.opis,
  synced_at = now();

-- Minimalni work order redovi (id = BigTehn IDRN)
INSERT INTO public.bigtehn_work_orders_cache (
  id, item_id, ident_broj, varijanta, komada,
  tezina_neobr, tezina_obr, status_rn, zakljucano, synced_at, naziv_dela
) VALUES
  (200080001, 810100, 'STR-TEST-A/1', 1, 1, 0, 0, false, false, now(), 'Root A'),
  (200080010, 810101, 'STR-TEST-B/1', 1, 1, 0, 0, false, false, now(), 'Root B'),
  (200080011, 810101, 'STR-TEST-B/2', 1, 1, 0, 0, false, false, now(), 'Dete B1'),
  (200080012, 810101, 'STR-TEST-B/3', 1, 1, 0, 0, false, false, now(), 'Dete B2'),
  (200080013, 810101, 'STR-TEST-B/4', 1, 1, 0, 0, false, false, now(), 'Dete B3'),
  (200080020, 810102, 'STR-TEST-C/1', 1, 1, 0, 0, false, false, now(), 'Root C'),
  (200080021, 810102, 'STR-TEST-C/2', 1, 1, 0, 0, false, false, now(), 'Dete C1'),
  (200080022, 810102, 'STR-TEST-C/3', 1, 1, 0, 0, false, false, now(), 'Dete C2'),
  (200080023, 810102, 'STR-TEST-C/4', 1, 1, 0, 0, false, false, now(), 'Unuk C2a'),
  (200080024, 810102, 'STR-TEST-C/5', 1, 1, 0, 0, false, false, now(), 'Unuk C2b')
ON CONFLICT (id) DO UPDATE SET
  item_id = EXCLUDED.item_id,
  ident_broj = EXCLUDED.ident_broj,
  naziv_dela = EXCLUDED.naziv_dela,
  synced_at = now();

-- MES „aktivni" samo root-ovi (kako u produkciji)
INSERT INTO public.production_active_work_orders (work_order_id, is_active, reason, source)
VALUES
  (200080001, true, 'seed rn struktura A', 'seed'),
  (200080010, true, 'seed rn struktura B', 'seed'),
  (200080020, true, 'seed rn struktura C', 'seed')
ON CONFLICT (work_order_id) DO UPDATE SET
  is_active = true,
  reason = EXCLUDED.reason;

-- tRNKomponente (samo ovi root-ovi nisu nigde child)
INSERT INTO public.bigtehn_rn_components_cache (id, parent_rn_id, child_rn_id, broj_komada, napomena, modified_at, synced_at)
VALUES
  -- B: 10 -> 11, 12, 13
  (400001, 200080010, 200080011, 1, 'seed B', NULL, now()),
  (400002, 200080010, 200080012, 1, 'seed B', NULL, now()),
  (400003, 200080010, 200080013, 1, 'seed B', NULL, now()),
  -- C: 20 -> 21, 22; 22 -> 23, 24
  (400010, 200080020, 200080021, 1, 'seed C', NULL, now()),
  (400011, 200080020, 200080022, 1, 'seed C', NULL, now()),
  (400012, 200080022, 200080023, 1, 'seed C n2', NULL, now()),
  (400013, 200080022, 200080024, 1, 'seed C n2', NULL, now())
ON CONFLICT (id) DO UPDATE SET
  parent_rn_id = EXCLUDED.parent_rn_id,
  child_rn_id = EXCLUDED.child_rn_id,
  broj_komada = EXCLUDED.broj_komada,
  napomena = EXCLUDED.napomena,
  synced_at = now();

COMMIT;

-- Smoke (zameniti 810102 po želji):
-- SELECT * FROM v_bigtehn_rn_struktura WHERE predmet_item_id = 810102 ORDER BY nivo, rn_id;
-- SELECT * FROM v_bigtehn_rn_root_count WHERE predmet_item_id = 810102;
-- Očekivano C: 5 redova u strukturi (1 root + 2 n1 + 2 n2); root_count = 1
