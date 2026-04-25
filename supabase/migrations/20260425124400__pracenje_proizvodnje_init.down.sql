-- ============================================================================
-- DRAFT ROLLBACK: Praćenje proizvodnje — backend osnov modula
-- ============================================================================
-- Pokretati samo ako je odgovarajuća up migracija primenjena i review potvrdi
-- da nema drugih objekata u šemama core/production/pdm koji zavise od ovih.
-- ============================================================================

BEGIN;

-- RPC i helper funkcije
DROP FUNCTION IF EXISTS production.skini_blokadu(uuid, text);
DROP FUNCTION IF EXISTS production.set_blokirano(uuid, text);
DROP FUNCTION IF EXISTS production.promovisi_akcionu_tacku(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS production.zatvori_aktivnost(uuid, text);
DROP FUNCTION IF EXISTS production.upsert_operativna_aktivnost(
  uuid, uuid, uuid, uuid, text, date, date, uuid, uuid,
  production.aktivnost_status, production.aktivnost_prioritet, integer,
  text, text, text, text, uuid, text, production.aktivnost_status_mode,
  text, production.aktivnost_izvor, uuid, uuid, uuid
);
DROP FUNCTION IF EXISTS production.get_operativni_plan(uuid, uuid);
DROP FUNCTION IF EXISTS production.get_pracenje_rn(uuid);
DROP FUNCTION IF EXISTS production.can_edit_pracenje(uuid, uuid);

-- Trigger funkcije
DROP FUNCTION IF EXISTS production.log_operativna_blok_promenu();
DROP FUNCTION IF EXISTS production.touch_updated_at();

-- View-ovi
DROP VIEW IF EXISTS production.v_operativna_aktivnost;
DROP VIEW IF EXISTS production.v_pozicija_progress;

-- Production tabele u obrnutom redosledu zavisnosti
DROP TABLE IF EXISTS production.operativna_aktivnost_blok_istorija;
DROP TABLE IF EXISTS production.operativna_aktivnost_pozicija;
DROP TABLE IF EXISTS production.operativna_aktivnost;
DROP TABLE IF EXISTS production.radni_nalog_saglasnost;
DROP TABLE IF EXISTS production.radni_nalog_lansiranje;
DROP TABLE IF EXISTS production.prijava_rada;
DROP TABLE IF EXISTS production.tp_operacija;
DROP TABLE IF EXISTS production.radni_nalog_pozicija;
DROP TABLE IF EXISTS production.radni_nalog;

-- PDM i core tabele
DROP TABLE IF EXISTS pdm.drawing;
DROP TABLE IF EXISTS core.radnik_alias;
ALTER TABLE IF EXISTS core.odeljenje DROP CONSTRAINT IF EXISTS core_odeljenje_vodja_radnik_fk;
DROP TABLE IF EXISTS core.radnik;
DROP TABLE IF EXISTS core.work_center;
DROP TABLE IF EXISTS core.odeljenje;

-- Enumi
DROP TYPE IF EXISTS production.tp_status;
DROP TYPE IF EXISTS production.rn_status;
DROP TYPE IF EXISTS production.aktivnost_status_mode;
DROP TYPE IF EXISTS production.aktivnost_izvor;
DROP TYPE IF EXISTS production.aktivnost_prioritet;
DROP TYPE IF EXISTS production.aktivnost_status;

-- Šeme se drop-uju samo ako su sada prazne.
DROP SCHEMA IF EXISTS pdm;
DROP SCHEMA IF EXISTS core;
DROP SCHEMA IF EXISTS production;

NOTIFY pgrst, 'reload schema';

COMMIT;
