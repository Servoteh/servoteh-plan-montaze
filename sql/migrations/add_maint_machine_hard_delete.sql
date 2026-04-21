-- ============================================================================
-- ODRŽAVANJE — Trajno brisanje mašine + audit log brisanja
-- ============================================================================
-- Svrha:
--   Pored postojećeg „arhiviraj" (soft-delete preko `archived_at`), uvodimo
--   pravo (hard) brisanje za rukovodstvo. Svaki delete je auditovan: snimamo
--   kompletan red u JSONB i evidentiramo ko je obrisao, kada i zašto.
--
--   Cascade-deletes su uključeni u RPC (FK ne postoje jer `machine_code` nije
--   FK referencirano kolono — istorijski razlog: BigTehn cache ima briši-i-puni
--   model). Cleanup pokriva: incidents, incident_events, checks, tasks, notes,
--   files (samo metadata; binarne fajlove iz Storage bucket-a briše JS sloj
--   pre poziva RPC-a), override.
--
--   Ovlašćenja (širi krug nego za update):
--     • ERP admin                                  (kao i pre)
--     • ERP menadzment                             (NOVO)
--     • maint profil 'chief' / 'admin'             (kao i pre)
--
--   `maint_notification_log` se NE dira (to je istorija obaveštenja, treba
--   da preživi brisanje mašine).
--
-- Zavisi od: add_maintenance_module.sql, add_maint_machines_catalog.sql,
--            add_maint_machine_files.sql.
--
-- DOWN (ručno):
--   DROP POLICY IF EXISTS mmdl_select ON public.maint_machines_deletion_log;
--   DROP POLICY IF EXISTS mmdl_insert ON public.maint_machines_deletion_log;
--   DROP TABLE IF EXISTS public.maint_machines_deletion_log;
--   DROP FUNCTION IF EXISTS public.maint_machine_delete_hard(TEXT, TEXT);
--   DROP FUNCTION IF EXISTS public.maint_is_erp_admin_or_management();
--   -- vrati staru DELETE policy iz add_maint_machines_catalog.sql
-- ============================================================================

-- ── 1) Helper: ERP uloga 'admin' ili 'menadzment' (širi krug za delete) ──
CREATE OR REPLACE FUNCTION public.maint_is_erp_admin_or_management()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.is_active = true
      AND ur.project_id IS NULL
      AND lower(ur.email) = lower(coalesce(auth.jwt()->>'email', ''))
      AND lower(ur.role::text) IN ('admin', 'menadzment')
  );
$$;

REVOKE ALL ON FUNCTION public.maint_is_erp_admin_or_management() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.maint_is_erp_admin_or_management() TO authenticated;

COMMENT ON FUNCTION public.maint_is_erp_admin_or_management() IS
  'TRUE ako je tekući korisnik ERP admin ili menadzment (user_roles, globalna rola). Koristi se za hard-delete mašina i pristup deletion log-u.';


-- ── 2) Audit log brisanja ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maint_machines_deletion_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_code      TEXT NOT NULL,
  machine_name      TEXT,

  /* Snapshot celog reda iz `maint_machines` u trenutku brisanja (to_jsonb).
     Sadrži sva polja: name, type, manufacturer, model, serial, godine,
     lokacija, kW, kg, notes, source, created_at, updated_at, archived_at… */
  snapshot          JSONB NOT NULL,

  /* Brojači povezanih redova koji su kaskadno obrisani:
     { tasks: N, checks: N, incidents: N, notes: N, files: N, override: N } */
  related_counts    JSONB NOT NULL DEFAULT '{}'::jsonb,

  reason            TEXT NOT NULL,
  deleted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_by_email  TEXT,

  CONSTRAINT mmdl_reason_not_blank CHECK (length(trim(reason)) >= 5)
);

CREATE INDEX IF NOT EXISTS idx_mmdl_at   ON public.maint_machines_deletion_log (deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_mmdl_code ON public.maint_machines_deletion_log (machine_code);

COMMENT ON TABLE public.maint_machines_deletion_log IS
  'Audit log trajnog brisanja mašina iz katalogа maint_machines. Punji ga RPC maint_machine_delete_hard. Direktan INSERT je zabranjen RLS-om.';
COMMENT ON COLUMN public.maint_machines_deletion_log.snapshot IS
  'to_jsonb(red iz maint_machines u trenutku brisanja).';
COMMENT ON COLUMN public.maint_machines_deletion_log.related_counts IS
  'Brojači povezanih redova koji su kaskadno obrisani (tasks, incidents, files, notes, checks, override).';

ALTER TABLE public.maint_machines_deletion_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mmdl_select ON public.maint_machines_deletion_log;
CREATE POLICY mmdl_select ON public.maint_machines_deletion_log
  FOR SELECT USING (
    public.maint_is_erp_admin()
    OR public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin', 'management')
  );

/* INSERT/UPDATE/DELETE — zabranjeno direktno; samo kroz RPC (SECURITY DEFINER). */
DROP POLICY IF EXISTS mmdl_insert ON public.maint_machines_deletion_log;
CREATE POLICY mmdl_insert ON public.maint_machines_deletion_log
  FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS mmdl_update ON public.maint_machines_deletion_log;
CREATE POLICY mmdl_update ON public.maint_machines_deletion_log
  FOR UPDATE USING (false);

DROP POLICY IF EXISTS mmdl_delete ON public.maint_machines_deletion_log;
CREATE POLICY mmdl_delete ON public.maint_machines_deletion_log
  FOR DELETE USING (false);

GRANT SELECT ON public.maint_machines_deletion_log TO authenticated;


-- ── 3) Override DELETE policy na maint_machines (uključi menadzment) ────
DROP POLICY IF EXISTS maint_machines_delete ON public.maint_machines;
CREATE POLICY maint_machines_delete ON public.maint_machines
  FOR DELETE USING (
    public.maint_is_erp_admin()
    OR public.maint_is_erp_admin_or_management()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );


