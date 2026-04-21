-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Dodaj admin uloge za Luka Tašić i Milovan Srejić
--
-- Prati obrazac iz sql/migrations/add_admin_roles.sql:
--   - Auth nalog (email + lozinka) se kreira RUČNO u Supabase Dashboard
--     (Authentication → Users → Invite user). Ova migracija NE sadrži
--     nijedan password i ne dodiruje auth.users.
--   - Ovde samo upisujemo mapiranje email → role='admin' u javnu
--     tabelu user_roles, sa must_change_password = TRUE (informativno,
--     prikazuje ⚠ badge u Podešavanjima/Korisnici).
--
-- Idempotentno — bezbedno za re-run.
-- ═══════════════════════════════════════════════════════════

-- 1) Seed nove admin uloge (insert only if missing) ----------------------
INSERT INTO public.user_roles (
  email, role, project_id, is_active, full_name, team,
  must_change_password, created_at, updated_at
)
SELECT v.email, v.role, NULL::uuid, TRUE, v.fname, v.team, TRUE, now(), now()
FROM (VALUES
  ('tasicluka123@gmail.com',  'admin', 'Luka Tašić',     'Administracija'),
  ('srejicmilovan@gmail.com', 'admin', 'Milovan Srejić', 'Administracija')
) AS v(email, role, fname, team)
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_roles ur
  WHERE lower(ur.email) = lower(v.email)
    AND ur.role = v.role
    AND ur.project_id IS NULL
);

-- 2) Re-aktiviraj / dopuni metapodatke ako red već postoji --------------
--    Ne diramo must_change_password da ne bismo resetovali stanje ako
--    je korisnik već postavio svoju lozinku i admin skinuo ⚠.
UPDATE public.user_roles ur
SET    is_active  = TRUE,
       full_name  = COALESCE(NULLIF(ur.full_name, ''), v.fname),
       team       = COALESCE(NULLIF(ur.team, ''),      v.team),
       updated_at = now()
FROM (VALUES
  ('tasicluka123@gmail.com',  'admin', 'Luka Tašić',     'Administracija'),
  ('srejicmilovan@gmail.com', 'admin', 'Milovan Srejić', 'Administracija')
) AS v(email, role, fname, team)
WHERE lower(ur.email) = lower(v.email)
  AND ur.role = v.role
  AND ur.project_id IS NULL;

-- 3) Verifikacija (zakomentarisano) -------------------------------------
-- SELECT email, role, full_name, team, is_active, must_change_password, updated_at
-- FROM   public.user_roles
-- WHERE  lower(email) IN ('tasicluka123@gmail.com','srejicmilovan@gmail.com')
-- ORDER  BY email;
