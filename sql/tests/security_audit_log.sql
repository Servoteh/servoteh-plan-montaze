-- ============================================================================
-- pgTAP: audit_log immutability + admin-only read
-- ============================================================================
-- Faza 2 security hardening (2026-04-23).
--
-- Verifikuje da `audit_log` (vidi sql/migrations/add_audit_log.sql):
--   1) NIJE direktno upisiv sa klijenta (authenticated rola NE moze INSERT
--      / UPDATE / DELETE) — zlonamerni klijent ne moze da krije svoje tragove.
--   2) Trigger `audit_row_change()` UPISUJE rec kad se promeni audited tabela
--      (u CI: user_roles, jedina audit-target koju imamo u bootstrap-u).
--   3) SELECT samo za admina (ostale role dobijaju 0 redova).
--
-- Audit_log politike u testu:
--   * audit_log_select_admin    USING(current_user_is_admin())
--   * audit_log_no_client_write USING(false) WITH CHECK(false)
--
-- Druga politika je FOR ALL → znaci da pokriva i SELECT, ali sa USING(false).
-- Multiple SELECT politike su OR-ovane, pa admin SELECT prolazi (USING true
-- preko prvog), dok non-admin direktni INSERT pada (sve INSERT politike su
-- WITH CHECK(false)).
--
-- Ne menja stanje baze trajno (BEGIN / ROLLBACK).
-- ============================================================================

BEGIN;
SET search_path = public, extensions;

SELECT plan(12);

-- ─── Setup: seed admin u user_roles + ocisti audit_log ────────────────────
SET LOCAL row_security = off;

INSERT INTO public.user_roles (email, role, project_id, is_active) VALUES
  ('audit-admin@test.local', 'admin',  NULL, true),
  ('audit-viewer@test.local','viewer', NULL, true);

-- Ocisti audit_log koji je popunjen prethodnim seed insert-om (trigger
-- na user_roles). Test mora da pocne sa cistom slate-om za audit verifikaciju.
DELETE FROM public.audit_log;

SET LOCAL row_security = on;

-- =========================================================================
-- TEST GROUP A: trigger write — promena user_roles popunjava audit_log
-- =========================================================================

-- 1) UPDATE user_roles kao admin → audit_log dobija novi UPDATE rec.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','audit-admin@test.local')::text,
                  true);
UPDATE public.user_roles SET role='leadpm' WHERE email='audit-viewer@test.local';
RESET ROLE;

-- Resetuj row_security pa procitaj audit_log kao postgres (BYPASSRLS).
SET LOCAL row_security = off;
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.audit_log WHERE table_name='user_roles' AND action='UPDATE'),
  '>=',
  1,
  'trigger upisuje UPDATE rec u audit_log kad se user_roles promeni'
);

-- 2) Audit rec ima ispravan actor_email iz JWT-a.
SELECT is(
  (SELECT actor_email FROM public.audit_log
    WHERE table_name='user_roles' AND action='UPDATE'
    ORDER BY changed_at DESC LIMIT 1),
  'audit-admin@test.local',
  'audit rec ima ispravan actor_email iz JWT-a'
);

-- 3) Audit rec sadrzi diff_keys (sta se promenilo).
SELECT ok(
  (SELECT 'role' = ANY(diff_keys) FROM public.audit_log
    WHERE table_name='user_roles' AND action='UPDATE'
    ORDER BY changed_at DESC LIMIT 1),
  'diff_keys sadrzi promenjeno polje "role"'
);

SET LOCAL row_security = on;

-- =========================================================================
-- TEST GROUP B: direktni write iz klijenta — BLOKIRAN
-- =========================================================================

-- 4) Authenticated (admin u JWT-u) NE MOZE direktno da INSERT-uje u audit_log.
--    Politika audit_log_no_client_write WITH CHECK(false) je RESTRICTIVE-style
--    (FOR ALL USING/WITH CHECK false), ali u PG-u FOR ALL nije RESTRICTIVE
--    automatski — to su PERMISSIVE. ALI: audit_log nema druge INSERT politike,
--    pa multiple-PERMISSIVE OR-ovanje NE pomaze: jedina dostupna INSERT politika
--    je WITH CHECK(false) → INSERT je odbijen sa SQLSTATE 42501.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','audit-admin@test.local')::text,
                  true);

