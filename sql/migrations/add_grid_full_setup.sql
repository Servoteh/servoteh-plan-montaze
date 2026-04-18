-- ═══════════════════════════════════════════════════════════
-- ALL-IN-ONE: Mesečni grid setup
-- Kombinuje 2 migracije u jednom prolazu (idempotent):
--   1) add_attendance_grid.sql  → field_hours, absence_code, UNIQUE(emp,date)
--   2) add_work_extras.sql      → two_machine_hours, field_subtype
-- Pokreni jednom u Supabase SQL Editor. Bezbedno za re-run.
-- ═══════════════════════════════════════════════════════════

-- Prerequisite ---------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'work_hours') THEN
    RAISE EXCEPTION 'Missing work_hours table. Run sql/migrations/add_kadrovska_phase1.sql first.';
  END IF;
END $$;

-- ═══ Step 1: add_attendance_grid (field_hours, absence_code, unique) ═══

ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS field_hours NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='work_hours_field_hours_check' AND conrelid='work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_field_hours_check
      CHECK (field_hours >= 0 AND field_hours <= 24);
  END IF;
END $$;

ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS absence_code TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='work_hours_absence_code_check' AND conrelid='work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_absence_code_check
      CHECK (absence_code IS NULL OR absence_code IN ('go','bo','sp','np','sl','pr'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='work_hours_emp_date_uq' AND conrelid='work_hours'::regclass
  ) THEN
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

CREATE INDEX IF NOT EXISTS idx_work_hours_date_only
  ON work_hours(work_date);

-- ═══ Step 2: add_work_extras (two_machine_hours, field_subtype) ═══

ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS two_machine_hours NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='work_hours_two_machine_hours_check' AND conrelid='work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_two_machine_hours_check
      CHECK (two_machine_hours >= 0 AND two_machine_hours <= 24);
  END IF;
END $$;

ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS field_subtype TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='work_hours_field_subtype_check' AND conrelid='work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_field_subtype_check
      CHECK (field_subtype IS NULL OR field_subtype IN ('domestic','foreign'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_work_hours_field_subtype
  ON work_hours(field_subtype)
  WHERE field_subtype IS NOT NULL;

-- ═══ Verifikacija ═══
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='work_hours' AND column_name='field_hours')        AS has_field_hours,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='work_hours' AND column_name='absence_code')        AS has_absence_code,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='work_hours' AND column_name='two_machine_hours')   AS has_two_machine,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name='work_hours' AND column_name='field_subtype')       AS has_field_subtype,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='work_hours_emp_date_uq')                              AS has_unique_emp_date;
-- Treba: sva 5 polja = TRUE
