-- Praktikanti: Janković Mihajlo, Radelić Uroš — nisu u timu HAP Fluid za
-- Kadrovska / mesečni grid. Filter „Firma” = employees.department
-- (src/ui/kadrovska/gridTab.js: e.department === company).
--
-- Premeštaju se na Servoteh da više ne ulaze u filter „HAP Fluid”.
BEGIN;
SET statement_timeout = '120s';

-- work_type *pre* promene sektora, samo redovi koji su još uvek HAP + ova dva
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'employees'
      AND column_name = 'work_type'
  ) THEN
    UPDATE public.employees
    SET
      work_type = 'praksa',
      updated_at = now()
    WHERE department = 'HAP Fluid'
      AND (
        full_name IN (
          'Janković Mihajlo', 'Jankovic Mihajlo',
          'Radelić Uroš', 'Radelić Uros', 'Radelic Uroš', 'Radelic Uros',
          'Mihajlo Janković', 'Mihajlo Jankovic',
          'Uroš Radelić', 'Uros Radelic'
        )
        OR (
          btrim(COALESCE(first_name, '')) = 'Mihajlo'
          AND btrim(COALESCE(last_name, '')) IN ('Janković', 'Jankovic', 'Jankovič')
        )
        OR (
          btrim(COALESCE(first_name, '')) IN ('Uroš', 'Uros')
          AND btrim(COALESCE(last_name, '')) IN ('Radelić', 'Radelic', 'Radelič')
        )
      );
  END IF;
END $$;

UPDATE public.employees
SET
  department = 'Servoteh',
  position = CASE
    WHEN btrim(COALESCE(position, '')) = '' THEN 'Praksa'
    ELSE position
  END,
  note = CASE
    WHEN btrim(COALESCE(note, '')) = '' THEN
      'HAP Fluid: uklonjeno (praksa) — 2026-04.'
    ELSE
      btrim(note) || E'\n' || 'HAP Fluid: uklonjeno (praksa) — 2026-04.'
  END,
  updated_at = now()
WHERE department = 'HAP Fluid'
  AND (
    full_name IN (
      'Janković Mihajlo',
      'Jankovic Mihajlo',
      'Radelić Uroš',
      'Radelić Uros',
      'Radelic Uroš',
      'Radelic Uros',
      'Mihajlo Janković',
      'Mihajlo Jankovic',
      'Uroš Radelić',
      'Uros Radelic'
    )
    OR (
         btrim(COALESCE(first_name, '')) = 'Mihajlo'
     AND btrim(COALESCE(last_name, '')) IN ('Janković', 'Jankovic', 'Jankovič')
    )
    OR (
         btrim(COALESCE(first_name, '')) IN ('Uroš', 'Uros')
     AND btrim(COALESCE(last_name, '')) IN ('Radelić', 'Radelic', 'Radelič')
    )
  );

COMMIT;
