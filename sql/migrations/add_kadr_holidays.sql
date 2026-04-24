-- ═══════════════════════════════════════════════════════════════════════
-- KADROVSKA — Državni praznici Republike Srbije (Faza K3.3)
--
-- Tabela `kadr_holidays` drži kalendar državnih praznika.
-- Praznici NISU hardkodovani u UI-ju — payroll engine i grid-validacije
-- konsultuju ovu tabelu (cache na FE u `kadrHolidaysState`).
--
-- Polja:
--   * holiday_date — datum (UNIQUE)
--   * name         — naziv praznika (Nova godina, Sretenje, Vaskrs, …)
--   * is_workday   — TRUE ako je zakonom propisan radni dan (default FALSE)
--   * note         — slobodno
--
-- Seed: RS praznici za 2026 i 2027 (Zakon o državnim i drugim praznicima
-- u Republici Srbiji, „Sl. glasnik RS" br. 43/2001 i izmene).
--
-- RLS: SELECT za sve authenticated, INSERT/UPDATE/DELETE samo admin.
-- Idempotentno, safe za re-run (seed ide uz ON CONFLICT DO NOTHING).
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'current_user_is_admin') THEN
    RAISE EXCEPTION 'Missing current_user_is_admin(). Run add_admin_roles.sql first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at') THEN
    RAISE EXCEPTION 'Missing update_updated_at(). Run schema.sql first.';
  END IF;
END $$;

-- 1) Tabela --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kadr_holidays (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date DATE NOT NULL,
  name         TEXT NOT NULL,
  is_workday   BOOLEAN NOT NULL DEFAULT false,
  note         TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT kadr_holidays_date_unique UNIQUE (holiday_date)
);

CREATE INDEX IF NOT EXISTS idx_kadr_holidays_date ON kadr_holidays(holiday_date);
CREATE INDEX IF NOT EXISTS idx_kadr_holidays_year
  ON kadr_holidays((EXTRACT(YEAR FROM holiday_date)::int));

-- 2) Trigger updated_at --------------------------------------------------
DROP TRIGGER IF EXISTS trg_kadr_holidays_updated ON kadr_holidays;
CREATE TRIGGER trg_kadr_holidays_updated
  BEFORE UPDATE ON kadr_holidays
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 3) RLS -----------------------------------------------------------------
ALTER TABLE kadr_holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kadr_holidays_select" ON kadr_holidays;
DROP POLICY IF EXISTS "kadr_holidays_insert_admin" ON kadr_holidays;
DROP POLICY IF EXISTS "kadr_holidays_update_admin" ON kadr_holidays;
DROP POLICY IF EXISTS "kadr_holidays_delete_admin" ON kadr_holidays;

CREATE POLICY "kadr_holidays_select" ON kadr_holidays
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "kadr_holidays_insert_admin" ON kadr_holidays
  FOR INSERT TO authenticated WITH CHECK (public.current_user_is_admin());

CREATE POLICY "kadr_holidays_update_admin" ON kadr_holidays
  FOR UPDATE TO authenticated
  USING      (public.current_user_is_admin())
  WITH CHECK (public.current_user_is_admin());

CREATE POLICY "kadr_holidays_delete_admin" ON kadr_holidays
  FOR DELETE TO authenticated USING (public.current_user_is_admin());

-- 4) Seed: 2026 ----------------------------------------------------------
-- Pravoslavni Vaskrs 2026 = 12.04.2026 → Vaskršnji praznici 10–13.04.2026
INSERT INTO kadr_holidays (holiday_date, name) VALUES
  (DATE '2026-01-01', 'Nova godina (1. dan)'),
  (DATE '2026-01-02', 'Nova godina (2. dan)'),
  (DATE '2026-01-07', 'Božić'),
  (DATE '2026-02-15', 'Sretenje – Dan državnosti (1. dan)'),
  (DATE '2026-02-16', 'Sretenje – Dan državnosti (2. dan)'),
  (DATE '2026-02-17', 'Sretenje – prenosno (15.02. nedelja)'),
  (DATE '2026-04-10', 'Veliki petak'),
  (DATE '2026-04-11', 'Velika subota'),
  (DATE '2026-04-12', 'Vaskrs'),
  (DATE '2026-04-13', 'Vaskršnji ponedeljak'),
  (DATE '2026-05-01', 'Praznik rada (1. dan)'),
  (DATE '2026-05-02', 'Praznik rada (2. dan)'),
  (DATE '2026-11-11', 'Dan primirja u Prvom svetskom ratu')
ON CONFLICT (holiday_date) DO NOTHING;

-- 5) Seed: 2027 ----------------------------------------------------------
-- Pravoslavni Vaskrs 2027 = 02.05.2027 → Vaskršnji praznici 30.04.–03.05.2027
-- Napomena: 02.05.2027 (Vaskrs) se poklapa sa Praznikom rada (2. dan)
INSERT INTO kadr_holidays (holiday_date, name) VALUES
  (DATE '2027-01-01', 'Nova godina (1. dan)'),
  (DATE '2027-01-02', 'Nova godina (2. dan)'),
  (DATE '2027-01-07', 'Božić'),
  (DATE '2027-02-15', 'Sretenje – Dan državnosti (1. dan)'),
  (DATE '2027-02-16', 'Sretenje – Dan državnosti (2. dan)'),
  (DATE '2027-04-30', 'Veliki petak'),
  (DATE '2027-05-01', 'Praznik rada (1. dan) / Velika subota'),
  (DATE '2027-05-02', 'Vaskrs / Praznik rada (2. dan)'),
  (DATE '2027-05-03', 'Vaskršnji ponedeljak – prenosno'),
  (DATE '2027-11-11', 'Dan primirja u Prvom svetskom ratu')
ON CONFLICT (holiday_date) DO NOTHING;

-- 6) Verifikacija --------------------------------------------------------
-- SELECT holiday_date, name FROM kadr_holidays
--  WHERE EXTRACT(YEAR FROM holiday_date) IN (2026, 2027)
--  ORDER BY holiday_date;
