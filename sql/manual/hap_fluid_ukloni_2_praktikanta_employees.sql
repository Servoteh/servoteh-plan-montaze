-- Pokreni u Supabase → SQL (NEW query) da odmah uklonīš dva praktikanta
-- sa „HAP Fluid” u tabeli zaposlenih (isti prikaz kao u Kadrovskoj listi).
--
-- 0) (opciono) Vidi koga tačno hvata:
--    SELECT id, full_name, first_name, last_name, department, position
--    FROM public.employees
--    WHERE department = 'HAP Fluid'
--      AND (
--        full_name ILIKE '%Jankov%Mihajlo%'
--        OR full_name ILIKE '%Radel%Uro%'
--      );
--
-- 1) Glavna izmena: department → Servoteh

BEGIN;

UPDATE public.employees
SET
  department = 'Servoteh',
  position = CASE
    WHEN btrim(COALESCE(position, '')) = '' THEN 'Praksa'
    ELSE position
  END,
  note = CASE
    WHEN btrim(COALESCE(note, '')) = '' THEN
      'HAP Fluid → Servoteh (praksa, ručni fix).'
    ELSE
      btrim(note) || E'\n' || 'HAP Fluid → Servoteh (praksa, ručni fix).'
  END,
  updated_at = now()
WHERE department = 'HAP Fluid'
  AND (
    (full_name ILIKE 'Jankovi%Mihajlo%' OR full_name ILIKE 'Mihajlo%Jankovi%')
    OR
    (full_name ILIKE 'Radeli%Uro%' OR full_name ILIKE 'Uro%Radeli%')
  );

COMMIT;

-- Ako UPDATE pokaže 0 redova, proveri tačan full_name (korak 0), pa npr.:
-- UPDATE public.employees SET department = 'Servoteh', updated_at = now()
-- WHERE id = 'PASTE-UUID' AND department = 'HAP Fluid';
