-- Referentna odeljenja: HAP Fluid i Servoteh (legacy nazivi iz employees.department)
-- + backfill department_id gde je tekst već tačan, a FK još nije postavljen.

INSERT INTO public.departments (id, name, sort_order)
VALUES
  (12, 'HAP Fluid',  108),
  (13, 'Servoteh',   109)
ON CONFLICT (id) DO NOTHING;

SELECT setval(
  'public.departments_id_seq',
  GREATEST(
    (SELECT COALESCE(MAX(id), 1) FROM public.departments),
    (SELECT last_value FROM public.departments_id_seq)
  )
);

UPDATE public.employees e
SET
  department_id = d.id,
  updated_at    = now()
FROM public.departments d
WHERE e.department_id IS NULL
  AND btrim(e.department) = 'HAP Fluid'
  AND d.id = 12;

UPDATE public.employees e
SET
  department_id = d.id,
  updated_at    = now()
FROM public.departments d
WHERE e.department_id IS NULL
  AND btrim(e.department) = 'Servoteh'
  AND d.id = 13;
