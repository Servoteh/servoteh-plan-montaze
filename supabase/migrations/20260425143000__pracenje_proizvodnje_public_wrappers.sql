-- ============================================================================
-- DRAFT MIGRATION: Praćenje proizvodnje — public wrapperi za PostgREST
-- ============================================================================
-- Razlog:
--   Inkrement 1 je sve nove RPC-e i tabele stavio u šeme `production`, `core`,
--   `pdm`. Supabase PostgREST po defaultu izlaže samo `public` (uz
--   `graphql_public, storage`), pa svi pozivi iz frontenda (rpc/get_pracenje_rn,
--   rpc/can_edit_pracenje, /rest/v1/odeljenje, /rest/v1/v_operativna_aktivnost,
--   …) vraćaju 404.
--   Posledica je da `canEditPracenje()` u `try/catch` interpretira 404 kao
--   FALSE i admin-i dobijaju read-only UI iako u bazi imaju puna prava.
--
--   Ova migracija dodaje:
--     1) public SQL wrapper funkcije za 8 RPC-a iz `production` šeme,
--     2) public read-only view-ove sa `security_invoker = true` za 6 tabela
--        koje UI traži preko PostgREST-a.
--
--   RLS i security definer logika ostaju netaknuti — wrapper-i samo prosleđuju
--   pozive ka stvarnim funkcijama / tabelama u nepublic šemama.
--
-- Zavisi od:
--   supabase/migrations/20260425124400__pracenje_proizvodnje_init.sql
-- ============================================================================

BEGIN;

-- ===== SEKCIJA 1 — RPC wrapperi =============================================

