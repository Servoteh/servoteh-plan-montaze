/**
 * BigTehn crteži (PDF) — shared service.
 *
 * Centralizuje sav rad sa `bigtehn_drawings_cache` (metapodaci) i Supabase
 * Storage bucket-om `bigtehn-drawings` (signed URL za PDF preview u novom tabu).
 *
 * Koriste ga:
 *   - Modul "Praćenje proizvodnje" (`src/services/planProizvodnje.js`),
 *     koji re-exportuje `getBigtehnDrawingSignedUrl` radi backward-compat.
 *   - Modul "Plan Montaže" → polje „Veza sa“ na fazi
 *     (`src/ui/planMontaze/linkedDrawingsDialog.js`).
 *
 * Pravilo: NE diraj `bigtehn_*_cache` tabele iz frontenda — to su keš tabele
 * koje puni Bridge sync proces; ovde samo READ + signed URL.
 */

import {
  sbReq,
  getSupabaseUrl,
  getSupabaseAnonKey,
} from './supabase.js';
import { getCurrentUser, getIsOnline } from '../state/auth.js';
import { showToast } from '../lib/dom.js';

/** Storage bucket sa PDF crtežima (privatan, sve preko signed URL-a). */
export const BIGTEHN_DRAWINGS_BUCKET = 'bigtehn-drawings';

/** Default trajanje signed URL-a (5 min) — usklađeno sa planProizvodnje modulom. */
export const SIGNED_URL_TTL_SECONDS = 300;

/**
 * Vraća signed URL (default 5 min) za PDF crtež po broju crteža.
 * Vraća null ako broj nije poznat (cache prazan ili Bridge nije sinhronizovao
 * ili je `removed_at` postavljen).
 *
 * @param {string} brojCrteza  Naziv crteža (= naziv fajla bez .pdf), npr. "SC-12345"
 * @param {number} [expiresIn=SIGNED_URL_TTL_SECONDS]
 */
