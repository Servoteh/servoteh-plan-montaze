/**
 * Sastanci — Supabase REST service.
 *
 * Centralni CRUD za sve tipove sastanaka (sedmicni / projektni), učesnike
 * i utility helpere koje koriste svi tabovi (Dashboard, PM Teme, Akcioni
 * Plan, Sedmični, Projektni).
 *
 * Pattern: parity sa services/projects.js i services/planProizvodnje.js.
 *   - sbReq() vraća null na grešku.
 *   - Mapping snake_case ↔ camelCase je u helperima na vrhu fajla.
 *   - Pisanje samo ako has_edit_role() (tj. autenticated user).
 *
 * Bitno:
 *   - Identifikator korisnika je EMAIL (parity sa user_roles, ne UUID).
 *   - "vodio_label" / "predlozio_label" su SNAPSHOT-ovi punog imena u
 *     trenutku unosa — kasnije promene u user_roles ne menjaju zapise.
 */

import { sbReq } from './supabase.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';

/* ── Konstante ── */

export const SASTANAK_TIPOVI = {
  sedmicni: 'Sedmični sastanak',
  projektni: 'Projektni sastanak',
};

export const SASTANAK_STATUSI = {
  planiran: 'Planiran',
  u_toku: 'U toku',
  zavrsen: 'Završen',
  zakljucan: 'Zaključan (arhivirano)',
};

export const SASTANAK_STATUS_BOJE = {
  planiran: '#7280a8',
  u_toku: '#3b82f6',
  zavrsen: '#10b981',
  zakljucan: '#a855f7',
};

/* ── Mappers ── */

export function mapDbSastanak(d) {
  if (!d) return null;
  return {
    id: d.id,
    tip: d.tip || 'sedmicni',
    naslov: d.naslov || '',
    datum: d.datum || null,
    vreme: d.vreme || null,
    mesto: d.mesto || '',
    projekatId: d.projekat_id || null,
    vodioEmail: d.vodio_email || '',
    vodioLabel: d.vodio_label || '',
    zapisnicarEmail: d.zapisnicar_email || '',
    zapisnicarLabel: d.zapisnicar_label || '',
    status: d.status || 'planiran',
    zakljucanAt: d.zakljucan_at || null,
    zakljucanByEmail: d.zakljucan_by_email || '',
    napomena: d.napomena || '',
    createdAt: d.created_at || null,
    createdByEmail: d.created_by_email || '',
    updatedAt: d.updated_at || null,
  };
}

export function mapDbUcesnik(d) {
  if (!d) return null;
  return {
    sastanakId: d.sastanak_id,
    email: String(d.email || '').toLowerCase().trim(),
    label: d.label || '',
    prisutan: d.prisutan !== false,
    pozvan: d.pozvan !== false,
    napomena: d.napomena || '',
  };
}

/* ── Loaders ── */

/**
 * Lista sastanaka sa filterima.
 * @param {object} filters
 * @param {'sedmicni'|'projektni'|null} filters.tip
 * @param {string|null} filters.status
 * @param {string|null} filters.fromDate  YYYY-MM-DD
 * @param {string|null} filters.toDate    YYYY-MM-DD
 * @param {string|null} filters.projekatId
 * @param {number} [filters.limit=200]
 */
export async function loadSastanci(filters = {}) {
  if (!getIsOnline()) return [];
  const params = ['select=*', 'order=datum.desc,vreme.desc.nullslast'];

  if (filters.tip) params.push(`tip=eq.${encodeURIComponent(filters.tip)}`);
  if (filters.status) params.push(`status=eq.${encodeURIComponent(filters.status)}`);
  if (filters.fromDate) params.push(`datum=gte.${encodeURIComponent(filters.fromDate)}`);
  if (filters.toDate) params.push(`datum=lte.${encodeURIComponent(filters.toDate)}`);
  if (filters.projekatId) params.push(`projekat_id=eq.${encodeURIComponent(filters.projekatId)}`);
  params.push(`limit=${filters.limit || 200}`);

  const data = await sbReq(`sastanci?${params.join('&')}`);
  return Array.isArray(data) ? data.map(mapDbSastanak) : [];
}

