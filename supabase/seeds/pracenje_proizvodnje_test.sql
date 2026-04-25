-- ============================================================================
-- TEST FIXTURE: Praćenje proizvodnje
-- ============================================================================
-- Pokrenuti tek nakon 20260425124400__pracenje_proizvodnje_init.sql.
-- Minimalni skup: 1 projekat, 1 RN, 3 pozicije, 5 TP operacija, 7 prijava
-- rada i 4 operativne aktivnosti (nije_krenulo, u_toku, blokirano, zavrseno).
-- ============================================================================

BEGIN;

-- Postojeća Faza 1 tabela; seed kreira izolovan test projekat.
INSERT INTO public.projects (
  id,
  project_code,
  project_name,
  projectm,
  project_deadline,
  pm_email,
  leadpm_email,
  reminder_enabled,
  status
)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'PRAC-PROD-TEST',
  'Test projekat - Praćenje proizvodnje',
  'Test linija',
  current_date + 30,
  'pm.test@example.com',
  'leadpm.test@example.com',
  false,
  'active'
)
ON CONFLICT (id) DO UPDATE SET
  project_name = EXCLUDED.project_name,
  project_deadline = EXCLUDED.project_deadline,
  status = EXCLUDED.status;

INSERT INTO core.radnik (id, sifra_radnika, ime, puno_ime, email, aktivan, legacy_sifra_radnika)
VALUES
  ('22222222-2222-2222-2222-222222222201', 1001, 'Aleksa', 'Aleksa Test', 'aleksa.test@example.com', true, 1001),
  ('22222222-2222-2222-2222-222222222202', 1002, 'Dača', 'Dača Test', 'daca.test@example.com', true, 1002),
  ('22222222-2222-2222-2222-222222222203', 1003, 'Nenad', 'Nenad Test', 'nenad.test@example.com', true, 1003)
ON CONFLICT (id) DO UPDATE SET
  ime = EXCLUDED.ime,
  puno_ime = EXCLUDED.puno_ime,
  email = EXCLUDED.email,
  updated_at = now();

INSERT INTO core.radnik_alias (id, radnik_id, alias, is_primary)
VALUES
  ('22222222-2222-2222-2222-222222222211', '22222222-2222-2222-2222-222222222201', 'Aleksa', true),
  ('22222222-2222-2222-2222-222222222212', '22222222-2222-2222-2222-222222222202', 'Dača', true),
  ('22222222-2222-2222-2222-222222222213', '22222222-2222-2222-2222-222222222203', 'Nenad', true)
ON CONFLICT ((lower(alias))) DO NOTHING;

INSERT INTO core.work_center (id, kod, naziv, odeljenje_id, legacy_rjgruparc, legacy_idoperacije)
VALUES
  ('33333333-3333-3333-3333-333333333301', '2.1', 'Struganje test', (SELECT id FROM core.odeljenje WHERE kod = 'MAS'), '2.1', 21),
  ('33333333-3333-3333-3333-333333333302', '3.1', 'Glodanje test', (SELECT id FROM core.odeljenje WHERE kod = 'MAS'), '3.1', 31),
  ('33333333-3333-3333-3333-333333333303', '4.1', 'Zavarivanje test', (SELECT id FROM core.odeljenje WHERE kod = 'ZAV'), '4.1', 41),
  ('33333333-3333-3333-3333-333333333304', '5.1', 'Farbanje test', (SELECT id FROM core.odeljenje WHERE kod = 'FAR'), '5.1', 51),
  ('33333333-3333-3333-3333-333333333305', '8.3', 'Kontrola test', (SELECT id FROM core.odeljenje WHERE kod = 'KK'), '8.3', 83)
ON CONFLICT (kod) DO UPDATE SET
  naziv = EXCLUDED.naziv,
  odeljenje_id = EXCLUDED.odeljenje_id,
  updated_at = now();

INSERT INTO pdm.drawing (id, drawing_no, revision, naziv, materijal, dimenzije, status, legacy_idcrtez)
VALUES
  ('44444444-4444-4444-4444-444444444401', 'SC-TEST-1000', 'A', 'Test podsklop', 'Čelik', '100x50', 'test', 90001),
  ('44444444-4444-4444-4444-444444444402', 'SC-TEST-1001', 'A', 'Test direktan deo 1', 'Čelik', '80x40', 'test', 90002),
  ('44444444-4444-4444-4444-444444444403', 'SC-TEST-1002', 'A', 'Test direktan deo 2', 'Aluminijum', '60x30', 'test', 90003)
ON CONFLICT (drawing_no, revision) DO UPDATE SET
  naziv = EXCLUDED.naziv,
  materijal = EXCLUDED.materijal,
  dimenzije = EXCLUDED.dimenzije,
  updated_at = now();

