-- ============================================================================
-- F.6 PILOT HARDENING — M-4: forsiranje created_by / updated_by
-- ============================================================================
-- Pre ove migracije, klijent (services/planProizvodnje.js) sam postavlja
-- created_by/updated_by na osnovu state.user.email iz JWT-a, ali RLS ne
-- proverava da li je vrednost koja stigne u payload-u zapravo email
-- ulogovanog korisnika. Pm korisnik može da pošalje:
--   PATCH production_overlays?id=eq.X
--   { shift_note: "lol", updated_by: "admin@firma.rs" }
-- i napiše napomenu kao da je admin (impersonacija u audit trail-u).
--
-- Strategija remedijacije: BEFORE INSERT/UPDATE trigger nadrasta klijent —
-- forsira da te kolone uvek dolaze iz auth.jwt(). Klijent SME da ih šalje
-- (back-compat sa postojećim kodom), ali se vrednosti silentno
-- prebrisuju.
--
-- Pokriva: production_overlays, production_drawings.
--
-- Idempotentno: CREATE OR REPLACE FUNCTION + DROP/CREATE trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.pp_force_audit_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $function$
DECLARE
  v_email text;
  v_uid_text text;
BEGIN
  -- Email iz JWT je primarni izvor; auth.uid() kao fallback (npr. ako
  -- token nema 'email' claim — npr. service-role pozivi sa custom token-om).
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_uid_text := nullif(auth.uid()::text, '');
  IF v_email = '' THEN
    v_email := v_uid_text;  -- fallback ako nema email-a (npr. magic link/anonymous)
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Probaj created_by, pa uploaded_by (production_drawings koristi taj naziv)
    IF TG_TABLE_NAME = 'production_drawings' THEN
      NEW.uploaded_by := COALESCE(v_uid_text::uuid, NEW.uploaded_by);
    ELSE
      NEW.created_by := v_email;
      NEW.updated_by := v_email;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'production_drawings' THEN
      -- production_drawings ima deleted_by (UUID), ostale audit kolone ne menjamo
      IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL THEN
        NEW.deleted_by := COALESCE(v_uid_text::uuid, NEW.deleted_by);
      END IF;
    ELSE
      NEW.updated_by := v_email;
      -- created_by se ne menja na UPDATE-u (ostavljamo OLD)
      NEW.created_by := OLD.created_by;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.pp_force_audit_columns() IS
  'F.6 (M-4): BEFORE INSERT/UPDATE trigger forsira audit kolone iz auth.jwt(), '
  'ne dozvoljava klijentskom payload-u da impersonira drugog korisnika.';

-- Trigger na production_overlays
DROP TRIGGER IF EXISTS po_force_audit_columns ON public.production_overlays;
CREATE TRIGGER po_force_audit_columns
  BEFORE INSERT OR UPDATE ON public.production_overlays
  FOR EACH ROW
  EXECUTE FUNCTION public.pp_force_audit_columns();

-- Trigger na production_drawings
DROP TRIGGER IF EXISTS pd_force_audit_columns ON public.production_drawings;
CREATE TRIGGER pd_force_audit_columns
  BEFORE INSERT OR UPDATE ON public.production_drawings
  FOR EACH ROW
  EXECUTE FUNCTION public.pp_force_audit_columns();
