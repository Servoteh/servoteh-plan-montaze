/**
 * Tanki HTTP wrapper nad Supabase REST/RPC API-jem.
 *
 * Ekvivalent legacy `sbReq()`:
 *  - bez framework-a, bez supabase-js zavisnosti
 *  - automatski koristi JWT iz state/auth.js ako postoji, inače anon ključ
 *  - Prefer header za UPSERT (POST → merge-duplicates) i RETURN=representation
 *
 * Vraća parsiran JSON, ili `null` na BILO KOJU grešku (HTTP, parse, mreža).
 * Zovi-strane (services) se OSLANJAJU na ovo: `null` znači "nije uspelo".
 */

import { SUPABASE_CONFIG, hasSupabaseConfig } from '../lib/constants.js';
import { getCurrentUser } from '../state/auth.js';

export { hasSupabaseConfig };

export function getSupabaseUrl() {
  return SUPABASE_CONFIG.url;
}

export function getSupabaseAnonKey() {
  return SUPABASE_CONFIG.anonKey;
}

/** Auth headers za direktne fetch pozive (Storage API itd.). */
export function getSupabaseHeaders() {
  const user = getCurrentUser();
  const token = user?._token || SUPABASE_CONFIG.anonKey;
  return {
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': 'Bearer ' + token,
  };
}

/**
 * @param {string} path     PostgREST putanja BEZ vodećeg slash-a, npr. 'employees?select=*'
 *                          ili 'rpc/get_my_user_roles' za RPC.
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [method='GET']
 * @param {object|null} [body=null]
 * @param {{ upsert?: boolean, withCount?: boolean }} [options]
 *        `upsert` (default `true`) — na POST pridružuje `resolution=merge-duplicates`
 *        kako bi UNIQUE konflikti odradili UPSERT; prosledi `false` kada želiš
 *        klasičan INSERT koji na duplikat vraća 409 (npr. kreiranje master zapisa).
 *        `withCount` — kada je `true` koristi internu grananu varijantu koja
 *        vraća `{ rows, total }`. NE koristi ovo sa sbReq direktno; postoji
 *        {@link sbReqWithCount} wrapper radi type-safety.
 * @returns {Promise<any|null>}
 */
export async function sbReq(path, method = 'GET', body = null, options = {}) {
  if (!hasSupabaseConfig()) return options.withCount ? { rows: null, total: null } : null;

  const user = getCurrentUser();
  const token = user?._token || SUPABASE_CONFIG.anonKey;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': 'Bearer ' + token,
  };
  if (method === 'POST') {
    const upsert = options.upsert !== false;
    headers['Prefer'] = upsert
      ? 'return=representation,resolution=merge-duplicates'
      : 'return=representation';
  } else if (method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }
  if (options.withCount && method === 'GET') {
    /* PostgREST `count=exact` → Content-Range header sadrži ukupan broj redova. */
    headers['Prefer'] = (headers['Prefer'] ? headers['Prefer'] + ',' : '') + 'count=exact';
  }

  try {
    const r = await fetch(SUPABASE_CONFIG.url + '/rest/v1/' + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    if (!r.ok) {
      console.error('SB err', { path, method, status: r.status, body: txt });
      return options.withCount ? { rows: null, total: null } : null;
    }
    /* PostgREST ponekad vrati prazno telo uz 2xx (npr. 204); ranije je to bilo kao greška (null). */
    let parsed;
    if (!txt) {
      if (method === 'PATCH') parsed = [];
      else if (method === 'DELETE') parsed = true;
      /* PostgREST: RPC sa RETURNS void daje 200/204 sa praznim telom — to je uspeh, ne NULL greška. */
      else if (method === 'POST') parsed = true;
      /* GET sa praznim telom (retko, ali proxy/edge): tretiraj kao prazan niz, ne kao grešku. */
      else if (method === 'GET') parsed = [];
      else parsed = null;
    } else {
      try {
        parsed = JSON.parse(txt);
      } catch (parseErr) {
        console.error('SB JSON parse err', {
          path,
          method,
          status: r.status,
          body: txt,
          parseErr,
        });
        return options.withCount ? { rows: null, total: null } : null;
      }
    }
    if (options.withCount && method === 'GET') {
      const cr = r.headers.get('content-range') || ''; /* primer: "0-49/1234" */
      const total = parseContentRangeTotal(cr);
      return { rows: Array.isArray(parsed) ? parsed : [], total };
    }
    return parsed;
  } catch (e) {
    console.error('SB fetch failed', { path, method, error: e });
    return options.withCount ? { rows: null, total: null } : null;
  }
}

