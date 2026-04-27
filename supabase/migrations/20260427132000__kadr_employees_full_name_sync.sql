-- Kadrovska: `full_name` je legacy/compat kolona.
-- Izvor istine su `last_name` + `first_name`, a `full_name` se sinhronizuje kao "Prezime Ime".

BEGIN;

CREATE OR REPLACE FUNCTION public.employees_sync_full_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_first text := NULLIF(btrim(NEW.first_name), '');
  v_last  text := NULLIF(btrim(NEW.last_name), '');
BEGIN
  IF v_first IS NOT NULL OR v_last IS NOT NULL THEN
    NEW.full_name := btrim(concat_ws(' ', v_last, v_first));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employees_full_name_sync ON public.employees;

CREATE TRIGGER employees_full_name_sync
BEFORE INSERT OR UPDATE OF first_name, last_name, full_name
ON public.employees
FOR EACH ROW
EXECUTE FUNCTION public.employees_sync_full_name();

UPDATE public.employees
SET
  full_name = btrim(concat_ws(' ', NULLIF(btrim(last_name), ''), NULLIF(btrim(first_name), ''))),
  updated_at = now()
WHERE (NULLIF(btrim(first_name), '') IS NOT NULL OR NULLIF(btrim(last_name), '') IS NOT NULL)
  AND btrim(coalesce(full_name, '')) IS DISTINCT FROM
      btrim(concat_ws(' ', NULLIF(btrim(last_name), ''), NULLIF(btrim(first_name), '')));

CREATE INDEX IF NOT EXISTS idx_employees_last_first
  ON public.employees (last_name, first_name);

COMMIT;
