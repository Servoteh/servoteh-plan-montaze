-- ============================================================================
-- DRAFT MIGRATION: Praćenje proizvodnje — backend osnov modula
-- ============================================================================
-- Ne izvršavati automatski nad bazom. Namenjeno je za review, zatim ručno
-- pokretanje u Supabase SQL Editoru / psql-u.
--
-- Zavisi od Faza 1 objekata:
--   public.projects, public.employees, public.akcioni_plan, public.user_roles,
--   public.has_edit_role(uuid), public.audit_log, public.audit_row_change().
-- ============================================================================

BEGIN;

-- ===== SEKCIJA 1 — Šeme ======================================================

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS production;
CREATE SCHEMA IF NOT EXISTS pdm;

GRANT USAGE ON SCHEMA core TO authenticated;
GRANT USAGE ON SCHEMA production TO authenticated;
GRANT USAGE ON SCHEMA pdm TO authenticated;

-- ===== SEKCIJA 2 — Enumi =====================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'production' AND t.typname = 'aktivnost_status') THEN
    CREATE TYPE production.aktivnost_status AS ENUM ('nije_krenulo', 'u_toku', 'blokirano', 'zavrseno');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'production' AND t.typname = 'aktivnost_prioritet') THEN
    CREATE TYPE production.aktivnost_prioritet AS ENUM ('nizak', 'srednji', 'visok');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'production' AND t.typname = 'aktivnost_izvor') THEN
    CREATE TYPE production.aktivnost_izvor AS ENUM ('rucno', 'iz_sastanka', 'iz_tp', 'iz_proizvodnje');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'production' AND t.typname = 'aktivnost_status_mode') THEN
    CREATE TYPE production.aktivnost_status_mode AS ENUM ('manual', 'auto_from_pozicija', 'auto_from_operacije');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'production' AND t.typname = 'rn_status') THEN
    CREATE TYPE production.rn_status AS ENUM ('draft', 'aktivan', 'lansiran', 'zavrsen', 'arhiviran', 'otkazan');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'production' AND t.typname = 'tp_status') THEN
    CREATE TYPE production.tp_status AS ENUM ('nije_krenulo', 'u_toku', 'blokirano', 'zavrseno', 'preskoceno');
  END IF;
END$$;

-- ===== SEKCIJA 3 — core tabele ==============================================

CREATE TABLE IF NOT EXISTS core.odeljenje (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod text NOT NULL UNIQUE,
  naziv text NOT NULL,
  vodja_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  vodja_radnik_id uuid,
  boja text NOT NULL DEFAULT '#64748b',
  sort_order integer NOT NULL DEFAULT 100,
  aktivan boolean NOT NULL DEFAULT true,
  legacy_department_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.work_center (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kod text NOT NULL UNIQUE,
  naziv text NOT NULL,
  odeljenje_id uuid REFERENCES core.odeljenje(id) ON DELETE SET NULL,
  napomena text,
  aktivan boolean NOT NULL DEFAULT true,
  legacy_rjgruparc text,
  legacy_idoperacije integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.radnik (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  odeljenje_id uuid REFERENCES core.odeljenje(id) ON DELETE SET NULL,
  sifra_radnika integer,
  ime text NOT NULL,
  puno_ime text,
  email text,
  kartica_id text,
  aktivan boolean NOT NULL DEFAULT true,
  legacy_sifra_radnika integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT core_radnik_sifra_radnika_unique UNIQUE (sifra_radnika),
  CONSTRAINT core_radnik_legacy_sifra_radnika_unique UNIQUE (legacy_sifra_radnika)
);

CREATE TABLE IF NOT EXISTS core.radnik_alias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radnik_id uuid NOT NULL REFERENCES core.radnik(id) ON DELETE CASCADE,
  alias text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  napomena text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS core_radnik_alias_lower_alias_uidx
  ON core.radnik_alias (lower(alias));

ALTER TABLE core.odeljenje
  DROP CONSTRAINT IF EXISTS core_odeljenje_vodja_radnik_fk,
  ADD CONSTRAINT core_odeljenje_vodja_radnik_fk
  FOREIGN KEY (vodja_radnik_id) REFERENCES core.radnik(id) ON DELETE SET NULL;

-- ===== SEKCIJA 4 — pdm tabele ===============================================

CREATE TABLE IF NOT EXISTS pdm.drawing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_no text NOT NULL,
  revision text NOT NULL DEFAULT 'A',
  naziv text NOT NULL,
  materijal text,
  dimenzije text,
  status text,
  legacy_idcrtez integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pdm_drawing_no_revision_unique UNIQUE (drawing_no, revision),
  CONSTRAINT pdm_drawing_legacy_idcrtez_unique UNIQUE (legacy_idcrtez)
);

-- ===== SEKCIJA 5 — production tabele ========================================

CREATE TABLE IF NOT EXISTS production.radni_nalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projekat_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  rn_broj text NOT NULL,
  naziv text NOT NULL,
  kupac_text text,
  datum_isporuke date,
  rok_izrade date,
  status production.rn_status NOT NULL DEFAULT 'aktivan',
  koordinator_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  koordinator_radnik_id uuid REFERENCES core.radnik(id) ON DELETE SET NULL,
  napomena text,
  legacy_idrn integer,
  legacy_idpredmet integer,
  legacy_idcrtez integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT production_radni_nalog_rn_broj_unique UNIQUE (rn_broj),
  CONSTRAINT production_radni_nalog_legacy_idrn_unique UNIQUE (legacy_idrn)
);

