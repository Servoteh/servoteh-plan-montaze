-- ============================================================================
-- pgTAP: has_edit_role() i current_user_is_admin() — privilege escalation guard
-- ============================================================================
-- Faza 2 security hardening (2026-04-23).
--
-- Verifikuje da SECURITY DEFINER funkcije koje su core auth model:
--   * RETURN false bez JWT-a (anon poziv ne sme da prođe)
--   * RETURN true samo za prave globalne / per-project role
--   * RETURN false za viewer / nepoznat email (privilege escalation guard)
--
-- Sve simulacije rade kroz `request.jwt.claims` GUC koji `auth.jwt()` čita
-- (vidi sql/ci/00_bootstrap.sql za stub funkcije).
--
-- Ne menja stanje baze trajno (BEGIN / ROLLBACK), bezbedno za re-run.
-- ============================================================================

BEGIN;
SET search_path = public, extensions;

SELECT plan(15);

-- ─── Setup: seed-uj user_roles sa različitim profilima ─────────────────────
-- FORCE RLS je aktivna posle enable_user_roles_rls_proper migracije pa cak
-- ni postgres bez JWT-a ne moze direktno da INSERT-uje. Privremeno gasimo
-- row_security GUC za seed (radi za postgres / BYPASSRLS roles).
SET LOCAL row_security = off;
INSERT INTO public.user_roles (email, role, project_id, is_active) VALUES
  ('admin@test.local',      'admin',      NULL, true),
  ('hr@test.local',         'hr',         NULL, true),
  ('menadzment@test.local', 'menadzment', NULL, true),
  ('pm-global@test.local',  'pm',         NULL, true),
  ('viewer@test.local',     'viewer',     NULL, true),
  ('inactive@test.local',   'admin',      NULL, false)
ON CONFLICT DO NOTHING;

-- PM sa per-project rolom (ne globalnom)
INSERT INTO public.user_roles (email, role, project_id, is_active) VALUES
  ('pm-proj@test.local', 'pm', '11111111-1111-1111-1111-111111111111', true)
ON CONFLICT DO NOTHING;
SET LOCAL row_security = on;

-- ── Helper za simulaciju JWT-a u testu ────────────────────────────────────
-- set_config(name, value, is_local) — is_local=true znači da se vraća na
-- ROLLBACK; između test-ova mora se eksplicitno menjati.
CREATE OR REPLACE FUNCTION test_set_jwt_email(p_email text)
RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
                    jsonb_build_object('email', p_email)::text,
                    true);
$$;

CREATE OR REPLACE FUNCTION test_clear_jwt()
RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', '', true);
$$;

-- =========================================================================
-- TEST GROUP A: has_edit_role() bez argumenta (globalni edit)
-- =========================================================================

-- 1) Bez JWT-a — anonimni / iscepani token → FALSE.
SELECT test_clear_jwt();
SELECT is(public.has_edit_role(), false,
  'has_edit_role() bez JWT-a vraca FALSE (anon zastita)');

-- 2) Admin → TRUE.
SELECT test_set_jwt_email('admin@test.local');
SELECT is(public.has_edit_role(), true,
  'has_edit_role() za admin globalno = TRUE');

-- 3) HR → TRUE (Faza 2 oduka: HR moze da menja Kadrovsku).
SELECT test_set_jwt_email('hr@test.local');
SELECT is(public.has_edit_role(), true,
  'has_edit_role() za hr globalno = TRUE');

-- 4) Menadzment → TRUE.
SELECT test_set_jwt_email('menadzment@test.local');
SELECT is(public.has_edit_role(), true,
  'has_edit_role() za menadzment globalno = TRUE');

-- 5) PM globalni → TRUE.
SELECT test_set_jwt_email('pm-global@test.local');
SELECT is(public.has_edit_role(), true,
  'has_edit_role() za pm globalno = TRUE');

-- 6) Viewer → FALSE (privilege escalation guard).
SELECT test_set_jwt_email('viewer@test.local');
SELECT is(public.has_edit_role(), false,
  'has_edit_role() za viewer = FALSE (privilege escalation guard)');

-- 7) Nepoznat email → FALSE.
SELECT test_set_jwt_email('intruder@evil.com');
SELECT is(public.has_edit_role(), false,
  'has_edit_role() za nepoznat email = FALSE');

-- 8) Admin sa is_active=false → FALSE.
SELECT test_set_jwt_email('inactive@test.local');
SELECT is(public.has_edit_role(), false,
  'has_edit_role() za is_active=false admin = FALSE');

-- =========================================================================
-- TEST GROUP B: has_edit_role(proj_id) — per-project rola
-- =========================================================================

-- 9) PM koji ima rolu na drugom projektu → FALSE za tudji projekat (IDOR).
SELECT test_set_jwt_email('pm-proj@test.local');
SELECT is(
  public.has_edit_role('22222222-2222-2222-2222-222222222222'::uuid),
  false,
  'pm sa per-project rolom NE moze da menja tudji projekat (IDOR guard)'
);

-- 10) Isti PM, sa svojim projektom → TRUE.
SELECT is(
  public.has_edit_role('11111111-1111-1111-1111-111111111111'::uuid),
  true,
  'pm sa per-project rolom moze da menja SVOJ projekat'
);

-- 11) Admin (globalno) i dalje moze da menja BILO KOJI projekat.
SELECT test_set_jwt_email('admin@test.local');
SELECT is(
  public.has_edit_role('99999999-9999-9999-9999-999999999999'::uuid),
  true,
  'admin moze da menja bilo koji projekat (globalna rola pobjedjuje)'
);

-- =========================================================================
-- TEST GROUP C: current_user_is_admin()
-- =========================================================================

-- 12) Bez JWT-a → FALSE.
SELECT test_clear_jwt();
SELECT is(public.current_user_is_admin(), false,
  'current_user_is_admin() bez JWT-a vraca FALSE');

-- 13) Admin → TRUE.
SELECT test_set_jwt_email('admin@test.local');
SELECT is(public.current_user_is_admin(), true,
  'current_user_is_admin() za admin = TRUE');

-- 14) HR (ima edit rolu, ali NIJE admin) → FALSE.
SELECT test_set_jwt_email('hr@test.local');
SELECT is(public.current_user_is_admin(), false,
  'current_user_is_admin() za hr = FALSE (admin je strogo admin)');

-- 15) PM → FALSE.
SELECT test_set_jwt_email('pm-global@test.local');
SELECT is(public.current_user_is_admin(), false,
  'current_user_is_admin() za pm = FALSE');

-- ─── Cleanup ──────────────────────────────────────────────────────────────
SELECT test_clear_jwt();
SELECT * FROM finish();
ROLLBACK;
