/**
 * Praćenje proizvodnje — service sloj.
 *
 * Tanki wrapper oko production RPC-ja iz Inkrementa 1. Zadržava postojeći
 * projekat pattern: UI/state nikad ne pozivaju `sbReq` direktno.
 */

import { sbReq } from './supabase.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';

function assertOnline() {
  if (!getIsOnline()) {
    throw new Error('Supabase nije dostupan (offline)');
  }
}

async function rpc(name, body = {}) {
  assertOnline();
  const res = await sbReq(`rpc/${name}`, 'POST', body, { upsert: false });
  if (res == null) {
    throw new Error(`RPC ${name} nije uspeo`);
  }
  return res;
}

async function select(path, fallback = []) {
  if (!getIsOnline()) return fallback;
  const res = await sbReq(path);
  return Array.isArray(res) ? res : fallback;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolveRnId(value) {
  const q = String(value || '').trim();
  if (!q) throw new Error('Unesi RN broj ili RN UUID.');
  if (UUID_RE.test(q)) return q;

  const encoded = encodeURIComponent(q);
  const numericFilter = /^\d+$/.test(q) ? `,legacy_idrn.eq.${encoded}` : '';
  const rows = await select(
    `radni_nalog?select=id,rn_broj,naziv,legacy_idrn&or=(rn_broj.eq.${encoded},rn_broj.ilike.*${encoded}*${numericFilter})&order=rn_broj.asc&limit=5`,
  );
  if (rows.length === 1) return rows[0].id;
  if (rows.length > 1) {
    throw new Error(`Nađeno je više RN-ova za "${q}". Unesi tačan RN broj ili UUID.`);
  }
  throw new Error(`RN "${q}" nije pronađen u proizvodnji. Proveri RN broj ili prvo importuj/lansiraj RN.`);
}

export async function fetchPracenjeRn(rnId) {
  if (!rnId) throw new Error('RN ID je obavezan');
  return rpc('get_pracenje_rn', { p_rn_id: rnId });
}

export async function fetchOperativniPlan({ rnId = null, projekatId = null } = {}) {
  if (!rnId && !projekatId) throw new Error('Prosledi rnId ili projekatId');
  return rpc('get_operativni_plan', {
    p_rn_id: rnId || null,
    p_projekat_id: projekatId || null,
  });
}

export async function upsertOperativnaAktivnost(payload = {}) {
  const p = normalizeAktivnostPayload(payload);
  return rpc('upsert_operativna_aktivnost', p);
}

export async function zatvoriAktivnost(id, napomena = '') {
  if (!id) throw new Error('ID aktivnosti je obavezan');
  return rpc('zatvori_aktivnost', { p_id: id, p_napomena: napomena || '' });
}

export async function setBlokirano(id, razlog) {
  if (!id) throw new Error('ID aktivnosti je obavezan');
  if (!String(razlog || '').trim()) throw new Error('Razlog blokade je obavezan');
  return rpc('set_blokirano', { p_id: id, p_razlog: razlog.trim() });
}

export async function skiniBlokadu(id, napomena = '') {
  if (!id) throw new Error('ID aktivnosti je obavezan');
  return rpc('skini_blokadu', { p_id: id, p_napomena: napomena || '' });
}

export async function promovisiAkcionuTacku(akcioniPlanId, odeljenjeId, rnId) {
  if (!akcioniPlanId || !odeljenjeId || !rnId) {
    throw new Error('Akciona tačka, odeljenje i RN su obavezni');
  }
  return rpc('promovisi_akcionu_tacku', {
    p_akcioni_plan_id: akcioniPlanId,
    p_odeljenje_id: odeljenjeId,
    p_rn_id: rnId,
  });
}

export async function canEditPracenje(projectId, rnId) {
  if (!projectId && !rnId) return false;
  try {
    return !!await rpc('can_edit_pracenje', {
      p_project_id: projectId || null,
      p_rn_id: rnId || null,
    });
  } catch (e) {
    console.warn('[pracenje] canEditPracenje failed', e);
    return false;
  }
}

/**
 * Dodatni lookup-i za modal. Ako non-public schema nije izložena kroz PostgREST,
 * vraćamo prazne liste i UI ostaje read-safe.
 */
export async function listOdeljenja() {
  return select('odeljenje?select=id,kod,naziv,boja,sort_order&order=sort_order.asc,naziv.asc');
}

export async function listRadnici() {
  return select('radnik?select=id,ime,puno_ime,email,aktivan&aktivan=eq.true&order=puno_ime.asc,ime.asc');
}

export async function fetchOperativneAktivnostiRaw(rnId) {
  if (!rnId) return [];
  return select(
    `v_operativna_aktivnost?select=*&radni_nalog_id=eq.${encodeURIComponent(rnId)}&order=rb.asc`,
  );
}

export async function listAkcioneTackeZaProjekat(projekatId) {
  if (!projekatId) return [];
  const rows = await select(
    `v_akcioni_plan?select=*&projekat_id=eq.${encodeURIComponent(projekatId)}&effective_status=in.(otvoren,u_toku,kasni)&order=rok.asc.nullslast,prioritet.asc,created_at.desc`,
  );
  const sastanakIds = [...new Set(rows.map(r => r.sastanak_id).filter(Boolean))];
  const sastanci = sastanakIds.length ? await select(
    `sastanci?select=id,naziv,datum,tip&id=in.(${sastanakIds.map(id => `"${String(id).replace(/"/g, '""')}"`).join(',')})`,
  ) : [];
  const sastanciById = new Map(sastanci.map(s => [s.id, s]));
  return rows.map(r => ({
    id: r.id,
    sastanakId: r.sastanak_id || null,
    temaId: r.tema_id || null,
    projekatId: r.projekat_id || null,
    rb: r.rb || null,
    naslov: r.naslov || '',
    opis: r.opis || '',
    odgovoranEmail: r.odgovoran_email || '',
    odgovoranLabel: r.odgovoran_label || r.odgovoran_text || r.odgovoran_email || '',
    rok: r.rok || null,
    status: r.effective_status || r.status || 'otvoren',
    prioritet: r.prioritet || 2,
    sastanak: sastanciById.get(r.sastanak_id) || null,
  }));
}

