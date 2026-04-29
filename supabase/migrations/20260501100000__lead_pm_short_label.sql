-- Skraćen naziv Lead PM u job_positions + usklađen tekstualni position za Milana Stojadinovića.

UPDATE public.job_positions
SET name = 'LEAD PM'
WHERE name = 'Viši projekt menadžer (Lead PM)';

UPDATE public.employees
SET position = 'LEAD PM'
WHERE full_name IN ('Stojadinovic Milan', 'Stojadinović Milan')
  AND position IN ('Glavni Projekt Menadzer', 'Viši projekt menadžer (Lead PM)');
