/**
 * Globalno stanje Kadrovska modula.
 *
 * Sva 4 sub-state objekta (employees, absences, work_hours, contracts) imaju
 * isti shape: { items / employees, loaded, _schema }.
 *  - loaded → da li je load() pokrenut barem jednom
 *  - _schema → da li sql migracija postoji u DB-u (false ako save padne)
 *
 * Cache se čuva u localStorage pod ključevima iz STORAGE_KEYS, tako da
 * korisnik vidi nešto i ako Supabase pukne između session-a.
 *
 * UI sloj (Faza 4) treba da zove `ensure*Loaded()` pre rendera.
 */

import { lsGetJSON, lsSetJSON, ssGet, ssSet } from '../lib/storage.js';
import { STORAGE_KEYS, SESSION_KEYS } from '../lib/constants.js';

/* ── Sub-states ── */
export const kadrovskaState = {
  employees: [],
  loaded: false,
  _schemaSupported: true,
  /** Trenutno aktivan tab (sync sa session storage; default 'employees'). */
  activeTab: ssGet(SESSION_KEYS.KADR_TAB, 'employees'),
};

export const kadrAbsencesState = {
  items: [],
  loaded: false,
  _schema: true,
};

export const kadrWorkHoursState = {
  items: [],
  loaded: false,
  _schema: true,
};

export const kadrContractsState = {
  items: [],
  loaded: false,
  _schema: true,
};

/* ── Aktivni tab (sessionStorage, traje koliko i tab browsera) ── */
export function getActiveKadrTab() {
  return ssGet(SESSION_KEYS.KADR_TAB, 'employees');
}

export function setActiveKadrTab(tab) {
  ssSet(SESSION_KEYS.KADR_TAB, tab);
}

/* ── Cache helperi ── */
export function loadEmployeesCache() {
  return lsGetJSON(STORAGE_KEYS.KADROVSKA, []) || [];
}
export function saveEmployeesCache(list) {
  lsSetJSON(STORAGE_KEYS.KADROVSKA, list || []);
}

export function loadAbsencesCache() {
  return lsGetJSON(STORAGE_KEYS.KADR_ABS, []) || [];
}
export function saveAbsencesCache(list) {
  lsSetJSON(STORAGE_KEYS.KADR_ABS, list || []);
}

export function loadWorkHoursCache() {
  return lsGetJSON(STORAGE_KEYS.KADR_WH, []) || [];
}
export function saveWorkHoursCache(list) {
  lsSetJSON(STORAGE_KEYS.KADR_WH, list || []);
}

export function loadContractsCache() {
  return lsGetJSON(STORAGE_KEYS.KADR_CON, []) || [];
}
export function saveContractsCache(list) {
  lsSetJSON(STORAGE_KEYS.KADR_CON, list || []);
}

/* ── Resetovanje na logout (security: ne curiti podatke između naloga) ── */
export function resetKadrovskaState() {
  kadrovskaState.employees = [];
  kadrovskaState.loaded = false;
  kadrAbsencesState.items = [];
  kadrAbsencesState.loaded = false;
  kadrWorkHoursState.items = [];
  kadrWorkHoursState.loaded = false;
  kadrContractsState.items = [];
  kadrContractsState.loaded = false;
}
