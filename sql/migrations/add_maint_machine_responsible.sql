-- ============================================================================
-- ODRŽAVANJE — Polje „odgovorni tehničar/operator" po mašini
-- ============================================================================
-- Svrha:
--   Omogućiti filter „Moje" u operativnoj listi `/maintenance/machines`
--   (tehničar/operator vidi samo mašine za koje je on zadužen). Ovo NIJE
--   RLS ograničenje — filtriranje se radi u UI-ju. Poenta je UX, ne sigurnost.
--
--   Vrednost je opciona: ako je NULL, mašina je „neodređena" i u chip-u „Moje"
--   se ne pojavljuje ni kod koga. Postavljanje vrši chief/admin iz kataloga.
--
--   SELECT RLS ostaje isti (`maint_has_floor_read_access`) — svi sa pristupom
--   vide celu listu; polje `responsible_user_id` je informativno.
--
-- Zavisi od: add_maint_machines_catalog.sql
--
-- Pokreni JEDNOM u Supabase SQL Editoru. Idempotentno (ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS).
--
-- DOWN (ručno):
--   DROP INDEX IF EXISTS public.idx_maint_machines_responsible;
--   ALTER TABLE public.maint_machines DROP COLUMN IF EXISTS responsible_user_id;
-- ============================================================================

-- ── 1) Kolona ─────────────────────────────────────────────────────────────
ALTER TABLE public.maint_machines
  ADD COLUMN IF NOT EXISTS responsible_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.maint_machines.responsible_user_id IS
  'Odgovorni tehničar/operator/šef za ovu mašinu. Informativno — koristi se za UI filter „Moje" i prikaz u Pregledu. NIJE RLS ograničenje.';

-- ── 2) Index (filter „Moje" vrti se često) ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_maint_machines_responsible
  ON public.maint_machines (responsible_user_id)
  WHERE responsible_user_id IS NOT NULL;

-- ── 3) View: aktivni katalog sa imenom odgovornog ────────────────────────
--     Koristi se u operativnoj listi kao single-fetch (umesto JOIN-a klijentski
--     na maint_user_profiles). `responsible_full_name` može biti NULL.
CREATE OR REPLACE VIEW public.v_maint_machines_with_responsible
WITH (security_invoker = true) AS
SELECT
  m.machine_code,
  m.name,
  m.type,
  m.manufacturer,
  m.model,
  m.location,
  m.archived_at,
  m.tracked,
  m.responsible_user_id,
  p.full_name AS responsible_full_name,
  p.role      AS responsible_role
FROM public.maint_machines m
LEFT JOIN public.maint_user_profiles p
  ON p.user_id = m.responsible_user_id;

COMMENT ON VIEW public.v_maint_machines_with_responsible IS
  'Katalog mašina + ime odgovornog (JOIN na maint_user_profiles). security_invoker=true — poštuje RLS pozivaoca.';
