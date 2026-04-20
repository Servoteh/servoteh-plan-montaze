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
  role      TEXT NOT NULL CHECK (role IN ('admin','leadpm','pm','user','viewer')),
  is_active BOOLEAN NOT NULL DEFAULT true
);

-- Idempotentno dodaje `is_active` ako neka starija verzija CI cache-a vec
-- ima `user_roles` bez te kolone (npr. iz ranijeg bootstrap-a).
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Grant-ovi očekivani u migracijama (PostgREST style).
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
