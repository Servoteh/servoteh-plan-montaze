-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY HARDENING — Revoke anon SELECT on v_production_operations
-- ═══════════════════════════════════════════════════════════════════════════
-- Datum: 2026-04-23 (Faza 1 enterprise audita)
--
-- Razlog:
--   Migracije `add_v_production_operations.sql` i `add_bigtehn_drawings.sql`
--   su postavile `GRANT SELECT ON public.v_production_operations TO anon`.
--   View denormalizuje 5+ poslovnih tabela (RN-ovi, kupci, mašine, rokovi,
--   nazivi delova) i bio je dostupan SVAKOM HTTP klijentu sa anon ključem
--   (anon ključ je javni — ide u JS bundle).
--
--   Authenticated korisnici i dalje imaju SELECT (politika ostaje
--   netaknuta), tako da UI radi bez ikakve regresije.
--
-- Promene:
--   * REVOKE SELECT ON public.v_production_operations FROM anon
--   * NOTIFY pgrst da PostgREST cache odmah odbaci anon select prava
--
-- DOWN (NE PREPORUČUJE SE):
--   GRANT SELECT ON public.v_production_operations TO anon;
--
-- Bezbedno za re-run (REVOKE od nepostojeće role je no-op).
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE SELECT ON public.v_production_operations FROM anon;

-- Reload PostgREST schema cache da nova permission slika odmah važi.
NOTIFY pgrst, 'reload schema';

-- ─── Verifikacija ──────────────────────────────────────────────────────────
-- Očekivano: samo `authenticated` ima SELECT (i postgres / vlasnik view-a).
SELECT grantee, privilege_type
FROM   information_schema.role_table_grants
WHERE  table_schema = 'public'
  AND  table_name   = 'v_production_operations'
ORDER  BY grantee, privilege_type;
-- Ne sme da vrati: ('anon','SELECT').
