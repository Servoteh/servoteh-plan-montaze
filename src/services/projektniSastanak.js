/**
 * Projektni sastanak (Presek stanja) — Supabase REST + Storage service.
 *
 * Specifični deo za 'projektni' tip sastanka:
 *   - presek_aktivnosti (rich-text odeljci)
 *   - presek_slike + Supabase Storage 'sastanak-slike'
 *
 * Storage path konvencija:
 *   sastanak-slike/<sastanak_id>/<uuid>.<ext>
 *
 * Svi slike su u privatnom bucket-u — UI mora da generiše SIGNED URL pre
 * prikaza (createSignedUrl trajanje 1h).
 */

import { sbReq, getSupabaseUrl, getSupabaseAnonKey } from './supabase.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';

export const SASTANAK_SLIKE_BUCKET = 'sastanak-slike';
const SIGNED_URL_TTL = 3600; // 1h

export const AKTIVNOST_STATUSI = {
  planiran: 'Planirano',
  u_toku: 'U toku',
  zavrsen: 'Završeno',
  blokirano: 'Blokirano',
  odlozeno: 'Odloženo',
};

export const AKTIVNOST_STATUS_BOJE = {
  planiran: '#7280a8',
  u_toku: '#3b82f6',
  zavrsen: '#10b981',
  blokirano: '#ef4444',
  odlozeno: '#6b7280',
};

/* ── Mappers ── */