CREATE OR REPLACE FUNCTION public.can_edit_pracenje(
  p_project_id uuid DEFAULT NULL,
  p_rn_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.can_edit_pracenje(p_project_id, p_rn_id);
$$;

CREATE OR REPLACE FUNCTION public.get_pracenje_rn(p_rn_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.get_pracenje_rn(p_rn_id);
$$;

CREATE OR REPLACE FUNCTION public.get_operativni_plan(
  p_rn_id uuid DEFAULT NULL,
  p_projekat_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.get_operativni_plan(p_rn_id, p_projekat_id);
$$;

CREATE OR REPLACE FUNCTION public.upsert_operativna_aktivnost(
  p_id uuid,
  p_radni_nalog_id uuid,
  p_projekat_id uuid,
  p_odeljenje_id uuid,
  p_naziv_aktivnosti text,
  p_planirani_pocetak date,
  p_planirani_zavrsetak date,
  p_odgovoran_user_id uuid,
  p_odgovoran_radnik_id uuid,
  p_status production.aktivnost_status,
  p_prioritet production.aktivnost_prioritet,
  p_rb integer,
  p_opis text,
  p_broj_tp text,
  p_kolicina_text text,
  p_odgovoran_label text,
  p_zavisi_od_aktivnost_id uuid,
  p_zavisi_od_text text,
  p_status_mode production.aktivnost_status_mode,
  p_rizik_napomena text,
  p_izvor production.aktivnost_izvor,
  p_izvor_akcioni_plan_id uuid,
  p_izvor_pozicija_id uuid,
  p_izvor_tp_operacija_id uuid
) RETURNS uuid
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.upsert_operativna_aktivnost(
    p_id,
    p_radni_nalog_id,
    p_projekat_id,
    p_odeljenje_id,
    p_naziv_aktivnosti,
    p_planirani_pocetak,
    p_planirani_zavrsetak,
    p_odgovoran_user_id,
    p_odgovoran_radnik_id,
    p_status,
    p_prioritet,
    p_rb,
    p_opis,
    p_broj_tp,
    p_kolicina_text,
    p_odgovoran_label,
    p_zavisi_od_aktivnost_id,
    p_zavisi_od_text,
    p_status_mode,
    p_rizik_napomena,
    p_izvor,
    p_izvor_akcioni_plan_id,
    p_izvor_pozicija_id,
    p_izvor_tp_operacija_id
  );
$$;

CREATE OR REPLACE FUNCTION public.zatvori_aktivnost(p_id uuid, p_napomena text)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.zatvori_aktivnost(p_id, p_napomena);
$$;

CREATE OR REPLACE FUNCTION public.set_blokirano(p_id uuid, p_razlog text)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.set_blokirano(p_id, p_razlog);
$$;

CREATE OR REPLACE FUNCTION public.skini_blokadu(p_id uuid, p_napomena text)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.skini_blokadu(p_id, p_napomena);
$$;

CREATE OR REPLACE FUNCTION public.promovisi_akcionu_tacku(
  p_akcioni_plan_id uuid,
  p_odeljenje_id uuid,
  p_rn_id uuid
) RETURNS uuid
LANGUAGE sql
VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT production.promovisi_akcionu_tacku(p_akcioni_plan_id, p_odeljenje_id, p_rn_id);
$$;

GRANT EXECUTE ON FUNCTION public.can_edit_pracenje(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pracenje_rn(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_operativni_plan(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_operativna_aktivnost(
  uuid, uuid, uuid, uuid, text, date, date, uuid, uuid,
  production.aktivnost_status, production.aktivnost_prioritet, integer,
  text, text, text, text, uuid, text,
  production.aktivnost_status_mode, text, production.aktivnost_izvor,
  uuid, uuid, uuid
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.zatvori_aktivnost(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_blokirano(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.skini_blokadu(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promovisi_akcionu_tacku(uuid, uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.can_edit_pracenje(uuid, uuid)
  IS 'PostgREST wrapper za production.can_edit_pracenje (Inkrement 3 hotfix).';
COMMENT ON FUNCTION public.get_pracenje_rn(uuid)
  IS 'PostgREST wrapper za production.get_pracenje_rn (Inkrement 3 hotfix).';
COMMENT ON FUNCTION public.get_operativni_plan(uuid, uuid)
  IS 'PostgREST wrapper za production.get_operativni_plan (Inkrement 3 hotfix).';
COMMENT ON FUNCTION public.upsert_operativna_aktivnost(
  uuid, uuid, uuid, uuid, text, date, date, uuid, uuid,
  production.aktivnost_status, production.aktivnost_prioritet, integer,
  text, text, text, text, uuid, text,
  production.aktivnost_status_mode, text, production.aktivnost_izvor,
  uuid, uuid, uuid
) IS 'PostgREST wrapper za production.upsert_operativna_aktivnost (Inkrement 3 hotfix).';
COMMENT ON FUNCTION public.zatvori_aktivnost(uuid, text)
  IS 'PostgREST wrapper za production.zatvori_aktivnost (Inkrement 3 hotfix).';
COMMENT ON FUNCTION public.set_blokirano(uuid, text)
  IS 'PostgREST wrapper za production.set_blokirano (Inkrement 3 hotfix).';
COMMENT ON FUNCTION public.skini_blokadu(uuid, text)
  IS 'PostgREST wrapper za production.skini_blokadu (Inkrement 3 hotfix).';
COMMENT ON FUNCTION public.promovisi_akcionu_tacku(uuid, uuid, uuid)
  IS 'PostgREST wrapper za production.promovisi_akcionu_tacku (Inkrement 3 hotfix).';

-- ===== SEKCIJA 2 — View-ovi za PostgREST =====================================

CREATE OR REPLACE VIEW public.radni_nalog
  WITH (security_invoker = true) AS
  SELECT * FROM production.radni_nalog;

CREATE OR REPLACE VIEW public.odeljenje
  WITH (security_invoker = true) AS
  SELECT * FROM core.odeljenje;

CREATE OR REPLACE VIEW public.radnik
  WITH (security_invoker = true) AS
  SELECT * FROM core.radnik;

CREATE OR REPLACE VIEW public.v_operativna_aktivnost
  WITH (security_invoker = true) AS
  SELECT * FROM production.v_operativna_aktivnost;

CREATE OR REPLACE VIEW public.prijava_rada
  WITH (security_invoker = true) AS
  SELECT * FROM production.prijava_rada;

CREATE OR REPLACE VIEW public.operativna_aktivnost_blok_istorija
  WITH (security_invoker = true) AS
  SELECT * FROM production.operativna_aktivnost_blok_istorija;

GRANT SELECT ON public.radni_nalog TO authenticated;
GRANT SELECT ON public.odeljenje TO authenticated;
GRANT SELECT ON public.radnik TO authenticated;
GRANT SELECT ON public.v_operativna_aktivnost TO authenticated;
GRANT SELECT ON public.prijava_rada TO authenticated;
GRANT SELECT ON public.operativna_aktivnost_blok_istorija TO authenticated;

COMMENT ON VIEW public.radni_nalog
  IS 'PostgREST proxy za production.radni_nalog (security_invoker=true). Sluzi za picker u UI-u za izbor RN-a.';
COMMENT ON VIEW public.odeljenje
  IS 'PostgREST proxy za core.odeljenje (security_invoker=true). RLS se ocenjuje na underlying tabeli.';
COMMENT ON VIEW public.radnik
  IS 'PostgREST proxy za core.radnik (security_invoker=true). RLS se ocenjuje na underlying tabeli.';
COMMENT ON VIEW public.v_operativna_aktivnost
  IS 'PostgREST proxy za production.v_operativna_aktivnost (security_invoker=true).';
COMMENT ON VIEW public.prijava_rada
  IS 'PostgREST proxy za production.prijava_rada (security_invoker=true). RLS se ocenjuje na underlying tabeli.';
COMMENT ON VIEW public.operativna_aktivnost_blok_istorija
  IS 'PostgREST proxy za production.operativna_aktivnost_blok_istorija (security_invoker=true).';

-- ===== SEKCIJA 3 — Refresh PostgREST cache ===================================

NOTIFY pgrst, 'reload schema';

COMMIT;
