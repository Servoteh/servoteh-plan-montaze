-- ============================================================================
-- SEED: Master lokacije iz BigTehn `dbo.tPozicije` (snimljeno sa servera)
-- ============================================================================
-- JEDNOKRATNA skripta. Idempotentna — bezbedna za ponovno pokretanje.
-- Sadrži 25 realnih polica; preskače placeholder redove `-`, `DEFINISI POLICU`
-- i `H2` koji nisu stvarne police.
--
-- Pokreni u Supabase SQL Editoru (paste celog fajla → Run).
-- ============================================================================

-- ── A — ROOT + VIRTUALNE LOKACIJE ───────────────────────────────────────────
-- MAG       : fizički parent za sve police (hijerarhija je flat u BigTehn-u).
-- UGRADJENO : komad ušao u finalni sklop — izlazi iz bilansa.
-- PROIZVODNJA: komad je WIP (u radu), još nije završen.
-- OTPISANO  : softverski škart (za razliku od K-S koji je fizička polica).
INSERT INTO public.loc_locations (location_code, name, location_type, parent_id, is_active)
VALUES
  ('MAG',         'Centralni magacin',                'WAREHOUSE',  NULL, true),
  ('UGRADJENO',   'Ugrađeno u finalni proizvod',      'ASSEMBLY',   NULL, true),
  ('PROIZVODNJA', 'U proizvodnji (work-in-progress)', 'PRODUCTION', NULL, true),
  ('OTPISANO',    'Otpisano / softverski škart',      'SCRAPPED',   NULL, true)
ON CONFLICT (location_code) DO NOTHING;

-- ── B — POLICE IZ tPozicije (25 redova) ─────────────────────────────────────
WITH parent AS (
  SELECT id FROM public.loc_locations WHERE location_code = 'MAG' LIMIT 1
),
src (code, naziv) AS (
  VALUES
    ('K-A1',  'FARBANJE'),
    ('K-A2',  'FARBANJE'),
    ('K-A3',  'FARBANJE'),
    ('K-A4',  'FARBANJE'),
    ('K-A5',  'FARBANJE'),
    ('K-A6',  'FARBANJE'),
    ('K-B1',  'ZAVARIVANJE'),
    ('K-B2',  'ZAVARIVANJE'),
    ('K-B3',  'ZAVARIVANJE'),
    ('K-B4',  'ZAVARIVANJE'),
    ('K-B5',  'ZAVARIVANJE'),
    ('K-B6',  'ZAVARIVANJE'),
    ('K-C1',  'ZAVRŠNA'),
    ('K-C2',  'ZAVRŠNA'),
    ('K-C3',  'ZAVRŠNA'),
    ('K-C4',  'ZAVRŠNA'),
    ('K-C5',  'ZAVRŠNA'),
    ('K-C6',  'ZAVRŠNA'),
    ('K-D',   'DORADA'),
    ('K-M',   'MONTAZA'),
    ('K-MG',  'MAGACIN'),
    ('K-MG3', 'MAGACIN_H3'),
    ('K-MG4', 'MAGACIN_H4'),
    ('K-MG8', 'MAGACIN_H8'),
    ('K-S',   'ŠKART')
),
ins AS (
  INSERT INTO public.loc_locations (location_code, name, location_type, parent_id, is_active)
  SELECT
    s.code,
    s.naziv,
    'SHELF'::public.loc_type_enum,
    (SELECT id FROM parent),
    true
  FROM src s
  ON CONFLICT (location_code) DO NOTHING
  RETURNING 1
)
SELECT
  (SELECT count(*) FROM src) AS u_ulazu,
  (SELECT count(*) FROM ins) AS ubacenih_novih,
  (SELECT count(*) FROM src) - (SELECT count(*) FROM ins) AS preskocenih_duplikata;

-- ── C — SANITY CHECK (automatski) ───────────────────────────────────────────
-- Pregled svega što je ubačeno, grupisano po tipu.
SELECT location_type, count(*) AS broj, string_agg(location_code, ', ' ORDER BY location_code) AS kodovi
FROM public.loc_locations
GROUP BY location_type
ORDER BY location_type;
