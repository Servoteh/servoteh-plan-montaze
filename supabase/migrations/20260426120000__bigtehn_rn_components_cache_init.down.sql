-- Rollback: 20260426120000__bigtehn_rn_components_cache_init.sql
-- Redosled: view-ovi, pa tabela (RLS i politike padaju sa tabelom).

DROP VIEW IF EXISTS public.v_bigtehn_rn_struktura;
DROP VIEW IF EXISTS public.v_bigtehn_rn_root_count;

DROP TABLE IF EXISTS public.bigtehn_rn_components_cache;
