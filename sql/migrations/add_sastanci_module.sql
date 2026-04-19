-- ============================================================================
-- MODUL SASTANCI — Sprint S1+S2+S3 (jedna migracija)
-- ============================================================================
-- Pokreni JEDNOM u Supabase SQL Editoru.
--
-- Šta dodaje:
--   1) projekt_bigtehn_rn       — N:M veza projects ↔ BigTehn RN
--   2) sastanci                 — sedmični + projektni sastanci
--   3) sastanak_ucesnici        — učesnici (po email-u)
--   4) pm_teme                  — teme za sedmične sastanke (predlog/usvojeno/odbijeno)
--   5) akcioni_plan             — akcioni zaključci sa rokom i odgovornim
--   6) presek_aktivnosti        — hijerarhijski rich-text odeljci za projektne sastanke
--   7) presek_slike             — slike po aktivnosti (Storage)
--   8) sastanak_arhiva          — JSONB snapshot pri zaključavanju + opciono PDF
--   9) Storage bucket "sastanak-slike" + RLS policies
--
-- Konvencije:
--   - email kao primarni identifier korisnika (parity sa user_roles)
--   - has_edit_role() reuse iz schema.sql (true za sve auth)
--   - "vodio_email" + "vodio_label" snapshot polja da se ime ne menja
--     ako se nakon sastanka promeni u user_roles
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0) projekt_bigtehn_rn — opciona veza projekta (UUID iz projects) sa
--    BigTehn radnim nalogom (id iz bigtehn_work_orders_cache, BIGINT).
--    Ovo je M:N — jedan projekat može imati više BigTehn RN-ova
--    (npr. RN 9400 obuhvata 9400/1, /2, /3, /4, /5, /6, /7).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projekt_bigtehn_rn (
  projekat_id           UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  bigtehn_rn_id         BIGINT NOT NULL,
  napomena              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (projekat_id, bigtehn_rn_id)
);
CREATE INDEX IF NOT EXISTS idx_pbr_rn ON public.projekt_bigtehn_rn(bigtehn_rn_id);

