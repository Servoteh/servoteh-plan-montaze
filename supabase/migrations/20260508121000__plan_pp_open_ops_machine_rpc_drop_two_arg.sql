-- Ukloni (text,integer) verziju; PostgREST ne izlaže pouzdano SETOF view (PGRST202).
-- SETOF jsonb — stabilan rpc odgovor (isti podaci kao redovi view-a).

DROP FUNCTION IF EXISTS public.plan_pp_open_ops_for_machine(text, integer);
DROP FUNCTION IF EXISTS public.plan_pp_open_ops_for_machine(text);

CREATE OR REPLACE FUNCTION public.plan_pp_open_ops_for_machine(p_machine_code text)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT to_jsonb(e)
  FROM public.v_production_operations_effective e
  WHERE p_machine_code IS NOT NULL
    AND btrim(p_machine_code) <> ''
    AND btrim(e.effective_machine_code) = btrim(p_machine_code)
    AND e.is_done_in_bigtehn IS FALSE
    AND e.rn_zavrsen IS FALSE
    AND e.is_cooperation_effective IS FALSE
    AND (e.local_status IS NULL OR e.local_status <> 'completed')
    AND e.overlay_archived_at IS NULL
  ORDER BY
    e.shift_sort_order ASC NULLS LAST,
    e.auto_sort_bucket ASC NULLS LAST,
    e.rok_izrade ASC NULLS LAST,
    e.prioritet_bigtehn ASC NULLS LAST
  LIMIT 2500;
$$;

COMMENT ON FUNCTION public.plan_pp_open_ops_for_machine(text) IS
  'Plan proizvodnje: otvorene operacije za jednu mašinu (jsonb za PostgREST).';

GRANT EXECUTE ON FUNCTION public.plan_pp_open_ops_for_machine(text) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_pp_open_ops_for_machine(text) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
