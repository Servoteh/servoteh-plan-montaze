-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Re-enable RLS na user_roles — proper, bez rekurzije
--
-- Zamena za disable_user_roles_rls_temp.sql (emergency fix iz
-- 2026-04-18 koji je samo isključio RLS).
--
-- Strategija:
--   1) SECURITY DEFINER funkcija public.current_user_is_admin()
--      → radi pod vlasnikom funkcije (postgres), bypass-uje RLS
--      u svom telu, NEMA rekurzije.
--   2) SECURITY DEFINER funkcija public.get_my_user_roles()
--      → vraća role-ove SAMO za trenutno ulogovanog user-a
--      (po email-u iz JWT-a). Backup za FE ako neki budući
--      RLS bug ponovo zaključa direct SELECT.
--   3) RLS enabled, sa politikama:
--      a) user_roles_read_self  — svako vidi SVOJ red (po email iz JWT)
--      b) user_roles_read_admin_all — admin vidi SVE (preko helper-a)
--      c) user_roles_admin_write    — samo admin može INSERT/UPDATE/DELETE
--
-- Posle ovoga:
--   - Login lookup za role-ove RADI za sve (selekt na svoj email).
--   - Lista u Podešavanjima radi SAMO za admina.
--   - Pisanje uloge mogu samo admini.
--
-- Bezbedno za re-run.
-- ═══════════════════════════════════════════════════════════

-- ── 1) SECURITY DEFINER helper: am I admin? ───────────────
CREATE OR REPLACE FUNCTION public.current_user_is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND  role = 'admin'
      AND  is_active = TRUE
  );
$$;

REVOKE ALL    ON FUNCTION public.current_user_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_admin() TO   authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_is_admin() TO   anon;

-- ── 2) RPC za FE: vrati moje role-ove (bezbedan fallback) ─
CREATE OR REPLACE FUNCTION public.get_my_user_roles()
RETURNS TABLE (
  email      TEXT,
  role       TEXT,
  project_id UUID,
  is_active  BOOLEAN
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT email, role, project_id, is_active
  FROM   public.user_roles
  WHERE  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
    AND  is_active = TRUE;
$$;

REVOKE ALL    ON FUNCTION public.get_my_user_roles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_user_roles() TO   authenticated;

-- ── 3) Skini sve postojeće RLS politike (čist start) ──────
DROP POLICY IF EXISTS "user_roles_read_own_or_admin" ON user_roles;
DROP POLICY IF EXISTS "user_roles_read_self"        ON user_roles;
DROP POLICY IF EXISTS "user_roles_read_admin_all"   ON user_roles;
DROP POLICY IF EXISTS "user_roles_admin_write"      ON user_roles;
DROP POLICY IF EXISTS "users_read_own_or_admin"     ON user_roles;
DROP POLICY IF EXISTS "users_admin_write"           ON user_roles;

-- ── 4) Uključi RLS ────────────────────────────────────────
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

-- ── 5) Nove politike (bez rekurzije!) ─────────────────────

-- 5a) Svako autentifikovan vidi SVOJ red. Bez podupita iz user_roles.
CREATE POLICY "user_roles_read_self" ON user_roles
  FOR SELECT
  TO authenticated
  USING (
    LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
  );

-- 5b) Admin vidi SVE redove (preko SECURITY DEFINER helper-a).
CREATE POLICY "user_roles_read_admin_all" ON user_roles
  FOR SELECT
  TO authenticated
  USING ( public.current_user_is_admin() );

-- 5c) Pisanje (INSERT/UPDATE/DELETE) — samo admin.
CREATE POLICY "user_roles_admin_write" ON user_roles
  FOR ALL
  TO authenticated
  USING      ( public.current_user_is_admin() )
  WITH CHECK ( public.current_user_is_admin() );

-- ── 6) Reload PostgREST schema cache (da nove RPC funkcije
--      budu odmah dostupne preko REST API-ja) ──────────────
NOTIFY pgrst, 'reload schema';

-- ── 7) Verifikacija ───────────────────────────────────────
SELECT
  (SELECT relrowsecurity FROM pg_class WHERE relname='user_roles')        AS rls_enabled,
  (SELECT count(*) FROM pg_policy WHERE polrelid='user_roles'::regclass)  AS num_policies,
  EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname='current_user_is_admin' AND pronamespace='public'::regnamespace
  )                                                                       AS has_admin_helper,
  EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname='get_my_user_roles'    AND pronamespace='public'::regnamespace
  )                                                                       AS has_my_roles_rpc;
-- Treba: rls_enabled=t, num_policies=3, has_admin_helper=t, has_my_roles_rpc=t
