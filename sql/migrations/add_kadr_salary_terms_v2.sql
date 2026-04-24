-- ═══════════════════════════════════════════════════════════════════════
-- KADROVSKA — Tip zarade (compensation_model) + novčani uslovi (Faza K3.3)
--
-- Postojeća kolona `salary_type` (ugovor/dogovor/satnica) se ZADRŽAVA
-- radi backward kompatibilnosti. Uvodimo NOVU kolonu:
--
--   compensation_model ∈ { fiksno, dva_dela, satnica }
--
-- i pripadajuća novčana polja po modelu:
--
--   FIKSNO:
--     fixed_amount               — mesečna fiksna zarada (RSD)
--     fixed_transport_component  — informativna komponenta prevoza
--                                  (već uračunata u fixed_amount)
--     fixed_extra_hour_rate      — cena sata van fonda (prekovremeni
--                                  i rad na praznik)
--
--   DVA_DELA:
--     first_part_amount          — fiksni prvi deo (akontacija)
--     split_hour_rate            — cena RADNOG sata (drugi deo, prekovremeni,
--                                  rad na praznik)
--     split_transport_amount     — prevoz kao DODATAN iznos
--
--   SATNICA:
--     hourly_rate                — već postoji; cena radnog sata
--     hourly_transport_amount    — prevoz kao DODATAN iznos
--
--   Teren (svi modeli):
--     terrain_domestic_rate      — dnevnica u zemlji (RSD)
--     terrain_foreign_rate       — dnevnica u inostranstvu (EUR)
--
-- Sve nove kolone su nullable / default 0 → safe additive za stare redove.
--
-- Update-uje view `v_employee_current_salary` da uključi nova polja.
--
-- Depends on: add_kadr_salary_terms.sql, add_kadr_salary_payroll.sql
-- Idempotentno, safe za re-run.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'salary_terms') THEN
    RAISE EXCEPTION 'Missing salary_terms. Run add_kadr_salary_terms.sql first.';
  END IF;
END $$;

-- 1) Nove kolone ---------------------------------------------------------
ALTER TABLE salary_terms
  ADD COLUMN IF NOT EXISTS compensation_model         TEXT,
  ADD COLUMN IF NOT EXISTS fixed_amount               NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fixed_transport_component  NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fixed_extra_hour_rate      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_part_amount          NUMERIC(14, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_hour_rate            NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS split_transport_amount     NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS hourly_transport_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terrain_domestic_rate      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terrain_foreign_rate       NUMERIC(10, 2) NOT NULL DEFAULT 0;

-- 2) CHECK na compensation_model ----------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'salary_terms_compensation_model_chk'
                   AND conrelid = 'salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_compensation_model_chk
      CHECK (compensation_model IS NULL
             OR compensation_model IN ('fiksno','dva_dela','satnica'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'salary_terms_v2_nonneg_chk'
                   AND conrelid = 'salary_terms'::regclass) THEN
    ALTER TABLE salary_terms
      ADD CONSTRAINT salary_terms_v2_nonneg_chk
      CHECK (fixed_amount >= 0
             AND fixed_transport_component >= 0
             AND fixed_extra_hour_rate >= 0
             AND first_part_amount >= 0
             AND split_hour_rate >= 0
             AND split_transport_amount >= 0
             AND hourly_transport_amount >= 0
             AND terrain_domestic_rate >= 0
             AND terrain_foreign_rate >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_salary_terms_comp_model
  ON salary_terms(compensation_model);

-- 3) Update view v_employee_current_salary ------------------------------
DROP VIEW IF EXISTS v_employee_current_salary;

CREATE VIEW v_employee_current_salary AS
SELECT DISTINCT ON (st.employee_id)
  st.employee_id,
  st.id                            AS salary_term_id,
  st.salary_type,
  st.compensation_model,
  st.effective_from,
  st.effective_to,
  st.amount,
  st.amount_type,
  st.currency,
  st.hourly_rate,
  st.transport_allowance_rsd,
  st.per_diem_rsd,
  st.per_diem_eur,
  st.fixed_amount,
  st.fixed_transport_component,
  st.fixed_extra_hour_rate,
  st.first_part_amount,
  st.split_hour_rate,
  st.split_transport_amount,
  st.hourly_transport_amount,
  st.terrain_domestic_rate,
  st.terrain_foreign_rate,
  st.contract_ref,
  st.note,
  st.updated_at
FROM salary_terms st
WHERE st.effective_from <= CURRENT_DATE
  AND (st.effective_to IS NULL OR st.effective_to >= CURRENT_DATE)
ORDER BY st.employee_id, st.effective_from DESC;

GRANT SELECT ON v_employee_current_salary TO authenticated;

-- 4) Verifikacija --------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name='salary_terms'
--    AND column_name IN ('compensation_model','fixed_amount',
--        'first_part_amount','split_hour_rate','terrain_domestic_rate');