export async function loadSastanak(id) {
  if (!id || !getIsOnline()) return null;
  const data = await sbReq(`sastanci?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return Array.isArray(data) && data.length ? mapDbSastanak(data[0]) : null;
}

export async function loadUcesnici(sastanakId) {
  if (!sastanakId || !getIsOnline()) return [];
  const data = await sbReq(
    `sastanak_ucesnici?sastanak_id=eq.${encodeURIComponent(sastanakId)}&select=*&order=label.asc`,
  );
  return Array.isArray(data) ? data.map(mapDbUcesnik) : [];
}

/* ── Savers ── */

function buildSastanakPayload(s) {
  const cu = getCurrentUser();
  const payload = {
    tip: s.tip || 'sedmicni',
    naslov: s.naslov || '',
    datum: s.datum,
    vreme: s.vreme || null,
    mesto: s.mesto || '',
    projekat_id: s.projekatId || null,
    vodio_email: s.vodioEmail || null,
    vodio_label: s.vodioLabel || null,
    zapisnicar_email: s.zapisnicarEmail || null,
    zapisnicar_label: s.zapisnicarLabel || null,
    status: s.status || 'planiran',
    napomena: s.napomena || null,
    updated_at: new Date().toISOString(),
  };
  if (s.id) payload.id = s.id;
  else payload.created_by_email = cu?.email || null;
  return payload;
}

export async function saveSastanak(s) {
  if (!getIsOnline()) return null;
  const data = await sbReq('sastanci', 'POST', buildSastanakPayload(s));
  return Array.isArray(data) && data.length ? mapDbSastanak(data[0]) : null;
}

export async function updateSastanakStatus(id, status, extra = {}) {
  if (!id || !getIsOnline()) return null;
  const payload = { status, updated_at: new Date().toISOString(), ...extra };
  const data = await sbReq(
    `sastanci?id=eq.${encodeURIComponent(id)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(data) && data.length ? mapDbSastanak(data[0]) : null;
}

export async function deleteSastanak(id) {
  if (!id || !getIsOnline()) return false;
  return (await sbReq(`sastanci?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}

/* ── Učesnici (bulk replace) ── */

export async function saveUcesnici(sastanakId, ucesnici) {
  if (!sastanakId || !getIsOnline()) return false;
  /* Strategija: obriši sve postojeće, pa upiši nove. Mali broj redova
     po sastanku (do ~30 ljudi) — ovo je jednostavnije od diff-a. */
  await sbReq(
    `sastanak_ucesnici?sastanak_id=eq.${encodeURIComponent(sastanakId)}`,
    'DELETE',
  );
  if (!ucesnici || !ucesnici.length) return true;
  const payload = ucesnici.map(u => ({
    sastanak_id: sastanakId,
    email: String(u.email || '').toLowerCase().trim(),
    label: u.label || null,
    prisutan: u.prisutan !== false,
    pozvan: u.pozvan !== false,
    napomena: u.napomena || null,
  }));
  return (await sbReq('sastanak_ucesnici', 'POST', payload)) !== null;
}

export async function updateUcesnikPrisustvo(sastanakId, email, prisutan) {
  if (!sastanakId || !email || !getIsOnline()) return false;
  const url = `sastanak_ucesnici?sastanak_id=eq.${encodeURIComponent(sastanakId)}`
    + `&email=eq.${encodeURIComponent(email)}`;
  return (await sbReq(url, 'PATCH', { prisutan: !!prisutan })) !== null;
}

/* ── Statistike za dashboard ── */

/**
 * Vrati osnovne brojke za dashboard:
 *   - planirani sastanci u sledećih 14 dana
 *   - sastanci u toku
 *   - akcioni plan: ukupno otvoreno, kasni
 *   - PM teme: na čekanju (status='predlog')
 */
export async function loadDashboardStats() {
  if (!getIsOnline()) return null;

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const in14days = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  const in14Str = in14days.toISOString().slice(0, 10);

  /* Paralelno: 4 count requesta. PostgREST `select=*&head=true` + Prefer:
     count=exact ne ide kroz naš sbReq jer on ne čita header-e. Umesto
     toga čitamo redove sa limit=1 i koristimo `select=id` + odvojen count
     poziv preko `Prefer: count=exact`. Da ne komplikujemo, vraćamo redove. */

  const [planirani, uToku, akcijeOpen, pmPending] = await Promise.all([
    sbReq(`sastanci?select=id&status=eq.planiran&datum=gte.${todayStr}&datum=lte.${in14Str}`),
    sbReq(`sastanci?select=id&status=eq.u_toku`),
    sbReq(`v_akcioni_plan?select=id,effective_status&effective_status=in.(otvoren,u_toku,kasni)`),
    sbReq(`pm_teme?select=id&status=eq.predlog`),
  ]);

  const akcijeRows = Array.isArray(akcijeOpen) ? akcijeOpen : [];

  return {
    sastancUpcoming: Array.isArray(planirani) ? planirani.length : 0,
    sastancUToku: Array.isArray(uToku) ? uToku.length : 0,
    akcijeOtvoreno: akcijeRows.length,
    akcijeKasni: akcijeRows.filter(r => r.effective_status === 'kasni').length,
    pmTemeNaCekanju: Array.isArray(pmPending) ? pmPending.length : 0,
  };
}
