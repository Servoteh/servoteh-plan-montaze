-- ============================================================================
-- ODRŽAVANJE — RPC za preimenovanje šifre mašine
-- ============================================================================
-- Kontekst:
--   `machine_code` je TEXT bez FK (jer je BigTehn cache u briši-i-puni režimu).
--   Zbog toga PostgreSQL ON UPDATE CASCADE ne radi automatski. Ova RPC
--   atomski menja `machine_code` u svim `maint_*` tabelama koje ga referenciraju.
--
--   NE diramo `bigtehn_machines_cache` (ERP vlasnik) ni `production_overlays`
--   (Plan Proizvodnje ima svoj domen šifara i zove ih "assigned_machine_code").
--
-- Tabele na kojima menjamo:
--   * public.maint_machines (PK — insert/delete)
--   * public.maint_tasks.machine_code
--   * public.maint_checks.machine_code
--   * public.maint_incidents.machine_code
--   * public.maint_machine_notes.machine_code
--   * public.maint_machine_status_override.machine_code (PK — jedan red po mašini)
--   * public.maint_notification_log.machine_code
--
-- Dozvola: chief/admin maint ili ERP admin (SECURITY DEFINER provera).
--
-- Povratna vrednost: JSONB sa brojem ažuriranih redova po tabeli.
--
-- Pokreni JEDNOM u Supabase SQL Editoru. Idempotentno.
--
-- DOWN (ručno):
--   DROP FUNCTION IF EXISTS public.maint_machine_rename(TEXT, TEXT);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.maint_machine_rename(
  p_old_code TEXT,
  p_new_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed    BOOLEAN;
  v_cnt_tasks  INT := 0;
  v_cnt_checks INT := 0;
  v_cnt_inc    INT := 0;
  v_cnt_notes  INT := 0;
  v_cnt_ovr    INT := 0;
  v_cnt_notif  INT := 0;
BEGIN
  v_allowed := public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_machine_rename: not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_old_code IS NULL OR btrim(p_old_code) = '' THEN
    RAISE EXCEPTION 'maint_machine_rename: old code is required';
  END IF;
  IF p_new_code IS NULL OR btrim(p_new_code) = '' THEN
    RAISE EXCEPTION 'maint_machine_rename: new code is required';
  END IF;
  IF p_old_code = p_new_code THEN
    RAISE EXCEPTION 'maint_machine_rename: old and new codes are the same';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.maint_machines WHERE machine_code = p_old_code) THEN
    RAISE EXCEPTION 'maint_machine_rename: machine "%" does not exist', p_old_code;
  END IF;
  IF EXISTS (SELECT 1 FROM public.maint_machines WHERE machine_code = p_new_code) THEN
    RAISE EXCEPTION 'maint_machine_rename: machine "%" already exists', p_new_code;
  END IF;

  /* 1) Kreiraj novi katalog red kao KOPIJU starog (isti metapodaci,
        source beleži poreklo, updated_by = trenutni korisnik). Izbegavamo
        direktan UPDATE PK da bi child redovi u sledećim koracima uspeli da
        nađu novi red (iako nemamo FK). */
  INSERT INTO public.maint_machines (
    machine_code, name, type, manufacturer, model, serial_number,
    year_of_manufacture, year_commissioned, location, department_id,
    power_kw, weight_kg, notes, tracked, archived_at, source,
    created_at, updated_at, updated_by
  )
  SELECT
    p_new_code, name, type, manufacturer, model, serial_number,
    year_of_manufacture, year_commissioned, location, department_id,
    power_kw, weight_kg, notes, tracked, archived_at, source,
    created_at, now(), auth.uid()
  FROM public.maint_machines
  WHERE machine_code = p_old_code;

  /* 2) Prebaci sve reference. Redosled nije bitan jer ne postoje FK, ali
        držimo ga konzistentnim radi čitljivosti.
        GET DIAGNOSTICS ROW_COUNT je portabilniji od CTE+count i ne pravi
        probleme pri plpgsql varijable-vs-relacija parsiranju. */
  UPDATE public.maint_tasks SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_tasks = ROW_COUNT;

  UPDATE public.maint_checks SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_checks = ROW_COUNT;

  UPDATE public.maint_incidents SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_inc = ROW_COUNT;

  UPDATE public.maint_machine_notes SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_notes = ROW_COUNT;

  UPDATE public.maint_machine_status_override SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_ovr = ROW_COUNT;

  UPDATE public.maint_notification_log SET machine_code = p_new_code
   WHERE machine_code = p_old_code;
  GET DIAGNOSTICS v_cnt_notif = ROW_COUNT;

  /* 3) Obriši stari katalog red. */
  DELETE FROM public.maint_machines WHERE machine_code = p_old_code;

  RETURN jsonb_build_object(
    'old_code',     p_old_code,
    'new_code',     p_new_code,
    'tasks',        v_cnt_tasks,
    'checks',       v_cnt_checks,
    'incidents',    v_cnt_inc,
    'notes',        v_cnt_notes,
    'overrides',    v_cnt_ovr,
    'notifications', v_cnt_notif
  );
END;
$$;

COMMENT ON FUNCTION public.maint_machine_rename(TEXT, TEXT) IS
  'Atomski preimenuje machine_code u svim maint_* tabelama (bez FK, zato RPC). Chief/admin only.';

REVOKE ALL ON FUNCTION public.maint_machine_rename(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.maint_machine_rename(TEXT, TEXT) TO authenticated;
