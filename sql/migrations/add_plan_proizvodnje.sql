-- ============================================================================
-- PLAN PROIZVODNJE — Sprint F.1: overlay tabele + Storage bucket
-- ============================================================================
-- Pokreni JEDNOM u Supabase SQL Editoru.
--
-- Šta dodaje:
--   1) production_overlays   — šefovi mašinske obrade upisuju lokalni
--                              redosled, status, napomenu i (opciono)
--                              REASSIGN operacije na drugu mašinu.
--                              NE pišemo nazad u BigTehn.
--   2) production_drawings   — metapodaci za skice/slike/PDF-ove koje
--                              šefovi kače uz operaciju (file je u Storage).
--   3) Storage bucket "production-drawings" + RLS politike.
--
-- Reference iz koda:
--   - bigtehn_work_orders_cache (id = IDRN)
--   - bigtehn_work_order_lines_cache (id = IDStavkeRN, machine_code = RJgrupaRC)
--   - bigtehn_machines_cache (rj_code = PK, npr. "8.3", "10.1")
--   - role enum iz user_roles: admin > leadpm > pm > hr > viewer
--     (pm i admin pišu; leadpm/pm/hr/viewer čitaju)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) production_overlays
-- ----------------------------------------------------------------------------
-- Jedan red po (work_order_id, line_id). Svaka operacija ima najviše jedan
-- overlay. Nedostatak overlay-a = "default" stanje (sortira se po roku/prioritetu,
-- status = 'waiting', radi na originalnoj mašini, bez napomene).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.production_overlays (
  id                       BIGSERIAL PRIMARY KEY,

  -- Logički FK na BigTehn cache (ne pravi pravi FK constraint jer cache se
  -- kompletno briše-i-puni i mogli bismo da blokujemo Bridge sync).
  work_order_id            BIGINT NOT NULL,        -- IDRN
  line_id                  BIGINT NOT NULL,        -- IDStavkeRN

  -- Šef ručno postavlja redosled (drag-drop). Manji broj = ranije.
  -- Skala 1..N po efektivnoj mašini. NULL znači "još nije rangirano".
  shift_sort_order         INTEGER,

  -- Lokalni status (NE ide u BigTehn). 'completed' dolazi iz tTehPostupak
  -- sync-a — overlay tu vrednost samo ogledava radi UI logike.
  local_status             TEXT NOT NULL DEFAULT 'waiting',
  CONSTRAINT po_local_status_check CHECK (
    local_status IN ('waiting', 'in_progress', 'blocked', 'completed')
  ),

  -- Šefova napomena (max ~500 karaktera u UI, ali bez constraint-a u SQL-u).
  shift_note               TEXT,

  -- REASSIGN — kad šef premesti operaciju sa originalne mašine
  -- (line.machine_code) na drugu. NULL = koristi originalnu.
  -- Vrednost mora postojati u bigtehn_machines_cache.rj_code (provera
  -- u app sloju, ne u SQL-u jer cache se briše-i-puni).
  assigned_machine_code    TEXT,

  -- Audit
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               TEXT,                   -- email šefa
  updated_by               TEXT,

  -- Soft archive — kad RN postane završen, ne brišemo overlay (treba
  -- za istoriju), samo popunjavamo archived_at i sakrivamo iz default view-a.
  archived_at              TIMESTAMPTZ,
  archived_reason          TEXT,                   -- npr. 'rn_completed', 'manual'

  CONSTRAINT po_unique_per_line UNIQUE (work_order_id, line_id)
);

CREATE INDEX IF NOT EXISTS po_idx_work_order
  ON public.production_overlays (work_order_id);

CREATE INDEX IF NOT EXISTS po_idx_assigned_machine
  ON public.production_overlays (assigned_machine_code)
  WHERE assigned_machine_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS po_idx_status_active
  ON public.production_overlays (local_status, updated_at DESC)
  WHERE archived_at IS NULL;

-- ----------------------------------------------------------------------------
-- updated_at trigger (kao što je urađeno za user_roles)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS po_touch_updated_at ON public.production_overlays;
CREATE TRIGGER po_touch_updated_at
  BEFORE UPDATE ON public.production_overlays
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 2) production_drawings
-- ----------------------------------------------------------------------------
-- Metapodaci o uploadovanim file-ovima. Pravi binarni sadržaj je u
-- Supabase Storage bucket-u "production-drawings".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.production_drawings (
  id                  BIGSERIAL PRIMARY KEY,

  -- Logički FK kao gore.
  work_order_id       BIGINT NOT NULL,
  line_id             BIGINT NOT NULL,

  -- Storage path: "production-drawings/<work_order_id>/<line_id>/<filename>"
  storage_path        TEXT NOT NULL UNIQUE,
  file_name           TEXT NOT NULL,
  mime_type           TEXT,
  size_bytes          BIGINT,

  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by         TEXT,

  -- Soft delete (operativno: 'deleted' file ostaje u Storage do cleanup job-a;
  -- ovo je hint za UI da ga ne prikazuje).
  deleted_at          TIMESTAMPTZ,
  deleted_by          TEXT
);

