-- =========================================================================
-- CI BOOTSTRAP — stubuje Supabase-specifične primitive za plain Postgres 15+
-- =========================================================================
-- NE koristi u produkciji. Koristi se samo u GitHub Actions / lokalnom Docker-u
-- za potrebe izvršavanja pgTAP testova nad `loc_*` i sličnim modulima.
--
-- Stubuje:
--   * role: authenticated, anon, service_role
--   * extension: pgcrypto (za gen_random_uuid()), pgtap (za testove)
--   * schema: auth + tabela auth.users + funkcije auth.uid() i auth.jwt()
--   * schema: extensions (prazan placeholder — pg_cron migracija se preskače)
--   * public.user_roles — minimalna tabela koju referenciraju RLS politike
--
-- Dizajn nota: sve je NOLOGIN, bez šifara — CI koristi isključivo postgres ulogu.
-- =========================================================================

\set ON_ERROR_STOP 1

-- ── Role ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE anon NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Ekstenzije ──────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pgtap;

-- Placeholder schema `extensions` (Supabase je koristi za pg_cron; CI preskače).
CREATE SCHEMA IF NOT EXISTS extensions;

-- ── auth schema + stub-ovi ──────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

/* Stub auth.uid() — vraća GUC "request.jwt.claim.sub" ako je postavljen
 * (tako pgTAP testovi mogu simulirati ulogovanog korisnika preko SET LOCAL).
 * U produkciji Supabase obezbeđuje native implementaciju — ne diramo. */
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v_sub TEXT := current_setting('request.jwt.claim.sub', true);
BEGIN
  IF v_sub IS NULL OR v_sub = '' THEN
    RETURN NULL;
  END IF;
  RETURN v_sub::UUID;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  v TEXT := current_setting('request.jwt.claims', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RETURN '{}'::JSONB;
  END IF;
  RETURN v::JSONB;
EXCEPTION WHEN others THEN
  RETURN '{}'::JSONB;
END;
$fn$;

-- ── public.user_roles — minimalni shape koji koriste RLS politike ───────
-- NB: produkcioni shape ima vise kolona (project_id, full_name, team, itd.) —
-- ovde drzimo samo one na koje se oslanja loc_* / ostali moduli (email, role,
-- is_active). Ako neka buduca migracija zahteva neku drugu kolonu, dopuni je
-- ovde (ili uradi `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`) da CI prode.
CREATE TABLE IF NOT EXISTS public.user_roles (
  email     TEXT PRIMARY KEY,
  role      TEXT NOT NULL CHECK (role IN ('admin','leadpm','pm','user','viewer','hr','menadzment')),
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- Idempotentno dodaje `is_active` ako neka starija verzija CI cache-a vec
-- ima `user_roles` bez te kolone (npr. iz ranijeg bootstrap-a).
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Globalni odnos (NULL = nije projekat-specifičan red) — potrebno za
-- `add_maintenance_module.sql` / `maint_is_erp_admin()` i srodne upite.
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS project_id UUID;

-- Uskladi CHECK sa Faza 2 pgTAP (hr, menadzment) ako je tabela starija verzija.
DO $$
BEGIN
  ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
  ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
    CHECK (role IN ('admin','leadpm','pm','user','viewer','hr','menadzment'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Stub BigTehn cache: `add_maintenance_module.sql` i `add_maint_machines_catalog.sql`
-- referenciraju ovu tabelu (view + seed), ali kompletan shape dolazi u produkciji
-- iz plan-proizvodnje synca. U CI zadržavamo min. kolone koje očekuje seed/view.
CREATE TABLE IF NOT EXISTS public.bigtehn_machines_cache (
  rj_code         TEXT PRIMARY KEY,
  name            TEXT,
  department_id   TEXT,
  no_procedure    BOOLEAN NOT NULL DEFAULT FALSE
);

-- Minimalni stub za FK iz pb_tasks → projects / employees (produkcija puni pun shape).
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_code TEXT NOT NULL DEFAULT '',
  project_name TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_projects_code ON public.projects(project_code);

CREATE TABLE IF NOT EXISTS public.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL DEFAULT '',
  department TEXT DEFAULT '',
  email TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Minimalni org stub za pb_get_load_stats filter (produkcija: add_kadr_org_structure.sql).
CREATE TABLE IF NOT EXISTS public.departments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.sub_departments (
  id SERIAL PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0
);
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES public.departments(id),
  ADD COLUMN IF NOT EXISTS sub_department_id INTEGER REFERENCES public.sub_departments(id);
INSERT INTO public.departments (id, name, sort_order) VALUES (5, 'Inženjering i projektovanje', 40)
  ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('public.departments', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.departments), 5));
INSERT INTO public.sub_departments (id, department_id, name, sort_order)
VALUES (5001, 5, 'Mašinsko projektovanje', 20)
  ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('public.sub_departments', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM public.sub_departments), 5001));

-- Grant-ovi očekivani u migracijama (PostgREST style).
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
-- Tabela: RLS odlučuje redove; ipak treba tabelni GRANT (pgTAP kao authenticated).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;

-- ── Dummy test korisnici ────────────────────────────────────────────────
-- Neki pgTAP testovi referenciraju `auth.users(id)` preko FK (npr. moved_by
-- u loc_location_movements). Seedujemo dva stabilna UUID-a kako bi insert-i
-- u testovima prošli bez potrebe da svaki test ručno kreira korisnika.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'pgtap-user-1@ci.local'),
  ('00000000-0000-0000-0000-000000000002', 'pgtap-user-2@ci.local')
ON CONFLICT (id) DO NOTHING;