-- ----------------------------------------------------------------------------
-- 1) sastanci
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sastanci (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'sedmicni' = redovni sedmični (PM teme + akcioni plan)
  -- 'projektni' = projektni / presek stanja (per-projekat, sa slikama)
  tip                   TEXT NOT NULL DEFAULT 'sedmicni'
                          CHECK (tip IN ('sedmicni', 'projektni')),

  naslov                TEXT NOT NULL,
  datum                 DATE NOT NULL,
  vreme                 TIME,
  mesto                 TEXT DEFAULT '',

  -- Za projektne sastanke obavezno; za sedmične NULL.
  projekat_id           UUID REFERENCES public.projects(id) ON DELETE SET NULL,

  -- "M. Stojadinović" — snapshot da se ne menja kad se promeni user_roles.
  vodio_email           TEXT,
  vodio_label           TEXT,

  zapisnicar_email      TEXT,
  zapisnicar_label      TEXT,

  status                TEXT NOT NULL DEFAULT 'planiran'
                          CHECK (status IN ('planiran', 'u_toku', 'zavrsen', 'zakljucan')),

  -- Kad je status='zakljucan', sve je read-only i postoji red u sastanak_arhiva.
  zakljucan_at          TIMESTAMPTZ,
  zakljucan_by_email    TEXT,

  napomena              TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_email      TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sastanci_datum ON public.sastanci(datum DESC);
CREATE INDEX IF NOT EXISTS idx_sastanci_tip ON public.sastanci(tip);
CREATE INDEX IF NOT EXISTS idx_sastanci_projekat ON public.sastanci(projekat_id);
CREATE INDEX IF NOT EXISTS idx_sastanci_status ON public.sastanci(status);

-- ----------------------------------------------------------------------------
-- 2) sastanak_ucesnici
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sastanak_ucesnici (
  sastanak_id           UUID NOT NULL REFERENCES public.sastanci(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  label                 TEXT,                       -- snapshot punog imena
  prisutan              BOOLEAN NOT NULL DEFAULT TRUE,
  pozvan                BOOLEAN NOT NULL DEFAULT TRUE,
  napomena              TEXT,
  PRIMARY KEY (sastanak_id, email)
);

-- ----------------------------------------------------------------------------
-- 3) pm_teme
--    Slobodne predložene teme za sedmični sastanak. PM-ovi unose, rukovodstvo
--    odobrava/odbija. Posle 'usvojeno' tema postaje deo dnevnog reda.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pm_teme (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Vrsta teme (kategorizacija u UI):
  vrsta                 TEXT NOT NULL DEFAULT 'tema'
                          CHECK (vrsta IN ('tema', 'problem', 'predlog', 'rizik', 'pitanje')),

  -- Oblast / domain:
  oblast                TEXT NOT NULL DEFAULT 'opste'
                          CHECK (oblast IN ('opste', 'proizvodnja', 'montaza', 'nabavka',
                                            'kadrovi', 'finansije', 'kvalitet', 'klijent', 'ostalo')),

  naslov                TEXT NOT NULL,
  opis                  TEXT,

  -- Veza ka projektu (opciono).
  projekat_id           UUID REFERENCES public.projects(id) ON DELETE SET NULL,

  -- Status approval workflow:
  status                TEXT NOT NULL DEFAULT 'predlog'
                          CHECK (status IN ('predlog', 'usvojeno', 'odbijeno', 'odlozeno', 'zatvoreno')),

  prioritet             INT NOT NULL DEFAULT 2 CHECK (prioritet IN (1, 2, 3)),
  -- 1 = visok, 2 = srednji, 3 = nizak

  -- Sastanak na koji je tema dodeljena (kad postane 'usvojeno'). NULL = nije zakazana.
  sastanak_id           UUID REFERENCES public.sastanci(id) ON DELETE SET NULL,

  predlozio_email       TEXT NOT NULL,
  predlozio_label       TEXT,
  predlozio_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  resio_email           TEXT,                       -- ko je odobrio/odbio
  resio_label           TEXT,
  resio_at              TIMESTAMPTZ,
  resio_napomena        TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pm_teme_status ON public.pm_teme(status);
CREATE INDEX IF NOT EXISTS idx_pm_teme_sastanak ON public.pm_teme(sastanak_id);
CREATE INDEX IF NOT EXISTS idx_pm_teme_projekat ON public.pm_teme(projekat_id);
CREATE INDEX IF NOT EXISTS idx_pm_teme_predlozio ON public.pm_teme(predlozio_email);

-- ----------------------------------------------------------------------------
-- 4) akcioni_plan
--    Zadaci sa sastanka — odgovoran + rok + status. Glavna tabela za
--    "otvorene stvari".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.akcioni_plan (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Kreiran na ovom sastanku (može biti NULL ako se kreira ad-hoc).
  sastanak_id           UUID REFERENCES public.sastanci(id) ON DELETE SET NULL,

  -- Veza ka temi (ako je tema otvorila zadatak).
  tema_id               UUID REFERENCES public.pm_teme(id) ON DELETE SET NULL,

  -- Veza ka projektu / aktivnosti (ako je iz projektnog sastanka).
  projekat_id           UUID REFERENCES public.projects(id) ON DELETE SET NULL,

  rb                    INT,                        -- redni broj u listi
  naslov                TEXT NOT NULL,
  opis                  TEXT,

  -- Odgovorni — primarno jedan, ali i slobodan tekst za "M. Stojadinović + V. Petrović".
  odgovoran_email       TEXT,
  odgovoran_label       TEXT,
  odgovoran_text        TEXT,

  rok                   DATE,
  rok_text              TEXT,                       -- "kraj aprila", "po dogovoru"

  status                TEXT NOT NULL DEFAULT 'otvoren'
                          CHECK (status IN ('otvoren', 'u_toku', 'zavrsen', 'kasni', 'odlozen', 'otkazan')),

  prioritet             INT NOT NULL DEFAULT 2 CHECK (prioritet IN (1, 2, 3)),

  zatvoren_at           TIMESTAMPTZ,
  zatvoren_by_email     TEXT,
  zatvoren_napomena     TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_email      TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ap_sastanak ON public.akcioni_plan(sastanak_id);
CREATE INDEX IF NOT EXISTS idx_ap_status ON public.akcioni_plan(status);
CREATE INDEX IF NOT EXISTS idx_ap_rok ON public.akcioni_plan(rok);
CREATE INDEX IF NOT EXISTS idx_ap_odgovoran ON public.akcioni_plan(odgovoran_email);
CREATE INDEX IF NOT EXISTS idx_ap_projekat ON public.akcioni_plan(projekat_id);

-- ----------------------------------------------------------------------------
-- 5) presek_aktivnosti
--    Hijerarhijski rich-text odeljci u projektnom sastanku.
--    Iz Word fajla: tabela "RB | Aktivnosti | Odgovoran | Rok".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.presek_aktivnosti (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sastanak_id           UUID NOT NULL REFERENCES public.sastanci(id) ON DELETE CASCADE,

  rb                    INT NOT NULL,
  redosled              INT NOT NULL DEFAULT 0,

  naslov                TEXT NOT NULL,             -- "RN 9400/1 - Presa za provlačenje"

  -- Pod-RN kao "9400/1" (slobodan tekst, opciono).
  pod_rn                TEXT,

  -- Rich text HTML — Quill output sa hijerarhijom (<ul><li>... podsklop ...</li></ul>).
  sadrzaj_html          TEXT,
  sadrzaj_text          TEXT,                      -- plain-text fallback za search

  odgovoran_email       TEXT,
  odgovoran_label       TEXT,
  odgovoran_text        TEXT,

  rok                   DATE,
  rok_text              TEXT,

  -- Local status za tu aktivnost (ne za ceo sastanak).
  status                TEXT NOT NULL DEFAULT 'u_toku'
                          CHECK (status IN ('planiran', 'u_toku', 'zavrsen', 'blokirano', 'odlozeno')),

  napomena              TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pa_sastanak ON public.presek_aktivnosti(sastanak_id, redosled);
CREATE INDEX IF NOT EXISTS idx_pa_status ON public.presek_aktivnosti(status);

-- ----------------------------------------------------------------------------
-- 6) presek_slike
--    Slike po aktivnosti (ili po sastanku ako aktivnost nije setovana).
--    Storage path: 'sastanak-slike/<sastanak_id>/<uuid>.jpg'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.presek_slike (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sastanak_id           UUID NOT NULL REFERENCES public.sastanci(id) ON DELETE CASCADE,
  aktivnost_id          UUID REFERENCES public.presek_aktivnosti(id) ON DELETE SET NULL,

  storage_path          TEXT NOT NULL,             -- npr. 'sastanak-slike/<sastanak_id>/<uuid>.jpg'
  file_name             TEXT,                      -- originalno ime fajla
  mime_type             TEXT,
  size_bytes            BIGINT,

  caption               TEXT,
  redosled              INT NOT NULL DEFAULT 0,

  uploaded_by_email     TEXT,
  uploaded_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ps_sastanak ON public.presek_slike(sastanak_id, redosled);
CREATE INDEX IF NOT EXISTS idx_ps_aktivnost ON public.presek_slike(aktivnost_id);

-- ----------------------------------------------------------------------------
-- 7) sastanak_arhiva
--    Snapshot pri zaključavanju (status='zakljucan'). Sve relacije se serijalizuju
--    u JSONB tako da kasnije izmene u user_roles / projects ne menjaju ono što
--    se desilo na sastanku.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sastanak_arhiva (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sastanak_id           UUID NOT NULL UNIQUE REFERENCES public.sastanci(id) ON DELETE CASCADE,

  -- Pun snapshot:
  -- {
  --   "sastanak": { ...row from sastanci... },
  --   "ucesnici": [ ... ],
  --   "pm_teme": [ ... ],         (samo teme dodeljene ovom sastanku)
  --   "akcioni_plan": [ ... ],
  --   "presek_aktivnosti": [ ... ],
  --   "presek_slike": [ ... ]      (sa signed URL-om u trenutku snapshota)
  -- }
  snapshot              JSONB NOT NULL,

  -- Generisani PDF zapisnik (Storage path u istom bucket-u).
  zapisnik_storage_path TEXT,
  zapisnik_size_bytes   BIGINT,
  zapisnik_generated_at TIMESTAMPTZ,

  arhivirao_email       TEXT,
  arhivirao_label       TEXT,
  arhivirano_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sa_arhivirano_at ON public.sastanak_arhiva(arhivirano_at DESC);

-- ============================================================================
-- 8) updated_at triggers
-- ============================================================================
DROP TRIGGER IF EXISTS trg_sastanci_updated ON public.sastanci;
CREATE TRIGGER trg_sastanci_updated BEFORE UPDATE ON public.sastanci
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pm_teme_updated ON public.pm_teme;
CREATE TRIGGER trg_pm_teme_updated BEFORE UPDATE ON public.pm_teme
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_akcioni_plan_updated ON public.akcioni_plan;
CREATE TRIGGER trg_akcioni_plan_updated BEFORE UPDATE ON public.akcioni_plan
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_presek_aktivnosti_updated ON public.presek_aktivnosti;
CREATE TRIGGER trg_presek_aktivnosti_updated BEFORE UPDATE ON public.presek_aktivnosti
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================================
-- 9) Auto-status: 'kasni' za akcioni_plan koji je prošao rok a nije završen
-- ============================================================================
-- Helper view koji vraća TRUE 'kasni' status za otvorene zadatke iza roka.
-- (Koristimo view + UI logiku, jer cron na bazi je suvišan za ovaj scope.)
CREATE OR REPLACE VIEW public.v_akcioni_plan AS
SELECT
  ap.*,
  CASE
    WHEN ap.status IN ('zavrsen', 'odlozen', 'otkazan') THEN ap.status
    WHEN ap.rok IS NOT NULL AND ap.rok < CURRENT_DATE AND ap.status IN ('otvoren', 'u_toku') THEN 'kasni'
    ELSE ap.status
  END AS effective_status,
  CASE
    WHEN ap.rok IS NULL THEN NULL
    ELSE (ap.rok - CURRENT_DATE)
  END AS dana_do_roka