CREATE INDEX IF NOT EXISTS pd_idx_line
  ON public.production_drawings (work_order_id, line_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS pd_idx_uploaded
  ON public.production_drawings (uploaded_at DESC);

-- ============================================================================
-- RLS politike
-- ============================================================================
-- Pravila:
--   - SELECT: svi authenticated korisnici (svi u Servoteh-u mogu da vide).
--   - INSERT/UPDATE/DELETE: samo role iz user_roles gde je role IN ('admin','pm').
--     ('leadpm' nije ovde namerno — to je vodja PM-ova za Plan Montaže;
--     Plan Proizvodnje je posebna domena, šef mašinske obrade je 'pm'.)
-- ============================================================================
ALTER TABLE public.production_overlays  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_drawings  ENABLE ROW LEVEL SECURITY;

-- Helper SECURITY DEFINER funkcija — bypass-uje RLS recursion na user_roles.
-- Vraća TRUE ako je trenutno autentifikovani user admin ili pm.
--
-- Implementacija namerno koristi SQL (ne PL/pgSQL) i EXISTS — to izbegava
-- "SELECT ... INTO var" sintaksu koja je u Supabase SQL Editoru znala da
-- bude pogrešno parsirana izvan dollar-quoted bloka (greška 42P01
-- "relation v_count does not exist").
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
      AND ur.role IN ('admin', 'pm')
  );
$$;

GRANT EXECUTE ON FUNCTION public.can_edit_plan_proizvodnje() TO authenticated;

-- ── production_overlays politike ──
DROP POLICY IF EXISTS "po_read_authenticated" ON public.production_overlays;
CREATE POLICY "po_read_authenticated"
  ON public.production_overlays FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "po_insert_admin_pm" ON public.production_overlays;
CREATE POLICY "po_insert_admin_pm"
  ON public.production_overlays FOR INSERT
  TO authenticated
  WITH CHECK (public.can_edit_plan_proizvodnje());

DROP POLICY IF EXISTS "po_update_admin_pm" ON public.production_overlays;
CREATE POLICY "po_update_admin_pm"
  ON public.production_overlays FOR UPDATE
  TO authenticated
  USING (public.can_edit_plan_proizvodnje())
  WITH CHECK (public.can_edit_plan_proizvodnje());

DROP POLICY IF EXISTS "po_delete_admin_pm" ON public.production_overlays;
CREATE POLICY "po_delete_admin_pm"
  ON public.production_overlays FOR DELETE
  TO authenticated
  USING (public.can_edit_plan_proizvodnje());

-- ── production_drawings politike ──
DROP POLICY IF EXISTS "pd_read_authenticated" ON public.production_drawings;
CREATE POLICY "pd_read_authenticated"
  ON public.production_drawings FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "pd_insert_admin_pm" ON public.production_drawings;
CREATE POLICY "pd_insert_admin_pm"
  ON public.production_drawings FOR INSERT
  TO authenticated
  WITH CHECK (public.can_edit_plan_proizvodnje());

DROP POLICY IF EXISTS "pd_update_admin_pm" ON public.production_drawings;
CREATE POLICY "pd_update_admin_pm"
  ON public.production_drawings FOR UPDATE
  TO authenticated
  USING (public.can_edit_plan_proizvodnje())
  WITH CHECK (public.can_edit_plan_proizvodnje());

DROP POLICY IF EXISTS "pd_delete_admin_pm" ON public.production_drawings;
CREATE POLICY "pd_delete_admin_pm"
  ON public.production_drawings FOR DELETE
  TO authenticated
  USING (public.can_edit_plan_proizvodnje());

-- ============================================================================
-- Storage bucket "production-drawings"
-- ============================================================================
-- Kreiraj bucket samo ako ne postoji. Bucket NIJE javan — fajlovi se
-- pristupaju samo kroz signed URL-ove iz aplikacije.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'production-drawings',
  'production-drawings',
  FALSE,                                            -- ne-javan
  20 * 1024 * 1024,                                 -- 20 MB max po fajlu
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'application/pdf'
  ]::text[]
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS politike — kontrolisemo pristup objektima po bucket-id-ju.
DROP POLICY IF EXISTS "pd_storage_read_authenticated" ON storage.objects;
CREATE POLICY "pd_storage_read_authenticated"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'production-drawings');

DROP POLICY IF EXISTS "pd_storage_insert_admin_pm" ON storage.objects;
CREATE POLICY "pd_storage_insert_admin_pm"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'production-drawings'
    AND public.can_edit_plan_proizvodnje()
  );

DROP POLICY IF EXISTS "pd_storage_update_admin_pm" ON storage.objects;
CREATE POLICY "pd_storage_update_admin_pm"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'production-drawings'
    AND public.can_edit_plan_proizvodnje()
  )
  WITH CHECK (
    bucket_id = 'production-drawings'
    AND public.can_edit_plan_proizvodnje()
  );

DROP POLICY IF EXISTS "pd_storage_delete_admin_pm" ON storage.objects;
CREATE POLICY "pd_storage_delete_admin_pm"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'production-drawings'
    AND public.can_edit_plan_proizvodnje()
  );

-- ============================================================================
-- Smoke test (opciono — odkomentariši ako želiš da proveriš da je sve setovano)
-- ============================================================================
-- SELECT
--   tablename,
--   rowsecurity,
--   (SELECT count(*) FROM pg_policy WHERE polrelid = (schemaname||'.'||tablename)::regclass) AS policy_count
-- FROM pg_tables
-- WHERE tablename IN ('production_overlays', 'production_drawings');
--
-- SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'production-drawings';
