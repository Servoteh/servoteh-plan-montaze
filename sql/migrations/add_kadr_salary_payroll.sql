-- ═══════════════════════════════════════════════════════════════════════
-- KADROVSKA — Mesečni obračun zarade (Faza K3.2)
--
-- Dopuna Faze K3 (salary_terms) — uvodi DVA koncepta:
--   (A) Dodatna polja na `salary_terms`:
--       - transport_allowance_rsd  — mesečni prevoz (0 = organizovan prevoz)
--       - per_diem_rsd             — dinarska dnevnica PO TERENU (domaći)
--       - per_diem_eur             — devizna dnevnica PO TERENU (ino)
--   (B) Nova tabela `salary_payroll` — jedan red po zaposlenom PO MESECU
--       koji prati ceo ciklus isplate:
--         1) „Prvi deo" (akontacija) — unosi se do 5. u mesecu.
--         2) „Drugi deo" — od 15. do 20.; konačni obračun = ukupno − prvi_deo.
--
-- Formula (RSD):
--   BAZA       = satničari: hourly_rate × hours_worked
--                fiksni:   fixed_salary
--   UKUPNO_RSD = BAZA + transport_rsd + (per_diem_rsd × domestic_days)
--   DRUGI_DEO  = UKUPNO_RSD − ADVANCE
--
-- Devizne dnevnice se ne zbrajaju u UKUPNO_RSD — čuvaju se u `total_eur`.
--
-- RLS: strogo admin (isti kao `salary_terms`).
-- Idempotentno, safe za re-run.
--
-- Depends on: add_kadr_salary_terms.sql
-- ═══════════════════════════════════════════════════════════════════════

-- 0) Sanity --------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'salary_terms') THEN
    RAISE EXCEPTION 'Missing salary_terms. Run add_kadr_salary_terms.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_user_is_admin') THEN
    RAISE EXCEPTION 'Missing current_user_is_admin(). Run add_admin_roles.sql first.';
  END IF;
END $$;