FROM public.akcioni_plan ap;

-- ============================================================================
-- 10) RLS policies
-- ============================================================================
ALTER TABLE public.projekt_bigtehn_rn   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sastanci             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sastanak_ucesnici    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pm_teme              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.akcioni_plan         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presek_aktivnosti    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presek_slike         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sastanak_arhiva      ENABLE ROW LEVEL SECURITY;

-- Sve auth korisnici mogu da čitaju.
DROP POLICY IF EXISTS "pbr_select" ON public.projekt_bigtehn_rn;
CREATE POLICY "pbr_select" ON public.projekt_bigtehn_rn FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pbr_write" ON public.projekt_bigtehn_rn;
CREATE POLICY "pbr_write"  ON public.projekt_bigtehn_rn FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

DROP POLICY IF EXISTS "sastanci_select" ON public.sastanci;
CREATE POLICY "sastanci_select" ON public.sastanci FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "sastanci_write" ON public.sastanci;
CREATE POLICY "sastanci_write"  ON public.sastanci FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

DROP POLICY IF EXISTS "su_select" ON public.sastanak_ucesnici;
CREATE POLICY "su_select" ON public.sastanak_ucesnici FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "su_write" ON public.sastanak_ucesnici;
CREATE POLICY "su_write"  ON public.sastanak_ucesnici FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