export function mapDbAktivnost(d) {
  if (!d) return null;
  return {
    id: d.id,
    sastanakId: d.sastanak_id,
    rb: d.rb || 0,
    redosled: d.redosled || 0,
    naslov: d.naslov || '',
    podRn: d.pod_rn || '',
    sadrzajHtml: d.sadrzaj_html || '',
    sadrzajText: d.sadrzaj_text || '',
    odgovoranEmail: d.odgovoran_email || '',
    odgovoranLabel: d.odgovoran_label || '',
    odgovoranText: d.odgovoran_text || '',
    rok: d.rok || null,
    rokText: d.rok_text || '',
    status: d.status || 'u_toku',
    napomena: d.napomena || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function mapDbSlika(d) {
  if (!d) return null;
  return {
    id: d.id,
    sastanakId: d.sastanak_id,
    aktivnostId: d.aktivnost_id || null,
    storagePath: d.storage_path || '',
    fileName: d.file_name || '',
    mimeType: d.mime_type || '',
    sizeBytes: d.size_bytes || 0,
    caption: d.caption || '',
    redosled: d.redosled || 0,
    uploadedByEmail: d.uploaded_by_email || '',
    uploadedAt: d.uploaded_at || null,
  };
}

/* ── Aktivnosti ── */

export async function loadAktivnosti(sastanakId) {
  if (!sastanakId || !getIsOnline()) return [];
  const data = await sbReq(
    `presek_aktivnosti?sastanak_id=eq.${encodeURIComponent(sastanakId)}&select=*&order=redosled.asc,rb.asc`,
  );
  return Array.isArray(data) ? data.map(mapDbAktivnost) : [];
}

function buildAktivnostPayload(a) {
  /* HTML → plain text za search (jednostavno strip taga). */
  const sadrzajText = String(a.sadrzajHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const payload = {
    sastanak_id: a.sastanakId,
    rb: a.rb || 0,
    redosled: a.redosled || 0,
    naslov: a.naslov || '',
    pod_rn: a.podRn || null,
    sadrzaj_html: a.sadrzajHtml || null,
    sadrzaj_text: sadrzajText || null,
    odgovoran_email: a.odgovoranEmail || null,
    odgovoran_label: a.odgovoranLabel || null,
    odgovoran_text: a.odgovoranText || null,
    rok: a.rok || null,
    rok_text: a.rokText || null,
    status: a.status || 'u_toku',
    napomena: a.napomena || null,
    updated_at: new Date().toISOString(),
  };
  if (a.id) payload.id = a.id;
  return payload;
}

export async function saveAktivnost(a) {
  if (!getIsOnline()) return null;
  const data = await sbReq('presek_aktivnosti', 'POST', buildAktivnostPayload(a));
  return Array.isArray(data) && data.length ? mapDbAktivnost(data[0]) : null;
}

export async function deleteAktivnost(id) {
  if (!id || !getIsOnline()) return false;
  return (await sbReq(`presek_aktivnosti?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}

/**
 * Reorder aktivnosti — bulk update redosleda. Prima niz {id, redosled}.
 */
export async function reorderAktivnosti(rows) {
  if (!Array.isArray(rows) || !rows.length || !getIsOnline()) return false;
  /* PATCH po redu — male količine, nije bottleneck. */
  for (const r of rows) {
    await sbReq(
      `presek_aktivnosti?id=eq.${encodeURIComponent(r.id)}`,
      'PATCH',
      { redosled: r.redosled, updated_at: new Date().toISOString() },
    );
  }
  return true;
}

/* ── Slike ── */

export async function loadSlike(sastanakId, aktivnostId = null) {
  if (!sastanakId || !getIsOnline()) return [];
  let url = `presek_slike?sastanak_id=eq.${encodeURIComponent(sastanakId)}&select=*&order=redosled.asc,uploaded_at.asc`;
  if (aktivnostId) {
    url += `&aktivnost_id=eq.${encodeURIComponent(aktivnostId)}`;
  }
  const data = await sbReq(url);
  return Array.isArray(data) ? data.map(mapDbSlika) : [];
}

/**
 * Upload fajla u Supabase Storage + insert reda u presek_slike.
 *
 * @param {string} sastanakId
 * @param {File}   file        File objekat iz <input type=file> ili drag-drop
 * @param {object} meta        { aktivnostId, caption, redosled }
 * @returns {Promise<object|null>} mapDbSlika ili null
 */
export async function uploadSlika(sastanakId, file, meta = {}) {
  if (!sastanakId || !file || !getIsOnline()) return null;
  const cu = getCurrentUser();
  const token = cu?._token || getSupabaseAnonKey();

  /* Validacija veličine (10 MB limit po SQL bucket-u, ali UI zaštita). */
  const MAX = 10 * 1024 * 1024;
  if (file.size > MAX) {
    console.error('[uploadSlika] Fajl prevelik:', file.size);
    return null;
  }

  /* Generiši path: sastanak-slike/<sastanak_id>/<uuid>.<ext> */
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const uuid = (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now();
  const objectPath = `${sastanakId}/${uuid}.${ext}`;
  const fullPath = `${SASTANAK_SLIKE_BUCKET}/${objectPath}`;

  /* Upload preko Storage REST endpoint-a. */
  const uploadUrl = `${getSupabaseUrl()}/storage/v1/object/${fullPath}`;
  let uploadOk = false;
  try {
    const resp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'apikey': getSupabaseAnonKey(),
        'Content-Type': file.type || 'application/octet-stream',
        'x-upsert': 'true',
        'cache-control': '3600',
      },
      body: file,
    });
    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => '');
      console.error('[uploadSlika] Storage upload pao:', resp.status, errTxt);
      return null;
    }
    uploadOk = true;
  } catch (e) {
    console.error('[uploadSlika] fetch failed', e);
    return null;
  }
  if (!uploadOk) return null;

  /* Insert metadata u tabelu. */
  const payload = {
    sastanak_id: sastanakId,
    aktivnost_id: meta.aktivnostId || null,
    storage_path: fullPath,
    file_name: file.name,
    mime_type: file.type || null,
    size_bytes: file.size,
    caption: meta.caption || null,
    redosled: meta.redosled || 0,
    uploaded_by_email: cu?.email || null,
  };
  const data = await sbReq('presek_slike', 'POST', payload);
  return Array.isArray(data) && data.length ? mapDbSlika(data[0]) : null;
}

export async function deleteSlika(slikaId) {
  if (!slikaId || !getIsOnline()) return false;
  /* Prvo dohvati storage_path da bismo mogli da obrišemo objekat. */
  const data = await sbReq(`presek_slike?id=eq.${encodeURIComponent(slikaId)}&select=storage_path&limit=1`);
  if (!Array.isArray(data) || !data.length) return false;
  const fullPath = data[0].storage_path;

  /* Obrisi iz Storage. */
  const cu = getCurrentUser();
  const token = cu?._token || getSupabaseAnonKey();
  try {
    await fetch(`${getSupabaseUrl()}/storage/v1/object/${fullPath}`, {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer ' + token,
        'apikey': getSupabaseAnonKey(),
      },
    });
  } catch (e) {
    console.warn('[deleteSlika] Storage delete failed (ali brišem red):', e);
  }

  /* Onda obriši red iz tabele. */
  return (await sbReq(`presek_slike?id=eq.${encodeURIComponent(slikaId)}`, 'DELETE')) !== null;
}

/**
 * Generiši signed URL za prikaz slike (1h TTL).
 * Vraća string ili null.
 */
export async function getSlikaSignedUrl(storagePath) {
  if (!storagePath) return null;
  const cu = getCurrentUser();
  const token = cu?._token || getSupabaseAnonKey();
  /* path BEZ bucket prefix-a za /sign endpoint. */
  const objectPath = storagePath.startsWith(SASTANAK_SLIKE_BUCKET + '/')
    ? storagePath.slice((SASTANAK_SLIKE_BUCKET + '/').length)
    : storagePath;
  try {
    const resp = await fetch(
      `${getSupabaseUrl()}/storage/v1/object/sign/${SASTANAK_SLIKE_BUCKET}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'apikey': getSupabaseAnonKey(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL }),
      },
    );
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json || !json.signedURL) return null;
    /* Endpoint vraća relativni signedURL — dopiši host. */
    return getSupabaseUrl() + '/storage/v1' + json.signedURL;
  } catch (e) {
    console.error('[getSlikaSignedUrl] fail', e);
    return null;
  }
}
