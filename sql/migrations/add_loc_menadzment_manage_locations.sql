-- LOKACIJE — uključi rolu `menadzment` u `loc_can_manage_locations()`
-- (INSERT/UPDATE master lokacija + u skladu sa `canEdit()` u src/state/auth.js)

CREATE OR REPLACE FUNCTION public.loc_can_manage_locations()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.loc_auth_roles() && ARRAY['admin', 'leadpm', 'pm', 'menadzment']::text[];
$$;

COMMENT ON FUNCTION public.loc_can_manage_locations() IS
  'TRUE ako korisnik ima jednu od globalnih uloga: admin, leadpm, pm, menadzment. Koristi RLS na loc_locations.';
