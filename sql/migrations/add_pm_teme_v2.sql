-- ============================================================================
-- PM TEME v2 — "Moje teme", "Hitno", "Za razmatranje", admin rang po projektu
-- + nova rola 'menadzment'
-- ============================================================================
-- Pokreni JEDNOM u Supabase SQL Editoru POSLE add_sastanci_module.sql.
--
-- Šta dodaje:
--   1) ALTER user_roles CHECK constraint da prihvati novu rolu 'menadzment'
--   2) ALTER pm_teme:
--        + hitno BOOLEAN          (svako sebi može da označi temu kao hitnu → crveno)
--        + za_razmatranje BOOLEAN (samo admin → "ide na razmatranje na sledeći sastanak")
--        + admin_rang INT         (samo admin → master prioritet po projektu, 1=najveći)
--   3) Indeks za sortiranje po projektu/rang-u
--   4) View v_pm_teme_pregled — sortiranje po (admin_rang, hitno DESC, prioritet, datum)
--
-- Konvencije:
--   - 'menadzment' rola: kao 'pm', ali član uprave; admin ih može menjati
--   - 'admin_rang' = 1, 2, 3 ... (NULL = neuređeno); manji broj = veći prioritet
--   - 'za_razmatranje' = boolean flag, ne brišemo posle sastanka — ostaje za istoriju
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Proširi user_roles.role CHECK da prihvati 'menadzment'
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- Pokupi sve postojeće CHECK constraintove na user_roles.role i obriši ih.
  -- (Različiti predeci su koristili 'user_roles_role_check', 'user_roles_role_allowed' itd.)
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'public' AND table_name = 'user_roles'
      AND column_name = 'role'
  ) THEN
    ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
    ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_allowed;
  END IF;
END $$;

ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_allowed
  CHECK (role IN ('admin','leadpm','pm','menadzment','hr','viewer'));

-- ----------------------------------------------------------------------------
-- 2) Dodaj kolone u pm_teme
-- ----------------------------------------------------------------------------
ALTER TABLE public.pm_teme
  ADD COLUMN IF NOT EXISTS hitno          BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.pm_teme
  ADD COLUMN IF NOT EXISTS za_razmatranje BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.pm_teme
  ADD COLUMN IF NOT EXISTS admin_rang     INT;

-- Snapshot ko je poslednji menjao admin polja (audit-lite).
ALTER TABLE public.pm_teme
  ADD COLUMN IF NOT EXISTS admin_rang_by_email     TEXT;

ALTER TABLE public.pm_teme
  ADD COLUMN IF NOT EXISTS admin_rang_at           TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- 3) Indeksi
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pm_teme_hitno
  ON public.pm_teme(hitno)
  WHERE hitno = TRUE;

CREATE INDEX IF NOT EXISTS idx_pm_teme_razmatranje
  ON public.pm_teme(za_razmatranje)
  WHERE za_razmatranje = TRUE;

CREATE INDEX IF NOT EXISTS idx_pm_teme_projekat_rang
  ON public.pm_teme(projekat_id, admin_rang NULLS LAST);

-- ----------------------------------------------------------------------------
-- 4) View: v_pm_teme_pregled — sortirano po projektu, sa svim flag-ovima
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_pm_teme_pregled AS
SELECT
  t.*,
  -- "Effective" prioritet za sortiranje:
  --   1) admin_rang ASC NULLS LAST (admin je glavni)
  --   2) za_razmatranje DESC (admin označio = ide gore)
  --   3) hitno DESC (korisnik označio = ide gore)
  --   4) prioritet ASC (1=visok dolazi prvi)
  --   5) predlozio_at DESC (noviji prvi)
  CASE
    WHEN t.za_razmatranje AND t.hitno THEN 'hitno_razmatra'
    WHEN t.za_razmatranje              THEN 'razmatra'
    WHEN t.hitno                        THEN 'hitno'
    ELSE 'normalno'
  END AS visual_tag
FROM public.pm_teme t;

-- ============================================================================
-- 5) Verifikacija
-- ============================================================================
SELECT 'kolone pm_teme' AS sta,
       COUNT(*)::TEXT || ' / 5 dodato (hitno, za_razmatranje, admin_rang, admin_rang_by_email, admin_rang_at)'
       AS rezultat
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pm_teme'
  AND column_name IN ('hitno','za_razmatranje','admin_rang','admin_rang_by_email','admin_rang_at')
UNION ALL
SELECT 'view v_pm_teme_pregled',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.views
         WHERE table_schema='public' AND table_name='v_pm_teme_pregled'
       ) THEN 'OK' ELSE 'NEMA' END
UNION ALL
SELECT 'rola menadzment',
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.check_constraints
         WHERE constraint_schema = 'public'
           AND constraint_name = 'user_roles_role_allowed'
           AND check_clause LIKE '%menadzment%'
       ) THEN 'OK' ELSE 'NEMA' END;
