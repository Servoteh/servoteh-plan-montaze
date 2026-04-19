/**
 * Akcioni plan — Supabase REST service.
 *
 * Akcioni zaključci sa rokom i odgovornim. Glavna tabela "otvorenih stvari"
 * koja preživljava sastanak.
 *
 * Effective status:
 *   - DB čuva `status` (otvoren/u_toku/zavrsen/...).
 *   - View v_akcioni_plan dodaje `effective_status` koji vraća 'kasni' ako
 *     je rok prošao a status je još otvoren/u_toku.
 *   - UI MORA da koristi v_akcioni_plan za read, ali piše u akcioni_plan.
 */

import { sbReq } from './supabase.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';

export const AKCIJA_STATUSI = {
  otvoren: 'Otvoren',
  u_toku: 'U toku',
  zavrsen: 'Završen',
  kasni: 'Kasni',
  odlozen: 'Odložen',
  otkazan: 'Otkazan',
};

export const AKCIJA_STATUS_BOJE = {
  otvoren: '#7280a8',
  u_toku: '#3b82f6',
  zavrsen: '#10b981',
  kasni: '#ef4444',
  odlozen: '#6b7280',
  otkazan: '#374151',
};

export function mapDbAkcija(d) {
  if (!d) return null;
  return {
    id: d.id,
    sastanakId: d.sastanak_id || null,
    temaId: d.tema_id || null,
    projekatId: d.projekat_id || null,
    rb: d.rb || null,
    naslov: d.naslov || '',
    opis: d.opis || '',
    odgovoranEmail: d.odgovoran_email || '',
    odgovoranLabel: d.odgovoran_label || '',
    odgovoranText: d.odgovoran_text || '',
    rok: d.rok || null,
    rokText: d.rok_text || '',
    status: d.status || 'otvoren',
    /* effective_status dolazi iz v_akcioni_plan view-a; akcioni_plan tabela
       ga nema, pa će biti undefined kad se piše posle save-a. */
    effectiveStatus: d.effective_status || d.status || 'otvoren',
    danaDoRoka: d.dana_do_roka != null ? Number(d.dana_do_roka) : null,
    prioritet: d.prioritet || 2,
    zatvorenAt: d.zatvoren_at || null,
    zatvorenByEmail: d.zatvoren_by_email || '',
    zatvorenNapomena: d.zatvoren_napomena || '',
    createdAt: d.created_at || null,
    createdByEmail: d.created_by_email || '',
    updatedAt: d.updated_at || null,
  };
}

/* ── Loaders ── */

/**
 * Lista akcionih zadataka.
 * Koristi v_akcioni_plan view zbog effective_status + dana_do_roka.
 *
 * @param {object} filters
 * @param {string|null} filters.sastanakId
 * @param {string|null} filters.projekatId
 * @param {string|null} filters.odgovoranEmail
 * @param {string|null} filters.effectiveStatus  npr. 'kasni' za samo kasneće
 * @param {boolean}     filters.openOnly         true → samo otvoren/u_toku/kasni
 * @param {number}      filters.limit
 */
export async function loadAkcije(filters = {}) {
  if (!getIsOnline()) return [];
  const params = ['select=*', 'order=rok.asc.nullslast,prioritet.asc,created_at.desc'];

  if (filters.sastanakId) params.push(`sastanak_id=eq.${encodeURIComponent(filters.sastanakId)}`);
  if (filters.projekatId) params.push(`projekat_id=eq.${encodeURIComponent(filters.projekatId)}`);
  if (filters.odgovoranEmail) {
    params.push(`odgovoran_email=eq.${encodeURIComponent(filters.odgovoranEmail)}`);
  }
  if (filters.effectiveStatus) {
    params.push(`effective_status=eq.${encodeURIComponent(filters.effectiveStatus)}`);
  }
  if (filters.openOnly) {
    params.push(`effective_status=in.(otvoren,u_toku,kasni)`);
  }
  params.push(`limit=${filters.limit || 500}`);

  const data = await sbReq(`v_akcioni_plan?${params.join('&')}`);
  return Array.isArray(data) ? data.map(mapDbAkcija) : [];
}

export async function loadAkcija(id) {
  if (!id || !getIsOnline()) return null;
  const data = await sbReq(
    `v_akcioni_plan?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  return Array.isArray(data) && data.length ? mapDbAkcija(data[0]) : null;
}

/* ── Savers ── */

function buildAkcijaPayload(a) {
  const cu = getCurrentUser();
  const payload = {
    sastanak_id: a.sastanakId || null,
    tema_id: a.temaId || null,
    projekat_id: a.projekatId || null,
    rb: a.rb || null,
    naslov: a.naslov || '',
    opis: a.opis || null,
    odgovoran_email: a.odgovoranEmail || null,
    odgovoran_label: a.odgovoranLabel || null,
    odgovoran_text: a.odgovoranText || null,
    rok: a.rok || null,
    rok_text: a.rokText || null,
    status: a.status || 'otvoren',
    prioritet: a.prioritet || 2,
    updated_at: new Date().toISOString(),
  };
  if (a.id) {
    payload.id = a.id;
  } else {
    payload.created_by_email = cu?.email || null;
  }
  /* Snapshot ko je zatvorio. */
  if (a.id && a.status === 'zavrsen' && !a.zatvorenAt) {
    payload.zatvoren_at = new Date().toISOString();
    payload.zatvoren_by_email = cu?.email || null;
    payload.zatvoren_napomena = a.zatvorenNapomena || null;
  }
  return payload;
}

export async function saveAkcija(a) {
  if (!getIsOnline()) return null;
  const data = await sbReq('akcioni_plan', 'POST', buildAkcijaPayload(a));
  return Array.isArray(data) && data.length ? mapDbAkcija(data[0]) : null;
}

export async function updateAkcijaStatus(id, status, napomena = '') {
  const cu = getCurrentUser();
  if (!id || !getIsOnline()) return null;
  const payload = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === 'zavrsen') {
    payload.zatvoren_at = new Date().toISOString();
    payload.zatvoren_by_email = cu?.email || null;
    payload.zatvoren_napomena = napomena || null;
  }
  const data = await sbReq(
    `akcioni_plan?id=eq.${encodeURIComponent(id)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(data) && data.length ? mapDbAkcija(data[0]) : null;
}

export async function deleteAkcija(id) {
  if (!id || !getIsOnline()) return false;
  return (await sbReq(`akcioni_plan?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}