/**
 * Isto kao `sbReq`, ali baca `Error` sa `err.code` (PostgREST / PG) umesto `null`.
 * @returns {Promise<any>}
 */
export async function sbReqThrow(path, method = 'GET', body = null, options = {}) {
  if (!hasSupabaseConfig()) {
    const e = new Error('Supabase nije konfigurisan');
    e.code = 'NO_CONFIG';
    throw e;
  }
  const user = getCurrentUser();
  const token = user?._token || SUPABASE_CONFIG.anonKey;
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': 'Bearer ' + token,
  };
  if (method === 'POST') {
    const upsert = options.upsert !== false;
    headers['Prefer'] = upsert
      ? 'return=representation,resolution=merge-duplicates'
      : 'return=representation';
  } else if (method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }
  let r;
  let txt;
  try {
    r = await fetch(SUPABASE_CONFIG.url + '/rest/v1/' + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    txt = await r.text();
  } catch (net) {
    const e = new Error(net?.message || 'Mrežna greška');
    e.code = 'NETWORK';
    throw e;
  }
  if (!r.ok) {
    let code = '';
    let msg = txt || r.statusText;
    try {
      const j = txt ? JSON.parse(txt) : {};
      if (j.code) code = j.code;
      if (j.message) msg = j.message;
    } catch {
      /* raw body */
    }
    if (!code && (r.status === 401 || r.status === 403)) code = '42501';
    const err = new Error(msg);
    err.code = code;
    err.status = r.status;
    throw err;
  }
  if (!txt) {
    if (method === 'PATCH') return [];
    if (method === 'DELETE') return true;
    if (method === 'POST') return true;
    if (method === 'GET') return [];
    return null;
  }
  try {
    return JSON.parse(txt);
  } catch (parseErr) {
    const err = new Error('Neispravan odgovor servera');
    err.code = 'PARSE';
    throw err;
  }
}

/**
 * Wrapper nad `sbReq` koji vraća `{ rows, total }` gde je `total` iz Content-Range header-a.
 * Koristi se za paginated liste.
 * @param {string} path
 * @returns {Promise<{ rows: any[]|null, total: number|null }>}
 */
export async function sbReqWithCount(path) {
  return sbReq(path, 'GET', null, { withCount: true });
}

function parseContentRangeTotal(cr) {
  if (!cr) return null;
  const idx = cr.lastIndexOf('/');
  if (idx < 0) return null;
  const tail = cr.slice(idx + 1).trim();
  if (!tail || tail === '*') return null;
  const n = Number(tail);
  return Number.isFinite(n) ? n : null;
}

/**
 * Health-check: pinguj Supabase REST-om. Koristi se za inicijalnu detekciju
 * online/offline statusa. Rezultat upiši kroz state/auth.js -> setOnline().
 */
export async function pingSupabase() {
  if (!hasSupabaseConfig()) return false;
  try {
    const r = await fetch(SUPABASE_CONFIG.url + '/rest/v1/?select=*', {
      method: 'GET',
      headers: {
        'apikey': SUPABASE_CONFIG.anonKey,
        'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey,
      },
    });
    return r.ok || r.status === 404; // 404 znači da REST radi ali tabela ne postoji
  } catch (e) {
    return false;
  }
}
