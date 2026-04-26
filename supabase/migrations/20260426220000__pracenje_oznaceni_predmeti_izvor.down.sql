-- Revert na prethodnu logiku (MES distinct item_id). Pokrenuti samo uz potvrdu.

DROP FUNCTION IF EXISTS public.pracenje_ukloni_oznaku(integer);
DROP FUNCTION IF EXISTS public.pracenje_oznaci_predmet(integer);
DROP FUNCTION IF EXISTS production.pracenje_ukloni_oznaku(integer);
DROP FUNCTION IF EXISTS production.pracenje_oznaci_predmet(integer);

DROP TABLE IF EXISTS production.pracenje_oznaceni_predmeti;

-- Izvorne definicije: vidi 20260426203000__pracenje_aktivni_predmeti_init.sql
-- (get_aktivni_predmeti, set_predmet_prioritet, shift_predmet_prioritet)
-- Ako treba potpuni restore, re-run taj fajl za te tri funkcije + public wrapperi + NOTIFY.

NOTIFY pgrst, 'reload schema';
