/**
 * Sastanci detalj — prošireni servis za rad unutar jednog sastanka.
 *
 * Koristi sbReq() + Supabase Storage API (direktan fetch).
 * Sve write operacije su guarded sa getIsOnline().
 */

import { sbReq, getSupabaseHeaders, getSupabaseUrl } from './supabase.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';
import { mapDbSastanak, mapDbUcesnik, loadSastanak, loadUcesnici } from './sastanci.js';

/* ── Mappers ── */

function mapPresekAktivnost(d) {
  if (!d) return null;
  return {
    id: d.id,
    sastanakId: d.sastanak_id,
    rb: d.rb,
    redosled: d.redosled ?? 0,
    naslov: d.naslov || '',
    podRn: d.pod_rn || '',
    sadrzajHtml: d.sadrzaj_html || '',
    sadrzajText: d.sadrzaj_text || '',
    odgEmail: d.odgovoran_email || '',
    odgLabel: d.odgovoran_label || '',
    odgText: d.odgovoran_text || '',
    rok: d.rok || null,
    rokText: d.rok_text || '',
    status: d.status || 'planiran',
    napomena: d.napomena || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

function mapPresekSlika(d) {
  if (!d) return null;
  return {
    id: d.id,
    sastanakId: d.sastanak_id,
    aktivnostId: d.aktivnost_id || null,
    storagePath: d.storage_path,
    fileName: d.file_name || '',
    mimeType: d.mime_type || '',
    sizeBytes: d.size_bytes || 0,
    caption: d.caption || '',
    redosled: d.redosled ?? 0,
    uploadedByEmail: d.uploaded_by_email || '',
    uploadedAt: d.uploaded_at || null,
  };
}

function mapArhiva(d) {
  if (!d) return null;
  return {
    id: d.id,
    sastanakId: d.sastanak_id,
    snapshot: d.snapshot || null,
    arhiviranEmail: d.arhivirao_email || '',
    arhiviranLabel: d.arhivirao_label || '',
    arhiviranoAt: d.arhivirano_at || null,
  };
}

/* ── Loader: puni detalj ── */

/**
 * Učitaj jedan sastanak sa svim prateće podacima (učesnici, aktivnosti, slike, arhiva).
 * @param {string} id UUID
 */
export async function getSastanakFull(id) {
  if (!id || !getIsOnline()) return null;
  const [sastanak, ucesnici, aktivnosti, slike, arhiva] = await Promise.all([
    loadSastanak(id),
    loadUcesnici(id),
    loadPresekAktivnosti(id),
    loadPresekSlike(id),
    loadArhivaSnapshot(id),
  ]);
  if (!sastanak) return null;
  return { ...sastanak, ucesnici, aktivnosti, slike, arhiva };
}

/* ── Status workflow ── */

/** planiran → u_toku */
export async function pocniSastanak(id) {
  return updateStatus(id, 'u_toku', {});
}

/** u_toku → zakljucan */
export async function zakljucajSastanak(id) {
  const cu = getCurrentUser();
  return updateStatus(id, 'zakljucan', {
    zakljucan_at: new Date().toISOString(),
    zakljucan_by_email: cu?.email || null,
  });
}

/** zakljucan → u_toku (admin/menadzment) */
export async function otvojiPonovo(id) {
  return updateStatus(id, 'u_toku', {
    zakljucan_at: null,
    zakljucan_by_email: null,
  });
}

/** * → zakljucan + kreira/ažurira arhiva snapshot */
export async function zakljucajSaSapisanikom(id) {
  const sastanak = await zakljucajSastanak(id);
  if (!sastanak) return null;
  await saveSnapshot(id);
  return loadSastanak(id);
}

async function updateStatus(id, status, extra) {
  if (!id || !getIsOnline()) return null;
  const payload = { status, updated_at: new Date().toISOString(), ...extra };
  const data = await sbReq(`sastanci?id=eq.${encodeURIComponent(id)}`, 'PATCH', payload);
  return Array.isArray(data) && data.length ? mapDbSastanak(data[0]) : null;
}

/* ── Učesnici ── */

export async function updateUcesnikPozvan(sastanakId, email, pozvan) {
  if (!sastanakId || !email || !getIsOnline()) return false;
  const url = `sastanak_ucesnici?sastanak_id=eq.${encodeURIComponent(sastanakId)}&email=eq.${encodeURIComponent(email)}`;
  return (await sbReq(url, 'PATCH', { pozvan: !!pozvan })) !== null;
}

export async function updateUcesnikPrisustvo(sastanakId, email, prisutan) {
  if (!sastanakId || !email || !getIsOnline()) return false;
  const url = `sastanak_ucesnici?sastanak_id=eq.${encodeURIComponent(sastanakId)}&email=eq.${encodeURIComponent(email)}`;
  return (await sbReq(url, 'PATCH', { prisutan: !!prisutan })) !== null;
}

export async function addUcesnik(sastanakId, { email, label }) {
  if (!sastanakId || !email || !getIsOnline()) return false;
  const payload = {
    sastanak_id: sastanakId,
    email: String(email).toLowerCase().trim(),
    label: label || null,
    prisutan: false,
    pozvan: true,
  };
  return (await sbReq('sastanak_ucesnici', 'POST', payload)) !== null;
}

export async function removeUcesnik(sastanakId, email) {
  if (!sastanakId || !email || !getIsOnline()) return false;
  return (await sbReq(
    `sastanak_ucesnici?sastanak_id=eq.${encodeURIComponent(sastanakId)}&email=eq.${encodeURIComponent(email)}`,
    'DELETE',
  )) !== null;
}

/* ── Presek aktivnosti ── */

export async function loadPresekAktivnosti(sastanakId) {
  if (!sastanakId || !getIsOnline()) return [];
  const data = await sbReq(
    `presek_aktivnosti?sastanak_id=eq.${encodeURIComponent(sastanakId)}&select=*&order=redosled.asc,rb.asc`,
  );
  return Array.isArray(data) ? data.map(mapPresekAktivnost) : [];
}

export async function savePresekAktivnost(aktivnost) {
  if (!getIsOnline()) return null;
  const cu = getCurrentUser();
  const payload = {
    sastanak_id: aktivnost.sastanakId,
    naslov: aktivnost.naslov || 'Nova tačka',
    pod_rn: aktivnost.podRn || null,
    sadrzaj_html: aktivnost.sadrzajHtml || null,
    sadrzaj_text: aktivnost.sadrzajText || null,
    odgovoran_email: aktivnost.odgEmail || null,
    odgovoran_label: aktivnost.odgLabel || null,
    odgovoran_text: aktivnost.odgText || null,
    rok: aktivnost.rok || null,
    rok_text: aktivnost.rokText || null,
    status: aktivnost.status || 'planiran',
    napomena: aktivnost.napomena || null,
    redosled: aktivnost.redosled ?? 0,
    updated_at: new Date().toISOString(),
  };
  if (aktivnost.id) {
    payload.id = aktivnost.id;
  } else {
    const existing = await loadPresekAktivnosti(aktivnost.sastanakId);
    payload.rb = (existing.length ? Math.max(...existing.map(a => a.rb)) : 0) + 1;
    payload.redosled = payload.rb;
    payload.created_at = new Date().toISOString();
  }
  const data = await sbReq('presek_aktivnosti', 'POST', payload);
  return Array.isArray(data) && data.length ? mapPresekAktivnost(data[0]) : null;
}

export async function deletePresekAktivnost(id) {
  if (!id || !getIsOnline()) return false;
  return (await sbReq(`presek_aktivnosti?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}

/** Bulk update redosled kolone — optimistic reorder. */
export async function reorderPresekAktivnosti(items) {
  if (!items?.length || !getIsOnline()) return false;
  const promises = items.map((item, idx) =>
    sbReq(
      `presek_aktivnosti?id=eq.${encodeURIComponent(item.id)}`,
      'PATCH',
      { redosled: idx },
    ),
  );
  const results = await Promise.all(promises);
  return results.every(r => r !== null);
}

/* ── Presek slike ── */

export async function loadPresekSlike(sastanakId) {
  if (!sastanakId || !getIsOnline()) return [];
  const data = await sbReq(
    `presek_slike?sastanak_id=eq.${encodeURIComponent(sastanakId)}&select=*&order=redosled.asc,uploaded_at.asc`,
  );
  return Array.isArray(data) ? data.map(mapPresekSlika) : [];
}

/**
 * Upload slike u Supabase Storage bucket 'sastanak-slike' i upis meta u DB.
 * @param {File} file
 * @param {string} sastanakId
 * @param {string|null} aktivnostId
 */
export async function uploadPresekSlika(file, sastanakId, aktivnostId) {
  if (!file || !sastanakId || !getIsOnline()) return null;
  const cu = getCurrentUser();
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const safeBase = file.name.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80);
  const uuid = crypto.randomUUID();
  const storagePath = `${sastanakId}/${uuid}_${safeBase}`;

  const supabaseUrl = getSupabaseUrl();
  const headers = getSupabaseHeaders();

  const uploadRes = await fetch(
    `${supabaseUrl}/storage/v1/object/sastanak-slike/${storagePath}`,
    {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: file,
    },
  );
  if (!uploadRes.ok) {
    console.error('[uploadPresekSlika] Storage upload failed', await uploadRes.text());
    return null;
  }

  const existing = await loadPresekSlike(sastanakId);
  const payload = {
    sastanak_id: sastanakId,
    aktivnost_id: aktivnostId || null,
    storage_path: storagePath,
    file_name: file.name,
    mime_type: file.type || null,
    size_bytes: file.size || null,
    redosled: existing.length,
    uploaded_by_email: cu?.email || null,
    uploaded_at: new Date().toISOString(),
  };
  const data = await sbReq('presek_slike', 'POST', payload);
  return Array.isArray(data) && data.length ? mapPresekSlika(data[0]) : null;
}

export async function deletePresekSlika(id, storagePath) {
  if (!id || !getIsOnline()) return false;
  if (storagePath) {
    const supabaseUrl = getSupabaseUrl();
    const headers = getSupabaseHeaders();
    await fetch(`${supabaseUrl}/storage/v1/object/sastanak-slike/${storagePath}`, {
      method: 'DELETE',
      headers,
    }).catch(() => { /* best-effort */ });
  }
  return (await sbReq(`presek_slike?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}

/**
 * Vrati signed URL za sliku (valid 1h).
 * @param {string} storagePath
 */
export async function getPresekSlikaUrl(storagePath) {
  if (!storagePath || !getIsOnline()) return null;
  const supabaseUrl = getSupabaseUrl();
  const headers = getSupabaseHeaders();
  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/sign/sastanak-slike/${storagePath}`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 }),
    },
  );
  if (!res.ok) return null;
  const json = await res.json();
  return json?.signedURL ? `${supabaseUrl}/storage/v1${json.signedURL}` : null;
}

/* ── Arhiva + Snapshot ── */

export async function loadArhivaSnapshot(sastanakId) {
  if (!sastanakId || !getIsOnline()) return null;
  const data = await sbReq(
    `sastanak_arhiva?sastanak_id=eq.${encodeURIComponent(sastanakId)}&select=*&limit=1`,
  );
  return Array.isArray(data) && data.length ? mapArhiva(data[0]) : null;
}

/**
 * Kreira ili ažurira red u sastanak_arhiva sa snapshotom svih podataka.
 * Ne generiše PDF (Faza C).
 */
export async function saveSnapshot(sastanakId) {
  if (!sastanakId || !getIsOnline()) return null;
  const cu = getCurrentUser();

  const [sastanak, ucesnici, aktivnosti, slike] = await Promise.all([
    loadSastanak(sastanakId),
    loadUcesnici(sastanakId),
    loadPresekAktivnosti(sastanakId),
    loadPresekSlike(sastanakId),
  ]);

  const snapshot = {
    snapshotAt: new Date().toISOString(),
    sastanak,
    ucesnici,
    aktivnosti,
    slike: slike.map(s => ({ ...s, signedUrl: undefined })),
  };

  const existing = await loadArhivaSnapshot(sastanakId);
  const payload = {
    sastanak_id: sastanakId,
    snapshot,
    arhivirao_email: cu?.email || null,
    arhivirao_label: cu?.user_metadata?.full_name || cu?.email || null,
    arhivirano_at: new Date().toISOString(),
  };

  if (existing?.id) {
    payload.id = existing.id;
  } else {
    payload.id = crypto.randomUUID();
  }

  const data = await sbReq('sastanak_arhiva', 'POST', payload);
  return Array.isArray(data) && data.length ? mapArhiva(data[0]) : null;
}

/* ── PM teme za sastanak ── */

export async function loadPmTemeForSastanak(sastanakId) {
  if (!sastanakId || !getIsOnline()) return [];
  const data = await sbReq(
    `pm_teme?sastanak_id=eq.${encodeURIComponent(sastanakId)}&select=*&order=prioritet.desc.nullslast,admin_rang.asc.nullslast,created_at.asc`,
  );
  if (!Array.isArray(data)) return [];
  return data.map(d => ({
    id: d.id,
    vrsta: d.vrsta || 'tema',
    oblast: d.oblast || 'opste',
    naslov: d.naslov || '',
    opis: d.opis || '',
    projekatId: d.projekat_id || null,
    status: d.status || 'predlog',
    prioritet: d.prioritet ?? null,
    adminRang: d.admin_rang ?? null,
    hitno: d.hitno === true,
    predlozioEmail: d.predlozio_email || '',
    predlozioLabel: d.predlozio_label || '',
    createdAt: d.created_at || null,
  }));
}

export async function updateTemaAdminRang(temaId, adminRang) {
  if (!temaId || !getIsOnline()) return false;
  const cu = getCurrentUser();
  return (await sbReq(`pm_teme?id=eq.${encodeURIComponent(temaId)}`, 'PATCH', {
    admin_rang: adminRang != null ? Number(adminRang) : null,
    admin_rang_by_email: cu?.email || null,
    admin_rang_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })) !== null;
}

export async function reorderPmTeme(items) {
  if (!items?.length || !getIsOnline()) return false;
  const cu = getCurrentUser();
  const ts = new Date().toISOString();
  const promises = items.map((item, idx) =>
    sbReq(`pm_teme?id=eq.${encodeURIComponent(item.id)}`, 'PATCH', {
      admin_rang: idx + 1,
      admin_rang_by_email: cu?.email || null,
      admin_rang_at: ts,
      updated_at: ts,
    }),
  );
  const results = await Promise.all(promises);
  return results.every(r => r !== null);
}