-- ── 4) RPC: trajno brisanje + audit + cascade cleanup ───────────────────
CREATE OR REPLACE FUNCTION public.maint_machine_delete_hard(
  p_code   TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed   BOOLEAN;
  v_row       public.maint_machines%ROWTYPE;
  v_counts    JSONB;
  v_email     TEXT;
  v_clean_code TEXT;
  v_clean_reason TEXT;
BEGIN
  v_clean_code   := trim(coalesce(p_code, ''));
  v_clean_reason := trim(coalesce(p_reason, ''));

  v_allowed := public.maint_is_erp_admin()
            OR public.maint_is_erp_admin_or_management()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: not authorized'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_code = '' THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: machine_code je obavezan'
      USING ERRCODE = '22023';
  END IF;
  IF length(v_clean_reason) < 5 THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: razlog je obavezan (min 5 karaktera)'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row
  FROM public.maint_machines
  WHERE machine_code = v_clean_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'maint_machine_delete_hard: masina % ne postoji u katalogu', v_clean_code
      USING ERRCODE = 'P0002';
  END IF;

  /* Brojači PRE brisanja — ide u snapshot. */
  SELECT jsonb_build_object(
    'tasks',     (SELECT count(*)::int FROM public.maint_tasks                  WHERE machine_code = v_clean_code),
    'checks',    (SELECT count(*)::int FROM public.maint_checks                 WHERE machine_code = v_clean_code),
    'incidents', (SELECT count(*)::int FROM public.maint_incidents              WHERE machine_code = v_clean_code),
    'notes',     (SELECT count(*)::int FROM public.maint_machine_notes          WHERE machine_code = v_clean_code),
    'files',     (SELECT count(*)::int FROM public.maint_machine_files          WHERE machine_code = v_clean_code AND deleted_at IS NULL),
    'override',  (SELECT count(*)::int FROM public.maint_machine_status_override WHERE machine_code = v_clean_code)
  ) INTO v_counts;

  v_email := coalesce(auth.jwt()->>'email', '');

  /* 1) Audit log — uvek prvi, da imamo trag i ako padne brisanje. */
  INSERT INTO public.maint_machines_deletion_log (
    machine_code, machine_name, snapshot, related_counts,
    reason, deleted_by, deleted_by_email
  ) VALUES (
    v_clean_code,
    v_row.name,
    to_jsonb(v_row),
    v_counts,
    v_clean_reason,
    auth.uid(),
    v_email
  );

  /* 2) Cascade cleanup — eksplicitno (FK ne postoje na machine_code). */
  DELETE FROM public.maint_incident_events
    WHERE incident_id IN (SELECT id FROM public.maint_incidents WHERE machine_code = v_clean_code);
  DELETE FROM public.maint_incidents              WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_checks                 WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_tasks                  WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_machine_notes          WHERE machine_code = v_clean_code;
  /* maint_machine_files: brišemo metadata (Storage blobove sređuje JS pre RPC-a). */
  DELETE FROM public.maint_machine_files          WHERE machine_code = v_clean_code;
  DELETE FROM public.maint_machine_status_override WHERE machine_code = v_clean_code;

  /* 3) Konačno sam katalog red. */
  DELETE FROM public.maint_machines WHERE machine_code = v_clean_code;

  RETURN jsonb_build_object(
    'ok', true,
    'machine_code', v_clean_code,
    'machine_name', v_row.name,
    'related',      v_counts,
    'deleted_at',   now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.maint_machine_delete_hard(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.maint_machine_delete_hard(TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.maint_machine_delete_hard(TEXT, TEXT) IS
  'Trajno briše mašinu iz kataloga + sve povezane redove (incidents, tasks, checks, notes, files-metadata, override). Snima audit zapis u maint_machines_deletion_log. Storage blobove brisati iz JS-a PRE poziva RPC-a. Dozvoljeno: ERP admin, ERP menadzment, maint chief/admin.';
