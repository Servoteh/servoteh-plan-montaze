-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Kadrovska — Mesečni grid (Excel-like attendance)
-- Extends work_hours so the monthly grid can store:
--   * field_hours       (terenski / field work hours)
--   * absence_code      (go|bo|sp|np|sl|pr) — when present, hours = 0
-- Adds UNIQUE(employee_id, work_date) so the front-end can use
-- PostgREST upsert (Prefer: resolution=merge-duplicates) for
-- batch saves of an entire month at once.
-- Depends on: sql/migrations/add_kadrovska_phase1.sql (work_hours)
-- Safe to run multiple times (idempotent).
-- ═══════════════════════════════════════════════════════════

-- Prerequisite guard --------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'work_hours') THEN
    RAISE EXCEPTION 'Missing work_hours table. Run sql/migrations/add_kadrovska_phase1.sql first.';
  END IF;
END $$;

-- 1) field_hours column (terenski rad) ---------------------
ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS field_hours NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_hours_field_hours_check' AND conrelid = 'work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_field_hours_check
      CHECK (field_hours >= 0 AND field_hours <= 24);
  END IF;
END $$;

-- 2) absence_code column ----------------------------------
--    go = godišnji, bo = bolovanje, sp = slobodan/plaćeni,
--    np = neplaćeno,  sl = službeno, pr = praznik
ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS absence_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_hours_absence_code_check' AND conrelid = 'work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_absence_code_check
      CHECK (absence_code IS NULL OR absence_code IN ('go','bo','sp','np','sl','pr'));
  END IF;
END $$;

-- 3) UNIQUE (employee_id, work_date) for upsert ------------
--    Drop any prior name first to make this idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_hours_emp_date_uq' AND conrelid = 'work_hours'::regclass
  ) THEN
    -- Defensive: if accidental duplicates exist, keep the most recently
    -- updated row per (employee_id, work_date) and delete older copies.
    DELETE FROM work_hours wh
    USING work_hours dup
    WHERE wh.employee_id = dup.employee_id
      AND wh.work_date   = dup.work_date
      AND wh.id <> dup.id
      AND COALESCE(wh.updated_at, wh.created_at) <
          COALESCE(dup.updated_at, dup.created_at);

    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_emp_date_uq UNIQUE (employee_id, work_date);
  END IF;
END $$;

-- 4) Helpful index for grid month queries ------------------
CREATE INDEX IF NOT EXISTS idx_work_hours_date_only
  ON work_hours(work_date);
