-- Kadrovska payroll: expose first/last name so FE does not depend on employee_name/full_name formatting.

CREATE OR REPLACE VIEW public.v_salary_payroll_month AS
SELECT
  p.*,
  e.full_name   AS employee_name,
  e.position    AS employee_position,
  e.department  AS employee_department,
  e.is_active   AS employee_active,
  e.first_name  AS employee_first_name,
  e.last_name   AS employee_last_name
FROM public.salary_payroll p
JOIN public.employees e ON e.id = p.employee_id;

GRANT SELECT ON public.v_salary_payroll_month TO authenticated;
