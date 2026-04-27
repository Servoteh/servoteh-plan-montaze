-- Supabase: isti sadržaj kao sql/migrations/add_maint_daily_ops_view.sql

-- ============================================================================
-- ODRŽAVANJE (CMMS) — dnevni ops snapshot (read-only view)
-- ============================================================================
-- MORA posle:
--   * add_maintenance_module.sql (v_maint_task_due_dates, incidenti, WO)
--   * add_maint_inventory.sql (maint_parts)
-- ============================================================================
-- Jedan red agregata za dashboard; RLS se nasleđuje sa underlying tabela
-- jer je view `security_invoker`.
-- ============================================================================

BEGIN;

DROP VIEW IF EXISTS public.v_maint_cmms_daily_summary;

CREATE VIEW public.v_maint_cmms_daily_summary
WITH (security_invoker = true) AS
SELECT
  (
    SELECT count(*)::bigint
    FROM public.maint_work_orders w
    WHERE w.status::text NOT IN ('zavrsen', 'otkazan')
  ) AS active_work_orders,
  (
    SELECT count(*)::bigint
    FROM public.maint_incidents i
    WHERE i.status::text NOT IN ('resolved', 'closed')
  ) AS open_incidents,
  (
    SELECT count(*)::bigint
    FROM public.maint_incidents i
    WHERE i.severity = 'critical'::public.maint_incident_severity
      AND i.status::text NOT IN ('resolved', 'closed')
  ) AS open_critical_incidents,
  (
    SELECT count(*)::bigint
    FROM public.v_maint_task_due_dates d
    WHERE d.next_due_at IS NOT NULL
      AND d.next_due_at < now()
  ) AS overdue_preventive_tasks,
  (
    SELECT count(*)::bigint
    FROM public.maint_parts p
    WHERE p.active
      AND p.current_stock < p.min_stock
  ) AS parts_below_min_stock;

COMMENT ON VIEW public.v_maint_cmms_daily_summary IS
  'CMMS: jedan red agregata za operativni dashboard (RLS preko security_invoker).';

GRANT SELECT ON public.v_maint_cmms_daily_summary TO authenticated;

COMMIT;