export async function fetchPrijaveZaOperaciju(pozicijaId, tpOperacijaId) {
  if (!pozicijaId || !tpOperacijaId) return [];
  const rows = await select(
    `prijava_rada?select=*,radnik:radnik_id(id,ime,puno_ime,email)&radni_nalog_pozicija_id=eq.${encodeURIComponent(pozicijaId)}&tp_operacija_id=eq.${encodeURIComponent(tpOperacijaId)}&order=finished_at.desc.nullslast,created_at.desc`,
  );
  return rows.map(r => ({
    id: r.id,
    datum: r.finished_at || r.started_at || r.created_at,
    radnik: r.radnik?.puno_ime || r.radnik?.ime || r.radnik_id || '',
    kolicina: r.kolicina,
    smena: r.smena || r.shift || '',
    napomena: r.napomena || '',
    dokumenti: [],
    raw: r,
  }));
}

export async function fetchActivityHistory(activityId) {
  if (!activityId) return { blokade: [], audit: [] };
  const [blokade, audit] = await Promise.all([
    select(
      `operativna_aktivnost_blok_istorija?select=*&aktivnost_id=eq.${encodeURIComponent(activityId)}&order=created_at.desc`,
    ),
    select(
      `audit_log?select=*&table_name=eq.operativna_aktivnost&record_id=eq.${encodeURIComponent(activityId)}&order=changed_at.desc`,
    ),
  ]);
  return { blokade, audit };
}

export async function logPracenjeExport({ rnId, tab, rnBroj }) {
  if (!getIsOnline()) return false;
  const user = getCurrentUser();
  const payload = {
    table_name: 'pracenje_proizvodnje_export',
    record_id: rnId || null,
    action: 'INSERT',
    actor_email: user?.email || null,
    actor_uid: user?.id || null,
    new_data: {
      rn_id: rnId || null,
      rn_broj: rnBroj || null,
      tab,
      exported_at: new Date().toISOString(),
    },
  };
  try {
    const res = await sbReq('audit_log', 'POST', payload, { upsert: false });
    return res != null;
  } catch {
    return false;
  }
}

export function subscribePracenjeRn(rnId, onChange, opts = {}) {
  let stopped = false;
  let timer = null;
  let lastSig = '';
  const intervalMs = opts.intervalMs || 30000;
  const tick = async () => {
    if (stopped || !rnId || !getIsOnline()) return schedule();
    try {
      const rows = await select(
        `v_operativna_aktivnost?select=id,updated_at,efektivni_status,blokirano_razlog&radni_nalog_id=eq.${encodeURIComponent(rnId)}&order=updated_at.desc`,
      );
      const sig = JSON.stringify(rows.map(r => [r.id, r.updated_at, r.efektivni_status, r.blokirano_razlog]));
      if (lastSig && sig !== lastSig) onChange?.({ mode: 'polling' });
      lastSig = sig;
    } catch (e) {
      console.warn('[pracenje] polling refresh check failed', e);
    } finally {
      schedule();
    }
  };
  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 1500);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function normalizeAktivnostPayload(payload) {
  return {
    p_id: payload.id || null,
    p_radni_nalog_id: payload.radni_nalog_id || payload.radniNalogId || null,
    p_projekat_id: payload.projekat_id || payload.projekatId || null,
    p_odeljenje_id: payload.odeljenje_id || payload.odeljenjeId || null,
    p_naziv_aktivnosti: payload.naziv_aktivnosti || payload.nazivAktivnosti || '',
    p_planirani_pocetak: payload.planirani_pocetak || payload.planiraniPocetak || null,
    p_planirani_zavrsetak: payload.planirani_zavrsetak || payload.planiraniZavrsetak || null,
    p_odgovoran_user_id: payload.odgovoran_user_id || null,
    p_odgovoran_radnik_id: payload.odgovoran_radnik_id || null,
    p_status: payload.status || 'nije_krenulo',
    p_prioritet: payload.prioritet || 'srednji',
    p_rb: Number.isFinite(Number(payload.rb)) ? Number(payload.rb) : 100,
    p_opis: payload.opis || null,
    p_broj_tp: payload.broj_tp || null,
    p_kolicina_text: payload.kolicina_text || null,
    p_odgovoran_label: payload.odgovoran_label || null,
    p_zavisi_od_aktivnost_id: payload.zavisi_od_aktivnost_id || null,
    p_zavisi_od_text: payload.zavisi_od_text || null,
    p_status_mode: payload.status_mode || 'manual',
    p_rizik_napomena: payload.rizik_napomena || null,
    p_izvor: payload.izvor || 'rucno',
    p_izvor_akcioni_plan_id: payload.izvor_akcioni_plan_id || null,
    p_izvor_pozicija_id: payload.izvor_pozicija_id || null,
    p_izvor_tp_operacija_id: payload.izvor_tp_operacija_id || null,
  };
}