CREATE TABLE IF NOT EXISTS production.radni_nalog_pozicija (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radni_nalog_id uuid NOT NULL REFERENCES production.radni_nalog(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES production.radni_nalog_pozicija(id) ON DELETE CASCADE,
  drawing_id uuid REFERENCES pdm.drawing(id) ON DELETE SET NULL,
  sifra_pozicije text,
  naziv text NOT NULL,
  kolicina_plan numeric(12,3) NOT NULL DEFAULT 1,
  jedinica_mere text NOT NULL DEFAULT 'kom',
  sort_order integer NOT NULL DEFAULT 100,
  napomena text,
  legacy_idrn integer,
  legacy_idkomponente integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS production.tp_operacija (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radni_nalog_id uuid NOT NULL REFERENCES production.radni_nalog(id) ON DELETE CASCADE,
  radni_nalog_pozicija_id uuid NOT NULL REFERENCES production.radni_nalog_pozicija(id) ON DELETE CASCADE,
  work_center_id uuid REFERENCES core.work_center(id) ON DELETE SET NULL,
  operacija_kod integer NOT NULL,
  naziv text NOT NULL,
  opis_rada text,
  alat_pribor text,
  tpz numeric(12,3) NOT NULL DEFAULT 0,
  tk numeric(12,3) NOT NULL DEFAULT 0,
  status_override production.tp_status,
  prioritet integer NOT NULL DEFAULT 100,
  legacy_idstavke_rn integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT production_tp_operacija_legacy_unique UNIQUE (legacy_idstavke_rn)
);

CREATE TABLE IF NOT EXISTS production.prijava_rada (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radni_nalog_id uuid NOT NULL REFERENCES production.radni_nalog(id) ON DELETE CASCADE,
  radni_nalog_pozicija_id uuid NOT NULL REFERENCES production.radni_nalog_pozicija(id) ON DELETE CASCADE,
  tp_operacija_id uuid REFERENCES production.tp_operacija(id) ON DELETE SET NULL,
  radnik_id uuid REFERENCES core.radnik(id) ON DELETE SET NULL,
  work_center_id uuid REFERENCES core.work_center(id) ON DELETE SET NULL,
  operacija_kod integer,
  kolicina numeric(12,3) NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  is_completed boolean NOT NULL DEFAULT false,
  napomena text,
  legacy_idpostupka integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT production_prijava_rada_nonnegative_qty CHECK (kolicina >= 0),
  CONSTRAINT production_prijava_rada_legacy_unique UNIQUE (legacy_idpostupka)
);

CREATE TABLE IF NOT EXISTS production.radni_nalog_lansiranje (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radni_nalog_id uuid NOT NULL REFERENCES production.radni_nalog(id) ON DELETE CASCADE,
  lansiran boolean NOT NULL DEFAULT true,
  datum_unosa timestamptz NOT NULL DEFAULT now(),
  created_by_radnik_id uuid REFERENCES core.radnik(id) ON DELETE SET NULL,
  potpis_unos text,
  legacy_idlansiran integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT production_rn_lansiranje_legacy_unique UNIQUE (legacy_idlansiran)
);

CREATE TABLE IF NOT EXISTS production.radni_nalog_saglasnost (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radni_nalog_id uuid NOT NULL REFERENCES production.radni_nalog(id) ON DELETE CASCADE,
  saglasan boolean NOT NULL DEFAULT true,
  datum_unosa timestamptz NOT NULL DEFAULT now(),
  created_by_radnik_id uuid REFERENCES core.radnik(id) ON DELETE SET NULL,
  potpis_unos text,
  legacy_idsaglasan integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT production_rn_saglasnost_legacy_unique UNIQUE (legacy_idsaglasan)
);

CREATE TABLE IF NOT EXISTS production.operativna_aktivnost (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  radni_nalog_id uuid NOT NULL REFERENCES production.radni_nalog(id) ON DELETE CASCADE,
  projekat_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  rb integer NOT NULL DEFAULT 100,
  odeljenje_id uuid NOT NULL REFERENCES core.odeljenje(id) ON DELETE RESTRICT,
  naziv_aktivnosti text NOT NULL,
  opis text,
  broj_tp text,
  kolicina_text text,
  planirani_pocetak date,
  planirani_zavrsetak date,
  odgovoran_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  odgovoran_radnik_id uuid REFERENCES core.radnik(id) ON DELETE SET NULL,
  odgovoran_label text,
  zavisi_od_aktivnost_id uuid REFERENCES production.operativna_aktivnost(id) ON DELETE SET NULL,
  zavisi_od_text text,
  status production.aktivnost_status NOT NULL DEFAULT 'nije_krenulo',
  status_mode production.aktivnost_status_mode NOT NULL DEFAULT 'manual',
  manual_override_status production.aktivnost_status,
  blokirano_razlog text,
  prioritet production.aktivnost_prioritet NOT NULL DEFAULT 'srednji',
  rizik_napomena text,
  izvor production.aktivnost_izvor NOT NULL DEFAULT 'rucno',
  izvor_akcioni_plan_id uuid REFERENCES public.akcioni_plan(id) ON DELETE SET NULL,
  izvor_pozicija_id uuid REFERENCES production.radni_nalog_pozicija(id) ON DELETE SET NULL,
  izvor_tp_operacija_id uuid REFERENCES production.tp_operacija(id) ON DELETE SET NULL,
  zatvoren_at timestamptz,
  zatvoren_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  zatvoren_napomena text,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT production_oa_blokirano_reason_chk CHECK (
    manual_override_status IS DISTINCT FROM 'blokirano'::production.aktivnost_status
    OR nullif(trim(blokirano_razlog), '') IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS production.operativna_aktivnost_pozicija (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aktivnost_id uuid NOT NULL REFERENCES production.operativna_aktivnost(id) ON DELETE CASCADE,
  radni_nalog_pozicija_id uuid NOT NULL REFERENCES production.radni_nalog_pozicija(id) ON DELETE CASCADE,
  tp_operacija_id uuid REFERENCES production.tp_operacija(id) ON DELETE SET NULL,
  tezina numeric(8,4) NOT NULL DEFAULT 1,
  napomena text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT production_oa_pozicija_unique UNIQUE (aktivnost_id, radni_nalog_pozicija_id, tp_operacija_id)
);

CREATE TABLE IF NOT EXISTS production.operativna_aktivnost_blok_istorija (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aktivnost_id uuid NOT NULL REFERENCES production.operativna_aktivnost(id) ON DELETE CASCADE,
  old_manual_override_status production.aktivnost_status,
  new_manual_override_status production.aktivnost_status,
  old_blokirano_razlog text,
  new_blokirano_razlog text,
  napomena text,
  changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_by_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ===== SEKCIJA 6 — Indeksi ===================================================

CREATE INDEX IF NOT EXISTS core_odeljenje_vodja_user_idx ON core.odeljenje(vodja_user_id);
CREATE INDEX IF NOT EXISTS core_odeljenje_vodja_radnik_idx ON core.odeljenje(vodja_radnik_id);
CREATE INDEX IF NOT EXISTS core_work_center_odeljenje_idx ON core.work_center(odeljenje_id);
CREATE INDEX IF NOT EXISTS core_radnik_employee_idx ON core.radnik(employee_id);
CREATE INDEX IF NOT EXISTS core_radnik_odeljenje_idx ON core.radnik(odeljenje_id);
CREATE INDEX IF NOT EXISTS core_radnik_alias_radnik_idx ON core.radnik_alias(radnik_id);
CREATE INDEX IF NOT EXISTS pdm_drawing_legacy_idx ON pdm.drawing(legacy_idcrtez) WHERE legacy_idcrtez IS NOT NULL;

CREATE INDEX IF NOT EXISTS production_radni_nalog_projekat_idx ON production.radni_nalog(projekat_id);
CREATE INDEX IF NOT EXISTS production_radni_nalog_koordinator_user_idx ON production.radni_nalog(koordinator_user_id);
CREATE INDEX IF NOT EXISTS production_radni_nalog_koordinator_radnik_idx ON production.radni_nalog(koordinator_radnik_id);
CREATE INDEX IF NOT EXISTS production_radni_nalog_pozicija_tree_idx ON production.radni_nalog_pozicija(radni_nalog_id, parent_id, sort_order);
CREATE INDEX IF NOT EXISTS production_radni_nalog_pozicija_parent_idx ON production.radni_nalog_pozicija(parent_id);
CREATE INDEX IF NOT EXISTS production_radni_nalog_pozicija_drawing_idx ON production.radni_nalog_pozicija(drawing_id);
CREATE INDEX IF NOT EXISTS production_tp_operacija_pozicija_wc_idx ON production.tp_operacija(radni_nalog_pozicija_id, work_center_id);
CREATE INDEX IF NOT EXISTS production_tp_operacija_rn_idx ON production.tp_operacija(radni_nalog_id);
CREATE INDEX IF NOT EXISTS production_tp_operacija_wc_idx ON production.tp_operacija(work_center_id);
CREATE INDEX IF NOT EXISTS production_prijava_rada_agg_idx ON production.prijava_rada(radni_nalog_id, radni_nalog_pozicija_id, tp_operacija_id);
CREATE INDEX IF NOT EXISTS production_prijava_rada_radnik_idx ON production.prijava_rada(radnik_id);
CREATE INDEX IF NOT EXISTS production_prijava_rada_wc_idx ON production.prijava_rada(work_center_id);
CREATE INDEX IF NOT EXISTS production_rn_lansiranje_rn_idx ON production.radni_nalog_lansiranje(radni_nalog_id);
CREATE INDEX IF NOT EXISTS production_rn_lansiranje_radnik_idx ON production.radni_nalog_lansiranje(created_by_radnik_id);
CREATE INDEX IF NOT EXISTS production_rn_saglasnost_rn_idx ON production.radni_nalog_saglasnost(radni_nalog_id);
CREATE INDEX IF NOT EXISTS production_rn_saglasnost_radnik_idx ON production.radni_nalog_saglasnost(created_by_radnik_id);
CREATE INDEX IF NOT EXISTS production_oa_rn_dept_status_idx ON production.operativna_aktivnost(radni_nalog_id, odeljenje_id, status_mode);
CREATE INDEX IF NOT EXISTS production_oa_projekat_idx ON production.operativna_aktivnost(projekat_id);
CREATE INDEX IF NOT EXISTS production_oa_odeljenje_idx ON production.operativna_aktivnost(odeljenje_id);
CREATE INDEX IF NOT EXISTS production_oa_odgovoran_user_idx ON production.operativna_aktivnost(odgovoran_user_id);
CREATE INDEX IF NOT EXISTS production_oa_odgovoran_radnik_idx ON production.operativna_aktivnost(odgovoran_radnik_id);
CREATE INDEX IF NOT EXISTS production_oa_zavisi_idx ON production.operativna_aktivnost(zavisi_od_aktivnost_id);
CREATE INDEX IF NOT EXISTS production_oa_akcioni_plan_idx ON production.operativna_aktivnost(izvor_akcioni_plan_id);
CREATE INDEX IF NOT EXISTS production_oa_izvor_pozicija_idx ON production.operativna_aktivnost(izvor_pozicija_id);
CREATE INDEX IF NOT EXISTS production_oa_izvor_tp_idx ON production.operativna_aktivnost(izvor_tp_operacija_id);
CREATE INDEX IF NOT EXISTS production_oa_planirani_zavrsetak_idx ON production.operativna_aktivnost(planirani_zavrsetak);
CREATE INDEX IF NOT EXISTS production_oa_pozicija_aktivnost_idx ON production.operativna_aktivnost_pozicija(aktivnost_id);
CREATE INDEX IF NOT EXISTS production_oa_pozicija_pozicija_idx ON production.operativna_aktivnost_pozicija(radni_nalog_pozicija_id);
CREATE INDEX IF NOT EXISTS production_oa_pozicija_tp_idx ON production.operativna_aktivnost_pozicija(tp_operacija_id);
CREATE INDEX IF NOT EXISTS production_oa_blok_aktivnost_idx ON production.operativna_aktivnost_blok_istorija(aktivnost_id, created_at DESC);

-- ===== SEKCIJA 7 — View-ovi ==================================================

CREATE OR REPLACE VIEW production.v_pozicija_progress
WITH (security_invoker = true)
AS
SELECT
  rnp.id AS radni_nalog_pozicija_id,
  tp.id AS tp_operacija_id,
  rnp.radni_nalog_id,
  rnp.kolicina_plan AS planirano_komada,
  COALESCE(sum(pr.kolicina), 0)::numeric(12,3) AS prijavljeno_komada,
  count(pr.id)::integer AS broj_prijava,
  max(pr.finished_at) AS poslednja_prijava_at,
  CASE
    WHEN tp.status_override = 'blokirano'::production.tp_status THEN 'blokirano'::production.aktivnost_status
    WHEN COALESCE(sum(pr.kolicina), 0) <= 0 THEN 'nije_krenulo'::production.aktivnost_status
    WHEN COALESCE(sum(pr.kolicina), 0) < rnp.kolicina_plan THEN 'u_toku'::production.aktivnost_status
    ELSE 'zavrseno'::production.aktivnost_status
  END AS auto_status,
  CASE
    WHEN rnp.kolicina_plan > 0 THEN LEAST(100, ROUND((COALESCE(sum(pr.kolicina), 0) / rnp.kolicina_plan) * 100))::integer
    ELSE 0
  END AS progress_pct
FROM production.radni_nalog_pozicija rnp
JOIN production.tp_operacija tp ON tp.radni_nalog_pozicija_id = rnp.id
LEFT JOIN production.prijava_rada pr ON pr.tp_operacija_id = tp.id
GROUP BY rnp.id, tp.id, rnp.radni_nalog_id, rnp.kolicina_plan, tp.status_override;

CREATE OR REPLACE VIEW production.v_operativna_aktivnost
WITH (security_invoker = true)
AS
WITH linked AS (
  SELECT
    oa.id AS aktivnost_id,
    COALESCE(oap.radni_nalog_pozicija_id, oa.izvor_pozicija_id) AS radni_nalog_pozicija_id,
    COALESCE(oap.tp_operacija_id, oa.izvor_tp_operacija_id) AS tp_operacija_id
  FROM production.operativna_aktivnost oa
  LEFT JOIN production.operativna_aktivnost_pozicija oap ON oap.aktivnost_id = oa.id
  WHERE oap.id IS NOT NULL OR oa.izvor_pozicija_id IS NOT NULL OR oa.izvor_tp_operacija_id IS NOT NULL
),
linked_progress AS (
  SELECT
    l.aktivnost_id,
    count(*)::integer AS linked_count,
    COALESCE(sum(vpp.planirano_komada), 0)::numeric(12,3) AS planirano_komada,
    COALESCE(sum(vpp.prijavljeno_komada), 0)::numeric(12,3) AS prijavljeno_komada,
    bool_or(vpp.auto_status = 'blokirano') AS any_blocked,
    bool_or(vpp.prijavljeno_komada > 0) AS any_started,
    bool_and(vpp.auto_status = 'zavrseno') AS all_done
  FROM linked l
  LEFT JOIN production.v_pozicija_progress vpp
    ON vpp.radni_nalog_pozicija_id = l.radni_nalog_pozicija_id
   AND (l.tp_operacija_id IS NULL OR vpp.tp_operacija_id = l.tp_operacija_id)
  GROUP BY l.aktivnost_id
),
effective AS (
  SELECT
    oa.*,
    rn.datum_isporuke,
    rn.rn_broj,
    rn.naziv AS radni_nalog_naziv,
    od.kod AS odeljenje_kod,
    od.naziv AS odeljenje_naziv,
    COALESCE(lp.linked_count, 0) AS linked_count,
    COALESCE(lp.planirano_komada, 0) AS planirano_komada,
    COALESCE(lp.prijavljeno_komada, 0) AS prijavljeno_komada,
    CASE
      WHEN lp.linked_count IS NULL OR lp.linked_count = 0 THEN oa.status
      WHEN lp.any_blocked THEN 'blokirano'::production.aktivnost_status
      WHEN lp.all_done THEN 'zavrseno'::production.aktivnost_status
      WHEN lp.any_started THEN 'u_toku'::production.aktivnost_status
      ELSE 'nije_krenulo'::production.aktivnost_status
    END AS auto_status
  FROM production.operativna_aktivnost oa
  JOIN production.radni_nalog rn ON rn.id = oa.radni_nalog_id
  JOIN core.odeljenje od ON od.id = oa.odeljenje_id
  LEFT JOIN linked_progress lp ON lp.aktivnost_id = oa.id
)
SELECT
  e.*,
  CASE
    WHEN e.manual_override_status = 'blokirano'::production.aktivnost_status THEN 'blokirano'::production.aktivnost_status
    WHEN e.status_mode IN ('auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode) THEN e.auto_status
    ELSE e.status
  END AS efektivni_status,
  (e.status_mode IN ('auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode)) AS status_is_auto,
  CASE WHEN e.datum_isporuke IS NOT NULL AND e.planirani_zavrsetak IS NOT NULL THEN e.datum_isporuke - e.planirani_zavrsetak ELSE NULL END AS rezerva_dani,
  CASE
    WHEN e.planirani_zavrsetak IS NULL THEN false
    ELSE current_date > e.planirani_zavrsetak
      AND (
        CASE
          WHEN e.manual_override_status = 'blokirano'::production.aktivnost_status THEN 'blokirano'::production.aktivnost_status
          WHEN e.status_mode IN ('auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode) THEN e.auto_status
          ELSE e.status
        END
      ) <> 'zavrseno'::production.aktivnost_status
  END AS kasni,
  e.odeljenje_naziv AS dashboard_odeljenje,
  CASE
    WHEN e.status_mode IN ('auto_from_pozicija'::production.aktivnost_status_mode, 'auto_from_operacije'::production.aktivnost_status_mode)
    THEN format('prijavljeno %s/%s', e.prijavljeno_komada, e.planirano_komada)
    ELSE NULL
  END AS status_detail
FROM effective e;

GRANT SELECT ON production.v_pozicija_progress TO authenticated;
GRANT SELECT ON production.v_operativna_aktivnost TO authenticated;

-- ===== SEKCIJA 8 — RPC funkcije =============================================

CREATE OR REPLACE FUNCTION production.get_pracenje_rn(p_rn_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = production, core, pdm, public, pg_temp
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  SELECT jsonb_build_object(
    'header', jsonb_build_object(
      'radni_nalog_id', rn.id,
      'rn_broj', rn.rn_broj,
      'projekat_id', rn.projekat_id,
      'projekat_naziv', p.project_name,
      'kupac', rn.kupac_text,
      'datum_isporuke', rn.datum_isporuke,
      'koordinator', cr.puno_ime,
      'napomena', rn.napomena
    ),
    'summary', jsonb_build_object(
      'pozicija_total', (SELECT count(*) FROM production.radni_nalog_pozicija WHERE radni_nalog_id = p_rn_id),
      'operacija_total', (SELECT count(*) FROM production.tp_operacija WHERE radni_nalog_id = p_rn_id),
      'nije_krenulo', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'nije_krenulo'),
      'u_toku', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'u_toku'),
      'zavrseno', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'zavrseno'),
      'blokirano', (SELECT count(*) FROM production.v_pozicija_progress WHERE radni_nalog_id = p_rn_id AND auto_status = 'blokirano')
    ),
    'positions', COALESCE((
      SELECT jsonb_agg(pos.payload ORDER BY pos.sort_order, pos.naziv)
      FROM (
        SELECT
          rnp.sort_order,
          rnp.naziv,
          jsonb_build_object(
            'id', rnp.id,
            'parent_id', rnp.parent_id,
            'sifra_pozicije', rnp.sifra_pozicije,
            'naziv', rnp.naziv,
            'kolicina_plan', rnp.kolicina_plan,
            'progress_pct', COALESCE(ROUND(avg(vpp.progress_pct))::integer, 0),
            'operations', COALESCE(jsonb_agg(
              jsonb_build_object(
                'tp_operacija_id', tp.id,
                'operacija_kod', tp.operacija_kod,
                'naziv', tp.naziv,
                'work_center', wc.kod,
                'planirano_komada', COALESCE(vpp.planirano_komada, rnp.kolicina_plan),
                'prijavljeno_komada', COALESCE(vpp.prijavljeno_komada, 0),
                'status', COALESCE(vpp.auto_status, 'nije_krenulo'::production.aktivnost_status),
                'poslednja_prijava_at', vpp.poslednja_prijava_at
              )
              ORDER BY tp.prioritet, tp.operacija_kod
            ) FILTER (WHERE tp.id IS NOT NULL), '[]'::jsonb),
            'children', '[]'::jsonb
          ) AS payload
        FROM production.radni_nalog_pozicija rnp
        LEFT JOIN production.tp_operacija tp ON tp.radni_nalog_pozicija_id = rnp.id
        LEFT JOIN core.work_center wc ON wc.id = tp.work_center_id
        LEFT JOIN production.v_pozicija_progress vpp ON vpp.tp_operacija_id = tp.id
        WHERE rnp.radni_nalog_id = p_rn_id
        GROUP BY rnp.id, rnp.sort_order, rnp.naziv, rnp.parent_id, rnp.sifra_pozicije, rnp.kolicina_plan
      ) pos
    ), '[]'::jsonb)
  )
  INTO v_payload
  FROM production.radni_nalog rn
  LEFT JOIN public.projects p ON p.id = rn.projekat_id
  LEFT JOIN core.radnik cr ON cr.id = rn.koordinator_radnik_id
  WHERE rn.id = p_rn_id;

  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'Radni nalog % ne postoji', p_rn_id;
  END IF;

  RETURN v_payload;
END;
$$;

CREATE OR REPLACE FUNCTION production.get_operativni_plan(p_rn_id uuid DEFAULT NULL, p_projekat_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = production, core, public, pg_temp
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  IF p_rn_id IS NULL AND p_projekat_id IS NULL THEN
    RAISE EXCEPTION 'get_operativni_plan: prosledi p_rn_id ili p_projekat_id';
  END IF;

  SELECT jsonb_build_object(
    'header', (
      SELECT jsonb_build_object(
        'radni_nalog_id', rn.id,
        'projekat_id', rn.projekat_id,
        'kupac', rn.kupac_text,
        'rn_broj', rn.rn_broj,
        'masina_linija', rn.naziv,
        'datum_isporuke', rn.datum_isporuke,
        'koordinator', cr.puno_ime,
        'napomena', rn.napomena
      )
      FROM production.radni_nalog rn
      LEFT JOIN core.radnik cr ON cr.id = rn.koordinator_radnik_id
      WHERE (p_rn_id IS NULL OR rn.id = p_rn_id)
        AND (p_projekat_id IS NULL OR rn.projekat_id = p_projekat_id)
      ORDER BY rn.created_at
      LIMIT 1
    ),
    'activities', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', v.id,
        'rb', v.rb,
        'odeljenje', v.odeljenje_naziv,
        'naziv_aktivnosti', v.naziv_aktivnosti,
        'broj_tp', v.broj_tp,
        'kolicina_text', v.kolicina_text,
        'planirani_pocetak', v.planirani_pocetak,
        'planirani_zavrsetak', v.planirani_zavrsetak,
        'odgovoran', COALESCE(v.odgovoran_label, r.puno_ime, r.ime),
        'zavisi_od', COALESCE(dep.naziv_aktivnosti, v.zavisi_od_text),
        'efektivni_status', v.efektivni_status,
        'status_is_auto', v.status_is_auto,
        'status_detail', v.status_detail,
        'prioritet', v.prioritet,
        'rizik_napomena', v.rizik_napomena,
        'rezerva_dani', v.rezerva_dani,
        'kasni', v.kasni
      ) ORDER BY v.odeljenje_naziv, v.rb)
      FROM production.v_operativna_aktivnost v
      LEFT JOIN core.radnik r ON r.id = v.odgovoran_radnik_id
      LEFT JOIN production.operativna_aktivnost dep ON dep.id = v.zavisi_od_aktivnost_id
      WHERE (p_rn_id IS NULL OR v.radni_nalog_id = p_rn_id)
        AND (p_projekat_id IS NULL OR v.projekat_id = p_projekat_id)
    ), '[]'::jsonb),
    'dashboard', jsonb_build_object(
      'total', (
        SELECT jsonb_build_object(
          'ukupno', count(*),
          'zavrseno', count(*) FILTER (WHERE v.efektivni_status = 'zavrseno'),
          'u_toku', count(*) FILTER (WHERE v.efektivni_status = 'u_toku'),
          'blokirano', count(*) FILTER (WHERE v.efektivni_status = 'blokirano'),
          'nije_krenulo', count(*) FILTER (WHERE v.efektivni_status = 'nije_krenulo'),
          'najkasniji_planirani_zavrsetak', max(v.planirani_zavrsetak)
        )
        FROM production.v_operativna_aktivnost v
        WHERE (p_rn_id IS NULL OR v.radni_nalog_id = p_rn_id)
          AND (p_projekat_id IS NULL OR v.projekat_id = p_projekat_id)
      ),
      'po_odeljenjima', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'odeljenje', x.odeljenje,
          'ukupno', x.ukupno,
          'zavrseno', x.zavrseno,
          'u_toku', x.u_toku,
          'blokirano', x.blokirano,
          'nije_krenulo', x.nije_krenulo,
          'najkasniji_planirani_zavrsetak', x.najkasniji_planirani_zavrsetak
        ) ORDER BY x.odeljenje)
        FROM (
          SELECT
            v.odeljenje_naziv AS odeljenje,
            count(*) AS ukupno,
            count(*) FILTER (WHERE v.efektivni_status = 'zavrseno') AS zavrseno,
            count(*) FILTER (WHERE v.efektivni_status = 'u_toku') AS u_toku,
            count(*) FILTER (WHERE v.efektivni_status = 'blokirano') AS blokirano,
            count(*) FILTER (WHERE v.efektivni_status = 'nije_krenulo') AS nije_krenulo,
            max(v.planirani_zavrsetak) AS najkasniji_planirani_zavrsetak
          FROM production.v_operativna_aktivnost v
          WHERE (p_rn_id IS NULL OR v.radni_nalog_id = p_rn_id)
            AND (p_projekat_id IS NULL OR v.projekat_id = p_projekat_id)
          GROUP BY v.odeljenje_naziv
        ) x
      ), '[]'::jsonb)
    )
  ) INTO v_payload;

  RETURN v_payload;
