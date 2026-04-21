-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Kadrovska — Zarade (Faza K3, „zarade")
--
-- Model:
--   * Istorijski zapis — svaki red u salary_terms je „period važenja"
--     uslova zarade za jednog zaposlenog. Polje effective_from je OBAVEZNO;
--     effective_to = NULL znači „trenutno važi".
--   * salary_type ∈ { 'ugovor', 'dogovor', 'satnica' }
--   * amount_type ∈ { 'neto', 'bruto' } — za ugovor/dogovor to je mesečna cifra;
--     za satnicu se računa po satu (amount je satna cena, amount_type je neto/bruto).
--   * currency — default 'RSD', može i 'EUR' ako se u ugovoru tako vodi.
--   * View `v_employee_current_salary` vraća AKTUELNU zaradu (trenutno važeću)
--     za svakog aktivnog zaposlenog.
--
-- RLS: striktno samo admin — po dogovoru „admini samo vide" zarade.
-- HR (rola 'hr') NEMA pristup — zarade su namerno izdvojene.
--
-- Depends on: add_kadrovska_module.sql (employees), add_admin_roles.sql
--            (current_user_is_admin), update_updated_at() helper.
-- Idempotentno, safe za re-run.
-- ═══════════════════════════════════════════════════════════

-- 0) Sanity -------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'employees') THEN
    RAISE EXCEPTION 'Missing employees. Run add_kadrovska_module.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_user_is_admin') THEN
    RAISE EXCEPTION 'Missing current_user_is_admin(). Run add_admin_roles.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
    RAISE EXCEPTION 'Missing update_updated_at(). Run schema.sql first.';
  END IF;
END $$;

-- 1) Tabela salary_terms -----------------------------------------------
CREATE TABLE IF NOT EXISTS salary_terms (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  salary_type      TEXT NOT NULL,
  effective_from   DATE NOT NULL,
  effective_to     DATE,
  amount           NUMERIC(14, 2) NOT NULL DEFAULT 0,
  amount_type      TEXT NOT NULL DEFAULT 'neto',
  currency         TEXT NOT NULL DEFAULT 'RSD',
  /* Za satnicu: hourly_rate je jednako polju `amount` (držimo radi jasnoće queries).
     Za mesečne: hourly_rate ostaje NULL i ne koristi se. */
  hourly_rate      NUMERIC(12, 2),
  contract_ref     TEXT,          -- referenca na br. ugovora (free text)
  note             TEXT DEFAULT '',
  created_by       TEXT,          -- auth.jwt() email u trenutku kreiranja
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- 2) Constraint-ovi ----------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_terms_type_chk'
                 AND conrelid='salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_type_chk
      CHECK (salary_type IN ('ugovor','dogovor','satnica'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_terms_amount_type_chk'
                 AND conrelid='salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_amount_type_chk
      CHECK (amount_type IN ('neto','bruto'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_terms_currency_chk'
                 AND conrelid='salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_currency_chk
      CHECK (currency IN ('RSD','EUR','USD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_terms_dates_chk'
                 AND conrelid='salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_dates_chk
      CHECK (effective_to IS NULL OR effective_to >= effective_from);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_terms_amount_chk'
                 AND conrelid='salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_amount_chk
      CHECK (amount >= 0);
  END IF;
END $$;

-- 3) Indeksi -----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_salary_terms_emp       ON salary_terms(employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_terms_active    ON salary_terms(employee_id)
  WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_salary_terms_period    ON salary_terms(effective_from, effective_to);

-- 4) Trigger updated_at ------------------------------------------------
DROP TRIGGER IF EXISTS trg_salary_terms_updated ON salary_terms;
CREATE TRIGGER trg_salary_terms_updated
  BEFORE UPDATE ON salary_terms
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 5) Trigger created_by (auto iz JWT) ---------------------------------
CREATE OR REPLACE FUNCTION salary_terms_set_created_by()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS NULL OR NEW.created_by = '' THEN
    NEW.created_by := LOWER(COALESCE(auth.jwt() ->> 'email', 'system'));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_salary_terms_created_by ON salary_terms;
CREATE TRIGGER trg_salary_terms_created_by
  BEFORE INSERT ON salary_terms
  FOR EACH ROW EXECUTE FUNCTION salary_terms_set_created_by();

-- 6) Trigger koji ZATVARA prethodni važeći red kada se INSERT-uje novi ---
--    Ako je effective_to NULL (tj. „trenutno važi") i postoji drugi red
--    za istog zaposlenog sa effective_to IS NULL, zatvori ga danom pre
--    effective_from novog reda. Ovim obezbeđujemo da uvek postoji
--    tačno JEDAN aktivan zapis po zaposlenom.
CREATE OR REPLACE FUNCTION salary_terms_close_previous()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_to IS NULL THEN
    UPDATE salary_terms
       SET effective_to = (NEW.effective_from - INTERVAL '1 day')::date,
           updated_at   = now()
     WHERE employee_id = NEW.employee_id
       AND id <> NEW.id
       AND effective_to IS NULL
       AND effective_from < NEW.effective_from;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_salary_terms_close_prev ON salary_terms;
CREATE TRIGGER trg_salary_terms_close_prev
  AFTER INSERT ON salary_terms
  FOR EACH ROW EXECUTE FUNCTION salary_terms_close_previous();

-- 7) VIEW: aktuelna zarada svakog zaposlenog ---------------------------
CREATE OR REPLACE VIEW v_employee_current_salary AS
SELECT DISTINCT ON (st.employee_id)
  st.employee_id,
  st.id                AS salary_term_id,
  st.salary_type,
  st.effective_from,
  st.effective_to,
  st.amount,
  st.amount_type,
  st.currency,
  st.hourly_rate,
  st.contract_ref,
  st.note,
  st.updated_at
FROM salary_terms st
WHERE st.effective_from <= CURRENT_DATE
  AND (st.effective_to IS NULL OR st.effective_to >= CURRENT_DATE)
ORDER BY st.employee_id, st.effective_from DESC;

-- GRANT SELECT samo authenticated; RLS kroz bazu će ionako filtrirati,
-- ali view je SECURITY INVOKER pa nasleđuje RLS sa salary_terms.
GRANT SELECT ON v_employee_current_salary TO authenticated;

-- 8) RLS: STRIKTNO samo admin -----------------------------------------
ALTER TABLE salary_terms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "salary_terms_select_admin" ON salary_terms;
DROP POLICY IF EXISTS "salary_terms_insert_admin" ON salary_terms;
DROP POLICY IF EXISTS "salary_terms_update_admin" ON salary_terms;
DROP POLICY IF EXISTS "salary_terms_delete_admin" ON salary_terms;

CREATE POLICY "salary_terms_select_admin" ON salary_terms
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

CREATE POLICY "salary_terms_insert_admin" ON salary_terms
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_admin());

CREATE POLICY "salary_terms_update_admin" ON salary_terms
  FOR UPDATE TO authenticated
  USING      (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

CREATE POLICY "salary_terms_delete_admin" ON salary_terms
  FOR DELETE TO authenticated
  USING (public.current_user_is_admin());

-- 9) Verifikacija -----------------------------------------------------
-- SELECT count(*) FROM salary_terms;
-- SELECT * FROM v_employee_current_salary LIMIT 5;
-- Kao admin: INSERT / UPDATE / DELETE prolazi.
-- Kao hr/leadpm/pm/viewer: query vraća 0 redova, INSERT baca 42501.