SELECT throws_ok(
  $sql$ INSERT INTO public.audit_log (table_name, action, record_id)
        VALUES ('fake_table','INSERT','99') $sql$,
  '42501',
  NULL,
  'admin NE MOZE direktno INSERT u audit_log (RLS WITH CHECK false)'
);

-- 5) Authenticated NE MOZE da DELETE iz audit_log direktno.
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','audit-admin@test.local')::text,
                  true);
DELETE FROM public.audit_log;
RESET ROLE;

-- Audit_log je i dalje pun (RLS USING false → 0 affected rows, no error).
SET LOCAL row_security = off;
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.audit_log WHERE table_name='user_roles'),
  '>=',
  1,
  'authenticated DELETE na audit_log je no-op (RLS USING false → 0 rows)'
);
SET LOCAL row_security = on;

-- =========================================================================
-- TEST GROUP C: SELECT — admin OK, viewer prazno
-- =========================================================================

-- 6) Admin moze da SELECT-uje audit_log (preko current_user_is_admin policy).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','audit-admin@test.local')::text,
                  true);
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.audit_log),
  '>=',
  1,
  'admin moze da SELECT-uje audit_log'
);
RESET ROLE;

-- 7) Viewer NE vidi nista (RLS filter).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('email','audit-viewer@test.local')::text,
                  true);
SELECT is(
  (SELECT count(*)::int FROM public.audit_log),
  0,
  'viewer NE moze da SELECT-uje audit_log (vidi 0 rec-a, RLS filter)'
);
RESET ROLE;

-- 8) Anonimni / bez JWT-a → 0 rec-a.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '', true);
SELECT is(
  (SELECT count(*)::int FROM public.audit_log),
  0,
  'bez JWT-a — audit_log nedostupan (0 rec-a)'
);
RESET ROLE;

-- =========================================================================
-- TEST GROUP D: service-role audit attribution (Faza 2)
-- =========================================================================
-- Verifikuje add_audit_actor_attribution.sql — current_user_email() prihvata
-- X-Audit-Actor header SAMO uz service_role JWT. Spoof attempt sa regular
-- authenticated korisnikom mora biti ignorisan.

-- 9) Service-role JWT + X-Audit-Actor → email = vrednost iz header-a.
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('role','service_role')::text,
                  true);
SELECT set_config('request.headers',
                  jsonb_build_object('x-audit-actor','test-worker@svr')::text,
                  true);
SELECT is(
  public.current_user_email(),
  'test-worker@svr',
  'service_role + X-Audit-Actor header → email iz header-a'
);

-- 10) Service-role JWT BEZ X-Audit-Actor → fallback 'service_role:unknown'.
SELECT set_config('request.headers', '', true);
SELECT is(
  public.current_user_email(),
  'service_role:unknown',
  'service_role bez X-Audit-Actor header-a → fallback "service_role:unknown"'
);

-- 11) Regular authenticated korisnik POKUSAVA spoof X-Audit-Actor → ignorise se.
SELECT set_config('request.jwt.claims',
                  jsonb_build_object('role','authenticated','email','realuser@test.local')::text,
                  true);
SELECT set_config('request.headers',
                  jsonb_build_object('x-audit-actor','spoofed@evil.com')::text,
                  true);
SELECT is(
  public.current_user_email(),
  'realuser@test.local',
  'regular authenticated NE moze da spoofuje X-Audit-Actor (fallback na JWT email)'
);

-- 12) Bez JWT-a uopste → NULL (anonimni poziv).
SELECT set_config('request.jwt.claims', '', true);
SELECT set_config('request.headers', '', true);
SELECT is(
  public.current_user_email(),
  NULL,
  'bez JWT-a uopste → current_user_email() vraca NULL'
);

-- ─── Cleanup ──────────────────────────────────────────────────────────────
SELECT * FROM finish();
ROLLBACK;