DROP POLICY IF EXISTS "pmt_select" ON public.pm_teme;
CREATE POLICY "pmt_select" ON public.pm_teme FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pmt_write" ON public.pm_teme;
CREATE POLICY "pmt_write"  ON public.pm_teme FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

DROP POLICY IF EXISTS "ap_select" ON public.akcioni_plan;
CREATE POLICY "ap_select" ON public.akcioni_plan FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ap_write" ON public.akcioni_plan;
CREATE POLICY "ap_write"  ON public.akcioni_plan FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

DROP POLICY IF EXISTS "pa_select" ON public.presek_aktivnosti;
CREATE POLICY "pa_select" ON public.presek_aktivnosti FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pa_write" ON public.presek_aktivnosti;
CREATE POLICY "pa_write"  ON public.presek_aktivnosti FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

DROP POLICY IF EXISTS "ps_select" ON public.presek_slike;
CREATE POLICY "ps_select" ON public.presek_slike FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ps_write" ON public.presek_slike;
CREATE POLICY "ps_write"  ON public.presek_slike FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

DROP POLICY IF EXISTS "sa_select" ON public.sastanak_arhiva;
CREATE POLICY "sa_select" ON public.sastanak_arhiva FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "sa_write" ON public.sastanak_arhiva;
CREATE POLICY "sa_write"  ON public.sastanak_arhiva FOR ALL TO authenticated USING (public.has_edit_role()) WITH CHECK (public.has_edit_role());

-- ============================================================================
-- 11) Storage bucket "sastanak-slike"
-- ============================================================================
-- Privatan bucket; 10 MB limit po fajlu (zbog telefonskih fotki); samo slike.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sastanak-slike',
  'sastanak-slike',
  false,
  10485760,
  ARRAY['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif','application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage RLS politike (svi auth čitaju, has_edit_role piše/briše)
DROP POLICY IF EXISTS "sastanak_slike_read" ON storage.objects;
CREATE POLICY "sastanak_slike_read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'sastanak-slike');

DROP POLICY IF EXISTS "sastanak_slike_insert" ON storage.objects;
CREATE POLICY "sastanak_slike_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'sastanak-slike' AND public.has_edit_role());

DROP POLICY IF EXISTS "sastanak_slike_update" ON storage.objects;
CREATE POLICY "sastanak_slike_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'sastanak-slike' AND public.has_edit_role())
  WITH CHECK (bucket_id = 'sastanak-slike' AND public.has_edit_role());

DROP POLICY IF EXISTS "sastanak_slike_delete" ON storage.objects;
CREATE POLICY "sastanak_slike_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'sastanak-slike' AND public.has_edit_role());

-- ============================================================================
-- 12) Verifikacija
-- ============================================================================
DO $$
DECLARE
  v_tables INT;
  v_bucket BOOLEAN;
BEGIN
  SELECT COUNT(*) INTO v_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('projekt_bigtehn_rn','sastanci','sastanak_ucesnici','pm_teme',
                       'akcioni_plan','presek_aktivnosti','presek_slike','sastanak_arhiva');

  SELECT EXISTS(SELECT 1 FROM storage.buckets WHERE id = 'sastanak-slike') INTO v_bucket;

  RAISE NOTICE '✓ Sastanci modul: % od 8 tabela kreirano. Bucket sastanak-slike: %', v_tables, v_bucket;
END $$;
