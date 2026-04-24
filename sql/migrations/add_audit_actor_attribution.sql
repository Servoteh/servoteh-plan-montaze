-- ============================================================================
-- AUDIT ACTOR ATTRIBUTION za service_role pozive (Faza 2 — 2026-04-23)
-- ============================================================================
-- Problem koji resavamo:
--   Edge Functions i Node.js worker-i (workers/loc-sync-mssql,
--   supabase/functions/{hr,maint}-notify-dispatch) pozivaju RPC sa
--   SUPABASE_SERVICE_ROLE_KEY. Kad ti pozivi modifikuju audited tabele
--   (npr. user_roles, kadr_*), trigger audit_row_change() pokusava da
--   procita actor email iz JWT-a. Service-role JWT NEMA `email` claim,
--   pa actor_email ostaje NULL — ne vidi se KO/STA je promenio red.
--
-- Resenje:
--   PostgREST izlaze HTTP header-e u GUC `request.headers` (JSONB).
--   Ako klijent posalje `X-Audit-Actor: <ime-worker-a>`, audit moze da
--   pripise rec konkretnom worker-u/funkciji.
--
--   Dodajemo "trust boundary" — header se prihvata SAMO kad poziv dolazi
--   pod service_role JWT-om. Regular authenticated korisnik NE moze
--   spoofovati actor email-a, jer mu se header ignorise.
--
-- Sta menjamo:
--   * `public.current_user_email()` (originalno iz add_audit_log.sql) —
--     CASE-based logika koja:
--     1) Ako JWT.role = 'service_role' → koristi X-Audit-Actor header,
--        sa fallback-om na literal 'service_role:unknown' (jasno vidljivo
--        u audit_log da neko nije postavio attribution).
--     2) Inace → standardan put preko JWT email-a.
--
-- Sta NE menjamo:
--   * audit_row_change() trigger — nepromenjen (i dalje koristi
--     current_user_email()).
--   * RLS politike koje koriste auth.jwt() (one prate stvarnu autentikaciju,
--     a ne audit attribution — to je odvojen sloj).
--
-- Klijenti koji moraju biti azurirani da bi atribucija imala efekta:
--   * supabase/functions/hr-notify-dispatch/index.ts   → header u rpc()
--   * supabase/functions/maint-notify-dispatch/index.ts → isto
--   * workers/loc-sync-mssql/src/supabaseClient.js      → header u global headers
--
-- Bezbedno za re-run (CREATE OR REPLACE).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE
      /* Trust X-Audit-Actor header SAMO kad je caller service_role.
         To znaci da regular authenticated korisnik NE moze da spoof-uje
         actor email — header se ignorise i fall-back ide na JWT email. */
      WHEN COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
        ''
      ) = 'service_role'
        THEN COALESCE(
          /* PostgREST izlaze sve HTTP header-e (lowercase ime) kao JSONB. */
          NULLIF(
            (NULLIF(current_setting('request.headers', true), '')::jsonb) ->> 'x-audit-actor',
            ''
          ),
          /* Service_role poziv bez X-Audit-Actor header-a — i dalje atribuiramo,
             samo manje precizno. Ovo je vidljivo u audit_log izvestaju i kazuje
             da treba da se popravi worker da posalje header. */
          'service_role:unknown'
        )

      /* Standardni put: regular authenticated korisnik kroz UI / SDK. */
      ELSE COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
        NULLIF(current_setting('request.jwt.claim.email', true), ''),
        NULL
      )
    END;
$$;

COMMENT ON FUNCTION public.current_user_email() IS
  'Vraca actor email za audit_log. Za service_role pozive prihvata X-Audit-Actor '
  'header (Faza 2 hardening, 2026-04-23). Za regular pozive cita email iz JWT-a. '
  'Spoof-zastita: header se ignorise van service_role konteksta.';

-- ─── Verifikacija ────────────────────────────────────────────────────────
-- Bez aktivnog JWT-a: vraca NULL (anonimni poziv ne kvari audit upis).
SELECT public.current_user_email() AS expected_null;

-- Reload PostgREST schema cache da nova logika odmah vazi.
NOTIFY pgrst, 'reload schema';
