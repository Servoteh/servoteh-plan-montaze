-- ============================================================================
-- FAZA 0: tRNKomponente → public.bigtehn_rn_components_cache + read-only view-i
-- ============================================================================
-- Izvor šeme MSSQL: dbo.tRNKomponente (QBigTehn export) — nema kolone
-- `DatumIVreme`; `modified_at` u cache-u je nullable (worker puni `synced_at`).
-- Nema FK ka bigtehn_work_orders_cache (cache se puni/brise pri full sync-u).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Tabela
-- ----------------------------------------------------------------------------
CREATE TABLE public.bigtehn_rn_components_cache (
  id                integer PRIMARY KEY,
  parent_rn_id      integer NOT NULL,
  child_rn_id       integer NOT NULL,
  broj_komada       integer,
  napomena          text,
  modified_at       timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_brncc_parent_child UNIQUE (parent_rn_id, child_rn_id)
);

COMMENT ON TABLE public.bigtehn_rn_components_cache IS
  'Hijerarhija RN–RN iz BigTehn dbo.tRNKomponente. id = IDKomponente. '
  'Nema FK na bigtehn_work_orders_cache jer se cache kompletno resinhronizuje.';

COMMENT ON COLUMN public.bigtehn_rn_components_cache.id IS 'Legacy tRNKomponente.IDKomponente (PK).';
COMMENT ON COLUMN public.bigtehn_rn_components_cache.parent_rn_id IS 'Legacy tRNKomponente.IDRN (parent RN).';
COMMENT ON COLUMN public.bigtehn_rn_components_cache.child_rn_id IS 'Legacy tRNKomponente.IDRNPodkomponenta (child RN, red u tRN).';
COMMENT ON COLUMN public.bigtehn_rn_components_cache.broj_komada IS 'Legacy BrojKomada.';
COMMENT ON COLUMN public.bigtehn_rn_components_cache.napomena IS 'Legacy Napomena.';
COMMENT ON COLUMN public.bigtehn_rn_components_cache.modified_at IS
  'Opciono (MSSQL trenutno nema odgovarajuću kolonu u exportu).';
COMMENT ON COLUMN public.bigtehn_rn_components_cache.synced_at IS 'Vreme upsert-a u Supabase (backfill/bridge).';

CREATE INDEX brncc_parent_idx ON public.bigtehn_rn_components_cache (parent_rn_id);
CREATE INDEX brncc_child_idx ON public.bigtehn_rn_components_cache (child_rn_id);

-- ----------------------------------------------------------------------------
-- 2) RLS (kao bigtehn_rework_scrap_cache: čitanje auth, pisanje samo service_role)
-- ----------------------------------------------------------------------------
ALTER TABLE public.bigtehn_rn_components_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "brncc_read_authenticated" ON public.bigtehn_rn_components_cache;
CREATE POLICY "brncc_read_authenticated"
  ON public.bigtehn_rn_components_cache FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "brncc_no_client_insert" ON public.bigtehn_rn_components_cache;
CREATE POLICY "brncc_no_client_insert"
  ON public.bigtehn_rn_components_cache FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "brncc_no_client_update" ON public.bigtehn_rn_components_cache;
CREATE POLICY "brncc_no_client_update"
  ON public.bigtehn_rn_components_cache FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "brncc_no_client_delete" ON public.bigtehn_rn_components_cache;
CREATE POLICY "brncc_no_client_delete"
  ON public.bigtehn_rn_components_cache FOR DELETE
  TO authenticated
  USING (false);

GRANT SELECT ON public.bigtehn_rn_components_cache TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bigtehn_rn_components_cache TO service_role;

-- ----------------------------------------------------------------------------
-- 3) v_bigtehn_rn_struktura — rekurzivno stablo od „root" RN-ova
--    Root: MES-aktivan RN (v_active…), item_id nije null, nije nigde child u cache-u.
--    Zaštita: max 10 nivoa; ciklus: child ne sme biti u path_idrn (u starijem PG
--    bez CYCLE). Multi-parent: isti child može ući više puta (preko roditelja).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bigtehn_rn_struktura
WITH (security_invoker = true) AS
WITH RECURSIVE root_rn AS (
  SELECT
    wo.id AS root_rn_id,
    wo.item_id::bigint AS predmet_item_id
  FROM public.v_active_bigtehn_work_orders wo
  WHERE wo.item_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.bigtehn_rn_components_cache c
      WHERE c.child_rn_id = wo.id::integer
    )
),
tree AS (
  SELECT
    r.predmet_item_id,
    r.root_rn_id,
    w.id::bigint AS rn_id,
    NULL::bigint AS parent_rn_id,
    0 AS nivo,
    NULL::integer AS broj_komada,
    ARRAY[r.root_rn_id::bigint] AS path_idrn
  FROM root_rn r
  INNER JOIN public.bigtehn_work_orders_cache w ON w.id = r.root_rn_id

  UNION ALL

  SELECT
    t.predmet_item_id,
    t.root_rn_id,
    w.id::bigint AS rn_id,
    t.rn_id AS parent_rn_id,
    t.nivo + 1,
    c.broj_komada,
    t.path_idrn || c.child_rn_id::bigint
  FROM tree t
  INNER JOIN public.bigtehn_rn_components_cache c
    ON c.parent_rn_id = t.rn_id::integer
  INNER JOIN public.bigtehn_work_orders_cache w
    ON w.id = c.child_rn_id::bigint
  WHERE t.nivo < 10
    AND NOT (c.child_rn_id::bigint = ANY (t.path_idrn))
)
SELECT
  predmet_item_id,
  root_rn_id,
  rn_id,
  parent_rn_id,
  nivo,
  broj_komada,
  path_idrn
FROM tree;

COMMENT ON VIEW public.v_bigtehn_rn_struktura IS
  'Stablo RN-ova: root = MES-aktivan RN sa item_id koji nije dete u tRNKomponente; '
  'nivo 0 = root, dalje rekurzija. path_idrn sprečava ciklus (max 10 nivoa). Isti RN '
  'kao dete više puta moguć ako postoji u više grana.';

-- ----------------------------------------------------------------------------
-- 4) v_bigtehn_rn_root_count — broj root RN-ova po predmetu (badge ekran 1)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bigtehn_rn_root_count
WITH (security_invoker = true) AS
SELECT
  r.predmet_item_id,
  COUNT(*)::integer AS root_count
FROM (
  SELECT DISTINCT
    wo.item_id::bigint AS predmet_item_id,
    wo.id AS root_rn_id
  FROM public.v_active_bigtehn_work_orders wo
  WHERE wo.item_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.bigtehn_rn_components_cache c
      WHERE c.child_rn_id = wo.id::integer
    )
) r
GROUP BY r.predmet_item_id;

COMMENT ON VIEW public.v_bigtehn_rn_root_count IS
  'Agregat: koliko MES-„root" RN-ova (isti kriterijum kao u v_bigtehn_rn_struktura) postoji po predmet_item_id.';

GRANT SELECT ON public.v_bigtehn_rn_struktura TO authenticated;
GRANT SELECT ON public.v_bigtehn_rn_root_count TO authenticated;