INSERT INTO production.radni_nalog (
  id,
  projekat_id,
  rn_broj,
  naziv,
  kupac_text,
  datum_isporuke,
  rok_izrade,
  status,
  koordinator_radnik_id,
  napomena,
  legacy_idrn,
  legacy_idpredmet,
  legacy_idcrtez
)
VALUES (
  '55555555-5555-5555-5555-555555555501',
  '11111111-1111-1111-1111-111111111111',
  'RN-PRAC-TEST-001',
  'Test linija za praćenje proizvodnje',
  'Test kupac',
  current_date + 30,
  current_date + 20,
  'lansiran',
  '22222222-2222-2222-2222-222222222203',
  'Seed fixture za smoke test RPC-a.',
  990001,
  880001,
  90001
)
ON CONFLICT (id) DO UPDATE SET
  datum_isporuke = EXCLUDED.datum_isporuke,
  rok_izrade = EXCLUDED.rok_izrade,
  status = EXCLUDED.status,
  updated_at = now();

INSERT INTO production.radni_nalog_pozicija (
  id,
  radni_nalog_id,
  parent_id,
  drawing_id,
  sifra_pozicije,
  naziv,
  kolicina_plan,
  jedinica_mere,
  sort_order,
  legacy_idrn,
  legacy_idkomponente
)
VALUES
  ('66666666-6666-6666-6666-666666666601', '55555555-5555-5555-5555-555555555501', NULL, '44444444-4444-4444-4444-444444444401', 'P-1000', 'Podsklop test', 10, 'kom', 10, 990101, 770001),
  ('66666666-6666-6666-6666-666666666602', '55555555-5555-5555-5555-555555555501', NULL, '44444444-4444-4444-4444-444444444402', 'P-1001', 'Direktan deo 1', 12, 'kom', 20, 990102, 770002),
  ('66666666-6666-6666-6666-666666666603', '55555555-5555-5555-5555-555555555501', NULL, '44444444-4444-4444-4444-444444444403', 'P-1002', 'Direktan deo 2', 8, 'kom', 30, 990103, 770003)
ON CONFLICT (id) DO UPDATE SET
  naziv = EXCLUDED.naziv,
  kolicina_plan = EXCLUDED.kolicina_plan,
  updated_at = now();

