-- ============================================================================
-- ODRŽAVANJE — Katalog mašina (`maint_machines`)
-- ============================================================================
-- Svrha:
--   * Modul Održavanje prestaje da bude „rob” BigTehn sync-a. `maint_machines`
--     je autoritativni izvor: name, type, manufacturer, model, serial,
--     godina proizvodnje, lokacija, napomene itd.
--   * `bigtehn_machines_cache` ostaje read-only izvor za inicijalni seed i
--     ručni uvoz (RPC `maint_machines_import_from_cache`).
--   * Arhiviranje je soft-delete (`archived_at`) — ne brišemo redove jer
--     postoje istorijski incidenti/taskovi/napomene koji ih referenciraju.
--
-- Zavisi od: `add_maintenance_module.sql` (helperi, `touch_updated_at`).
-- Može da se pokrene i ako je već prošao `add_maint_hide_no_procedure.sql` —
-- ovaj fajl na kraju ponovo OVERRIDE-uje `v_maint_machine_current_status` da
-- vuče iz `maint_machines`.
--
-- Pokreni JEDNOM u Supabase SQL Editoru (posle backup-a). Idempotentno
-- (CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE VIEW, seed ON CONFLICT DO
-- NOTHING).
--
-- DOWN (ručno — samo za rollback test):
--   DROP VIEW IF EXISTS public.v_maint_machines_importable;
--   DROP FUNCTION IF EXISTS public.maint_machines_import_from_cache(TEXT[]);
--   -- vrati stari view v_maint_machine_current_status iz add_maintenance_module
--   DROP TABLE IF EXISTS public.maint_machines;
-- ============================================================================

-- ── 1) Tabela ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.maint_machines (
  machine_code          TEXT PRIMARY KEY,

  -- Osnovni podaci (name je obavezan; ostatak opcioni)
  name                  TEXT NOT NULL,
  type                  TEXT,
  manufacturer          TEXT,
  model                 TEXT,
  serial_number         TEXT,
  year_of_manufacture   INT,
  year_commissioned     INT,
  location              TEXT,
  /* department_id je TEXT jer BigTehn cache drži slobodan ERP identifikator
     (npr. "RJ3"), ne UUID FK — u sistemu ne postoji tabela `departments`. */
  department_id         TEXT,

  -- Tehnički parametri (opciono)
  power_kw              NUMERIC(6,2),
  weight_kg             NUMERIC(10,2),

  -- Slobodne beleške (remont, specifičnosti, dokumentacija)
  notes                 TEXT,

  -- Kontrola vidljivosti
  tracked               BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at           TIMESTAMPTZ,
  source                TEXT NOT NULL DEFAULT 'manual',  -- 'bigtehn' | 'manual'

  -- Audit
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  CONSTRAINT maint_machines_year_mfr_sane CHECK (year_of_manufacture IS NULL
      OR (year_of_manufacture BETWEEN 1900 AND EXTRACT(YEAR FROM now())::int + 1)),
  CONSTRAINT maint_machines_year_com_sane CHECK (year_commissioned IS NULL
      OR (year_commissioned BETWEEN 1900 AND EXTRACT(YEAR FROM now())::int + 1)),
  CONSTRAINT maint_machines_source_chk   CHECK (source IN ('bigtehn', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_maint_machines_active
  ON public.maint_machines (machine_code)
  WHERE archived_at IS NULL AND tracked = TRUE;

CREATE INDEX IF NOT EXISTS idx_maint_machines_archived
  ON public.maint_machines (archived_at) WHERE archived_at IS NOT NULL;

COMMENT ON TABLE public.maint_machines IS
  'Autoritativni katalog mašina za modul Održavanje. Inicijalni seed iz bigtehn_machines_cache (no_procedure=false), dalje se menja ručno.';
COMMENT ON COLUMN public.maint_machines.machine_code IS
  'PK — nepromenljiva šifra mašine. Za mašine iz BigTehn cache-a = rj_code; za ručno dodate = slobodan TEXT (npr. KOMP-01).';
COMMENT ON COLUMN public.maint_machines.source IS
  'Origin: bigtehn (seed/import) ili manual (ručno dodato u UI-ju).';

-- ── 2) updated_at trigger ────────────────────────────────────────────────
DROP TRIGGER IF EXISTS maint_machines_touch_updated ON public.maint_machines;
CREATE TRIGGER maint_machines_touch_updated
  BEFORE UPDATE ON public.maint_machines
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 3) RLS ───────────────────────────────────────────────────────────────
ALTER TABLE public.maint_machines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS maint_machines_select ON public.maint_machines;
CREATE POLICY maint_machines_select ON public.maint_machines
  FOR SELECT USING (public.maint_has_floor_read_access());

DROP POLICY IF EXISTS maint_machines_insert ON public.maint_machines;
CREATE POLICY maint_machines_insert ON public.maint_machines
  FOR INSERT WITH CHECK (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_machines_update ON public.maint_machines;
CREATE POLICY maint_machines_update ON public.maint_machines
  FOR UPDATE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  )
  WITH CHECK (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

DROP POLICY IF EXISTS maint_machines_delete ON public.maint_machines;
CREATE POLICY maint_machines_delete ON public.maint_machines
  FOR DELETE USING (
    public.maint_is_erp_admin()
    OR public.maint_profile_role() IN ('chief', 'admin')
  );

-- ── 3b) Guard: ako je tabela ranije kreirana sa department_id UUID,
--      spusti ga na TEXT (idempotentno, bezbedno jer tabela je verovatno
--      prazna u tom slučaju, a `USING department_id::text` radi za NULL-ove).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'maint_machines'
      AND column_name = 'department_id'
      AND data_type = 'uuid'
  ) THEN
    EXECUTE 'ALTER TABLE public.maint_machines
             ALTER COLUMN department_id TYPE TEXT USING department_id::text';
  END IF;
