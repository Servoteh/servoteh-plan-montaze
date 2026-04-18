-- ═══════════════════════════════════════════════════════════
-- MIGRATION: Kadrovska — PHASE 1 business rules enforcement
-- Enforces the business rules for the Kadrovska module:
--   * contracts.date_from must be NOT NULL (start date is mandatory)
--   * contracts.date_to may be NULL (end date is optional)
--   * contracts.date_to (if present) must be >= contracts.date_from
-- Depends on: sql/migrations/add_kadrovska_phase1.sql
-- Safe to run multiple times (idempotent).
-- ═══════════════════════════════════════════════════════════

-- Prerequisite guard --------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'contracts') THEN
    RAISE EXCEPTION 'Missing contracts table. Run sql/migrations/add_kadrovska_phase1.sql first.';
  END IF;
END $$;

-- 1) Backfill any existing NULL date_from before enforcing NOT NULL
--    (safe fallback: use created_at::date, else CURRENT_DATE)
UPDATE contracts
SET date_from = COALESCE(date_from, created_at::date, CURRENT_DATE)
WHERE date_from IS NULL;

-- 2) Enforce NOT NULL on date_from
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contracts' AND column_name = 'date_from' AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE contracts ALTER COLUMN date_from SET NOT NULL;
  END IF;
END $$;

-- 3) Ensure date ordering: date_to must be >= date_from when present
--    Use a NOT VALID → VALIDATE pattern so the migration succeeds on
--    big tables without long locks, and cleanly skips if already there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'contracts_dates_valid' AND conrelid = 'contracts'::regclass
  ) THEN
    ALTER TABLE contracts
      ADD CONSTRAINT contracts_dates_valid
      CHECK (date_to IS NULL OR date_to >= date_from) NOT VALID;
    ALTER TABLE contracts VALIDATE CONSTRAINT contracts_dates_valid;
  END IF;
END $$;