INSERT INTO production.tp_operacija (
  id,
  radni_nalog_id,
  radni_nalog_pozicija_id,
  work_center_id,
  operacija_kod,
  naziv,
  opis_rada,
  tpz,
  tk,
  prioritet,
  legacy_idstavke_rn
)
VALUES
  ('77777777-7777-7777-7777-777777777701', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666601', '33333333-3333-3333-3333-333333333301', 10, 'Struganje', 'Struganje podsklopa', 1, 0.5, 10, 101),
  ('77777777-7777-7777-7777-777777777702', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666601', '33333333-3333-3333-3333-333333333302', 20, 'Glodanje', 'Glodanje podsklopa', 1, 0.75, 20, 102),
  ('77777777-7777-7777-7777-777777777703', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666602', '33333333-3333-3333-3333-333333333303', 30, 'Zavarivanje', 'Zavarivanje direktnog dela 1', 1, 0.6, 30, 103),
  ('77777777-7777-7777-7777-777777777704', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666602', '33333333-3333-3333-3333-333333333304', 40, 'Farbanje', 'Farbanje direktnog dela 1', 1, 0.4, 40, 104),
  ('77777777-7777-7777-7777-777777777705', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666603', '33333333-3333-3333-3333-333333333305', 50, 'Kontrola', 'Kontrola direktnog dela 2', 1, 0.2, 50, 105)
ON CONFLICT (id) DO UPDATE SET
  naziv = EXCLUDED.naziv,
  opis_rada = EXCLUDED.opis_rada,
  updated_at = now();

INSERT INTO production.prijava_rada (
  id,
  radni_nalog_id,
  radni_nalog_pozicija_id,
  tp_operacija_id,
  radnik_id,
  work_center_id,
  operacija_kod,
  kolicina,
  started_at,
  finished_at,
  is_completed,
  napomena,
  legacy_idpostupka
)
VALUES
  ('88888888-8888-8888-8888-888888888801', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666601', '77777777-7777-7777-7777-777777777701', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 10, 2, now() - interval '7 days', now() - interval '7 days' + interval '2 hours', false, 'Prva delimična prijava', 201),
  ('88888888-8888-8888-8888-888888888802', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666601', '77777777-7777-7777-7777-777777777701', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', 10, 3, now() - interval '6 days', now() - interval '6 days' + interval '2 hours', false, 'Druga delimična prijava', 202),
  ('88888888-8888-8888-8888-888888888803', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666601', '77777777-7777-7777-7777-777777777702', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', 20, 10, now() - interval '5 days', now() - interval '5 days' + interval '3 hours', true, 'Glodanje završeno', 203),
  ('88888888-8888-8888-8888-888888888804', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666602', '77777777-7777-7777-7777-777777777703', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333303', 30, 4, now() - interval '4 days', now() - interval '4 days' + interval '1 hour', false, 'Zavarivanje 1', 204),
  ('88888888-8888-8888-8888-888888888805', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666602', '77777777-7777-7777-7777-777777777703', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333303', 30, 4, now() - interval '3 days', now() - interval '3 days' + interval '1 hour', false, 'Zavarivanje 2', 205),
  ('88888888-8888-8888-8888-888888888806', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666602', '77777777-7777-7777-7777-777777777703', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333303', 30, 4, now() - interval '2 days', now() - interval '2 days' + interval '1 hour', true, 'Zavarivanje završeno', 206),
  ('88888888-8888-8888-8888-888888888807', '55555555-5555-5555-5555-555555555501', '66666666-6666-6666-6666-666666666602', '77777777-7777-7777-7777-777777777704', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333304', 40, 12, now() - interval '1 day', now() - interval '1 day' + interval '1 hour', true, 'Farbanje završeno', 207)
ON CONFLICT (id) DO UPDATE SET
  kolicina = EXCLUDED.kolicina,
  finished_at = EXCLUDED.finished_at,
  is_completed = EXCLUDED.is_completed,
  updated_at = now();

INSERT INTO production.operativna_aktivnost (
  id,
  radni_nalog_id,
  projekat_id,
  rb,
  odeljenje_id,
  naziv_aktivnosti,
  broj_tp,
  kolicina_text,
  planirani_pocetak,
  planirani_zavrsetak,
  odgovoran_radnik_id,
  odgovoran_label,
  status,
  status_mode,
  manual_override_status,
  blokirano_razlog,
  prioritet,
  rizik_napomena,
  izvor,
  izvor_pozicija_id,
  izvor_tp_operacija_id
)
VALUES
  ('99999999-9999-9999-9999-999999999901', '55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111', 10, (SELECT id FROM core.odeljenje WHERE kod = 'MAS'), 'Struganje podsklopa', 'TP-10', '10 kom', current_date - 7, current_date + 5, '22222222-2222-2222-2222-222222222201', 'Aleksa', 'nije_krenulo', 'auto_from_operacije', NULL, NULL, 'visok', NULL, 'iz_tp', '66666666-6666-6666-6666-666666666601', '77777777-7777-7777-7777-777777777701'),
  ('99999999-9999-9999-9999-999999999902', '55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111', 20, (SELECT id FROM core.odeljenje WHERE kod = 'KK'), 'Kontrola direktnog dela 2', 'TP-50', '8 kom', current_date, current_date + 10, '22222222-2222-2222-2222-222222222202', 'Dača', 'nije_krenulo', 'auto_from_operacije', NULL, NULL, 'srednji', NULL, 'iz_tp', '66666666-6666-6666-6666-666666666603', '77777777-7777-7777-7777-777777777705'),
  ('99999999-9999-9999-9999-999999999903', '55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111', 30, (SELECT id FROM core.odeljenje WHERE kod = 'ZAV'), 'Materijal i priprema delova', NULL, 'set', current_date - 2, current_date + 3, '22222222-2222-2222-2222-222222222203', 'Nenad', 'u_toku', 'manual', 'blokirano', 'Nedostaje materijal za završetak pripreme', 'visok', 'Dobavljač kasni', 'rucno', NULL, NULL),
  ('99999999-9999-9999-9999-999999999904', '55555555-5555-5555-5555-555555555501', '11111111-1111-1111-1111-111111111111', 40, (SELECT id FROM core.odeljenje WHERE kod = 'FAR'), 'Farbanje direktnog dela 1', 'TP-40', '12 kom', current_date - 3, current_date + 2, '22222222-2222-2222-2222-222222222202', 'Dača', 'nije_krenulo', 'auto_from_operacije', NULL, NULL, 'nizak', NULL, 'iz_tp', '66666666-6666-6666-6666-666666666602', '77777777-7777-7777-7777-777777777704')
ON CONFLICT (id) DO UPDATE SET
  naziv_aktivnosti = EXCLUDED.naziv_aktivnosti,
  status = EXCLUDED.status,
  status_mode = EXCLUDED.status_mode,
  manual_override_status = EXCLUDED.manual_override_status,
  blokirano_razlog = EXCLUDED.blokirano_razlog,
  updated_at = now();

INSERT INTO production.operativna_aktivnost_pozicija (aktivnost_id, radni_nalog_pozicija_id, tp_operacija_id, tezina, napomena)
VALUES
  ('99999999-9999-9999-9999-999999999901', '66666666-6666-6666-6666-666666666601', '77777777-7777-7777-7777-777777777701', 1, 'Auto status u_toku'),
  ('99999999-9999-9999-9999-999999999902', '66666666-6666-6666-6666-666666666603', '77777777-7777-7777-7777-777777777705', 1, 'Auto status nije_krenulo'),
  ('99999999-9999-9999-9999-999999999904', '66666666-6666-6666-6666-666666666602', '77777777-7777-7777-7777-777777777704', 1, 'Auto status zavrseno')
ON CONFLICT (aktivnost_id, radni_nalog_pozicija_id, tp_operacija_id) DO NOTHING;

COMMIT;

-- Smoke test primeri:
-- SELECT production.get_pracenje_rn('55555555-5555-5555-5555-555555555501');
-- SELECT production.get_operativni_plan(p_rn_id => '55555555-5555-5555-5555-555555555501');
