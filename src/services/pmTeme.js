/**
 * PM Teme — Supabase REST service (v2).
 *
 * Tema životni ciklus:
 *   1. PM/menadžment je dodaje (status='predlog', hitno=true ako je urgentno)
 *   2. Admin može da označi 'za razmatranje' (sledeći sastanak menadžmenta)
 *      i da postavi 'admin_rang' (master prioritet po projektu).
 *   3. Rukovodstvo odobrava (status='usvojeno') ili odbija (status='odbijeno').
 *   4. Usvojena tema se može vezati za sastanak (sastanak_id) → automatski
 *      deo dnevnog reda.
 *   5. Posle sastanka tema može preći u 'zatvoreno' (rešena kroz akcioni plan).
 *
 * Polja:
 *   - prioritet (1=visok, 2=srednji, 3=nizak) — predlagaceva self-evaluacija
 *   - hitno (BOOLEAN) — svako može da označi → CRVENI okvir u UI
 *   - za_razmatranje (BOOLEAN) — SAMO admin → "ide na sledeći sastanak"
 *   - admin_rang (INT) — SAMO admin → master sortiranje po projektu (1=najveći)
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
    hitno: !!d.hitno,
    zaRazmatranje: !!d.za_razmatranje,
    adminRang: d.admin_rang ?? null,
    adminRangByEmail: d.admin_rang_by_email || '',
    adminRangAt: d.admin_rang_at || null,
    sastanakId: d.sastanak_id || null,
    predlozioEmail: d.predlozio_email || '',
    predlozioLabel: d.predlozio_label || '',
    predlozioAt: d.predlozio_at || null,
    resioEmail: d.resio_email || '',
    resioLabel: d.resio_label || '',
    resioAt: d.resio_at || null,
    resioNapomena: d.resio_napomena || '',
    visualTag: d.visual_tag || null,
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

/* ── Loaders ── */

/**
 * @param {object} filters
 * @param {string|null} filters.status
 * @param {string|null} filters.sastanakId
 * @param {string|null} filters.projekatId
 * @param {string|null} filters.predlozioEmail
 * @param {boolean}     [filters.hitnoOnly]
 * @param {boolean}     [filters.razmatranjeOnly]
 * @param {boolean}     [filters.usePregledView] — koristi v_pm_teme_pregled (dodaje visual_tag)
 * @param {number}      [filters.limit=500]
 */
export async function loadPmTeme(filters = {}) {
  if (!getIsOnline()) return [];
  const table = filters.usePregledView ? 'v_pm_teme_pregled' : 'pm_teme';
  /* Sortiranje: admin_rang (manji prvi, NULLs zadnje), pa hitno DESC,
     pa za_razmatranje DESC, pa prioritet ASC, pa predlozio_at DESC. */
  const params = [
    'select=*',
    'order=admin_rang.asc.nullslast,hitno.desc,za_razmatranje.desc,prioritet.asc,predlozio_at.desc',
  ];

  if (filters.status) params.push(`status=eq.${encodeURIComponent(filters.status)}`);
  if (filters.sastanakId) params.push(`sastanak_id=eq.${encodeURIComponent(filters.sastanakId)}`);
  if (filters.projekatId) params.push(`projekat_id=eq.${encodeURIComponent(filters.projekatId)}`);
  if (filters.predlozioEmail) {
    params.push(`predlozio_email=eq.${encodeURIComponent(filters.predlozioEmail)}`);
  }
  if (filters.hitnoOnly) params.push('hitno=eq.true');
  if (filters.razmatranjeOnly) params.push('za_razmatranje=eq.true');
  params.push(`limit=${filters.limit || 500}`);

  const data = await sbReq(`${table}?${params.join('&')}`);
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
    hitno: t.hitno === true,
    sastanak_id: t.sastanakId || null,
    updated_at: new Date().toISOString(),
  };
  if (t.id) {
    payload.id = t.id;
  } else {
    payload.predlozio_email = t.predlozioEmail || cu?.email || '';
    payload.predlozio_label = t.predlozioLabel || cu?.email || '';
    payload.predlozio_at = new Date().toISOString();
  }
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
 * Toggle hitno flag — svako (u edit modu) može da označi svoju temu kao hitnu.
 * UI sloj kontroliše da li ne-vlasnik može da menja flag (po dogovoru — samo svoje).
 */
export async function setHitno(temaId, hitno) {
  if (!temaId || !getIsOnline()) return null;
  const payload = {
    hitno: !!hitno,
    updated_at: new Date().toISOString(),
  };
  const data = await sbReq(
    `pm_teme?id=eq.${encodeURIComponent(temaId)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(data) && data.length ? mapDbTema(data[0]) : null;
}

/**
 * Admin-only: označi temu kao "za razmatranje" na sledećem sastanku menadžmenta.
 * Pozivati iz UI gde je već provereno da je trenutni korisnik admin.
 */
export async function setZaRazmatranje(temaId, zaRazmatranje) {
  const cu = getCurrentUser();
  if (!temaId || !getIsOnline()) return null;
  const payload = {
    za_razmatranje: !!zaRazmatranje,
    admin_rang_by_email: cu?.email || null,
    admin_rang_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const data = await sbReq(
    `pm_teme?id=eq.${encodeURIComponent(temaId)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(data) && data.length ? mapDbTema(data[0]) : null;
}

/**
 * Admin-only: postavi master rang teme (1=najveći; NULL = ukloni rang).
 */
export async function setAdminRang(temaId, rang) {
  const cu = getCurrentUser();
  if (!temaId || !getIsOnline()) return null;
  const payload = {
    admin_rang: rang === null || rang === '' ? null : Number(rang) || null,
    admin_rang_by_email: cu?.email || null,
    admin_rang_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const data = await sbReq(
    `pm_teme?id=eq.${encodeURIComponent(temaId)}`,
    'PATCH',
    payload,
  );
  return Array.isArray(data) && data.length ? mapDbTema(data[0]) : null;
}

/**
 * Bulk reorder — admin u "Pregled po projektu" prevuče listu i pošalje
 * niz [{ id, rang }, ...] po novom redosledu (rang = 1, 2, 3, ...).
 * Šaljemo paralelno PATCH-eve, ako je ozbiljniji throughput problem
 * možemo kasnije preći na PostgREST batch upsert.
 */
export async function reorderProjektTeme(items) {
  if (!Array.isArray(items) || !items.length || !getIsOnline()) return false;
  const cu = getCurrentUser();
  const ts = new Date().toISOString();
  const tasks = items.map((it) =>
    sbReq(`pm_teme?id=eq.${encodeURIComponent(it.id)}`, 'PATCH', {
      admin_rang: it.rang === null || it.rang === '' ? null : Number(it.rang) || null,
      admin_rang_by_email: cu?.email || null,
      admin_rang_at: ts,
      updated_at: ts,
    }),
  );
  try {
    await Promise.all(tasks);
    return true;
  } catch (e) {
    console.error('[pmTeme] reorderProjektTeme failed', e);
    return false;
  }
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
