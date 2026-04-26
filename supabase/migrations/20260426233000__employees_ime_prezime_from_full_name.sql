-- Data: popunjavanje first_name / last_name iz full_name.
-- Konvencija: full_name = "Prezime Ime" (prva reč = prezime, ostatak = ime; više reči u imenu ostaju zajedno).
-- Stari SQL (add_kadr_employee_extended) koristio je "poslednja reč = prezime" — ova migracija prepisuje sve redove
-- iz kanonskog full_name da budu usklađeni sa UI i izvozima.
--
-- Napomena: dijakritike su onakve kakve su u full_name; za korekciju pravopisa izmeniti full_name pa ponoviti istu logiku.

UPDATE public.employees e
SET
  last_name = split_part(t.fn, ' ', 1),
  first_name = CASE
    WHEN strpos(t.fn, ' ') > 0
    THEN btrim(substr(t.fn, strpos(t.fn, ' ') + 1))
    ELSE NULL
  END,
  updated_at = now()
FROM (
  SELECT
    id,
    btrim(regexp_replace(coalesce(full_name, ''), E'\\s+', ' ', 'g')) AS fn
  FROM public.employees
) t
WHERE e.id = t.id
  AND t.fn IS NOT NULL
  AND t.fn <> '';

-- Korekcija pravopisa u full_name (primer iz kadrovske evidencije); posle glavnog UPDATE-a.
UPDATE public.employees
SET
  full_name = 'Durutović Jelena',
  last_name = 'Durutović',
  first_name = 'Jelena',
  updated_at = now()
WHERE full_name = 'Durutovic Jelena';
