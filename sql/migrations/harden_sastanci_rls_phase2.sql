-- ============================================================================
-- HARDEN sastanci_* RLS (Faza 2 — 2026-04-23) — Model B: ucesnici + management
-- ============================================================================
-- Sta se menja:
--   * Skida se `USING(true)` za SELECT na sastanci, sastanak_ucesnici,
--     presek_aktivnosti, presek_slike, sastanak_arhiva, pm_teme, akcioni_plan.
--   * Nove SELECT politike: korisnik vidi sastanak (i sve njegove pod-zapise)
--     ako je u sastanak_ucesnici za taj sastanak, ili je predlozio temu / vodio
--     sastanak / odgovoran za zadatak, ili je u admin/menadzment ulozi.
--   * `projekt_bigtehn_rn` ostaje `USING(true)` — to je samo veza projekata
--     sa BigTehn RN brojevima, ne osetljiv sadrzaj.
--
-- Sta NE menjamo:
--   * WRITE politike (has_edit_role()) — prebrisane u Fazi 1, prolaze za
--     pm/leadpm/admin/menadzment/hr. Operativno znaci: ko sme da pise i dalje
--     pise; samo READ se suzava.
--
-- Product odluka:
--   User je u Fazi 2 izabrao model B (ucesnici + management). Implementacija:
--     - sastanci-base tabele (sastanci, ucesnici, presek_*, arhiva): SAMO
--       ucesnici sastanka + management, plus eksplicitne uloge (vodio,
--       zapisnicar) na sastanci tabeli.
--     - cross-team workflow tabele (pm_teme, akcioni_plan): predlozio /
--       odgovoran ja, ili vidim parent sastanak (preko is_sastanak_ucesnik),
--       ili sam management. PM-ovi koji nisu u zapisniku NE vide sastanke
--       drugih timova — to je svesna stroza politika nego status quo.
--
--   Ako se ovo pokaze previse strogo u praksi (npr. menadzment-only sedmicni
--   sastanak nije vidljiv operativnom PM-u koji bi voleo da prati), opcija je:
--     - Dodati lead-pm-vidi-sve politiku ovde, ILI
--     - U UI dodati "ucestvuj kao posmatrac" toggle koji INSERT-uje u
--       sastanak_ucesnici sa pozvan=false, prisutan=false.
--
-- Bezbedno za re-run (DROP POLICY IF EXISTS pre svakog CREATE-a).
-- ============================================================================

-- ─── 1) Helper funkcije (SECURITY DEFINER, ne-rekurzivne) ─────────────────

-- a) Da li je ulogovan korisnik admin ili menadzment (jedinstvena management
--    grupa za sastanci modul). Razlikuje se od current_user_is_admin (samo
--    admin) i current_user_is_hr_or_admin (admin/hr/menadzment).
CREATE OR REPLACE FUNCTION public.current_user_is_management()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND  role IN ('admin','menadzment')
      AND  project_id IS NULL
      AND  is_active = TRUE
  );
$$;

COMMENT ON FUNCTION public.current_user_is_management() IS
  'TRUE za globalne admin/menadzment role. Koristi se u sastanci_* RLS politikama '
  'da bi management imao pun pristup svim sastancima nezavisno od ucestvovanja.';

REVOKE ALL    ON FUNCTION public.current_user_is_management() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_is_management() TO   authenticated;

-- b) Da li je ulogovan korisnik u listi ucesnika datog sastanka.
--    SECURITY DEFINER + qualified table access izbegava RLS rekurziju
--    (sastanak_ucesnici politika moze referencirati ovu funkciju).
CREATE OR REPLACE FUNCTION public.is_sastanak_ucesnik(p_sastanak_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.sastanak_ucesnici
    WHERE  sastanak_id = p_sastanak_id
      AND  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
  );
$$;

COMMENT ON FUNCTION public.is_sastanak_ucesnik(UUID) IS
  'TRUE ako je ulogovan korisnik (po JWT email) u listi ucesnika datog '
  'sastanka. Koristi se u sastanci_* RLS politikama za ucesnik-only model.';

REVOKE ALL    ON FUNCTION public.is_sastanak_ucesnik(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_sastanak_ucesnik(UUID) TO   authenticated;

-- ─── 2) sastanci — SELECT samo za ucesnike + uloge + management ───────────
-- Pravilo: vidim sastanak ako sam:
--   * u listi ucesnika (is_sastanak_ucesnik),
--   * vodio sastanka (vodio_email),
--   * zapisnicar (zapisnicar_email),
--   * kreator (created_by_email — vazno: PM koji tek kreira sastanak ne mora
--     odmah da bude na listi ucesnika, ali mora moci da ga otvori i edituje),
--   * admin / menadzment.
DROP POLICY IF EXISTS "sastanci_select" ON public.sastanci;
CREATE POLICY "sastanci_select" ON public.sastanci
  FOR SELECT TO authenticated
  USING (
    public.is_sastanak_ucesnik(id)
    OR public.current_user_is_management()
    OR LOWER(COALESCE(vodio_email, '')) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
    OR LOWER(COALESCE(zapisnicar_email, '')) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
    OR LOWER(COALESCE(created_by_email, '')) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
  );

