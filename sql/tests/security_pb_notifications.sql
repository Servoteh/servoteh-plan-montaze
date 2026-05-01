-- ============================================================================
-- pgTAP: PB notifikacije — GRANT service_role, RLS na config/log
-- ============================================================================
BEGIN;
SET search_path = public, extensions;

SELECT plan(8);

-- ─── Seed admin + običan korisnik (kao security_pb_rls) ───────────────────
SET LOCAL row_security = off;
INSERT INTO public.user_roles (email, role, project_id, is_active) VALUES
  ('pb-admin@test.local', 'admin', NULL, true),
  ('pb-user@test.local', 'viewer', NULL, true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'pb-admin@test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pb-user@test.local')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.pb_notification_config (id, enabled, email_recipients)
VALUES (1, true, ARRAY['ops@test.local']::text[])
ON CONFLICT (id) DO UPDATE SET email_recipients = EXCLUDED.email_recipients;

INSERT INTO public.pb_notification_log (
  id, channel, recipient, body, trigger_type, status, recipient_user_id
) VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'email',
  'pb-user@test.local',
  'test body',
  'deadline_warning',
  'sent',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
) ON CONFLICT (id) DO NOTHING;

SET LOCAL row_security = on;

-- 1) enqueue — authenticated NE SME
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  jsonb_build_object(
    'email', 'pb-user@test.local',
    'sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  )::text,
  true);

SELECT throws_ok(
  $$ SELECT public.pb_enqueue_notifications() $$,
  '42501',
  NULL,
  'authenticated NE može pb_enqueue_notifications'
);

-- 2) dequeue — authenticated NE SME
SELECT throws_ok(
  $$ SELECT * FROM public.pb_dispatch_dequeue(1) $$,
  '42501',
  NULL,
  'authenticated NE može pb_dispatch_dequeue'
);

-- 3) Korisnik vidi svoj red u log-u
SELECT cmp_ok(
  (
    SELECT count(*)::int FROM public.pb_notification_log
    WHERE recipient_user_id = auth.uid()
  ),
  '=',
  1,
  'recipient_user_id = auth.uid() — jedan red'
);

-- 4) Config SELECT radi
SELECT lives_ok(
  $$ SELECT enabled FROM public.pb_notification_config WHERE id = 1 $$,
  'authenticated može SELECT pb_notification_config'
);

-- 5) Config UPDATE — non-admin NE SME
SELECT throws_ok(
  $$ UPDATE public.pb_notification_config SET deadline_warning_days = 5 WHERE id = 1 $$,
  '42501',
  NULL,
  'viewer NE može UPDATE pb_notification_config'
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  jsonb_build_object(
    'email', 'pb-admin@test.local',
    'sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  )::text,
  true);

-- 6) Admin — UPDATE config živi
SELECT lives_ok(
  $$ UPDATE public.pb_notification_config SET deadline_warning_days = 4 WHERE id = 1 $$,
  'admin MOŽE UPDATE pb_notification_config'
);

-- 7) Admin vidi ceo notification log
SELECT cmp_ok(
  (SELECT count(*)::int FROM public.pb_notification_log WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  '>=',
  1,
  'admin vidi red u pb_notification_log'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