END $$;

-- ── 4) Seed iz BigTehn cache-a (samo mašine: no_procedure=false) ─────────
INSERT INTO public.maint_machines (
  machine_code, name, department_id, source, tracked, archived_at
)
SELECT
  m.rj_code,
  COALESCE(NULLIF(TRIM(m.name), ''), m.rj_code),
  m.department_id,
  'bigtehn',
  TRUE,
  NULL
FROM public.bigtehn_machines_cache m
WHERE COALESCE(m.no_procedure, FALSE) = FALSE
ON CONFLICT (machine_code) DO NOTHING;

-- ── 5) View: status po mašini (sad iz `maint_machines`) ──────────────────
--     Zamenjuje definiciju iz add_maint_hide_no_procedure.sql / add_maintenance_module.sql.
CREATE OR REPLACE VIEW public.v_maint_machine_current_status
WITH (security_invoker = true) AS
SELECT
  m.machine_code,
  coalesce(
    mso.status,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM public.maint_incidents i
        WHERE i.machine_code = m.machine_code
          AND i.status NOT IN ('resolved', 'closed')
          AND i.severity = 'critical'
      ) THEN 'down'::public.maint_operational_status
      WHEN EXISTS (
        SELECT 1 FROM public.maint_incidents i
        WHERE i.machine_code = m.machine_code
          AND i.status NOT IN ('resolved', 'closed')
          AND i.severity = 'major'
      ) THEN 'degraded'::public.maint_operational_status
      WHEN EXISTS (
        SELECT 1 FROM public.v_maint_task_due_dates d
        WHERE d.machine_code = m.machine_code
          AND d.severity = 'critical'
          AND d.next_due_at < (now() - (d.grace_period_days::text || ' days')::interval)
      ) THEN 'degraded'::public.maint_operational_status
      WHEN EXISTS (
        SELECT 1 FROM public.v_maint_task_due_dates d
        WHERE d.machine_code = m.machine_code
          AND d.next_due_at < now()
      ) THEN 'degraded'::public.maint_operational_status
      ELSE 'running'::public.maint_operational_status
    END
  ) AS status,
  (SELECT count(*)::int FROM public.maint_incidents i
   WHERE i.machine_code = m.machine_code AND i.status NOT IN ('resolved', 'closed')) AS open_incidents_count,
  (SELECT count(*)::int FROM public.v_maint_task_due_dates d
   WHERE d.machine_code = m.machine_code AND d.next_due_at < now()) AS overdue_checks_count,
  mso.reason        AS override_reason,
  mso.valid_until   AS override_valid_until
FROM public.maint_machines m
LEFT JOIN public.maint_machine_status_override mso
  ON mso.machine_code = m.machine_code
 AND (mso.valid_until IS NULL OR mso.valid_until > now())
WHERE m.archived_at IS NULL
  AND m.tracked = TRUE;

COMMENT ON VIEW public.v_maint_machine_current_status IS
  'Status samo za aktivne, nepraćene mašine iz maint_machines (archived_at IS NULL AND tracked). Izvor imena i metapodataka je maint_machines, ne BigTehn cache.';

-- ── 6) View: „koje mašine iz BigTehn cache-a nisu još uvezene” ───────────
--     UI tab „Katalog” koristi ovo za dialog „Uvezi iz BigTehn-a”.
CREATE OR REPLACE VIEW public.v_maint_machines_importable
WITH (security_invoker = true) AS
SELECT
  c.rj_code        AS machine_code,
  c.name,
  c.department_id,
  COALESCE(c.no_procedure, FALSE) AS no_procedure
FROM public.bigtehn_machines_cache c
LEFT JOIN public.maint_machines m ON m.machine_code = c.rj_code
WHERE m.machine_code IS NULL;

COMMENT ON VIEW public.v_maint_machines_importable IS
  'Kandidati za uvoz iz BigTehn cache-a (oni kojih još nema u maint_machines). UI filtrira po no_procedure=false, ali pun spisak je dostupan ako chief želi da ručno uveze i pomoćnu operaciju.';

-- ── 7) RPC: uvoz liste šifara iz cache-a ─────────────────────────────────
--     Bulk insert u `maint_machines` sa `source='bigtehn'`. ON CONFLICT ne
--     diraj (ne prepiši ručne izmene). Vraća broj stvarno uvezenih redova.
CREATE OR REPLACE FUNCTION public.maint_machines_import_from_cache(
  p_codes TEXT[]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_allowed BOOLEAN;
  v_count   INT := 0;
BEGIN
  v_allowed := public.maint_is_erp_admin()
            OR public.maint_profile_role() IN ('chief', 'admin');
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'maint_machines_import_from_cache: not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_codes IS NULL OR cardinality(p_codes) = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.maint_machines (
    machine_code, name, department_id, source, tracked, archived_at, updated_by
  )
  SELECT
    c.rj_code,
    COALESCE(NULLIF(TRIM(c.name), ''), c.rj_code),
    c.department_id,
    'bigtehn',
    TRUE,
    NULL,
    auth.uid()
  FROM public.bigtehn_machines_cache c
  WHERE c.rj_code = ANY (p_codes)
  ON CONFLICT (machine_code) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.maint_machines_import_from_cache(TEXT[]) IS
  'Uvozi odabrane rj_code iz bigtehn_machines_cache u maint_machines (source=bigtehn). Idempotentno — postojeći redovi se ne menjaju.';

REVOKE ALL ON FUNCTION public.maint_machines_import_from_cache(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.maint_machines_import_from_cache(TEXT[]) TO authenticated;
