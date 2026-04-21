/* ══════════════════════════════════════════════════════════════════════════
   AUDIT LOG — Generička tabela sa trigger-om koji loguje SVE izmene na
   ključnim tabelama Kadrovske i Održavanja.

   Dizajn:
     * Jedna tabela `audit_log` u koju sve ide (table_name + record_id
       + old_data/new_data JSONB).
     * Jedna generička PL/pgSQL funkcija `audit_row_change()` koja se kači
       kao AFTER INSERT/UPDATE/DELETE trigger na željene tabele.
     * Actor se čita iz JWT-a (email claim) kroz helper `current_user_email()`.
     * RLS: SELECT samo admin; INSERT tek kroz trigger (SECURITY DEFINER).
     * UI ovo NE prikazuje — podaci služe za interni audit/forenziku.

   Idempotentna je (CREATE IF NOT EXISTS + DROP TRIGGER IF EXISTS pre CREATE).

   Primenjeno: audit na employees, employee_children, salary_terms,
   salary_payroll, absences, work_hours, contracts, vacation_entitlements,
   user_roles.
   ══════════════════════════════════════════════════════════════════════════ */

/* ---- 1) Helper: čitanje email-a iz JWT-a -------------------------------- */
CREATE OR REPLACE FUNCTION public.current_user_email()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    NULLIF(current_setting('request.jwt.claim.email', true), ''),
    NULL
  );
$$;

/* ---- 2) Tabela audit_log ------------------------------------------------ */
CREATE TABLE IF NOT EXISTS public.audit_log (
  id           bigserial PRIMARY KEY,
  table_name   text       NOT NULL,
  record_id    text,                  -- PK kao string (UUID ili bigint)
  action       text       NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  actor_email  text,
  actor_uid    uuid,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  old_data     jsonb,
  new_data     jsonb,
  diff_keys    text[]                 -- brzi filter: šta se promenilo
);

CREATE INDEX IF NOT EXISTS idx_audit_log_table_rec
  ON public.audit_log (table_name, record_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON public.audit_log (actor_email, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_changed_at
  ON public.audit_log (changed_at DESC);

/* ---- 3) RLS: samo admin čita audit; INSERT ide preko triggera --------- */
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_select_admin ON public.audit_log;
CREATE POLICY audit_log_select_admin
  ON public.audit_log
  FOR SELECT
  USING (public.current_user_is_admin());

/* Eksplicitno zabrani direktan INSERT/UPDATE/DELETE sa klijenta — neka ide
   isključivo kroz trigger (SECURITY DEFINER). */
DROP POLICY IF EXISTS audit_log_no_client_write ON public.audit_log;
CREATE POLICY audit_log_no_client_write
  ON public.audit_log
  FOR ALL
  USING (false)
  WITH CHECK (false);

/* ---- 4) Generička trigger funkcija ------------------------------------- */
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action   text := TG_OP;
  v_table    text := TG_TABLE_NAME;
  v_rec_id   text;
  v_old      jsonb;
  v_new      jsonb;
  v_diff     text[] := '{}';
  v_key      text;
  v_email    text;
  v_uid      uuid;
BEGIN
  /* Old/new kao JSONB — ignorisati tehnička polja. */
  IF TG_OP IN ('UPDATE','DELETE') THEN
    v_old := to_jsonb(OLD);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    v_new := to_jsonb(NEW);
  END IF;

  /* Uzmi ID reda — pokušaj 'id', pa 'employee_id', pa hash. */
  IF TG_OP = 'DELETE' THEN
    v_rec_id := COALESCE(v_old ->> 'id', v_old ->> 'employee_id', v_old ->> 'pk');
  ELSE
    v_rec_id := COALESCE(v_new ->> 'id', v_new ->> 'employee_id', v_new ->> 'pk');
  END IF;

  /* Diff keys — samo kod UPDATE. */
  IF TG_OP = 'UPDATE' AND v_old IS NOT NULL AND v_new IS NOT NULL THEN
    FOR v_key IN SELECT key FROM jsonb_each(v_new) LOOP
      IF (v_new -> v_key) IS DISTINCT FROM (v_old -> v_key) THEN
        v_diff := array_append(v_diff, v_key);
      END IF;
    END LOOP;
    /* Ako se zapravo ništa nije promenilo (npr. save istih vrednosti) —
       ne punimo log da ne generišemo šum. */
    IF array_length(v_diff, 1) IS NULL THEN
      RETURN NULL;
    END IF;
    /* Preskoči izmene gde se promenilo SAMO updated_at (redundantan audit). */
    IF array_length(v_diff, 1) = 1 AND v_diff[1] = 'updated_at' THEN
      RETURN NULL;
    END IF;
  END IF;

  /* Actor. */
  BEGIN
    v_email := public.current_user_email();
  EXCEPTION WHEN OTHERS THEN
    v_email := NULL;
  END;
  BEGIN
    v_uid := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_uid := NULL;
  END;

  INSERT INTO public.audit_log (
    table_name, record_id, action,
    actor_email, actor_uid,
    old_data, new_data, diff_keys
  ) VALUES (
    v_table, v_rec_id, v_action,
    v_email, v_uid,
    v_old, v_new, v_diff
  );

  RETURN NULL;  -- AFTER trigger, vraćamo NULL
END;
$$;

/* ---- 5) Helper makro za kačenje triggera ------------------------------- */
/* Nema pravih makroa u PG — koristimo DO blok koji prima array imena tabela. */
DO $$
DECLARE
  t text;
  target_tables text[] := ARRAY[
    'employees',
    'employee_children',
    'salary_terms',
    'salary_payroll',
    'absences',
    'work_hours',
    'contracts',
    'vacation_entitlements',
    'user_roles'
  ];
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    /* Preskoči ako tabela ne postoji (idempotent, npr. stariji projekat). */
    IF NOT EXISTS (
      SELECT 1 FROM pg_tables
      WHERE schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'audit: skipping non-existent table %', t;
      CONTINUE;
    END IF;

    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%1$s
         AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()',
      t
    );
  END LOOP;
END$$;

/* ---- 6) Retencija: jednostavna funkcija za čišćenje starih zapisa ------ */
/* Ne zovemo je automatski; admin je može pokrenuti npr. 1/god preko SQL-a. */
CREATE OR REPLACE FUNCTION public.audit_log_cleanup(older_than_days int DEFAULT 730)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'audit_log_cleanup: samo admin';
  END IF;
  DELETE FROM public.audit_log
   WHERE changed_at < now() - make_interval(days => older_than_days);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.audit_log_cleanup(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_email() TO authenticated;
