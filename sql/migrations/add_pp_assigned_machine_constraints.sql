-- ============================================================================
-- F.7 PILOT HARDENING — M-1: FK + CHECK na production_overlays.assigned_machine_code
-- ============================================================================
-- Pre ove migracije, kolona je TEXT bez ikakve validacije. Klijent je
-- mogao da pošalje proizvoljan string ('lol', '\'><script>alert(1)</script>',
-- typo '3.10X', itd.). RLS samo proverava da je korisnik admin/pm/menadzment,
-- ne kakvu vrednost šalje.
--
-- Audit pre primene (potvrđeno):
--   SELECT COUNT(*) FROM production_overlays
--    WHERE assigned_machine_code IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM bigtehn_machines_cache WHERE rj_code = assigned_machine_code);
--   = 0
-- Tj. nema invalidnih vrednosti — bezbedno dodavati FK bez backfill-a.
--
-- Format CHECK:
--   - Dozvoljeno: '2.1', '3.10', '3.9.1', '10.5' (1-2 cifre + tačka + 1-3 cifre,
--     opciono još jedna grupa)
--   - Zabranjeno: '<script>', 'lol', 'machine 5', whitespace, prazan string
--
-- Idempotentno: DROP CONSTRAINT IF EXISTS pre svakog ADD.
-- ============================================================================

-- Skini stare verzije ako postoje (idempotentnost)
ALTER TABLE public.production_overlays
  DROP CONSTRAINT IF EXISTS po_assigned_machine_format;
ALTER TABLE public.production_overlays
  DROP CONSTRAINT IF EXISTS po_assigned_machine_fk;

-- 1) Format CHECK: rj_code je u BigTehn-u uvek "X.Y" ili "X.Y.Z"
--    gde su X, Y, Z cele brojeve (1-3 cifre po segmentu, max 3 segmenta).
--    Dozvoljavamo NULL (= mašina nije reasignovana, koristi se originalna).
ALTER TABLE public.production_overlays
  ADD CONSTRAINT po_assigned_machine_format CHECK (
    assigned_machine_code IS NULL
    OR assigned_machine_code ~ '^[0-9]{1,3}(\.[0-9]{1,3}){1,2}$'
  ) NOT VALID;

-- VALIDATE odvojeno — ako neki postojeći red ne mečuje (ne bi trebalo,
-- audit je pokazao 2 postojeća reda sa kodovima koji mečuju), constraint
-- ostaje "NOT VALID" i admin treba ručno da ispravi pa pozove VALIDATE.
ALTER TABLE public.production_overlays
  VALIDATE CONSTRAINT po_assigned_machine_format;

-- 2) FK na bigtehn_machines_cache.rj_code — sprečava typo i sprečava
--    REASSIGN na nepostojeću mašinu. ON DELETE SET NULL: ako se mašina
--    obriše iz BigTehn-a (npr. dekomisija), reassignment se vraća na
--    NULL (= effective_machine_code postaje original_machine_code, a
--    operacija se ne briše).
ALTER TABLE public.production_overlays
  ADD CONSTRAINT po_assigned_machine_fk
  FOREIGN KEY (assigned_machine_code)
  REFERENCES public.bigtehn_machines_cache(rj_code)
  ON DELETE SET NULL
  ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE public.production_overlays
  VALIDATE CONSTRAINT po_assigned_machine_fk;

COMMENT ON CONSTRAINT po_assigned_machine_format ON public.production_overlays IS
  'F.7 (M-1): rj_code format X.Y ili X.Y.Z, X/Y/Z = 1-3 cifre.';
COMMENT ON CONSTRAINT po_assigned_machine_fk ON public.production_overlays IS
  'F.7 (M-1): FK ka bigtehn_machines_cache. ON DELETE SET NULL (mašina '
  'obrisana → reassignment se vraća na NULL = originalna mašina).';
