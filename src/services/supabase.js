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

/**
 * @param {string} path     PostgREST putanja BEZ vodećeg slash-a, npr. 'employees?select=*'
 *                          ili 'rpc/get_my_user_roles' za RPC.
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} [method='GET']
 * @param {object|null} [body=null]
 * @returns {Promise<any|null>}
 */
export async function sbReq(path, method = 'GET', body = null) {
  if (!hasSupabaseConfig()) return null;

  const user = getCurrentUser();
  const token = user?._token || SUPABASE_CONFIG.anonKey;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_CONFIG.anonKey,
    'Authorization': 'Bearer ' + token,
  };
  if (method === 'POST') {
    headers['Prefer'] = 'return=representation,resolution=merge-duplicates';
  } else if (method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
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
      return null;
    }
    if (!txt) return null;
    try {
      return JSON.parse(txt);
    } catch (parseErr) {
      console.error('SB JSON parse err', { path, method, status: r.status, body: txt, parseErr });
      return null;
    }
  } catch (e) {
    console.error('SB fetch failed', { path, method, error: e });
    return null;
  }
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
