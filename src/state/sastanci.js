/**
 * Sastanci modul — module-local state.
 *
 * Pattern parity sa state/kadrovska.js — singleton state objekat sa
 * resetSastanciState() koji router zove pri logout-u.
 */

import { SESSION_KEYS } from '../lib/constants.js';

const state = {
  /* Cache projekata (lite verzija {id, label}) — koristi ga PM Teme select. */
  projektiCache: null,
  projektiCacheAt: 0,
  /* Aktivni tab kroz reload — sessionStorage. */
  activeTab: 'dashboard',
  /* Trenutno otvoren sastanak (kad je u modal-u/stranici). */
  openSastanakId: null,
};

const PROJEKTI_TTL = 60 * 1000; // 60s

export function getSastanciState() {
  return state;
}

export function getProjektiCache() {
  if (!state.projektiCache) return null;
  if (Date.now() - state.projektiCacheAt > PROJEKTI_TTL) return null;
  return state.projektiCache;
}

export function setProjektiCache(arr) {
  state.projektiCache = arr;
  state.projektiCacheAt = Date.now();
}

export function clearProjektiCache() {
  state.projektiCache = null;
  state.projektiCacheAt = 0;
}

export function setActiveTab(tab) {
  state.activeTab = tab;
}

export function setOpenSastanak(id) {
  state.openSastanakId = id;
}

/** Lista / kalendar u tabu Sastanci (sessionStorage). */
export function getSastSastanView() {
  try {
    return sessionStorage.getItem(SESSION_KEYS.SAST_SASTANCI_VIEW) || 'lista';
  } catch {
    return 'lista';
  }
}

/** Aktivni interni tab u detalju sastanka (sessionStorage). */
export function getSastDetaljTab() {
  try {
    return sessionStorage.getItem(SESSION_KEYS.SAST_DETALJ_TAB) || 'pripremi';
  } catch {
    return 'pripremi';
  }
}

export function setSastDetaljTab(tab) {
  try {
    sessionStorage.setItem(SESSION_KEYS.SAST_DETALJ_TAB, tab);
  } catch { /* ignore */ }
}

/** Lista / Kanban u Akcionom planu (sessionStorage). */
export function getSastAkcioniView() {
  try {
    return sessionStorage.getItem(SESSION_KEYS.SAST_AKCIONI_VIEW) || 'lista';
  } catch {
    return 'lista';
  }
}

export function setSastAkcioniView(v) {
  try {
    sessionStorage.setItem(SESSION_KEYS.SAST_AKCIONI_VIEW, v);
  } catch { /* ignore */ }
}

export function resetSastanciState() {
  state.projektiCache = null;
  state.projektiCacheAt = 0;
  state.activeTab = 'dashboard';
  state.openSastanakId = null;
}
