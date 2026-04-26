-- ============================================================================
-- pgTAP: maint_assets RLS + helper maint_asset_visible
-- ============================================================================
-- Verifikuje da migracija add_maint_assets_supertable.sql ostavlja
--   * RLS uključen,
--   * očekivane politike (po imenu),
--   * pomoćnu funkciju i trigger za unos u maint_machines bez asset_id.
-- Ne testira puna behavioural pravila (operator vs chief) — to su kompleksni
-- setup-i sa maint_user_profiles; cilj je regresiono uhvatiti odsustvo RLS.
-- ============================================================================

BEGIN;
SET search_path = public, extensions;

SELECT plan(7);

-- 1) Tabela
SELECT has_table('public', 'maint_assets', 'tabela public.maint_assets postoji');

-- 2) RLS
SELECT is(
  (SELECT c.relrowsecurity::int
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'maint_assets'
   LIMIT 1),
  1,
  'RLS ukljucen na public.maint_assets (relrowsecurity)'
);

-- 3) Politike (SELECT + INSERT — ostale slede isti obrasac imenovanja)
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'maint_assets'
      AND policyname = 'maint_assets_select'
  ),
  'politika maint_assets_select postoji'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'maint_assets'
      AND policyname = 'maint_assets_insert'
  ),
  'politika maint_assets_insert postoji'
);

-- 4) Helper
SELECT has_function('public', 'maint_asset_visible', ARRAY['uuid'], 'funkcija maint_asset_visible(uuid)');

-- 5) lives_ok: helper sa “praznim” id ne puca
SELECT lives_ok(
  'SELECT public.maint_asset_visible(''00000000-0000-0000-0000-000000000000''::uuid)',
  'maint_asset_visible ne baca gresku za proizvoljni uuid'
);

-- 6) Trigger na maint_machines (BEFORE INSERT ensure asset)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname = 'public'
      AND c.relname = 'maint_machines'
      AND t.tgname = 'maint_machines_ensure_asset'
  ),
  'trigger maint_machines_ensure_asset postoji na public.maint_machines'
);

SELECT * FROM finish();
ROLLBACK;
