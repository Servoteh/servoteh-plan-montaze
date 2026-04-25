-- ============================================================================
-- DOWN MIGRATION: Praćenje proizvodnje — public wrapperi za PostgREST
-- ============================================================================
-- Skida public wrapper funkcije i view-ove kreirane u
-- 20260425143000__pracenje_proizvodnje_public_wrappers.sql.
-- Ne dira `production`, `core`, `pdm` šeme.
-- ============================================================================

BEGIN;

-- View-ovi prvo (zavise od underlying tabela, ne od funkcija)
DROP VIEW IF EXISTS public.operativna_aktivnost_blok_istorija;
DROP VIEW IF EXISTS public.prijava_rada;
DROP VIEW IF EXISTS public.v_operativna_aktivnost;
DROP VIEW IF EXISTS public.radnik;
DROP VIEW IF EXISTS public.odeljenje;
DROP VIEW IF EXISTS public.radni_nalog;

-- Wrapper funkcije
DROP FUNCTION IF EXISTS public.promovisi_akcionu_tacku(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.skini_blokadu(uuid, text);
DROP FUNCTION IF EXISTS public.set_blokirano(uuid, text);
DROP FUNCTION IF EXISTS public.zatvori_aktivnost(uuid, text);
DROP FUNCTION IF EXISTS public.upsert_operativna_aktivnost(
  uuid, uuid, uuid, uuid, text, date, date, uuid, uuid,
  production.aktivnost_status, production.aktivnost_prioritet, integer,
  text, text, text, text, uuid, text,
  production.aktivnost_status_mode, text, production.aktivnost_izvor,
  uuid, uuid, uuid
);
DROP FUNCTION IF EXISTS public.get_operativni_plan(uuid, uuid);
DROP FUNCTION IF EXISTS public.get_pracenje_rn(uuid);
DROP FUNCTION IF EXISTS public.can_edit_pracenje(uuid, uuid);

NOTIFY pgrst, 'reload schema';

COMMIT;
