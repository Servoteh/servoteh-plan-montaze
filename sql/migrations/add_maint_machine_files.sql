-- ============================================================================
-- ODRŽAVANJE — Dokumenti uz mašinu (`maint_machine_files` + Storage bucket)
-- ============================================================================
-- Svrha:
--   Chief/admin/tehničar mogu da uploaduju dokumentaciju uz mašinu:
--   uputstva (PDF), fotografije (JPG/PNG), garantne listove, servisne
--   izveštaje, tehničke crteže. Binarni sadržaj je u Supabase Storage
--   bucket-u `maint-machine-files` (privatan), metapodaci su ovde u tabeli.
--
-- Pokreni JEDNOM u Supabase SQL Editoru (posle backup-a).
-- Idempotentno (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING).
--
-- DOWN (ručno, rollback test):
--   DROP POLICY IF EXISTS mmf_select ON public.maint_machine_files;
--   DROP POLICY IF EXISTS mmf_insert ON public.maint_machine_files;
--   DROP POLICY IF EXISTS mmf_update ON public.maint_machine_files;
--   DROP POLICY IF EXISTS mmf_delete ON public.maint_machine_files;
--   DROP TABLE IF EXISTS public.maint_machine_files;
--   DROP POLICY IF EXISTS "mmf_storage_read" ON storage.objects;
--   DROP POLICY IF EXISTS "mmf_storage_insert" ON storage.objects;
--   DROP POLICY IF EXISTS "mmf_storage_update" ON storage.objects;
--   DROP POLICY IF EXISTS "mmf_storage_delete" ON storage.objects;
--   DELETE FROM storage.buckets WHERE id = 'maint-machine-files';
-- ============================================================================

-- ── 1) Metapodaci ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maint_machine_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_code    TEXT NOT NULL,

  /* Original file name (za prikaz), storage_path je jedinstveni UUID ključ
     unutar bucket-a da izbegnemo kolizije imena. */
  file_name       TEXT NOT NULL,
  storage_path    TEXT NOT NULL UNIQUE,

  mime_type       TEXT,
  size_bytes      BIGINT,

  /* Tip dokumenta (autocomplete na UI-u, ne enum). */
  category        TEXT,
  description     TEXT,

  /* Soft delete (zadržavamo red za audit; fajl u Storage-u brišemo odmah). */
  deleted_at      TIMESTAMPTZ,

  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mmf_machine_active
  ON public.maint_machine_files (machine_code, uploaded_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.maint_machine_files IS
  'Dokumentacija (PDF, slike, crteži, izveštaji) uz mašinu. Binarni sadržaj je u Storage bucket-u maint-machine-files.';
COMMENT ON COLUMN public.maint_machine_files.storage_path IS
  'Relativna putanja unutar bucket-a, npr. "8.3/<uuid>-uputstvo.pdf".';
COMMENT ON COLUMN public.maint_machine_files.category IS
  'Tip dokumenta: manual | photo | drawing | invoice | service_report | warranty | other (slobodan tekst).';

-- ── 2) RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.maint_machine_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mmf_select ON public.maint_machine_files;
CREATE POLICY mmf_select ON public.maint_machine_files
  FOR SELECT USING (public.maint_has_floor_read_access());

/* Upload: operator/technician/chief/admin mogu da dodaju. Operator sme
   da doda fotografiju ili servisni izveštaj; UI može da dodatno ograniči. */
DROP POLICY IF EXISTS mmf_insert ON public.maint_machine_files;
CREATE POLICY mmf_insert ON public.maint_machine_files
  FOR INSERT WITH CHECK (
    uploaded_by = auth.uid()
    AND (
      public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('operator', 'technician', 'chief', 'admin')
    )
  );

/* Izmena opisa/kategorije: autor (do 24h) ili chief/admin/ERP admin. */
DROP POLICY IF EXISTS mmf_update ON public.maint_machine_files;
CREATE POLICY mmf_update ON public.maint_machine_files
  FOR UPDATE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
    OR (
      uploaded_by = auth.uid()
      AND uploaded_at > now() - interval '24 hours'
      AND public.maint_profile_role() IN ('operator', 'technician')
    )
  )
  WITH CHECK (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
    OR (
      uploaded_by = auth.uid()
      AND uploaded_at > now() - interval '24 hours'
      AND public.maint_profile_role() IN ('operator', 'technician')
    )
  );

/* Brisanje metapodatka: isto pravilo kao update. */
DROP POLICY IF EXISTS mmf_delete ON public.maint_machine_files;
CREATE POLICY mmf_delete ON public.maint_machine_files
  FOR DELETE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
    OR (
      uploaded_by = auth.uid()
      AND uploaded_at > now() - interval '24 hours'
      AND public.maint_profile_role() IN ('operator', 'technician')
    )
  );

-- ── 3) Storage bucket ────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'maint-machine-files',
  'maint-machine-files',
  FALSE,                                            -- privatan
  25 * 1024 * 1024,                                 -- 25 MB po fajlu
  ARRAY[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain', 'text/csv'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- ── 4) Storage RLS politike ──────────────────────────────────────────────
DROP POLICY IF EXISTS "mmf_storage_read" ON storage.objects;
CREATE POLICY "mmf_storage_read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'maint-machine-files'
    AND public.maint_has_floor_read_access()
  );

DROP POLICY IF EXISTS "mmf_storage_insert" ON storage.objects;
CREATE POLICY "mmf_storage_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'maint-machine-files'
    AND (
      public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('operator', 'technician', 'chief', 'admin')
    )
  );

DROP POLICY IF EXISTS "mmf_storage_update" ON storage.objects;
CREATE POLICY "mmf_storage_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'maint-machine-files'
    AND (
      public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('chief', 'admin')
    )
  )
  WITH CHECK (
    bucket_id = 'maint-machine-files'
    AND (
      public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('chief', 'admin')
    )
  );

DROP POLICY IF EXISTS "mmf_storage_delete" ON storage.objects;
CREATE POLICY "mmf_storage_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'maint-machine-files'
    AND (
      public.maint_is_erp_admin()
      OR public.maint_profile_role() IN ('chief', 'admin')
      OR owner = auth.uid()
    )
  );

-- ── 5) Sanity check ──────────────────────────────────────────────────────
-- SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'maint-machine-files';
