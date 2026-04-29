-- Plan „Po mašini”: otvorene operacije bez PostgREST URL filtera (tačka u 8.2, kodiranje, prazni odgovori).
-- Isti uslovi kao u src/services/planProizvodnje.js loadOperationsForMachine (GET na view).
-- Napomena: PostgREST ne mapira pouzdano dva parametra (vidi migraciju 20260508121000).

CREATE OR REPLACE FUNCTION public.plan_pp_open_ops_for_machine(
  p_machine_code text,
  p_limit integer DEFAULT 2500
)
RETURNS SETOF public.v_production_operations_effective
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT *
  FROM public.v_production_operations_effective
  WHERE p_machine_code IS NOT NULL
    AND btrim(p_machine_code) <> ''
    AND btrim(effective_machine_code) = btrim(p_machine_code)
    AND is_done_in_bigtehn IS FALSE
    AND rn_zavrsen IS FALSE
    AND is_cooperation_effective IS FALSE
    AND (local_status IS NULL OR local_status <> 'completed')
    AND overlay_archived_at IS NULL
  ORDER BY
    shift_sort_order ASC NULLS LAST,
    auto_sort_bucket ASC NULLS LAST,
    rok_izrade ASC NULLS LAST,
    prioritet_bigtehn ASC NULLS LAST
  LIMIT LEAST(GREATEST(coalesce(p_limit, 2500), 1), 5000);
$$;

COMMENT ON FUNCTION public.plan_pp_open_ops_for_machine(text, integer) IS
  'Plan proizvodnje: otvorene operacije za jednu mašinu (effective_machine_code). Poziv iz aplikacije umesto PostgREST filtera na tačku.';

GRANT EXECUTE ON FUNCTION public.plan_pp_open_ops_for_machine(text, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.plan_pp_open_ops_for_machine(text, integer) FROM PUBLIC;

NOTIFY pgrst, 'reload schema';