-- ─── 3) sastanak_ucesnici — SELECT ako vidis parent sastanak ──────────────
-- Svako moze da vidi LISTU ucesnika sastanaka koje vec vidi. Ovo je takodje
-- "moze da vidi sebe" (jer ako si ucesnik, vidis sam sebe u listi).
DROP POLICY IF EXISTS "su_select" ON public.sastanak_ucesnici;
CREATE POLICY "su_select" ON public.sastanak_ucesnici
  FOR SELECT TO authenticated
  USING (
    public.is_sastanak_ucesnik(sastanak_id)
    OR public.current_user_is_management()
  );

-- ─── 4) presek_aktivnosti — SELECT vezuje za parent sastanak ──────────────
DROP POLICY IF EXISTS "pa_select" ON public.presek_aktivnosti;
CREATE POLICY "pa_select" ON public.presek_aktivnosti
  FOR SELECT TO authenticated
  USING (
    public.is_sastanak_ucesnik(sastanak_id)
    OR public.current_user_is_management()
  );

-- ─── 5) presek_slike — isto kao presek_aktivnosti ─────────────────────────
DROP POLICY IF EXISTS "ps_select" ON public.presek_slike;
CREATE POLICY "ps_select" ON public.presek_slike
  FOR SELECT TO authenticated
  USING (
    public.is_sastanak_ucesnik(sastanak_id)
    OR public.current_user_is_management()
  );

-- ─── 6) sastanak_arhiva — isto ────────────────────────────────────────────
DROP POLICY IF EXISTS "sa_select" ON public.sastanak_arhiva;
CREATE POLICY "sa_select" ON public.sastanak_arhiva
  FOR SELECT TO authenticated
  USING (
    public.is_sastanak_ucesnik(sastanak_id)
    OR public.current_user_is_management()
  );

-- ─── 7) pm_teme — predlozio + management + (ucesnik na zakazanom sastanku) ─
-- Razlika u odnosu na sastanci-base: tema mozda jos nije zakazana
-- (sastanak_id IS NULL pri statusu 'predlog'). U tom slucaju vidi je samo
-- predlozioc + management. Cim se tema dodeli sastanku, vide je i ucesnici.
DROP POLICY IF EXISTS "pmt_select" ON public.pm_teme;
CREATE POLICY "pmt_select" ON public.pm_teme
  FOR SELECT TO authenticated
  USING (
    LOWER(COALESCE(predlozio_email, '')) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
    OR public.current_user_is_management()
    OR (sastanak_id IS NOT NULL AND public.is_sastanak_ucesnik(sastanak_id))
  );

-- ─── 8) akcioni_plan — odgovoran + management + ucesnik parent sastanka ───
-- Zadatak moze biti ad-hoc kreiran (sastanak_id IS NULL). U tom slucaju
-- vidi ga samo odgovoran + management. Inace ucesnici sastanka.
DROP POLICY IF EXISTS "ap_select" ON public.akcioni_plan;
CREATE POLICY "ap_select" ON public.akcioni_plan
  FOR SELECT TO authenticated
  USING (
    LOWER(COALESCE(odgovoran_email, '')) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
    OR public.current_user_is_management()
    OR (sastanak_id IS NOT NULL AND public.is_sastanak_ucesnik(sastanak_id))
  );

-- ─── 9) projekt_bigtehn_rn — OSTAJE USING(true) ───────────────────────────
-- Samo veza projekata sa BigTehn RN brojevima. Ne sadrzi osetljive podatke.
-- Ostavljamo eksplicitno bez izmena da ne pravimo regresiju u UI listingu
-- projekata. Politika je vec definisana u add_sastanci_module.sql.

-- ─── 10) Reload PostgREST schema cache ────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ─── 11) Verifikacija ─────────────────────────────────────────────────────
SELECT
  policyname,
  cmd,
  qual
FROM   pg_policies
WHERE  schemaname = 'public'
  AND  tablename IN (
    'sastanci','sastanak_ucesnici','pm_teme','akcioni_plan',
    'presek_aktivnosti','presek_slike','sastanak_arhiva'
  )
  AND  cmd = 'SELECT'
ORDER  BY tablename, policyname;
-- Ne sme da vrati nijednu politiku sa qual = 'true' (sve moraju biti
-- ucesnik/management/owner check-ovi).
