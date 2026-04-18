/**
 * Tipsani wrapperi nad localStorage / sessionStorage.
 *
 * - Sve postojeće ključeve (vidi src/lib/constants.js) MORAMO da očuvamo
 *   bit-paritetno kako bi vraćeni korisnici videli svoje stare podatke
 *   (theme, kadrovske cache-eve, hub izbor itd.).
 * - Nikad ne bacaju izuzetak — fail-safe (offline mode, privatni mode).
 */

/* ── localStorage ── */

export function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (e) {
    return fallback;
  }
}

export function lsGetJSON(key, fallback = null) {
  const raw = lsGet(key, null);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

export function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

export function lsSetJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function lsRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) { /* noop */ }
}

/* ── sessionStorage ── */

export function ssGet(key, fallback = null) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (e) {
    return fallback;
  }
}

export function ssSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false;
  }
}

export function ssRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch (e) { /* noop */ }
}
