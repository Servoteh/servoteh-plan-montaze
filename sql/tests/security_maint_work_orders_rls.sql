-- ============================================================================
-- pgTAP: maint_work_orders + deca tabele — RLS ukljucen, politike postoje
-- ============================================================================

BEGIN;
SET search_path = public, extensions;

SELECT plan(7);

SELECT has_table('public', 'maint_work_orders', 'tabela maint_work_orders postoji');
SELECT has_table('public', 'maint_wo_events', 'tabela maint_wo_events postoji');

SELECT is(
  (SELECT c.relrowsecurity::int
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'maint_work_orders'
   LIMIT 1),
  1,
  'RLS ukljucen na maint_work_orders'
);

SELECT ok(
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maint_work_orders' AND policyname = 'maint_wo_select'),
  'politika maint_wo_select postoji'
);
SELECT ok(
  EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'maint_work_orders' AND policyname = 'maint_wo_insert'),
  'politika maint_wo_insert postoji'
);

SELECT has_function('public', 'maint_wo_row_visible', ARRAY['uuid', 'uuid', 'uuid'], 'funkcija maint_wo_row_visible postoji');
SELECT has_function('public', 'maint_incidents_autocreate_work_order', 'funkcija maint_incidents_autocreate_work_order postoji');

SELECT * FROM finish();
ROLLBACK;
