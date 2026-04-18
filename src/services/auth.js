/**
 * Supabase Auth API klijent — bez framework-a, samo fetch.
 *
 * Sve metode rade KROZ state/auth.js da bi sbReq() i UI sloj automatski
 * dobili tačan token i online flag. Ovaj modul NIKAD ne dotiče DOM —
 * UI sloj (Faza 3) renderuje login formu i rukuje grešku.
 *
 * Bezbednost:
 *   - Password se NIKAD ne loguje, ne kešira, ne šalje nigde drugde.
 *   - Sesija (access + refresh token) ide u localStorage pod
 *     STORAGE_KEYS.AUTH (kompatibilno sa legacy fajlom — isti ključ!).
 */

import {
  SUPABASE_CONFIG,
  hasSupabaseConfig,
} from '../lib/constants.js';
import {
  setUser,
  setRole,
  setOnline,
  persistSession,
  loadPersistedSession,
} from '../state/auth.js';

/**
 * Login email + password.
 * @returns {{ok:true,user:object}|{ok:false,error:string}}
 */
export async function login(email, password) {
  if (!hasSupabaseConfig()) {
    return { ok: false, error: 'Supabase konfiguracija nije postavljena (proveri .env)' };
  }
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '');
  if (!cleanEmail || !cleanPass) {
    return { ok: false, error: 'Unesi email i lozinku' };
  }
  try {
    const r = await fetch(SUPABASE_CONFIG.url + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_CONFIG.anonKey,
      },
      body: JSON.stringify({ email: cleanEmail, password: cleanPass }),
    });
    const d = await r.json();
    if (d.error) {
      return { ok: false, error: d.error_description || d.error };
    }
    const user = {
      email: (d.user.email || cleanEmail).toLowerCase(),
      emailRaw: String(d.user?.email || cleanEmail || '').trim(),
      id: d.user.id,
      _token: d.access_token,
    };
    setUser(user);
    setOnline(true);
    persistSession({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      user: d.user,
    });
    return { ok: true, user };
  } catch (e) {
    console.error('[auth] login error', e);
    return { ok: false, error: 'Greška pri prijavi' };
  }
}

/** Brisanje sesije lokalno + best-effort REST logout. */
export async function logout() {
  const session = loadPersistedSession();
  const token = session?.access_token;
  if (hasSupabaseConfig() && token) {
    try {
      await fetch(SUPABASE_CONFIG.url + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      });
    } catch (e) { /* ignore — server logout je best-effort */ }
  }
  setUser(null);
  setRole('viewer');
  setOnline(false);
  persistSession(null);
}

/**
 * Pokušaj povraćaja sesije iz localStorage (refresh token).
 * @returns {Promise<boolean>} true ako je sesija uspešno restaurirana
 */
export async function restoreSession() {
  if (!hasSupabaseConfig()) return false;
  const session = loadPersistedSession();
  if (!session?.refresh_token && !session?.access_token) return false;
  try {
    let accessToken = session.access_token;
    let user = session.user || null;
    if (session.refresh_token) {
      const refreshRes = await fetch(SUPABASE_CONFIG.url + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_CONFIG.anonKey,
        },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      const refreshData = await refreshRes.json();
      if (!refreshRes.ok || refreshData.error) throw new Error(refreshData.error || 'refresh_failed');
      accessToken = refreshData.access_token;
      user = refreshData.user;
      persistSession({
        access_token: refreshData.access_token,
        refresh_token: refreshData.refresh_token || session.refresh_token,
        user: refreshData.user,
      });
    } else if (accessToken) {
      const userRes = await fetch(SUPABASE_CONFIG.url + '/auth/v1/user', {
        headers: {
          'apikey': SUPABASE_CONFIG.anonKey,
          'Authorization': 'Bearer ' + accessToken,
        },
      });
      if (!userRes.ok) throw new Error('user_restore_failed');
      user = await userRes.json();
    }
    if (!user?.email || !accessToken) throw new Error('invalid_session');

    setUser({
      email: (user.email || '').toLowerCase(),
      emailRaw: String(user?.email || '').trim(),
      id: user.id,
      _token: accessToken,
    });
    setOnline(true);
    return true;
  } catch (e) {
    console.warn('[auth] restoreSession failed', e);
    persistSession(null);
    setUser(null);
    setRole('viewer');
    setOnline(false);
    return false;
  }
}
