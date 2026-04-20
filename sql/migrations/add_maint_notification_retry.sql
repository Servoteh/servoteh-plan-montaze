-- ============================================================================
-- ODRŽAVANJE — retry RPC za `maint_notification_log`
-- ============================================================================
-- Zavisi od `add_maint_notification_outbox.sql` (attempts/next_attempt_at kolone).
--
-- Koristi ga UI („Obaveštenja” tab, chief/admin): vraća jedan red iz statusa
-- 'failed' (ili 'sent' ako je greškom poslato) u 'queued' da worker ponovi
-- pokušaj. Ne resetuje `attempts` na 0 — samo spušta ispod `max_attempts` da
-- dequeue može ponovo da ga uzme.
--
-- Dozvoljen je ERP admin-u i maint chief/admin profilu.
-- Pokreni u Supabase SQL Editoru. Idempotentno.
--
-- DOWN (ručno):
--   DROP FUNCTION IF EXISTS public.maint_notification_retry(uuid);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.maint_notification_retry(
  p_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed BOOLEAN;
BEGIN
  v_allowed := public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_notification_retry: not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE public.maint_notification_log
     SET status          = 'queued',
         error           = NULL,
         next_attempt_at = now(),
         /* Spusti attempts na max-1 = 7 ako je dostigao plafon, inače zadrži. */
         attempts        = LEAST(attempts, 7)
   WHERE id = p_id;

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.maint_notification_retry(uuid) IS
  'Vraća notifikaciju u queue (retry) — chief/admin ili ERP admin.';

REVOKE ALL ON FUNCTION public.maint_notification_retry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.maint_notification_retry(uuid) TO authenticated;