END;
$$;

CREATE OR REPLACE FUNCTION production.upsert_operativna_aktivnost(
  p_id uuid DEFAULT NULL,
  p_radni_nalog_id uuid DEFAULT NULL,
  p_projekat_id uuid DEFAULT NULL,
  p_odeljenje_id uuid DEFAULT NULL,
  p_naziv_aktivnosti text DEFAULT NULL,
  p_planirani_pocetak date DEFAULT NULL,
  p_planirani_zavrsetak date DEFAULT NULL,
  p_odgovoran_user_id uuid DEFAULT NULL,
  p_odgovoran_radnik_id uuid DEFAULT NULL,
  p_status production.aktivnost_status DEFAULT 'nije_krenulo',
  p_prioritet production.aktivnost_prioritet DEFAULT 'srednji',
  p_rb integer DEFAULT 100,
  p_opis text DEFAULT NULL,
  p_broj_tp text DEFAULT NULL,
  p_kolicina_text text DEFAULT NULL,
  p_odgovoran_label text DEFAULT NULL,
  p_zavisi_od_aktivnost_id uuid DEFAULT NULL,
  p_zavisi_od_text text DEFAULT NULL,
  p_status_mode production.aktivnost_status_mode DEFAULT 'manual',
  p_rizik_napomena text DEFAULT NULL,
  p_izvor production.aktivnost_izvor DEFAULT 'rucno',
  p_izvor_akcioni_plan_id uuid DEFAULT NULL,
  p_izvor_pozicija_id uuid DEFAULT NULL,
  p_izvor_tp_operacija_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = production, core, public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_project_id uuid;
BEGIN
  SELECT COALESCE(p_projekat_id, rn.projekat_id) INTO v_project_id
  FROM production.radni_nalog rn
  WHERE rn.id = p_radni_nalog_id;

  IF p_radni_nalog_id IS NULL OR p_odeljenje_id IS NULL OR nullif(trim(COALESCE(p_naziv_aktivnosti, '')), '') IS NULL THEN
    RAISE EXCEPTION 'upsert_operativna_aktivnost: radni nalog, odeljenje i naziv su obavezni';
  END IF;

  IF NOT production.can_edit_pracenje(v_project_id, p_radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo izmene operativnih aktivnosti';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO production.operativna_aktivnost (
      radni_nalog_id, projekat_id, rb, odeljenje_id, naziv_aktivnosti, opis,
      broj_tp, kolicina_text, planirani_pocetak, planirani_zavrsetak,
      odgovoran_user_id, odgovoran_radnik_id, odgovoran_label,
      zavisi_od_aktivnost_id, zavisi_od_text, status, prioritet, status_mode,
      rizik_napomena, izvor, izvor_akcioni_plan_id, izvor_pozicija_id, izvor_tp_operacija_id,
      created_by, updated_by
    )
    VALUES (
      p_radni_nalog_id, v_project_id, p_rb, p_odeljenje_id, p_naziv_aktivnosti, p_opis,
      p_broj_tp, p_kolicina_text, p_planirani_pocetak, p_planirani_zavrsetak,
      p_odgovoran_user_id, p_odgovoran_radnik_id, p_odgovoran_label,
      p_zavisi_od_aktivnost_id, p_zavisi_od_text, p_status, p_prioritet, p_status_mode,
      p_rizik_napomena, p_izvor, p_izvor_akcioni_plan_id, p_izvor_pozicija_id, p_izvor_tp_operacija_id,
      auth.uid(), auth.uid()
    )
    RETURNING id INTO v_id;
  ELSE
    UPDATE production.operativna_aktivnost
       SET radni_nalog_id = p_radni_nalog_id,
           projekat_id = v_project_id,
           rb = p_rb,
           odeljenje_id = p_odeljenje_id,
           naziv_aktivnosti = p_naziv_aktivnosti,
           opis = p_opis,
           broj_tp = p_broj_tp,
           kolicina_text = p_kolicina_text,
           planirani_pocetak = p_planirani_pocetak,
           planirani_zavrsetak = p_planirani_zavrsetak,
           odgovoran_user_id = p_odgovoran_user_id,
           odgovoran_radnik_id = p_odgovoran_radnik_id,
           odgovoran_label = p_odgovoran_label,
           zavisi_od_aktivnost_id = p_zavisi_od_aktivnost_id,
           zavisi_od_text = p_zavisi_od_text,
           status = p_status,
           prioritet = p_prioritet,
           status_mode = p_status_mode,
           rizik_napomena = p_rizik_napomena,
           izvor = p_izvor,
           izvor_akcioni_plan_id = p_izvor_akcioni_plan_id,
           izvor_pozicija_id = p_izvor_pozicija_id,
           izvor_tp_operacija_id = p_izvor_tp_operacija_id,
           updated_by = auth.uid()
     WHERE id = p_id
     RETURNING id INTO v_id;
  END IF;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION production.zatvori_aktivnost(p_id uuid, p_napomena text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = production, public, pg_temp
AS $$
DECLARE
  v_row production.operativna_aktivnost;
BEGIN
  SELECT * INTO v_row FROM production.operativna_aktivnost WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aktivnost % ne postoji', p_id; END IF;
  IF NOT production.can_edit_pracenje(v_row.projekat_id, v_row.radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo zatvaranja aktivnosti';
  END IF;

  UPDATE production.operativna_aktivnost
     SET status = 'zavrseno',
         manual_override_status = NULL,
         blokirano_razlog = NULL,
         zatvoren_at = now(),
         zatvoren_by = auth.uid(),
         zatvoren_napomena = p_napomena,
         updated_by = auth.uid()
   WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION production.promovisi_akcionu_tacku(p_akcioni_plan_id uuid, p_odeljenje_id uuid, p_rn_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = production, public, pg_temp
AS $$
DECLARE
  v_ap public.akcioni_plan;
  v_rn production.radni_nalog;
  v_id uuid;
BEGIN
  SELECT * INTO v_ap FROM public.akcioni_plan WHERE id = p_akcioni_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Akciona tačka % ne postoji', p_akcioni_plan_id; END IF;

  SELECT * INTO v_rn FROM production.radni_nalog WHERE id = p_rn_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Radni nalog % ne postoji', p_rn_id; END IF;

  IF NOT production.can_edit_pracenje(COALESCE(v_ap.projekat_id, v_rn.projekat_id), p_rn_id) THEN
    RAISE EXCEPTION 'Nemaš pravo promocije akcione tačke';
  END IF;

  INSERT INTO production.operativna_aktivnost (
    radni_nalog_id, projekat_id, odeljenje_id, naziv_aktivnosti, opis,
    planirani_zavrsetak, odgovoran_label, status, prioritet, izvor,
    izvor_akcioni_plan_id, created_by, updated_by
  )
  VALUES (
    p_rn_id,
    COALESCE(v_ap.projekat_id, v_rn.projekat_id),
    p_odeljenje_id,
    v_ap.naslov,
    v_ap.opis,
    v_ap.rok,
    COALESCE(v_ap.odgovoran_label, v_ap.odgovoran_text, v_ap.odgovoran_email),
    CASE WHEN v_ap.status = 'zavrsen' THEN 'zavrseno'::production.aktivnost_status ELSE 'nije_krenulo'::production.aktivnost_status END,
    CASE v_ap.prioritet WHEN 1 THEN 'visok'::production.aktivnost_prioritet WHEN 3 THEN 'nizak'::production.aktivnost_prioritet ELSE 'srednji'::production.aktivnost_prioritet END,
    'iz_sastanka',
    v_ap.id,
    auth.uid(),
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION production.set_blokirano(p_id uuid, p_razlog text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = production, public, pg_temp
AS $$
DECLARE
  v_row production.operativna_aktivnost;
BEGIN
  IF nullif(trim(COALESCE(p_razlog, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Razlog blokade je obavezan';
  END IF;

  SELECT * INTO v_row FROM production.operativna_aktivnost WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aktivnost % ne postoji', p_id; END IF;
  IF NOT production.can_edit_pracenje(v_row.projekat_id, v_row.radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo blokiranja aktivnosti';
  END IF;

  UPDATE production.operativna_aktivnost
     SET manual_override_status = 'blokirano',
         blokirano_razlog = p_razlog,
         updated_by = auth.uid()
   WHERE id = p_id;
END;
$$;

CREATE OR REPLACE FUNCTION production.skini_blokadu(p_id uuid, p_napomena text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = production, public, pg_temp
AS $$
DECLARE
  v_row production.operativna_aktivnost;
BEGIN
  SELECT * INTO v_row FROM production.operativna_aktivnost WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aktivnost % ne postoji', p_id; END IF;
  IF NOT production.can_edit_pracenje(v_row.projekat_id, v_row.radni_nalog_id) THEN
    RAISE EXCEPTION 'Nemaš pravo skidanja blokade';
  END IF;

  UPDATE production.operativna_aktivnost
     SET manual_override_status = NULL,
         blokirano_razlog = NULL,
         updated_by = auth.uid()
   WHERE id = p_id;

  UPDATE production.operativna_aktivnost_blok_istorija
     SET napomena = COALESCE(p_napomena, napomena)
   WHERE id = (
     SELECT id
     FROM production.operativna_aktivnost_blok_istorija
     WHERE aktivnost_id = p_id
     ORDER BY created_at DESC
     LIMIT 1
   );
END;
$$;

-- ===== SEKCIJA 9 — Helper funkcije ==========================================

CREATE OR REPLACE FUNCTION production.can_edit_pracenje(p_project_id uuid DEFAULT NULL, p_rn_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = production, public, pg_temp
AS $$
  WITH ctx AS (
    SELECT COALESCE(
      p_project_id,
      (SELECT rn.projekat_id FROM production.radni_nalog rn WHERE rn.id = p_rn_id)
    ) AS project_id
  )
  SELECT
    public.has_edit_role((SELECT project_id FROM ctx))
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE lower(ur.email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
        AND ur.is_active = true
        AND ur.role IN ('admin', 'pm', 'menadzment')
        AND (
          ur.project_id IS NULL
          OR ur.project_id = (SELECT project_id FROM ctx)
        )
    );
$$;

GRANT EXECUTE ON FUNCTION production.can_edit_pracenje(uuid, uuid) TO authenticated;

-- ===== SEKCIJA 10 — Audit triggeri ==========================================

CREATE OR REPLACE FUNCTION production.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = production, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION production.log_operativna_blok_promenu()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = production, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       OLD.manual_override_status IS DISTINCT FROM NEW.manual_override_status
       OR OLD.blokirano_razlog IS DISTINCT FROM NEW.blokirano_razlog
     ) THEN
    INSERT INTO production.operativna_aktivnost_blok_istorija (
      aktivnost_id,
      old_manual_override_status,
      new_manual_override_status,
      old_blokirano_razlog,
      new_blokirano_razlog,
      changed_by,
      changed_by_email
    )
    VALUES (
      NEW.id,
      OLD.manual_override_status,
      NEW.manual_override_status,
      OLD.blokirano_razlog,
      NEW.blokirano_razlog,
      auth.uid(),
      public.current_user_email()
    );
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  item text;
  touch_targets text[] := ARRAY[
    'core.odeljenje',
    'core.work_center',
    'core.radnik',
    'core.radnik_alias',
    'pdm.drawing',
    'production.radni_nalog',
    'production.radni_nalog_pozicija',
    'production.tp_operacija',
    'production.prijava_rada',
    'production.radni_nalog_lansiranje',
    'production.radni_nalog_saglasnost',
    'production.operativna_aktivnost',
    'production.operativna_aktivnost_pozicija',
    'production.operativna_aktivnost_blok_istorija'
  ];
BEGIN
  FOREACH item IN ARRAY touch_targets LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_updated_at ON %s', item);
    EXECUTE format('CREATE TRIGGER trg_touch_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION production.touch_updated_at()', item);
  END LOOP;
END$$;

DO $$
DECLARE
  t text;
  target_tables text[] := ARRAY[
    'radni_nalog',
    'radni_nalog_pozicija',
    'tp_operacija',
    'prijava_rada',
    'radni_nalog_lansiranje',
    'radni_nalog_saglasnost',
    'operativna_aktivnost',
    'operativna_aktivnost_pozicija',
    'operativna_aktivnost_blok_istorija'
  ];
BEGIN
  FOREACH t IN ARRAY target_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON production.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON production.%1$I FOR EACH ROW EXECUTE FUNCTION public.audit_row_change()',
      t
    );
  END LOOP;
END$$;

DROP TRIGGER IF EXISTS trg_operativna_aktivnost_blok_istorija ON production.operativna_aktivnost;
CREATE TRIGGER trg_operativna_aktivnost_blok_istorija
  AFTER UPDATE OF manual_override_status, blokirano_razlog ON production.operativna_aktivnost
  FOR EACH ROW EXECUTE FUNCTION production.log_operativna_blok_promenu();

-- ===== SEKCIJA 11 — RLS politike ============================================

ALTER TABLE core.odeljenje ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.work_center ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.radnik ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.radnik_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE pdm.drawing ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.radni_nalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.radni_nalog_pozicija ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.tp_operacija ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.prijava_rada ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.radni_nalog_lansiranje ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.radni_nalog_saglasnost ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.operativna_aktivnost ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.operativna_aktivnost_pozicija ENABLE ROW LEVEL SECURITY;
ALTER TABLE production.operativna_aktivnost_blok_istorija ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      ('core.odeljenje'::regclass, 'production.can_edit_pracenje(NULL, NULL)'),
      ('core.work_center'::regclass, 'production.can_edit_pracenje(NULL, NULL)'),
      ('core.radnik'::regclass, 'production.can_edit_pracenje(NULL, NULL)'),
      ('core.radnik_alias'::regclass, 'production.can_edit_pracenje(NULL, NULL)'),
      ('pdm.drawing'::regclass, 'production.can_edit_pracenje(NULL, NULL)'),
      ('production.radni_nalog'::regclass, 'production.can_edit_pracenje(projekat_id, id)'),
      ('production.radni_nalog_pozicija'::regclass, 'EXISTS (SELECT 1 FROM production.radni_nalog rn WHERE rn.id = radni_nalog_id AND production.can_edit_pracenje(rn.projekat_id, rn.id))'),
      ('production.tp_operacija'::regclass, 'EXISTS (SELECT 1 FROM production.radni_nalog rn WHERE rn.id = radni_nalog_id AND production.can_edit_pracenje(rn.projekat_id, rn.id))'),
      ('production.prijava_rada'::regclass, 'EXISTS (SELECT 1 FROM production.radni_nalog rn WHERE rn.id = radni_nalog_id AND production.can_edit_pracenje(rn.projekat_id, rn.id))'),
      ('production.radni_nalog_lansiranje'::regclass, 'EXISTS (SELECT 1 FROM production.radni_nalog rn WHERE rn.id = radni_nalog_id AND production.can_edit_pracenje(rn.projekat_id, rn.id))'),
      ('production.radni_nalog_saglasnost'::regclass, 'EXISTS (SELECT 1 FROM production.radni_nalog rn WHERE rn.id = radni_nalog_id AND production.can_edit_pracenje(rn.projekat_id, rn.id))'),
      ('production.operativna_aktivnost'::regclass, 'production.can_edit_pracenje(projekat_id, radni_nalog_id)'),
      ('production.operativna_aktivnost_pozicija'::regclass, 'EXISTS (SELECT 1 FROM production.operativna_aktivnost oa WHERE oa.id = aktivnost_id AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))'),
      ('production.operativna_aktivnost_blok_istorija'::regclass, 'EXISTS (SELECT 1 FROM production.operativna_aktivnost oa WHERE oa.id = aktivnost_id AND production.can_edit_pracenje(oa.projekat_id, oa.radni_nalog_id))')
    ) AS x(target, write_check)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS pracenje_select ON %s', r.target);
    EXECUTE format('CREATE POLICY pracenje_select ON %s FOR SELECT TO authenticated USING (true)', r.target);
    EXECUTE format('DROP POLICY IF EXISTS pracenje_insert ON %s', r.target);
    EXECUTE format('CREATE POLICY pracenje_insert ON %s FOR INSERT TO authenticated WITH CHECK (%s)', r.target, r.write_check);
    EXECUTE format('DROP POLICY IF EXISTS pracenje_update ON %s', r.target);
    EXECUTE format('CREATE POLICY pracenje_update ON %s FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', r.target, r.write_check, r.write_check);
    EXECUTE format('DROP POLICY IF EXISTS pracenje_delete ON %s', r.target);
    EXECUTE format('CREATE POLICY pracenje_delete ON %s FOR DELETE TO authenticated USING (%s)', r.target, r.write_check);
  END LOOP;
END$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pdm TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA production TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA production TO authenticated;

-- ===== SEKCIJA 12 — Seed core.odeljenje =====================================

INSERT INTO core.odeljenje (kod, naziv, boja, sort_order)
VALUES
  ('ZAV', 'Zavarivanje', '#ef4444', 10),
  ('MAS', 'Mašinska obrada', '#3b82f6', 20),
  ('FAR', 'Farbanje', '#f59e0b', 30),
  ('MON', 'Montaža', '#10b981', 40),
  ('ELA', 'Elektrika/Automatika', '#8b5cf6', 50),
  ('KK', 'Kontrola kvaliteta', '#06b6d4', 60),
  ('LOG', 'Logistika', '#64748b', 70)
ON CONFLICT (kod) DO NOTHING;

-- ===== SEKCIJA 13 — Komentari ===============================================

COMMENT ON TYPE production.aktivnost_status IS 'Status operativne aktivnosti: nije krenulo, u toku, blokirano ili završeno.';
COMMENT ON TYPE production.aktivnost_prioritet IS 'Prioritet operativne aktivnosti: nizak, srednji ili visok.';
COMMENT ON TYPE production.aktivnost_izvor IS 'Izvor operativne aktivnosti: ručno, iz sastanka, iz TP-a ili iz proizvodnje.';
COMMENT ON TYPE production.aktivnost_status_mode IS 'Način računanja statusa operativne aktivnosti: ručno ili automatski iz pozicije/operacija.';
COMMENT ON TYPE production.rn_status IS 'Status kanonskog radnog naloga u Faza 2 production šemi.';
COMMENT ON TYPE production.tp_status IS 'Status planirane TP operacije ili ručni override operacije.';

COMMENT ON TABLE core.odeljenje IS 'Šifarnik odeljenja za proizvodnju i operativni plan.';
COMMENT ON COLUMN core.odeljenje.id IS 'Primarni ključ odeljenja.';
COMMENT ON COLUMN core.odeljenje.kod IS 'Stabilan kod odeljenja, npr. ZAV, MAS, FAR.';
COMMENT ON COLUMN core.odeljenje.naziv IS 'Prikazni naziv odeljenja.';
COMMENT ON COLUMN core.odeljenje.vodja_user_id IS 'Opcioni FK na auth.users za vođu odeljenja.';
COMMENT ON COLUMN core.odeljenje.vodja_radnik_id IS 'Opcioni FK na core.radnik za vođu odeljenja.';
COMMENT ON COLUMN core.odeljenje.boja IS 'HEX boja za UI badge.';
COMMENT ON COLUMN core.odeljenje.sort_order IS 'Redosled prikaza u dashboardu.';
COMMENT ON COLUMN core.odeljenje.aktivan IS 'Da li se odeljenje koristi u novim unosima.';
COMMENT ON COLUMN core.odeljenje.legacy_department_id IS 'Nullable legacy identifikator odeljenja iz BigTehn/BB šifarnika.';
COMMENT ON COLUMN core.odeljenje.created_at IS 'Vreme kreiranja reda.';
COMMENT ON COLUMN core.odeljenje.updated_at IS 'Vreme poslednje izmene reda.';

COMMENT ON TABLE core.work_center IS 'Radni centar, mašina ili grupa operacija vezana za odeljenje.';
COMMENT ON COLUMN core.work_center.id IS 'Primarni ključ radnog centra.';
COMMENT ON COLUMN core.work_center.kod IS 'Stabilan kod radnog centra, najčešće legacy RJgrupaRC.';
COMMENT ON COLUMN core.work_center.naziv IS 'Naziv radnog centra.';
COMMENT ON COLUMN core.work_center.odeljenje_id IS 'Odeljenje koje vlasnički pokriva radni centar.';
COMMENT ON COLUMN core.work_center.napomena IS 'Slobodna napomena.';
COMMENT ON COLUMN core.work_center.aktivan IS 'Da li se radni centar koristi.';
COMMENT ON COLUMN core.work_center.legacy_rjgruparc IS 'Nullable legacy tOperacije.RJgrupaRC vrednost.';
COMMENT ON COLUMN core.work_center.legacy_idoperacije IS 'Nullable legacy tOperacije.IDOperacije vrednost.';
COMMENT ON COLUMN core.work_center.created_at IS 'Vreme kreiranja reda.';
COMMENT ON COLUMN core.work_center.updated_at IS 'Vreme poslednje izmene reda.';

COMMENT ON TABLE core.radnik IS 'Kanonski proizvodni radnik, opcionalno povezan sa kadrovskim employees redom.';
COMMENT ON COLUMN core.radnik.id IS 'Primarni ključ radnika.';
COMMENT ON COLUMN core.radnik.employee_id IS 'Opcioni FK ka public.employees za istog čoveka.';
COMMENT ON COLUMN core.radnik.odeljenje_id IS 'Matično odeljenje radnika.';
COMMENT ON COLUMN core.radnik.sifra_radnika IS 'Nova poslovna šifra radnika, ako se koristi.';
COMMENT ON COLUMN core.radnik.ime IS 'Kratko ime ili nadimak za prikaz.';
COMMENT ON COLUMN core.radnik.puno_ime IS 'Puno ime i prezime.';
COMMENT ON COLUMN core.radnik.email IS 'Email radnika kada postoji.';
COMMENT ON COLUMN core.radnik.kartica_id IS 'ID kartice za identifikaciju radnika.';
COMMENT ON COLUMN core.radnik.aktivan IS 'Da li je radnik aktivan.';
COMMENT ON COLUMN core.radnik.legacy_sifra_radnika IS 'Nullable legacy tRadnici.SifraRadnika vrednost.';
COMMENT ON COLUMN core.radnik.created_at IS 'Vreme kreiranja reda.';
COMMENT ON COLUMN core.radnik.updated_at IS 'Vreme poslednje izmene reda.';

COMMENT ON TABLE core.radnik_alias IS 'Alias/nadimak radnika za mapiranje Excel imena na kanonskog radnika.';
COMMENT ON COLUMN core.radnik_alias.id IS 'Primarni ključ aliasa.';
COMMENT ON COLUMN core.radnik_alias.radnik_id IS 'Radnik kome alias pripada.';
COMMENT ON COLUMN core.radnik_alias.alias IS 'Alias ili nadimak, unique case-insensitive.';
COMMENT ON COLUMN core.radnik_alias.is_primary IS 'Da li je alias primarni prikazni nadimak.';
COMMENT ON COLUMN core.radnik_alias.napomena IS 'Slobodna napomena o aliasu.';
COMMENT ON COLUMN core.radnik_alias.created_at IS 'Vreme kreiranja reda.';
COMMENT ON COLUMN core.radnik_alias.updated_at IS 'Vreme poslednje izmene reda.';

COMMENT ON TABLE pdm.drawing IS 'Kanonski crtež iz PDM domena.';
COMMENT ON COLUMN pdm.drawing.id IS 'Primarni ključ crteža.';
COMMENT ON COLUMN pdm.drawing.drawing_no IS 'Broj crteža.';
COMMENT ON COLUMN pdm.drawing.revision IS 'Revizija crteža.';
COMMENT ON COLUMN pdm.drawing.naziv IS 'Naziv dela/sklopa sa crteža.';
COMMENT ON COLUMN pdm.drawing.materijal IS 'Materijal iz PDM-a.';
COMMENT ON COLUMN pdm.drawing.dimenzije IS 'Dimenzije materijala/dela.';
COMMENT ON COLUMN pdm.drawing.status IS 'Slobodan status crteža do uvođenja posebnog šifarnika.';
COMMENT ON COLUMN pdm.drawing.legacy_idcrtez IS 'Nullable legacy PDMCrtezi.IDCrtez vrednost.';
COMMENT ON COLUMN pdm.drawing.created_at IS 'Vreme kreiranja reda.';
COMMENT ON COLUMN pdm.drawing.updated_at IS 'Vreme poslednje izmene reda.';

COMMENT ON TABLE production.radni_nalog IS 'Kanonski radni nalog za Faza 2 production model.';
COMMENT ON COLUMN production.radni_nalog.id IS 'Primarni ključ RN-a.';
COMMENT ON COLUMN production.radni_nalog.projekat_id IS 'FK ka postojećem public.projects; projekat ima više RN-ova.';
COMMENT ON COLUMN production.radni_nalog.rn_broj IS 'Poslovni broj RN-a.';
COMMENT ON COLUMN production.radni_nalog.naziv IS 'Naziv mašine, linije ili dela.';
COMMENT ON COLUMN production.radni_nalog.kupac_text IS 'Snapshot naziva kupca dok core.partner nije uveden.';
COMMENT ON COLUMN production.radni_nalog.datum_isporuke IS 'Datum isporuke RN-a, koristi se za rezerva_dani i kasni.';
COMMENT ON COLUMN production.radni_nalog.rok_izrade IS 'Interni rok izrade RN-a.';
COMMENT ON COLUMN production.radni_nalog.status IS 'Status RN-a iz production.rn_status enum-a.';
COMMENT ON COLUMN production.radni_nalog.koordinator_user_id IS 'Koordinator RN-a kao auth korisnik; nezavisno od created_by.';
COMMENT ON COLUMN production.radni_nalog.koordinator_radnik_id IS 'Koordinator RN-a kao proizvodni radnik.';
COMMENT ON COLUMN production.radni_nalog.napomena IS 'Header napomena RN-a.';
COMMENT ON COLUMN production.radni_nalog.legacy_idrn IS 'Nullable legacy tRN.IDRN vrednost.';
COMMENT ON COLUMN production.radni_nalog.legacy_idpredmet IS 'Nullable legacy Predmeti.IDPredmet vrednost.';
COMMENT ON COLUMN production.radni_nalog.legacy_idcrtez IS 'Nullable legacy PDMCrtezi.IDCrtez vrednost.';
COMMENT ON COLUMN production.radni_nalog.created_at IS 'Vreme kreiranja reda.';
COMMENT ON COLUMN production.radni_nalog.updated_at IS 'Vreme poslednje izmene reda.';
COMMENT ON COLUMN production.radni_nalog.created_by IS 'Auth korisnik koji je kreirao red.';
COMMENT ON COLUMN production.radni_nalog.updated_by IS 'Auth korisnik koji je poslednji menjao red.';

COMMENT ON TABLE production.radni_nalog_pozicija IS 'Rekurzivna struktura pozicija/sklopova unutar RN-a.';
COMMENT ON TABLE production.tp_operacija IS 'Planirana TP operacija za poziciju RN-a.';
COMMENT ON TABLE production.prijava_rada IS 'Realna prijava rada po RN-u, poziciji i TP operaciji.';
COMMENT ON TABLE production.radni_nalog_lansiranje IS 'Workflow zapis lansiranja RN-a.';
COMMENT ON TABLE production.radni_nalog_saglasnost IS 'Workflow zapis saglasnosti RN-a.';
COMMENT ON TABLE production.operativna_aktivnost IS 'Trajan operativni backlog aktivnosti po odeljenjima za RN/projekat.';
COMMENT ON TABLE production.operativna_aktivnost_pozicija IS 'Multi-link tabela koja povezuje operativnu aktivnost sa više pozicija/TP operacija.';
COMMENT ON TABLE production.operativna_aktivnost_blok_istorija IS 'Audit istorija promene blokade operativne aktivnosti.';

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'production'
      AND table_name IN (
        'radni_nalog_pozicija','tp_operacija','prijava_rada',
        'radni_nalog_lansiranje','radni_nalog_saglasnost',
        'operativna_aktivnost','operativna_aktivnost_pozicija',
        'operativna_aktivnost_blok_istorija'
      )
      AND col_description(format('%I.%I', table_schema, table_name)::regclass::oid, ordinal_position) IS NULL
  LOOP
    EXECUTE format('COMMENT ON COLUMN %I.%I.%I IS %L',
      c.table_schema,
      c.table_name,
      c.column_name,
      'Kolona ' || c.column_name || ' tabele ' || c.table_schema || '.' || c.table_name || '.'
    );
  END LOOP;
END$$;

COMMENT ON COLUMN production.operativna_aktivnost.legacy_id IS 'Nullable legacy identifikator; za operativni plan se očekuje NULL jer nema direktnog QBigTehn ekvivalenta.';
COMMENT ON COLUMN production.operativna_aktivnost.blokirano_razlog IS 'Obavezan razlog kada je manual_override_status = blokirano.';
COMMENT ON COLUMN production.operativna_aktivnost.status_mode IS 'Određuje da li se efektivni status čita ručno ili automatski iz prijava rada.';
COMMENT ON COLUMN production.operativna_aktivnost_pozicija.tezina IS 'Relativna težina linka u budućim agregacijama multi-pozicijske aktivnosti.';

COMMENT ON FUNCTION production.can_edit_pracenje(uuid, uuid) IS 'TRUE ako korisnik ima Faza 1 has_edit_role za projekat/RN ili globalnu admin/pm/menadzment rolu.';
COMMENT ON FUNCTION production.get_pracenje_rn(uuid) IS 'Vraća JSON payload za tab Po pozicijama.';
COMMENT ON FUNCTION production.get_operativni_plan(uuid, uuid) IS 'Vraća JSON payload operativnog plana za RN ili projekat.';
COMMENT ON FUNCTION production.upsert_operativna_aktivnost(uuid, uuid, uuid, uuid, text, date, date, uuid, uuid, production.aktivnost_status, production.aktivnost_prioritet, integer, text, text, text, text, uuid, text, production.aktivnost_status_mode, text, production.aktivnost_izvor, uuid, uuid, uuid) IS 'Kreira ili ažurira operativnu aktivnost uz RBAC proveru.';
COMMENT ON FUNCTION production.zatvori_aktivnost(uuid, text) IS 'Zatvara operativnu aktivnost uz RBAC proveru.';
COMMENT ON FUNCTION production.promovisi_akcionu_tacku(uuid, uuid, uuid) IS 'Kreira operativnu aktivnost iz postojeće Faza 1 akcione tačke.';
COMMENT ON FUNCTION production.set_blokirano(uuid, text) IS 'Postavlja manual blokadu aktivnosti sa obaveznim razlogom.';
COMMENT ON FUNCTION production.skini_blokadu(uuid, text) IS 'Skida manual blokadu aktivnosti i upisuje napomenu u istoriju.';

NOTIFY pgrst, 'reload schema';

COMMIT;
