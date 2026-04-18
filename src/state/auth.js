/**
 * Globalno stanje autentifikacije.
 *
 * Razlog za postojanje ovog modula umesto golih `let` u `services/supabase.js`:
 *   - sbReq() i pozivi servisa moraju da znaju trenutni JWT token.
 *   - Auth servis menja korisnika nakon login-a.
 *   - UI sloj treba da reaguje na promenu (npr. da ažurira hub i header).
 *
 * Modul izlaže snapshot getter (`getAuth`) i mali pub/sub (`onAuthChange`).
 * Nikad ne čuvamo password u memoriji — samo email + Supabase session token.
 */

import { lsGetJSON, lsSetJSON, lsRemove } from '../lib/storage.js';
import { STORAGE_KEYS } from '../lib/constants.js';

/* Interni state — nikad ne eksportuj direktno. */
const state = {
  /** { email, emailRaw, id, _token, _refreshToken, _expiresAt } | null */
  user: null,
  /** 'admin' | 'leadpm' | 'pm' | 'hr' | 'viewer' */
  role: 'viewer',
  /** Postoji li trenutno mreža + Supabase odgovara? Postavlja services/supabase.js. */
  isOnline: false,
  /** True ako je poslednji /user_roles upit pao zbog HTTP/parse greške. */
  lastUserRolesQueryFailed: false,
};

const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn(getAuth());
    } catch (e) {
      console.error('[auth] listener error', e);
    }
  }
}

/* ── Public API ── */

/** Vrati read-only snapshot — UI sloj NIKAD ne sme da mutira ovaj objekat. */
export function getAuth() {
  return {
    user: state.user,
    role: state.role,
    isOnline: state.isOnline,
    lastUserRolesQueryFailed: state.lastUserRolesQueryFailed,
  };
}

export function getCurrentUser() {
  return state.user;
}

export function getCurrentRole() {
  return state.role;
}

export function getIsOnline() {
  return state.isOnline;
}

export function setUser(user) {
  state.user = user;
  notify();
}

export function setRole(role) {
  state.role = role || 'viewer';
  notify();
}

export function setOnline(flag) {
  state.isOnline = !!flag;
  notify();
}

export function setLastUserRolesQueryFailed(flag) {
  state.lastUserRolesQueryFailed = !!flag;
}

/** Subscribe na bilo koju promenu. Vrati `unsubscribe()` funkciju. */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/* ── Role helperi (bit-paritet sa legacy/index.html) ── */

export function canEdit() {
  return ['admin', 'leadpm', 'pm'].includes(state.role);
}
export function isLeadPM() {
  return state.role === 'leadpm';
}
export function isAdmin() {
  return state.role === 'admin';
}
export function isHR() {
  return state.role === 'hr' || isAdmin();
}
export function canManageUsers() {
  return isAdmin();
}
export function canAccessKadrovska() {
  return isHR() || isAdmin();
}

/* ── Persistencija sesije u localStorage (fallback ako Supabase ne stigne) ── */

export function loadPersistedSession() {
  return lsGetJSON(STORAGE_KEYS.AUTH, null);
}

export function persistSession(session) {
  if (session) {
    lsSetJSON(STORAGE_KEYS.AUTH, session);
  } else {
    lsRemove(STORAGE_KEYS.AUTH);
  }
}
