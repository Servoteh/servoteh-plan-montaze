-- ═══════════════════════════════════════════════════════════════════════════
-- PB — Load meter samo za Mašinsko projektovanje (Inženjering i projektovanje)
-- ═══════════════════════════════════════════════════════════════════════════
-- Opterećenje u Projektnom biro-u treba da prikaže samo zaposlene iz pododeljenja
-- „Mašinsko projektovanje“, ne celu firmu.
--
-- Zavisi od: public.departments, public.sub_departments (add_kadr_org_structure.sql),
--           public.employees sa department_id / sub_department_id.
-- Fallback: ako sub_department_id nije podešen, tekstualno polje department
--            koje sadrži „mašinsko“ i „projektovanje“ (legacy payroll tekst).
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES public.departments(id),
  ADD COLUMN IF NOT EXISTS sub_department_id INTEGER REFERENCES public.sub_departments(id);

CREATE OR REPLACE FUNCTION public.pb_get_load_stats(window_days INTEGER DEFAULT 30)
RETURNS TABLE (
  employee_id   UUID,
  full_name     TEXT,
  total_hours   NUMERIC,
  max_hours     NUMERIC,
  load_pct      INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today     DATE := CURRENT_DATE;
  v_end       DATE := CURRENT_DATE + window_days;
  v_workdays  INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO v_workdays
  FROM generate_series(v_today, v_end, '1 day'::interval) AS gs(d)
  WHERE EXTRACT(DOW FROM gs.d) NOT IN (0, 6);

  RETURN QUERY
  SELECT
    e.id AS employee_id,
    e.full_name,
    COALESCE(SUM(
      LEAST(t.norma_sati_dan, 7) *
      (
        SELECT COUNT(*)::INTEGER
        FROM generate_series(
          GREATEST(t.datum_pocetka_plan, v_today),
          LEAST(t.datum_zavrsetka_plan, v_end),
          '1 day'::interval
        ) AS gs2(d)
        WHERE EXTRACT(DOW FROM gs2.d) NOT IN (0, 6)
      )
    ), 0)::NUMERIC AS total_hours,
    (v_workdays * 7)::NUMERIC AS max_hours,
    CASE WHEN v_workdays * 7 > 0 THEN
      ROUND(
        COALESCE(SUM(
          LEAST(t.norma_sati_dan, 7) *
          (
            SELECT COUNT(*)::INTEGER
            FROM generate_series(
              GREATEST(t.datum_pocetka_plan, v_today),
              LEAST(t.datum_zavrsetka_plan, v_end),
              '1 day'::interval
            ) AS gs3(d)
            WHERE EXTRACT(DOW FROM gs3.d) NOT IN (0, 6)
          )
        ), 0) * 100 / (v_workdays * 7)
      )::INTEGER
    ELSE 0 END AS load_pct
  FROM public.employees e
  LEFT JOIN public.pb_tasks t ON
    t.employee_id = e.id
    AND t.status <> 'Završeno'::public.pb_task_status
    AND t.deleted_at IS NULL
    AND t.datum_pocetka_plan IS NOT NULL
    AND t.datum_zavrsetka_plan IS NOT NULL
    AND t.datum_zavrsetka_plan >= v_today
    AND t.datum_pocetka_plan <= v_end
  WHERE e.is_active = TRUE
    AND (
      EXISTS (
        SELECT 1
        FROM public.sub_departments sd
        INNER JOIN public.departments d ON d.id = sd.department_id
        WHERE sd.id = e.sub_department_id
          AND d.name = 'Inženjering i projektovanje'
          AND sd.name = 'Mašinsko projektovanje'
      )
      OR (
        e.sub_department_id IS NULL
        AND (
          lower(trim(coalesce(e.department, ''))) LIKE '%mašinsko%'
          OR lower(trim(coalesce(e.department, ''))) LIKE '%masinski%'
        )
        AND lower(trim(coalesce(e.department, ''))) LIKE '%projektovanje%'
      )
    )
  GROUP BY e.id, e.full_name
  ORDER BY load_pct DESC;
END;
$$;

-- TODO(PB4): uključiti opterećenost iz phases (Plan montaže) za ukupan load — vidi docs/pb_review_report.md F2

REVOKE ALL ON FUNCTION public.pb_get_load_stats(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pb_get_load_stats(INTEGER) TO authenticated;
