-- ═══════════════════════════════════════════════════════════
-- Migration: add phase_type column to phases table
-- ═══════════════════════════════════════════════════════════
-- Stores the type of each montage phase so the Gantt can render
-- Mašinska (mechanical) bars in a darker tier and Elektro
-- (electrical) bars in a lighter tier with a diagonal pattern
-- fallback for print/PDF exports.
--
-- Safe to run multiple times (idempotent).
-- Backward compatible: existing rows default to 'mechanical'.
-- The client (index.html) already infers 'electrical' heuristically
-- when phase_name contains "Elektro", so historical data is
-- classified automatically without a backfill if you prefer.
-- ═══════════════════════════════════════════════════════════

ALTER TABLE phases
  ADD COLUMN IF NOT EXISTS phase_type TEXT
  DEFAULT 'mechanical'
  CHECK (phase_type IN ('mechanical','electrical'));

-- Optional backfill: classify existing rows by name.
UPDATE phases
   SET phase_type = 'electrical'
 WHERE phase_type IS NULL
    OR (phase_type = 'mechanical' AND LOWER(phase_name) LIKE '%elektro%');

UPDATE phases
   SET phase_type = 'mechanical'
 WHERE phase_type IS NULL;

-- Useful index for filter/aggregation queries.
CREATE INDEX IF NOT EXISTS idx_phases_phase_type ON phases(phase_type);
