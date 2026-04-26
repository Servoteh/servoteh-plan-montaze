-- ============================================================================
-- pgTAP: user_roles RLS — IDOR + privilege escalation guard
-- ============================================================================
-- Faza 2 security hardening (2026-04-23).
--
-- Verifikuje da `user_roles` RLS politike (sinhrono sa schema.sql i
-- enable_user_roles_rls_proper.sql):
--   1) Obican autentifikovan korisnik vidi SAMO svoj red.
--   2) Admin vidi sve redove.
--   3) Obican autentifikovan korisnik NE moze da menja sopstveni red
--      (sebi da podigne rolu na admin) — privilege escalation guard.
--   4) Obican autentifikovan korisnik NE moze da menja tudji red — IDOR.
--   5) Admin moze da menja sve redove.
--
-- Postgres RLS ponasanje za referencu:
--   * INSERT: WITH CHECK kvar → ERROR "new row violates row-level security policy"
--             (testira se sa throws_ok).
--   * UPDATE/DELETE: USING filter ne baca gresku, samo daje 0 affected rows
--             (testira se SELECT-om posle pokusaja izmene).
--
-- pgTAP testovi se izvrsavaju kao postgres superuser. Da bi RLS politike
-- "udarile", switch-ujemo na `authenticated` rolu sa `SET LOCAL ROLE` i
-- postavljamo `request.jwt.claims` GUC da auth.jwt() vrati pravi email.
-- Posle svake provere vracamo se na postgres rolu da bi unread-and-write
-- seed mogao da se uradi izvan RLS-a.
--
-- Ne menja stanje baze trajno (BEGIN / ROLLBACK).
-- ============================================================================

BEGIN;
SET search_path = public, extensions;

SELECT plan(12);

-- ─── Setup: seed-uj user_roles (kao postgres) ─────────────────────────────
-- FORCE ROW LEVEL SECURITY je aktivna na user_roles posle migracije
-- enable_user_roles_rls_proper.sql, sto znaci da bi cak i postgres morao
-- da prodje RLS WITH CHECK kod INSERT-a (a postgres nema JWT pa admin
-- provera pada). Privremeno gasimo row_security GUC za seed.
SET LOCAL row_security = off;
INSERT INTO public.user_roles (email, role, project_id, is_active) VALUES
  ('admin-rls@test.local',  'admin',  NULL, true),
  ('viewer-rls@test.local', 'viewer', NULL, true),
  ('pm-rls@test.local',     'pm',     NULL, true);
SET LOCAL row_security = on;

-- =========================================================================
-- TEST GROUP A: SELECT politike — read-self + read-admin-all
-- =========================================================================

-- 1) Viewer vidi SAMO svoj red.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','viewer-rls@test.local')::text,
                  true);
SELECT is(
  (SELECT count(*)::int FROM public.user_roles
    WHERE email IN ('admin-rls@test.local','viewer-rls@test.local','pm-rls@test.local')),
  1,
  'viewer vidi SAMO svoj red u user_roles (read-self)'
);

-- 2) Viewer dobija SVOJ email kad upita.
SELECT is(
  (SELECT email FROM public.user_roles WHERE email='viewer-rls@test.local'),
  'viewer-rls@test.local',
  'viewer moze da procita SVOJ red'
);

-- 3) Viewer NE vidi admina (IDOR).
SELECT is(
  (SELECT count(*)::int FROM public.user_roles WHERE email='admin-rls@test.local'),
  0,
  'viewer NE vidi admina (IDOR guard)'
);

-- 4) PM vidi samo svoj red.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','pm-rls@test.local')::text,
                  true);
SELECT is(
  (SELECT count(*)::int FROM public.user_roles
    WHERE email IN ('admin-rls@test.local','viewer-rls@test.local','pm-rls@test.local')),
  1,
  'pm vidi SAMO svoj red'
);

-- 5) Admin vidi SVE seed-ovane redove (preko current_user_is_admin helpera).
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','admin-rls@test.local')::text,
                  true);
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.user_roles
    WHERE email IN ('admin-rls@test.local','viewer-rls@test.local','pm-rls@test.local')),
  '=',
  3,
  'admin vidi sva 3 seed-ovana reda'
);

-- =========================================================================
-- TEST GROUP B: INSERT/UPDATE/DELETE — admin-write only
-- =========================================================================

-- 6) Viewer pokusava da podigne sebi rolu na admin → 0 rows affected,
--    rola ostaje viewer.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','viewer-rls@test.local')::text,
                  true);
UPDATE public.user_roles SET role='admin' WHERE email='viewer-rls@test.local';
RESET ROLE;
SELECT is(
  (SELECT role FROM public.user_roles WHERE email='viewer-rls@test.local'),
  'viewer',
  'viewer rola posle UPDATE OSTAJE viewer (privilege escalation guard)'
);

-- 7) Viewer pokusava da obriše tudji red → DELETE 0 rows.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','viewer-rls@test.local')::text,
                  true);
DELETE FROM public.user_roles WHERE email='admin-rls@test.local';
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.user_roles WHERE email='admin-rls@test.local'),
  1,
  'viewer NE moze da obrise admin red (DELETE filtriran RLS-om)'
);

-- 8) Viewer pokusava INSERT → WITH CHECK violation throws ERROR.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','viewer-rls@test.local')::text,
                  true);
SELECT throws_ok(
  $sql$ INSERT INTO public.user_roles (email, role, project_id, is_active)
        VALUES ('escalated@evil.com', 'admin', NULL, true) $sql$,
  '42501',  -- SQLSTATE: insufficient_privilege (RLS WITH CHECK violation)
  NULL,
  'viewer pokusava INSERT novog admin reda — RLS WITH CHECK odbija (SQLSTATE 42501)'
);
RESET ROLE;
SELECT is(
  (SELECT count(*)::int FROM public.user_roles WHERE email='escalated@evil.com'),
  0,
  'novi admin red NIJE kreiran (privilege escalation guard)'
);

-- 9) Admin MOZE da promeni rolu obicnom korisniku.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','admin-rls@test.local')::text,
                  true);
UPDATE public.user_roles SET role='leadpm' WHERE email='pm-rls@test.local';
RESET ROLE;
SELECT is(
  (SELECT role FROM public.user_roles WHERE email='pm-rls@test.local'),
  'leadpm',
  'admin moze da promeni rolu drugog korisnika'
);

-- 10) Admin MOZE da kreira novog korisnika.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','admin-rls@test.local')::text,
                  true);
INSERT INTO public.user_roles (email, role, project_id, is_active)
  VALUES ('newuser@test.local', 'pm', NULL, true);
RESET ROLE;
SELECT is(
  (SELECT role FROM public.user_roles WHERE email='newuser@test.local'),
  'pm',
  'admin moze da kreira novi user_roles red'
);

-- 11) Admin moze da deaktivira tudjeg admina.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','admin-rls@test.local')::text,
                  true);
INSERT INTO public.user_roles (email, role, project_id, is_active)
  VALUES ('admin2@test.local', 'admin', NULL, true);
UPDATE public.user_roles SET is_active=false WHERE email='admin2@test.local';
RESET ROLE;
SELECT is(
  (SELECT is_active FROM public.user_roles WHERE email='admin2@test.local'),
  false,
  'admin moze da deaktivira drugog admina'
);

-- ─── Cleanup ──────────────────────────────────────────────────────────────
SELECT * FROM finish();
ROLLBACK;
