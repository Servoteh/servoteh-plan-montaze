-- Praćenje proizvodnje: kreiraj Faza 2 red u production.radni_nalog iz bigtehn_work_orders_cache
-- kada MES prikaže aktivni RN, a još nema mape (legacy_idrn) u proizvodnji.

BEGIN;

CREATE OR REPLACE FUNCTION production.ensure_radni_nalog_iz_bigtehn(p_work_order_id bigint)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = production, public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_old_legacy int;
  v_rn_broj text;
  v_naziv text;
  v_kupac text;
  v_item int;
  v_rok date;
  v_nap text;
  v_wo int;
BEGIN
  IF p_work_order_id IS NULL OR p_work_order_id <= 0 THEN
    RAISE EXCEPTION 'Neispravan BigTehn radni nalog id';
  END IF;
  IF p_work_order_id > 2147483647 THEN
    RAISE EXCEPTION 'BigTehn id je predugačak za legacy_idrn (int4)';
  END IF;
  v_wo := p_work_order_id::integer;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Moraš biti ulogovan';
  END IF;

  SELECT id INTO v_id
  FROM production.radni_nalog
  WHERE legacy_idrn = v_wo
  LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT
    btrim(w.ident_broj),
    coalesce(nullif(btrim(w.naziv_dela), ''), 'RN ' || btrim(w.ident_broj)),
    nullif(btrim(coalesce(c.name, c.short_name, '')), ''),
    w.item_id::integer,
    (w.rok_izrade AT TIME ZONE 'UTC')::date,
    nullif(btrim(w.napomena), '')
  INTO v_rn_broj, v_naziv, v_kupac, v_item, v_rok, v_nap
  FROM public.bigtehn_work_orders_cache w
  LEFT JOIN public.bigtehn_customers_cache c ON c.id = w.customer_id
  WHERE w.id = p_work_order_id;

  IF v_rn_broj IS NULL OR v_rn_broj = '' THEN
    RAISE EXCEPTION 'BigTehn radni nalog % nije u cache-u ili nema ident_broj', p_work_order_id;
  END IF;

  SELECT id, legacy_idrn
  INTO v_id, v_old_legacy
  FROM production.radni_nalog
  WHERE rn_broj = v_rn_broj
  LIMIT 1;

  PERFORM set_config('row_security', 'off', true);
  BEGIN
    IF v_id IS NOT NULL THEN
      IF v_old_legacy IS NOT NULL AND v_old_legacy <> v_wo THEN
        RAISE EXCEPTION 'RN % je već povezan sa drugim BigTehn nalogom (legacy_idrn=%)', v_rn_broj, v_old_legacy;
      END IF;
      UPDATE production.radni_nalog
         SET legacy_idrn = v_wo,
             naziv = coalesce(nullif(btrim(naziv), ''), v_naziv),
             kupac_text = coalesce(kupac_text, v_kupac),
             napomena = coalesce(napomena, v_nap),
             datum_isporuke = coalesce(datum_isporuke, v_rok),
             legacy_idpredmet = coalesce(legacy_idpredmet, v_item),
             updated_at = now(),
             updated_by = auth.uid()
       WHERE id = v_id;
    ELSE
      INSERT INTO production.radni_nalog (
        projekat_id,
        rn_broj,
        naziv,
        kupac_text,
        datum_isporuke,
        rok_izrade,
        legacy_idrn,
        legacy_idpredmet,
        napomena,
        status,
        created_by,
        updated_by
      )
      VALUES (
        NULL,
        v_rn_broj,
        v_naziv,
        v_kupac,
        v_rok,
        NULL,
        v_wo,
        v_item,
        v_nap,
        'aktivan'::production.rn_status,
        auth.uid(),
        auth.uid()
      )
      RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('row_security', 'on', true);
    RAISE;
  END;
  PERFORM set_config('row_security', 'on', true);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION production.ensure_radni_nalog_iz_bigtehn(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION production.ensure_radni_nalog_iz_bigtehn(bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.ensure_radni_nalog_iz_bigtehn(p_work_order_id bigint)
RETURNS uuid
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.ensure_radni_nalog_iz_bigtehn(p_work_order_id);
$$;

GRANT EXECUTE ON FUNCTION public.ensure_radni_nalog_iz_bigtehn(bigint) TO authenticated;

COMMENT ON FUNCTION production.ensure_radni_nalog_iz_bigtehn(bigint) IS
  'Kreira ili povezuje red u production.radni_nalog iz public.bigtehn_work_orders_cache (MES aktivni RN) za Praćenje proizvodnje.';
COMMENT ON FUNCTION public.ensure_radni_nalog_iz_bigtehn(bigint) IS
  'PostgREST wrapper za production.ensure_radni_nalog_iz_bigtehn.';

NOTIFY pgrst, 'reload schema';

COMMIT;
