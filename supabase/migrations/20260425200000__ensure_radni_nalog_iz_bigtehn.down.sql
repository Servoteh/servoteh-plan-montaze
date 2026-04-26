BEGIN;

DROP FUNCTION IF EXISTS public.ensure_radni_nalog_iz_bigtehn(bigint);
DROP FUNCTION IF EXISTS production.ensure_radni_nalog_iz_bigtehn(bigint);

NOTIFY pgrst, 'reload schema';

COMMIT;
