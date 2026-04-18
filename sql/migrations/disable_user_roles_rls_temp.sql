-- ═══════════════════════════════════════════════════════════
-- TEMP: user_roles RLS DISABLED (svesno, internal tool)
--
-- KONTEKST:
--   Prethodne dve migracije (add_admin_roles.sql i
--   fix_user_roles_rls_recursion.sql) nisu uspele da reše
--   problem da PostgREST API zahtev na /rest/v1/user_roles
--   ne uspeva za authenticated user-a, što je dovodilo do
--   `effectiveRole='viewer'` za sve user-e (uključujući
--   admina) i blokiralo pristup modulima.
--
--   Ovo je primenjeno kao emergency fix dana 2026-04-18 da
--   bi aplikacija ponovo radila. Dijagnoza Network response-a
--   nije završena pa nije utvrđen tačan uzrok (može biti
--   nešto izvan SQL-a — JWT scope, PostgREST cache, helper
--   funkcija permission, itd).
--
-- BEZBEDNOSNI KOMPROMIS:
--   - SELECT na user_roles je otvoren za sve authenticated.
--     → svaki ulogovan user može preko Postman-a videti listu
--       email→role mapping-a (4-5 internih kolega).
--   - INSERT/UPDATE/DELETE su takođe otvoreni za authenticated
--     ako PostgREST GRANT-ovi to dozvoljavaju.
--     → tehnički vičan korisnik može sebi promeniti rolu.
--   - FE i dalje primenjuje gating: canEdit(), canManageUsers(),
--     canAccessKadrovska() — UI je zaštićen.
--
--   Za internu aplikaciju sa 4 poznata user-a — prihvatljivo.
--   NIJE PRIHVATLJIVO ako se broj user-a poveća ili ako se
--   doda osetljivi PII u user_roles (full_name, telefon, itd
--   već postoje pa pažnja).
--
-- KAKO VRATITI PRAVO RLS:
--   Opcija B iz chat-a 2026-04-18: napraviti SECURITY DEFINER
--   funkciju `public.get_my_user_roles()` koja vraća redove
--   za current JWT email, pa FE poziva tu funkciju (preko
--   `/rest/v1/rpc/get_my_user_roles`) umesto direktnog SELECT
--   na user_roles. Onda RLS može da bude DENY ALL osim za
--   admin write preko helper funkcije.
--   Pre toga: pribaviti Network response sa user_roles GET-a
--   da znamo zašto fix_user_roles_rls_recursion.sql nije bio
--   dovoljan.
--
-- Bezbedno za re-run.
-- ═══════════════════════════════════════════════════════════

-- 1) Skini sve postojeće politike na user_roles
DROP POLICY IF EXISTS "user_roles_read_own_or_admin" ON user_roles;
DROP POLICY IF EXISTS "user_roles_read_self"        ON user_roles;
DROP POLICY IF EXISTS "user_roles_read_admin_all"   ON user_roles;
DROP POLICY IF EXISTS "user_roles_admin_write"      ON user_roles;
DROP POLICY IF EXISTS "users_read_own_or_admin"     ON user_roles;
DROP POLICY IF EXISTS "users_admin_write"           ON user_roles;

-- 2) Privremeno isključi RLS na user_roles
ALTER TABLE user_roles DISABLE ROW LEVEL SECURITY;

-- 3) Verifikacija
-- SELECT relrowsecurity AS rls_enabled,
--        (SELECT count(*) FROM pg_policy WHERE polrelid='user_roles'::regclass) AS num_policies
-- FROM   pg_class WHERE relname='user_roles';
-- Očekivano: rls_enabled=f, num_policies=0
