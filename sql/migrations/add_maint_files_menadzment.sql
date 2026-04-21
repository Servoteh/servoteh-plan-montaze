-- ============================================================================
-- ODRŽAVANJE — Dozvoli menadzment-u upload dokumenata uz mašinu
-- ============================================================================
-- Svrha:
--   Proširuje postojeće INSERT politike na `public.maint_machine_files` i
--   `storage.objects` (bucket 'maint-machine-files') tako da ERP rola
--   `menadzment` može da priloži dokumente (uputstva, fotografije, crteže,
--   servisne izveštaje) uz mašinu — bez potrebe za maint profilom.
--
--   Prethodno: dozvolilo se samo operator/technician/chief/admin (maint
--   profil) + ERP admin. Sada i ERP menadzment.
--
--   UPDATE i DELETE za menadzment NAMERNO NISU dodati — menadzment može da
--   dodaje nove fajlove, ali istorijski zapis ostaje (UPDATE/DELETE ostaje
--   isključivo na maint chief/admin + ERP admin, ili autoru u roku od 24h).
--
-- Zavisi od:
--   * sql/migrations/add_maint_machine_files.sql       (tabela + bucket)
--   * sql/migrations/add_maint_machine_hard_delete.sql (helper
--       `maint_is_erp_admin_or_management()`)
--
-- DOWN (ručno) — vrati definicije iz add_maint_machine_files.sql.
-- ============================================================================

-- ── 1) maint_machine_files.INSERT — dodaj menadzment ────────────────────
DROP POLICY IF EXISTS mmf_insert ON public.maint_machine_files;
CREATE POLICY mmf_insert ON public.maint_machine_files
  FOR INSERT WITH CHECK (
    uploaded_by = auth.uid()
    AND (
      public.maint_is_erp_admin()
      OR public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('operator', 'technician', 'chief', 'admin')
    )
  );

-- ── 2) storage.objects INSERT — dodaj menadzment za bucket maint-machine-files
DROP POLICY IF EXISTS "mmf_storage_insert" ON storage.objects;
CREATE POLICY "mmf_storage_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'maint-machine-files'
    AND (
      public.maint_is_erp_admin()
      OR public.maint_is_erp_admin_or_management()
      OR public.maint_profile_role() IN ('operator', 'technician', 'chief', 'admin')
    )
  );
