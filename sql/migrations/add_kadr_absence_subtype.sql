-- ═══════════════════════════════════════════════════════════════════════
-- KADROVSKA — Detaljnija odsustva (Faza K3.3)
--
-- Dodaje:
--   * absences.absence_subtype  — preciziranje vrste za type='bolovanje':
--       'obicno' (65%), 'povreda_na_radu' (100%), 'odrzavanje_trudnoce' (100%)
--   * absences.slobodan_reason  — razlog za type='slobodan' (strukturisano,
--       dugoročno bolje za reporte i statistiku):
--       'brak', 'rodjenje_deteta', 'selidba', 'smrt_clana_porodice',
--       'dobrovoljno_davanje_krvi', 'ostalo'
--   * work_hours.absence_subtype — isti enum, mirror absences za bolovanje
--                                   uneto direktno iz mesečnog grida
--
-- Sve je nullable; ako je zadat subtype, mora odgovarati type-u.
--
-- Depends on: add_kadrovska_phase1.sql, add_attendance_grid.sql,
--             add_kadr_employee_extended.sql
-- Idempotentno, safe za re-run.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'absences') THEN
    RAISE EXCEPTION 'Missing absences. Run add_kadrovska_phase1.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'work_hours') THEN
    RAISE EXCEPTION 'Missing work_hours. Run add_kadrovska_phase1.sql first.';
  END IF;
END $$;

-- 1) absences.absence_subtype + absences.slobodan_reason ----------------
ALTER TABLE absences
  ADD COLUMN IF NOT EXISTS absence_subtype TEXT,
  ADD COLUMN IF NOT EXISTS slobodan_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='absences_absence_subtype_chk'
                   AND conrelid='absences'::regclass) THEN
    ALTER TABLE absences
      ADD CONSTRAINT absences_absence_subtype_chk
      CHECK (absence_subtype IS NULL
             OR absence_subtype IN ('obicno','povreda_na_radu','odrzavanje_trudnoce'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='absences_slobodan_reason_chk'
                   AND conrelid='absences'::regclass) THEN
    ALTER TABLE absences
      ADD CONSTRAINT absences_slobodan_reason_chk
      CHECK (slobodan_reason IS NULL
             OR slobodan_reason IN ('brak','rodjenje_deteta','selidba',
                                    'smrt_clana_porodice',
                                    'dobrovoljno_davanje_krvi','ostalo'));
  END IF;

  /* Konzistentnost: subtype dozvoljen samo uz bolovanje;
     slobodan_reason samo uz slobodan/placeno. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='absences_subtype_consistency_chk'
                   AND conrelid='absences'::regclass) THEN
    ALTER TABLE absences
      ADD CONSTRAINT absences_subtype_consistency_chk
      CHECK (
        (absence_subtype IS NULL OR type = 'bolovanje')
        AND
        (slobodan_reason IS NULL OR type IN ('slobodan','placeno'))
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_absences_subtype  ON absences(absence_subtype)
  WHERE absence_subtype IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_absences_slobodan ON absences(slobodan_reason)
  WHERE slobodan_reason IS NOT NULL;

-- 2) work_hours.absence_subtype -----------------------------------------
ALTER TABLE work_hours
  ADD COLUMN IF NOT EXISTS absence_subtype TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='work_hours_absence_subtype_chk'
                   AND conrelid='work_hours'::regclass) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_absence_subtype_chk
      CHECK (absence_subtype IS NULL
             OR absence_subtype IN ('obicno','povreda_na_radu','odrzavanje_trudnoce'));
  END IF;

  /* Subtype dozvoljen samo kada je u gridu uneto bolovanje (absence_code='bo') */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='work_hours_subtype_consistency_chk'
                   AND conrelid='work_hours'::regclass) THEN
    ALTER TABLE work_hours
      ADD CONSTRAINT work_hours_subtype_consistency_chk
      CHECK (absence_subtype IS NULL OR absence_code = 'bo');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_work_hours_subtype ON work_hours(absence_subtype)
  WHERE absence_subtype IS NOT NULL;

-- 3) Verifikacija --------------------------------------------------------
-- SELECT type, absence_subtype, slobodan_reason
--   FROM absences
--  WHERE absence_subtype IS NOT NULL OR slobodan_reason IS NOT NULL
--  LIMIT 10;
