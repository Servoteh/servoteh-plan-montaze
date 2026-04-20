-- ============================================================================
-- ODRŽAVANJE — Nivo 1: sakrij „ne-mašine” iz modula
-- ============================================================================
-- Konteks:
--   `bigtehn_machines_cache.no_procedure = TRUE` znači da red NIJE obradna
--   mašina, već pomoćna operacija (npr. Kontrola, Kooperacija, Montaža,
--   Transport). Plan Proizvodnje ih već koristi kao `is_non_machining`.
--
-- Ovo rešenje (Nivo 1):
--   * Filtriraj `no_procedure=TRUE` redove iz glavnog view-a
--     `v_maint_machine_current_status`.
--   * NE diramo tabele, maint_* podaci i dalje mogu da se unesu ručno za
--     `rj_code` koji je „ne-mašina” — samo neće biti prikazani u listi/dashbord-u
--     dok se `no_procedure` ne promeni u BigTehn-u.
--
-- Ako ti posle treba fino ručno upravljanje (Nivo 2), dodaćemo
-- `maint_machine_catalog (machine_code PK, tracked BOOL, note, …)` u zasebnoj
-- migraciji.
--
-- Pokreni JEDNOM u Supabase SQL Editoru (posle backup-a). Idempotentno.
--
-- DOWN (ručno):
--   -- vrati stari view bez WHERE filtera iz add_maintenance_module.sql
-- ============================================================================

CREATE OR REPLACE VIEW public.v_maint_machine_current_status
WITH (security_invoker = true) AS
SELECT
  m.rj_code AS machine_code,
  coalesce(
    mso.status,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM public.maint_incidents i
        WHERE i.machine_code = m.rj_code
          AND i.status NOT IN ('resolved', 'closed')
          AND i.severity = 'critical'
      ) THEN 'down'::public.maint_operational_status
      WHEN EXISTS (
        SELECT 1 FROM public.maint_incidents i
        WHERE i.machine_code = m.rj_code
          AND i.status NOT IN ('resolved', 'closed')
          AND i.severity = 'major'
      ) THEN 'degraded'::public.maint_operational_status
      WHEN EXISTS (
        SELECT 1 FROM public.v_maint_task_due_dates d
        WHERE d.machine_code = m.rj_code
          AND d.severity = 'critical'
          AND d.next_due_at < (now() - (d.grace_period_days::text || ' days')::interval)
      ) THEN 'degraded'::public.maint_operational_status
      WHEN EXISTS (
        SELECT 1 FROM public.v_maint_task_due_dates d
        WHERE d.machine_code = m.rj_code
          AND d.next_due_at < now()
      ) THEN 'degraded'::public.maint_operational_status
      ELSE 'running'::public.maint_operational_status
    END
  ) AS status,
  (SELECT count(*)::int FROM public.maint_incidents i
   WHERE i.machine_code = m.rj_code AND i.status NOT IN ('resolved', 'closed')) AS open_incidents_count,
  (SELECT count(*)::int FROM public.v_maint_task_due_dates d
   WHERE d.machine_code = m.rj_code AND d.next_due_at < now()) AS overdue_checks_count,
  mso.reason AS override_reason,
  mso.valid_until AS override_valid_until
FROM public.bigtehn_machines_cache m
LEFT JOIN public.maint_machine_status_override mso
  ON mso.machine_code = m.rj_code
 AND (mso.valid_until IS NULL OR mso.valid_until > now())
WHERE COALESCE(m.no_procedure, FALSE) = FALSE;

COMMENT ON VIEW public.v_maint_machine_current_status IS
  'Status samo za OBRADNE mašine iz bigtehn_machines_cache (no_procedure = false). Pomoćne operacije (Kontrola, Kooperacija, Montaža…) su sakrivene iz Održavanja.';