export async function getBigtehnDrawingSignedUrl(brojCrteza, expiresIn = SIGNED_URL_TTL_SECONDS) {
  if (!getIsOnline() || !brojCrteza) return null;

  /* 1) Lookup storage_path iz cache-a */
  const params = new URLSearchParams();
  params.set('select', 'storage_path');
  params.set('drawing_no', `eq.${brojCrteza}`);
  params.set('removed_at', 'is.null');
  params.set('limit', '1');
  const rows = await sbReq(`bigtehn_drawings_cache?${params.toString()}`);
  const storagePath = Array.isArray(rows) && rows[0]?.storage_path;
  if (!storagePath) return null;

  /* 2) Sign */
  const user = getCurrentUser();
  const token = user?._token || getSupabaseAnonKey();
  const apiKey = getSupabaseAnonKey();
  const baseUrl = getSupabaseUrl();
  try {
    const r = await fetch(
      `${baseUrl}/storage/v1/object/sign/${BIGTEHN_DRAWINGS_BUCKET}/${encodeURI(storagePath)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'apikey': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn }),
      },
    );
    if (!r.ok) {
      console.error('[getBigtehnDrawingSignedUrl] failed', r.status);
      return null;
    }
    const { signedURL, signedUrl } = await r.json();
    /* PostgREST API menja casing tokom verzija; pokrij obe */
    const rel = signedURL || signedUrl;
    if (!rel) return null;
    return baseUrl + '/storage/v1' + (rel.startsWith('/') ? rel : '/' + rel);
  } catch (e) {
    console.error('[getBigtehnDrawingSignedUrl] exception', e);
    return null;
  }
}

/**
 * Vrati metapodatke jednog crteža po broju crteža (drawing_no).
 *
 * @param {string} drawingNo
 * @returns {Promise<{drawing_no:string, storage_path:string, file_name:string, mime_type:string|null, size_bytes:number|null}|null>}
 */
export async function getDrawingByNumber(drawingNo) {
  if (!getIsOnline() || !drawingNo) return null;
  const params = new URLSearchParams();
  params.set('select', 'drawing_no,storage_path,file_name,mime_type,size_bytes');
  params.set('drawing_no', `eq.${String(drawingNo)}`);
  params.set('removed_at', 'is.null');
  params.set('limit', '1');
  const rows = await sbReq(`bigtehn_drawings_cache?${params.toString()}`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/**
 * Vrati listu crteža (sa metapodacima) za jedan RN, identifikovan po
 * `bigtehn_work_orders_cache.ident_broj` (npr. `"9000/568"`).
 *
 * Korak 1: nađi sve `bigtehn_work_orders_cache` redove sa `ident_broj=rnCode`
 *   → izvuci sve distinct `broj_crteza` (može biti više varijanti istog RN-a).
 * Korak 2: učitaj `bigtehn_drawings_cache` za sve te brojeve crteža (samo
 *   `removed_at IS NULL`) i vrati ih kao [{drawing_no, storage_path, file_name, ...}].
 *
 * Brojevi crteža za koje fajl još nije sinhronizovan u Storage NEĆE biti u
 * vraćenoj listi (ali postoje kao "kandidat" iz BigTehn-a).
 *
 * @param {string} rnCode  vrednost `work_packages.rn_code` (= `ident_broj` u BigTehn-u)
 * @returns {Promise<Array<object>>}
 */
export async function listDrawingsForRnCode(rnCode) {
  if (!getIsOnline()) return [];
  const code = String(rnCode || '').trim();
  if (!code) return [];

  /* Normalizacija: WP rn_code u Plan Montaži često sadrži prefiks „RN "
     (npr. „RN 9000/1"), dok je u BigTehn-u `ident_broj` bez prefiksa
     („9000/1"). Pokušaj sa oba oblika — prvo sa skinutim prefiksom, pa sa
     originalnim, pa fallback varijante (npr. razmak/separatori). */
  const candidates = [];
  const stripped = code.replace(/^RN\s+/i, '').trim();
  if (stripped && stripped !== code) candidates.push(stripped);
  candidates.push(code);
  /* Dedup, sačuvaj redosled. */
  const seenC = new Set();
  const tryCodes = candidates.filter(c => (c && !seenC.has(c) && (seenC.add(c), true)));

  let woRows = null;
  for (const c of tryCodes) {
    const woParams = new URLSearchParams();
    woParams.set('select', 'broj_crteza');
    woParams.set('ident_broj', `eq.${c}`);
    woParams.set('limit', '500');
    const rows = await sbReq(`bigtehn_work_orders_cache?${woParams.toString()}`);
    if (Array.isArray(rows) && rows.length) {
      woRows = rows;
      break;
    }
  }
  if (!Array.isArray(woRows) || !woRows.length) return [];
  const drawingNos = [
    ...new Set(
      woRows
        .map(r => (r?.broj_crteza == null ? '' : String(r.broj_crteza).trim()))
        .filter(s => s !== ''),
    ),
  ];
  if (!drawingNos.length) return [];

  /* 2) Lookup u bigtehn_drawings_cache. PostgREST `in.(...)` filter. */
  const escaped = drawingNos.map(s => `"${s.replace(/"/g, '\\"')}"`).join(',');
  const dParams = new URLSearchParams();
  dParams.set('select', 'drawing_no,storage_path,file_name,mime_type,size_bytes');
  dParams.set('drawing_no', `in.(${escaped})`);
  dParams.set('removed_at', 'is.null');
  dParams.set('order', 'drawing_no.asc');
  dParams.set('limit', '500');
  const drawings = await sbReq(`bigtehn_drawings_cache?${dParams.toString()}`);
  return Array.isArray(drawings) ? drawings : [];
}

/**
 * Konveniencija: dohvati listu crteža za work_package iz Plan Montaže state-a
 * (potreban je njegov `rn_code`/`rnCode`).
 *
 * Prima ili WP objekat (sa `rnCode`/`rn_code`) ili string `rn_code` direktno.
 *
 * @param {string|{rnCode?:string, rn_code?:string}} wpOrRnCode
 */
export async function listDrawingsForWorkPackage(wpOrRnCode) {
  let rnCode = '';
  if (typeof wpOrRnCode === 'string') {
    rnCode = wpOrRnCode;
  } else if (wpOrRnCode && typeof wpOrRnCode === 'object') {
    rnCode = wpOrRnCode.rnCode || wpOrRnCode.rn_code || '';
  }
  return await listDrawingsForRnCode(rnCode);
}

/**
 * Otvara PDF crtež u novom tabu — kreira signed URL i `window.open`.
 * Ako fajl ne postoji ili broj crteža nije sinhronizovan u Storage,
 * prikazuje toast „Crtež nije dostupan“ i ne otvara prazan tab.
 *
 * @param {string} drawingNo
 */
export async function openDrawingPdf(drawingNo) {
  const code = String(drawingNo || '').trim();
  if (!code) return;
  const url = await getBigtehnDrawingSignedUrl(code);
  if (!url) {
    showToast('Crtež nije dostupan');
    return;
  }
  window.open(url, '_blank', 'noopener');
}
