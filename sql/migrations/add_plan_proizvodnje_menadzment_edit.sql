-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Plan Proizvodnje — dozvoli edit za rolu `menadzment`
--
-- Šta radi:
--   Redefiniše helper funkciju `public.can_edit_plan_proizvodnje()`
--   tako da `menadzment` rola (uprava) takođe sme da menja
--   `production_overlays` i `production_drawings` (INSERT/UPDATE/
--   DELETE), kao i odgovarajuće storage objekte u bucket-u
--   `production-drawings`.
--
--   RLS politike u `add_plan_proizvodnje.sql` su već vezane za ovu
--   funkciju, tako da ih ne treba ponovo kreirati — dovoljno je
--   zameniti telo funkcije (CREATE OR REPLACE).
--
-- Kontekst:
--   Klijentski gate `canEditPlanProizvodnje()` u `src/state/auth.js`
--   sada uključuje i rolu `menadzment`. Ova migracija sinhronizuje
--   DB sloj sa tim.
--
-- Bezbedno za re-run (CREATE OR REPLACE).
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.can_edit_plan_proizvodnje()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE LOWER(ur.email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND ur.is_active = TRUE
      AND ur.role IN ('admin', 'pm', 'menadzment')
  );
$$;

COMMENT ON FUNCTION public.can_edit_plan_proizvodnje() IS
  'TRUE ako je trenutno autentifikovani user admin, pm (šef mašinske obrade) ili menadzment. Koristi se u RLS politikama nad production_overlays, production_drawings i storage bucket-a production-drawings.';

GRANT EXECUTE ON FUNCTION public.can_edit_plan_proizvodnje() TO authenticated;

-- ── Verifikacija (ručno u SQL Editor-u) ─────────────────────────────────
-- SELECT pg_get_functiondef('public.can_edit_plan_proizvodnje'::regproc);
-- Očekivano: WHERE ur.role IN ('admin', 'pm', 'menadzment').
