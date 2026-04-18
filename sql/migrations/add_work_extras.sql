-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Kadrovska — Mesečni grid extras
-- Dodaje za potrebe tabova "Mesečni grid" i "Izveštaji":
--   * two_machine_hours  — broj sati rada na dve mašine taj dan
--                          (zasebno se evidentira jer se dodatno plaća)
--   * field_subtype      — podtip terena: 'domestic' (u zemlji) /
--                          'foreign' (u inostranstvu). Validan samo
--                          ako field_hours > 0.
-- Depends on: sql/migrations/add_attendance_grid.sql
-- Safe to run multiple times (idempotent).
-- ═══════════════════════════════════════════════════════════

-- Prerequisite guard --------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'work_hours') THEN
    RAISE EXCEPTION 'Missing work_hours table. Run sql/migrations/add_kadrovska_phase1.sql first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='work_hours' AND column_name='field_hours'
  ) THEN
    RAISE EXCEPTION 'Missing work_hours.field_hours. Run sql/migrations/add_attendance_grid.sql first.';
  END IF;
END $$;

-- 1) two_machine_hours kolona -----------------------------
ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS two_machine_hours NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_hours_two_machine_hours_check'
      AND conrelid = 'work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_two_machine_hours_check
      CHECK (two_machine_hours >= 0 AND two_machine_hours <= 24);
  END IF;
END $$;

-- 2) field_subtype kolona ---------------------------------
--    'domestic' = u zemlji
--    'foreign'  = u inostranstvu
ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS field_subtype TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_hours_field_subtype_check'
      AND conrelid = 'work_hours'::regclass
  ) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_field_subtype_check
      CHECK (field_subtype IS NULL OR field_subtype IN ('domestic','foreign'));
  END IF;
END $$;

-- 3) Soft consistency: ako field_hours = 0, field_subtype mora biti NULL
--    (ne forsiramo CHECK jer želimo da batch upsert-i ne padaju zbog
--    redosleda update-a; rešavamo na FE strani u _gridApplyEdit).

-- 4) Helpful index za reports koji filtriraju po subtype-u
CREATE INDEX IF NOT EXISTS idx_work_hours_field_subtype
  ON work_hours(field_subtype)
  WHERE field_subtype IS NOT NULL;
