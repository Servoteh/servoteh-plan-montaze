/**
 * Light / Dark tema — bit-paritet sa legacy/index.html.
 *
 * Logika:
 *   1. Ako korisnik ima sačuvanu temu u localStorage (THEME_KEY), koristi nju.
 *   2. Inače, prati system pref (prefers-color-scheme).
 *   3. Listener prati promene system teme dok korisnik ručno ne izabere.
 *
 * Tema se primenjuje preko `data-theme="light|dark"` na <html> elementu;
 * sve CSS varijable (vidi src/styles/legacy.css) reaguju automatski.
 */

import { lsGet, lsSet } from './storage.js';
import { STORAGE_KEYS } from './constants.js';

function getStoredTheme() {
  return lsGet(STORAGE_KEYS.THEME, null);
}

function getSystemTheme() {
  return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
    ? 'light' : 'dark';
}

export function applyTheme(theme) {
  const t = (theme === 'light' || theme === 'dark') ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  /* Sva theme-toggle dugmad u app-u: sinhronizuj title atribut */
  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.setAttribute('title', t === 'dark' ? 'Pređi na Light temu' : 'Pređi na Dark temu');
  });
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  lsSet(STORAGE_KEYS.THEME, next);
}

export function getCurrentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

/** Pozovi jednom na startu app-a (npr. iz main.js bootstrap-a). */
export function initTheme() {
  const stored = getStoredTheme();
  applyTheme(stored || getSystemTheme());
  if (!stored && window.matchMedia) {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const listener = e => {
        /* Korisnik nije birao — i dalje pratimo OS. */
        if (!getStoredTheme()) applyTheme(e.matches ? 'light' : 'dark');
      };
      if (mq.addEventListener) mq.addEventListener('change', listener);
      else if (mq.addListener) mq.addListener(listener);
    } catch (e) { /* noop */ }
  }
}
