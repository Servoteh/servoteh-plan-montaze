-- ============================================================================
-- PLAN PROIZVODNJE / LOKACIJE — ručna lista aktivnih BigTehn RN-ova
-- ============================================================================
-- Poslovno pravilo:
--   Pregledi naloga i tehnoloških postupaka u MES-u prikazuju samo ručno
--   označene aktivne RN-ove. Ovo je NAMERNO odvojeno od BigTehn `StatusRN`
--   (status_rn), jer se MES aktivnost održava ručno po dogovoru.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.production_active_work_orders (
  work_order_id BIGINT PRIMARY KEY,                  -- BigTehn tRN.IDRN
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  reason        TEXT,
  source        TEXT NOT NULL DEFAULT 'manual_seed',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    TEXT
);

CREATE INDEX IF NOT EXISTS production_active_work_orders_active_idx
  ON public.production_active_work_orders (is_active, work_order_id);

DROP TRIGGER IF EXISTS production_active_work_orders_touch_updated_at
  ON public.production_active_work_orders;
CREATE TRIGGER production_active_work_orders_touch_updated_at
  BEFORE UPDATE ON public.production_active_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.production_active_work_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "production active wo: read for authenticated"
  ON public.production_active_work_orders;
CREATE POLICY "production active wo: read for authenticated"
  ON public.production_active_work_orders FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "production active wo: write for plan editors"
  ON public.production_active_work_orders;
CREATE POLICY "production active wo: write for plan editors"
  ON public.production_active_work_orders FOR ALL
  TO authenticated
  USING (public.can_edit_plan_proizvodnje())
  WITH CHECK (public.can_edit_plan_proizvodnje());

-- View za čitanje svih RN-ova sa MES aktivnim flagom.
CREATE OR REPLACE VIEW public.v_bigtehn_work_orders_with_mes_active
WITH (security_invoker = true) AS
SELECT
  wo.*,
  COALESCE(awo.is_active, FALSE) AS is_mes_active,
  awo.reason AS mes_active_reason,
  awo.source AS mes_active_source,
  awo.updated_at AS mes_active_updated_at,
  awo.updated_by AS mes_active_updated_by
FROM public.bigtehn_work_orders_cache wo
LEFT JOIN public.production_active_work_orders awo
  ON awo.work_order_id = wo.id;

-- View za default preglede: samo ručno aktivni RN-ovi.
CREATE OR REPLACE VIEW public.v_active_bigtehn_work_orders
WITH (security_invoker = true) AS
SELECT *
FROM public.v_bigtehn_work_orders_with_mes_active
WHERE is_mes_active IS TRUE;

GRANT SELECT ON public.production_active_work_orders TO authenticated;
GRANT SELECT ON public.v_bigtehn_work_orders_with_mes_active TO authenticated;
GRANT SELECT ON public.v_active_bigtehn_work_orders TO authenticated;

-- ----------------------------------------------------------------------------
-- Initial seed po listi aktivnih naloga iz poslovnog dogovora.
-- `rn_root` je deo pre "/" u BigTehn ident_broj (npr. 9400 iz 9400/267).
-- ----------------------------------------------------------------------------
WITH manual_roots(rn_root, reason) AS (
  VALUES
    ('9811-1', 'Termicka linija - 14. Oktobar'),
    ('9811-2', 'Termicka linija - 14. Oktobar'),
    ('9811-3', 'Termicka linija - 14. Oktobar'),
    ('9811-4', 'Termicka linija - 14. Oktobar'),
    ('9811-5', 'Termicka linija - 14. Oktobar'),
    ('9811-6', 'Termicka linija - 14. Oktobar'),
    ('9400',   'Izrada kosuljica - 14. Oktobar'),
    ('9000',   'AP PERUN'),
    ('7919',   'AP PERUN'),
    ('9531',   'AP PERUN'),
    ('8069',   'Kovacki centar'),
    ('7351',   'Kovacki centar'),
    ('7701',   'Termicka linija otkovaka'),
    ('8034',   'Servotransfer prese'),
    ('8035',   'Servotransfer prese'),
    ('9033',   'Servotransfer prese'),
    ('9034',   'Servotransfer prese'),
    ('9836',   'Frikom'),
    ('9906',   'MBM LUX'),
    ('7918',   'Servoteh - izrada pomocnih alata')
),
matched AS (
  SELECT wo.id AS work_order_id, TRUE AS is_active, mr.reason
  FROM public.bigtehn_work_orders_cache wo
  INNER JOIN manual_roots mr
    ON split_part(trim(wo.ident_broj), '/', 1) = mr.rn_root
),
hap_fluid AS (
  SELECT
    wo.id AS work_order_id,
    CASE
      WHEN NULLIF(substring(split_part(trim(wo.ident_broj), '/', 1) FROM '^\d+'), '')::int >= 8000
        THEN TRUE
      ELSE FALSE
    END AS is_active,
    CASE
      WHEN NULLIF(substring(split_part(trim(wo.ident_broj), '/', 1) FROM '^\d+'), '')::int >= 8000
        THEN 'HAP fluid - RN >= 8000'
      ELSE 'HAP fluid - RN < 8000 zatvoren'
    END AS reason
  FROM public.bigtehn_work_orders_cache wo
  LEFT JOIN public.bigtehn_customers_cache c ON c.id = wo.customer_id
  LEFT JOIN public.bigtehn_items_cache i ON i.id = wo.item_id
  WHERE NULLIF(substring(split_part(trim(wo.ident_broj), '/', 1) FROM '^\d+'), '') IS NOT NULL
    AND (
      concat_ws(' ', c.name, c.short_name) ILIKE '%hap%fluid%'
      OR concat_ws(' ', i.broj_predmeta, i.naziv_predmeta, i.opis) ILIKE '%hap%fluid%'
    )
),
seed_rows AS (
  SELECT * FROM matched
  UNION
  SELECT * FROM hap_fluid
)
INSERT INTO public.production_active_work_orders (work_order_id, is_active, reason, source)
SELECT work_order_id, is_active, reason, 'initial_business_list'
FROM seed_rows
ON CONFLICT (work_order_id) DO NOTHING;

COMMENT ON TABLE public.production_active_work_orders IS
  'Ručna MES lista aktivnih BigTehn RN-ova. Odvojeno od BigTehn status_rn.';

COMMENT ON VIEW public.v_active_bigtehn_work_orders IS
  'BigTehn radni nalozi koje MES ručno tretira kao aktivne.';