-- 1) Dodatna polja na salary_terms (prevoz + dnevnice) ------------------
ALTER TABLE salary_terms
  ADD COLUMN IF NOT EXISTS transport_allowance_rsd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS per_diem_rsd            NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS per_diem_eur            NUMERIC(10, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_terms_extras_nonneg_chk'
                 AND conrelid='salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_extras_nonneg_chk
      CHECK (transport_allowance_rsd >= 0
             AND per_diem_rsd >= 0
             AND per_diem_eur >= 0);
  END IF;
END $$;

/* Update view v_employee_current_salary da vraća i nova polja.
   Napomena: CREATE OR REPLACE VIEW NE dozvoljava dodavanje kolona u
   sredinu postojećeg view-a (42P16). Zato prvo DROP pa CREATE.
   Zavisnosti: salary_payroll i kadr_payroll_init_month još ne postoje
   u trenutku ovog DROP-a (kreiraju se niže u istoj migraciji). */
DROP VIEW IF EXISTS v_employee_current_salary;

CREATE VIEW v_employee_current_salary AS
SELECT DISTINCT ON (st.employee_id)
  st.employee_id,
  st.id                      AS salary_term_id,
  st.salary_type,
  st.effective_from,
  st.effective_to,
  st.amount,
  st.amount_type,
  st.currency,
  st.hourly_rate,
  st.transport_allowance_rsd,
  st.per_diem_rsd,
  st.per_diem_eur,
  st.contract_ref,
  st.note,
  st.updated_at
FROM salary_terms st
WHERE st.effective_from <= CURRENT_DATE
  AND (st.effective_to IS NULL OR st.effective_to >= CURRENT_DATE)
ORDER BY st.employee_id, st.effective_from DESC;

GRANT SELECT ON v_employee_current_salary TO authenticated;

-- 2) Tabela salary_payroll (mesečni obračun) ---------------------------
CREATE TABLE IF NOT EXISTS salary_payroll (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id          UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_year          INT  NOT NULL,
  period_month         INT  NOT NULL,                   -- 1..12
  /* Snapshot salary_type iz salary_terms u trenutku obračuna */
  salary_type          TEXT NOT NULL DEFAULT 'ugovor',  -- ugovor | dogovor | satnica
  /* ── Prvi deo (akontacija) ── */
  advance_amount       NUMERIC(14, 2) NOT NULL DEFAULT 0,
  advance_paid_on      DATE,
  advance_note         TEXT DEFAULT '',
  /* ── Baza plate ── */
  fixed_salary         NUMERIC(14, 2) NOT NULL DEFAULT 0,  -- za fiksne (ugovor/dogovor)
  hours_worked         NUMERIC(8, 2)  NOT NULL DEFAULT 0,  -- za satničare
  hourly_rate          NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- snapshot satnice
  /* ── Dodaci ── */
  transport_rsd        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  domestic_days        INT            NOT NULL DEFAULT 0,  -- broj domaćih terena
  per_diem_rsd         NUMERIC(12, 2) NOT NULL DEFAULT 0,  -- snapshot
  foreign_days         INT            NOT NULL DEFAULT 0,  -- broj ino terena
  per_diem_eur         NUMERIC(10, 2) NOT NULL DEFAULT 0,  -- snapshot
  /* ── Izračunato (snimljeno, lako za query-je i Excel) ── */
  total_rsd            NUMERIC(14, 2) NOT NULL DEFAULT 0,  -- base + transport + per_diem_rsd*domestic_days
  total_eur            NUMERIC(14, 2) NOT NULL DEFAULT 0,  -- per_diem_eur * foreign_days
  second_part_rsd      NUMERIC(14, 2) NOT NULL DEFAULT 0,  -- total_rsd − advance_amount
  /* ── Finalizacija ── */
  final_paid_on        DATE,
  status               TEXT NOT NULL DEFAULT 'draft',
  note                 TEXT DEFAULT '',
  /* Meta */
  created_by           TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now(),
  /* Jedan red po zaposlenom × periodu */
  UNIQUE (employee_id, period_year, period_month)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_payroll_month_chk'
                 AND conrelid='salary_payroll'::regclass) THEN
    ALTER TABLE salary_payroll
      ADD CONSTRAINT salary_payroll_month_chk
      CHECK (period_month BETWEEN 1 AND 12);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_payroll_year_chk'
                 AND conrelid='salary_payroll'::regclass) THEN
    ALTER TABLE salary_payroll
      ADD CONSTRAINT salary_payroll_year_chk
      CHECK (period_year BETWEEN 2000 AND 2100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_payroll_status_chk'
                 AND conrelid='salary_payroll'::regclass) THEN
    ALTER TABLE salary_payroll
      ADD CONSTRAINT salary_payroll_status_chk
      CHECK (status IN ('draft','advance_paid','finalized','paid'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_payroll_type_chk'
                 AND conrelid='salary_payroll'::regclass) THEN
    ALTER TABLE salary_payroll
      ADD CONSTRAINT salary_payroll_type_chk
      CHECK (salary_type IN ('ugovor','dogovor','satnica'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='salary_payroll_nonneg_chk'
                 AND conrelid='salary_payroll'::regclass) THEN
    ALTER TABLE salary_payroll
      ADD CONSTRAINT salary_payroll_nonneg_chk
      CHECK (advance_amount >= 0 AND fixed_salary >= 0 AND hours_worked >= 0
             AND hourly_rate >= 0 AND transport_rsd >= 0 AND domestic_days >= 0
             AND per_diem_rsd >= 0 AND foreign_days >= 0 AND per_diem_eur >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_salary_payroll_emp       ON salary_payroll(employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_payroll_period    ON salary_payroll(period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_salary_payroll_status    ON salary_payroll(status);

-- Triggers
DROP TRIGGER IF EXISTS trg_salary_payroll_updated ON salary_payroll;
CREATE TRIGGER trg_salary_payroll_updated
  BEFORE UPDATE ON salary_payroll
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION salary_payroll_set_created_by()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by IS NULL OR NEW.created_by = '' THEN
    NEW.created_by := LOWER(COALESCE(auth.jwt() ->> 'email', 'system'));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_salary_payroll_created_by ON salary_payroll;
CREATE TRIGGER trg_salary_payroll_created_by
  BEFORE INSERT ON salary_payroll
  FOR EACH ROW EXECUTE FUNCTION salary_payroll_set_created_by();

/* Auto-izračun total_rsd / total_eur / second_part_rsd na INSERT/UPDATE.
   Čuvamo redundantno u bazi da bi Excel export / reporti bili brzi i
   da FE može da filtrira bez ponovnog računanja. */
CREATE OR REPLACE FUNCTION salary_payroll_compute_totals()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_base NUMERIC(14, 2);
BEGIN
  IF NEW.salary_type = 'satnica' THEN
    v_base := COALESCE(NEW.hours_worked, 0) * COALESCE(NEW.hourly_rate, 0);
  ELSE
    v_base := COALESCE(NEW.fixed_salary, 0);
  END IF;

  NEW.total_rsd := v_base
                 + COALESCE(NEW.transport_rsd, 0)
                 + COALESCE(NEW.per_diem_rsd, 0) * COALESCE(NEW.domestic_days, 0);
  NEW.total_eur := COALESCE(NEW.per_diem_eur, 0) * COALESCE(NEW.foreign_days, 0);
  NEW.second_part_rsd := NEW.total_rsd - COALESCE(NEW.advance_amount, 0);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_salary_payroll_totals ON salary_payroll;
CREATE TRIGGER trg_salary_payroll_totals
  BEFORE INSERT OR UPDATE ON salary_payroll
  FOR EACH ROW EXECUTE FUNCTION salary_payroll_compute_totals();

-- 3) RLS: strogo admin (HR NEMA pristup) --------------------------------
ALTER TABLE salary_payroll ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "salary_payroll_select_admin" ON salary_payroll;
DROP POLICY IF EXISTS "salary_payroll_insert_admin" ON salary_payroll;
DROP POLICY IF EXISTS "salary_payroll_update_admin" ON salary_payroll;
DROP POLICY IF EXISTS "salary_payroll_delete_admin" ON salary_payroll;

CREATE POLICY "salary_payroll_select_admin" ON salary_payroll
  FOR SELECT TO authenticated
  USING (public.current_user_is_admin());

CREATE POLICY "salary_payroll_insert_admin" ON salary_payroll
  FOR INSERT TO authenticated
  WITH CHECK (public.current_user_is_admin());

CREATE POLICY "salary_payroll_update_admin" ON salary_payroll
  FOR UPDATE TO authenticated
  USING      (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

CREATE POLICY "salary_payroll_delete_admin" ON salary_payroll
  FOR DELETE TO authenticated
  USING (public.current_user_is_admin());

-- 4) View: mesečni pregled sa JOIN-om na employees (za brz FE render) -
CREATE OR REPLACE VIEW v_salary_payroll_month AS
SELECT
  p.*,
  e.full_name   AS employee_name,
  e.position    AS employee_position,
  e.department  AS employee_department,
  e.is_active   AS employee_active
FROM salary_payroll p
JOIN employees e ON e.id = p.employee_id;

GRANT SELECT ON v_salary_payroll_month TO authenticated;

-- 5) Pomoćna RPC: inicijalizuj draft redove za sve aktivne zaposlene ---
--
-- Kreira jedan `draft` red po svakom aktivnom zaposlenom za dati mesec,
-- sa snapshot-om trenutnih uslova iz v_employee_current_salary.
-- Idempotentno — redovi koji već postoje se ne diraju.
-- Poziva se iz UI-ja na klik „Pripremi mesec".
CREATE OR REPLACE FUNCTION public.kadr_payroll_init_month(
  p_year INT,
  p_month INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn_init$
DECLARE
  v_count INT := 0;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'invalid month %', p_month;
  END IF;

  WITH ins AS (
    INSERT INTO salary_payroll (
      employee_id, period_year, period_month, salary_type,
      fixed_salary, hourly_rate,
      transport_rsd, per_diem_rsd, per_diem_eur,
      status
    )
    SELECT
      e.id, p_year, p_month,
      COALESCE(s.salary_type, 'ugovor'),
      CASE WHEN COALESCE(s.salary_type,'ugovor') IN ('ugovor','dogovor')
           THEN COALESCE(s.amount, 0) ELSE 0 END,
      CASE WHEN s.salary_type = 'satnica'
           THEN COALESCE(s.amount, 0) ELSE 0 END,
      COALESCE(s.transport_allowance_rsd, 0),
      COALESCE(s.per_diem_rsd, 0),
      COALESCE(s.per_diem_eur, 0),
      'draft'
    FROM employees e
    LEFT JOIN v_employee_current_salary s ON s.employee_id = e.id
    WHERE e.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM salary_payroll p
         WHERE p.employee_id = e.id
           AND p.period_year = p_year
           AND p.period_month = p_month
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM ins;

  RETURN v_count;
END;
$fn_init$;

REVOKE ALL ON FUNCTION public.kadr_payroll_init_month(int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kadr_payroll_init_month(int, int) TO authenticated;

-- 6) Verifikacija -----------------------------------------------------
-- SELECT * FROM v_employee_current_salary LIMIT 3;
-- SELECT * FROM salary_payroll LIMIT 1;
-- SELECT kadr_payroll_init_month(2026, 4);  -- vraća broj novih draft redova
