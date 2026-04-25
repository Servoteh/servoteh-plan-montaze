-- ============================================================================
-- F.7 PILOT HARDENING — L-2: revoke audit_log_cleanup od anon/authenticated
-- ============================================================================
-- Pre ove migracije, RPC `public.audit_log_cleanup(integer)` je SECURITY
-- DEFINER sa EXECUTE granted to anon i authenticated. To znači da bilo
-- koji ulogovan korisnik (čak i anon u teoriji) može da pozove:
--   POST /rest/v1/rpc/audit_log_cleanup
--   { older_than_days: 0 }
-- i obrisati ceo audit_log. Funkcija je očito predviđena za pg_cron
-- ili za admin-ručno održavanje, ne za REST exposure.
--
-- Strategija remedijacije: REVOKE EXECUTE od anon i authenticated.
-- service_role i postgres role ostaju (cron ih može zvati).
--
-- Idempotentno: REVOKE je no-op ako već nema pristupa.
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public.audit_log_cleanup(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.audit_log_cleanup(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.audit_log_cleanup(integer) FROM authenticated;

COMMENT ON FUNCTION public.audit_log_cleanup(integer) IS
  'F.7 (L-2): EXECUTE samo za service_role (pg_cron / admin tooling). '
  'Anon i authenticated revoked.';
