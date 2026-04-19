/**
 * PM Teme — Supabase REST service.
 *
 * Tema životni ciklus:
 *   1. PM je dodaje (status='predlog')
 *   2. Rukovodstvo odobrava (status='usvojeno') ili odbija (status='odbijeno')
 *   3. Usvojena tema se može vezati za sastanak (sastanak_id) → automatski deo
 *      dnevnog reda
 *   4. Posle sastanka tema može preći u 'zatvoreno' (rešena kroz akcioni plan)
 */

import { sbReq } from './supabase.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';

export const TEMA_VRSTE = {
  tema: 'Tema',
  problem: 'Problem',
  predlog: 'Predlog',
  rizik: 'Rizik',
  pitanje: 'Pitanje',
};

export const TEMA_OBLASTI = {
  opste: 'Opšte',
  proizvodnja: 'Proizvodnja',
  montaza: 'Montaža',
  nabavka: 'Nabavka',
  kadrovi: 'Kadrovi',
  finansije: 'Finansije',
  kvalitet: 'Kvalitet',
  klijent: 'Klijent',
  ostalo: 'Ostalo',
};

export const TEMA_STATUSI = {
  predlog: 'Na čekanju',
  usvojeno: 'Usvojeno',
  odbijeno: 'Odbijeno',
  odlozeno: 'Odloženo',
  zatvoreno: 'Zatvoreno',
};

export const TEMA_STATUS_BOJE = {
  predlog: '#f59e0b',
  usvojeno: '#10b981',
  odbijeno: '#ef4444',
  odlozeno: '#6b7280',
  zatvoreno: '#a855f7',
};

export const PRIORITETI = { 1: 'Visok', 2: 'Srednji', 3: 'Nizak' };

export function mapDbTema(d) {
  if (!d) return null;
  return {
    id: d.id,
    vrsta: d.vrsta || 'tema',
    oblast: d.oblast || 'opste',
    naslov: d.naslov || '',
    opis: d.opis || '',
    projekatId: d.projekat_id || null,
    status: d.status || 'predlog',
    prioritet: d.prioritet || 2,
    sastanakId: d.sastanak_id || null,
    predlozioEmail: d.predlozio_email || '',
    predlozioLabel: d.predlozio_label || '',
    predlozioAt: d.predlozio_at || null,
    resioEmail: d.resio_email || '',
    resioLabel: d.resio_label || '',
    resioAt: d.resio_at || null,
    resioNapomena: d.resio_napomena || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

/* ── Loaders ── */

/**
 * @param {object} filters
 * @param {string|null} filters.status
 * @param {string|null} filters.sastanakId  ako je setovan, vrati samo teme za taj sastanak
 * @param {string|null} filters.projekatId
 * @param {string|null} filters.predlozioEmail
 * @param {number} [filters.limit=200]
 */
export async function loadPmTeme(filters = {}) {
  if (!getIsOnline()) return [];
  const params = ['select=*', 'order=prioritet.asc,predlozio_at.desc'];

  if (filters.status) params.push(`status=eq.${encodeURIComponent(filters.status)}`);
  if (filters.sastanakId) params.push(`sastanak_id=eq.${encodeURIComponent(filters.sastanakId)}`);
  if (filters.projekatId) params.push(`projekat_id=eq.${encodeURIComponent(filters.projekatId)}`);
  if (filters.predlozioEmail) {
    params.push(`predlozio_email=eq.${encodeURIComponent(filters.predlozioEmail)}`);
  }
  params.push(`limit=${filters.limit || 200}`);

  const data = await sbReq(`pm_teme?${params.join('&')}`);
  return Array.isArray(data) ? data.map(mapDbTema) : [];
}

export async function loadTema(id) {
  if (!id || !getIsOnline()) return null;
  const data = await sbReq(`pm_teme?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return Array.isArray(data) && data.length ? mapDbTema(data[0]) : null;
}

/* ── Savers ── */

function buildTemaPayload(t) {
  const cu = getCurrentUser();
  const payload = {
    vrsta: t.vrsta || 'tema',
    oblast: t.oblast || 'opste',
    naslov: t.naslov || '',
    opis: t.opis || null,
    projekat_id: t.projekatId || null,
    status: t.status || 'predlog',
    prioritet: t.prioritet || 2,
    sastanak_id: t.sastanakId || null,
    updated_at: new Date().toISOString(),
  };
  if (t.id) {
    payload.id = t.id;
  } else {
    /* Pri kreiranju snapshot ko je predložio. */
    payload.predlozio_email = t.predlozioEmail || cu?.email || '';
    payload.predlozio_label = t.predlozioLabel || cu?.email || '';
    payload.predlozio_at = new Date().toISOString();
  }
  /* Kad se status menja na usvojeno/odbijeno/odlozeno, snapshot ko je odlučio. */
  if (t.id && ['usvojeno', 'odbijeno', 'odlozeno', 'zatvoreno'].includes(payload.status)) {
    if (t.resioEmail || cu?.email) {
      payload.resio_email = t.resioEmail || cu?.email;
      payload.resio_label = t.resioLabel || t.resioEmail || cu?.email;
      payload.resio_at = t.resioAt || new Date().toISOString();
      payload.resio_napomena = t.resioNapomena || null;
    }
  }
  return payload;
}

export async function saveTema(t) {
  if (!getIsOnline()) return null;
  const data = await sbReq('pm_teme', 'POST', buildTemaPayload(t));
  return Array.isArray(data) && data.length ? mapDbTema(data[0]) : null;
}

export async function deleteTema(id) {
  if (!id || !getIsOnline()) return false;
  return (await sbReq(`pm_teme?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}

/**
 * Convenience: dodeli temu sastanku (status → 'usvojeno', sastanak_id → setovan).
 */
export async function dodeliTemuSastanku(temaId, sastanakId) {
  const cu = getCurrentUser();
  if (!temaId || !sastanakId || !getIsOnline()) return null;
  const payload = {
    status: 'usvojeno',
    sastanak_id: sastanakId,
    resio_email: cu?.email || null,
    resio_label: cu?.email || null,
    resio_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const data = await sbReq(
    `pm_teme?id=eq.${encodeURIComponent(temaId)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(data) && data.length ? mapDbTema(data[0]) : null;
}

export async function odbijTemu(temaId, napomena = '') {
  const cu = getCurrentUser();
  if (!temaId || !getIsOnline()) return null;
  const payload = {
    status: 'odbijeno',
    resio_email: cu?.email || null,
    resio_label: cu?.email || null,
    resio_at: new Date().toISOString(),
    resio_napomena: napomena || null,
    updated_at: new Date().toISOString(),
  };
  const data = await sbReq(
    `pm_teme?id=eq.${encodeURIComponent(temaId)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(data) && data.length ? mapDbTema(data[0]) : null;
}
