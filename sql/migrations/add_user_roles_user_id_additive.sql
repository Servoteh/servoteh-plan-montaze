-- ============================================================================
-- F.7 PILOT HARDENING — H-3 PHASE 1 (additive): user_roles.user_id kolona
-- ============================================================================
-- Pre ove migracije, sve role rezolucije (current_user_role,
-- can_edit_plan_proizvodnje, loc_can_manage_locations, …) rade nad
-- `lower(auth.jwt() ->> 'email')`. Problem: ako admin promeni email
-- korisnika u Supabase Studio, on instant gubi rolu — i šire,
-- email-bazirana auth je krhkija od auth.uid()-bazirane.
--
-- Strategija (3-faza migracija):
--   FAZA 1 (ovaj PR): ADDITIVE — dodaje `user_id uuid` kolonu u
--                     `user_roles`, backfill-uje preko email match-a,
--                     dodaje paralelne SECURITY DEFINER funkcije koje
--                     koriste auth.uid(). Postojeće fn-ovi rade kao pre.
--   FAZA 2 (sledeći PR): refactor svih RLS politika i client koda da
--                        koriste auth.uid() umesto email match-a.
--   FAZA 3 (3. PR): NOT NULL constraint na user_id, deprecate email
--                   lookup, drop legacy fn.
--
-- Razlog za 3 faze: korisnik 'srejicmilovan@gmail.com' (admin) trenutno
-- nema sesiju u auth.users (verovatno legacy / još nije aktivirao). Pre
-- nego što kažemo „auth.uid() je obavezan" treba osigurati da svi aktivni
-- admin-i imaju validan user_id.
--
-- Idempotentno: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE.
-- ============================================================================

-- 1) Dodaj user_id kolonu (UUID, FK ka auth.users, ON DELETE CASCADE
--    — ako se obriše Supabase Auth user, briše se i njegov role red).
ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;

-- 2) Backfill: za svaki red gde auth.users.email = user_roles.email
--    (case-insensitive), set user_id. Korisnici bez auth.users zapisa
--    ostaju sa user_id = NULL (Faza 2 će ih obraditi).
UPDATE public.user_roles ur
SET user_id = u.id
FROM auth.users u
WHERE ur.user_id IS NULL
  AND lower(u.email) = lower(ur.email);

-- 3) Index na user_id (RLS politike u Fazi 2 će često filtirati po njemu).
CREATE INDEX IF NOT EXISTS user_roles_user_id_idx
  ON public.user_roles(user_id) WHERE user_id IS NOT NULL;

-- 4) Paralelne SECURITY DEFINER funkcije koje koriste auth.uid().
--    Klijent i RLS i dalje koriste stare email-bazirane fn-ove;
--    nove su tu da olakšaju Fazu 2 refactor (postepena migracija).

-- current_user_role_v2: prefer user_id match, fallback na email.
CREATE OR REPLACE FUNCTION public.current_user_role_v2()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT COALESCE(
    /* Prefer: user_id match (sigurniji, ne menja se sa email-om) */
    (SELECT lower(role)
       FROM public.user_roles
      WHERE user_id = auth.uid()
        AND is_active = true
      ORDER BY
        CASE lower(role)
          WHEN 'admin' THEN 1 WHEN 'leadpm' THEN 2 WHEN 'pm' THEN 3
          WHEN 'menadzment' THEN 4 WHEN 'hr' THEN 5 WHEN 'viewer' THEN 6
          ELSE 7
        END
      LIMIT 1),
    /* Fallback: email match (legacy korisnici bez user_id) */
    (SELECT lower(role)
       FROM public.user_roles
      WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        AND is_active = true
      ORDER BY
        CASE lower(role)
          WHEN 'admin' THEN 1 WHEN 'leadpm' THEN 2 WHEN 'pm' THEN 3
          WHEN 'menadzment' THEN 4 WHEN 'hr' THEN 5 WHEN 'viewer' THEN 6
          ELSE 7
        END
      LIMIT 1),
    'viewer'
  );
$function$;

-- can_edit_plan_proizvodnje_v2: identičan logici v1 ali preko v2 role.
CREATE OR REPLACE FUNCTION public.can_edit_plan_proizvodnje_v2()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT public.current_user_role_v2() IN ('admin', 'pm', 'menadzment');
$function$;

COMMENT ON COLUMN public.user_roles.user_id IS
  'F.7 (H-3) Faza 1: FK ka auth.users(id). Backfill iz email-a; '
  'NULL za legacy korisnike koji još nisu imali sesiju.';
COMMENT ON FUNCTION public.current_user_role_v2() IS
  'F.7 (H-3) Faza 1: auth.uid() prefer + email fallback. Faza 2 cutover.';
COMMENT ON FUNCTION public.can_edit_plan_proizvodnje_v2() IS
  'F.7 (H-3) Faza 1: paralelno sa can_edit_plan_proizvodnje() (legacy email).';
