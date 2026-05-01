/**
 * Plan Montaže — Supabase orchestrator + debounced save queue.
 *
 * UI moduli treba da koriste samo ove visoke API-je, a ne `projects.js`
 * direktno (osim za map/build helpere). Ovde su:
 *   - fetchAllProjectsHierarchy(): kompletan load svih projekata sa WP-ovima
 *     i fazama (replace `allData.projects`).
 *   - queueProjectSave(), queuePhaseSaveByIndex(i), queueCurrentWpSync():
 *     debounce kao u legacy (SAVE_DEBOUNCE_MS).
 *   - saveAllCurrentPhases(): forsirani upsert svih faza aktivnog WP-a.
 *
 * Race protection: switchProject može da bude prekinut tokom load-a; UI sloj
 * koristi `planMontazeState.activeProjectLoadToken` da odbaci stari rezultat.
 */

import { sbReq } from './supabase.js';
import {
  loadProjectsFromDb,
  loadAllProjectData,
  saveProjectToDb,
  saveWorkPackageToDb,
  savePhaseToDb,
  deletePhaseFromDb,
  deleteWorkPackageFromDb,
  deleteProjectFromDb,
} from './projects.js';
import { canEdit, getIsOnline } from '../state/auth.js';
import {
  allData,
  planMontazeState,
  getActiveProject,
  getActiveWP,
  getActivePhases,
  ensureProjectLocations,
  ensureLocationColorsForProjects,
  ensurePeopleFromProjects,
  persistState,
} from '../state/planMontaze.js';
import { SAVE_DEBOUNCE_MS } from '../lib/constants.js';

/* ── SAVE STATUS TRACKER (F5.5) ──────────────────────────────────────── */
/* Drži broj queued (debouncing) i inflight (network in-progress) save-ova.
   UI status panel se subscribe-uje preko `subscribeSaveStatus()`. */

const _saveStatus = {
  queued: 0,    /* Broj aktivnih timer-a (projectSave, phaseSaveTimers, wpSync) */
  inflight: 0,  /* Broj POST/PATCH zahteva u flight-u */
  lastError: null,
  lastSavedAt: null,
};
const _saveListeners = new Set();

export function subscribeSaveStatus(fn) {
  _saveListeners.add(fn);
  fn(_saveStatus);
  return () => _saveListeners.delete(fn);
}

export function getSaveStatus() {
  return { ..._saveStatus };
}

function _emitSaveStatus() {
  for (const fn of _saveListeners) {
    try { fn(_saveStatus); } catch (e) { /* ignore */ }
  }
}

function _recountQueued() {
  let n = 0;
  if (planMontazeState.projectSaveTimer) n++;
  if (planMontazeState.wpSyncTimer) n++;
  n += planMontazeState.phaseSaveTimers?.size || 0;
  _saveStatus.queued = n;
  _emitSaveStatus();
}

async function _trackInflight(fn) {
  _saveStatus.inflight++;
  _emitSaveStatus();
  try {
    const r = await fn();
    _saveStatus.lastSavedAt = Date.now();
    _saveStatus.lastError = null;
    return r;
  } catch (e) {
    _saveStatus.lastError = String(e?.message || e);
    throw e;
  } finally {
    _saveStatus.inflight--;
    _emitSaveStatus();
  }
}

/* ── LOAD: kompletna hijerarhija projects → WP → phases ──────────────── */

/**
 * Učitaj sve projekte iz baze + njihove WP-ove i faze. Replace-uje
 * `allData.projects`. Čuva aktivni projekat/WP ako i dalje postoje posle load-a.
 * Vraća true ako je sve uspelo, false ako je makar jedan korak vratio null.
 * UI treba posle ovoga da pozove `cacheToLocal` ekvivalent (`persistState`).
 */
export async function fetchAllProjectsHierarchy() {
  if (!getIsOnline()) return false;
  const projects = await loadProjectsFromDb();
  if (!projects) return false;
  for (const p of projects) {
    const wps = await loadAllProjectData(p.id);
    p.workPackages = wps || [];
  }
  /* Replace allData.projects in place tako da getteri vide novi state. */
  const keepProjectId = planMontazeState.activeProjectId;
  const keepWpId = planMontazeState.activeWpId;
  allData.projects.length = 0;
  projects.forEach(p => allData.projects.push(p));
  if (allData.projects.some(p => p.id === keepProjectId)) {
    planMontazeState.activeProjectId = keepProjectId;
    const p = allData.projects.find(x => x.id === keepProjectId);
    if (p?.workPackages?.some(w => w.id === keepWpId)) {
      planMontazeState.activeWpId = keepWpId;
    } else {
      planMontazeState.activeWpId = p.workPackages?.[0]?.id || null;
    }
  } else {
    planMontazeState.activeProjectId = allData.projects[0]?.id || null;
    planMontazeState.activeWpId = allData.projects[0]?.workPackages?.[0]?.id || null;
  }
  allData.projects.forEach(ensureProjectLocations);
  ensureLocationColorsForProjects();
  ensurePeopleFromProjects();
  persistState();
  return true;
}

/* ── SAVE QUEUE: debounce upsert ─────────────────────────────────────── */

/**
 * Debouncedi save aktivnog projekta (project meta polja). Više uzastopnih
 * editova → jedan POST nakon mirovanja od SAVE_DEBOUNCE_MS.
 */
export function queueProjectSave() {
  if (!getIsOnline() || !canEdit()) return;
  if (planMontazeState.projectSaveTimer) {
    clearTimeout(planMontazeState.projectSaveTimer);
  }
  planMontazeState.projectSaveTimer = setTimeout(async () => {
    const proj = getActiveProject();
    if (proj) await _trackInflight(() => saveProjectToDb(proj));
    planMontazeState.projectSaveTimer = null;
    _recountQueued();
  }, SAVE_DEBOUNCE_MS);
  _recountQueued();
}

/**
 * Debouncedi save jedne faze po indeksu u aktivnom WP. Race-safe: u trenutku
 * stvarnog snimanja, posebno se traži živa faza preko ID-a, jer se može
 * dogoditi da se redosled u međuvremenu promenio.
 */
export function queuePhaseSaveByIndex(i) {
  if (!getIsOnline() || !canEdit()) return;
  const proj = getActiveProject();
  const wp = getActiveWP();
  const ph = getActivePhases()[i];
  if (!proj || !wp || !ph?.id) return;
  const existing = planMontazeState.phaseSaveTimers.get(ph.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    const liveProj = getActiveProject();
    const liveWp = getActiveWP();
    if (!liveProj || !liveWp) {
      planMontazeState.phaseSaveTimers.delete(ph.id);
      _recountQueued();
      return;
    }
    const liveIndex = liveWp.phases.findIndex(x => x.id === ph.id);
    if (liveIndex === -1) {
      planMontazeState.phaseSaveTimers.delete(ph.id);
      _recountQueued();
      return;
    }
    await _trackInflight(() => savePhaseToDb(liveWp.phases[liveIndex], liveProj.id, liveWp.id, liveIndex));
    planMontazeState.phaseSaveTimers.delete(ph.id);
    _recountQueued();
  }, SAVE_DEBOUNCE_MS);
  planMontazeState.phaseSaveTimers.set(ph.id, timer);
  _recountQueued();
}

/**
 * Debouncedi sync celog aktivnog WP-a (struktura + sve faze) — koristi se
 * posle reorder-a / dodavanja / brisanja faze.
 */
export function queueCurrentWpSync() {
  if (!getIsOnline() || !canEdit()) return;
  if (planMontazeState.wpSyncTimer) clearTimeout(planMontazeState.wpSyncTimer);
  planMontazeState.wpSyncTimer = setTimeout(async () => {
    await _trackInflight(() => saveAllCurrentPhases());
    planMontazeState.wpSyncTimer = null;
    _recountQueued();
  }, SAVE_DEBOUNCE_MS);
  _recountQueued();
}

/** Forsiran upsert svih faza iz aktivnog WP-a (sekvencijalno). */
export async function saveAllCurrentPhases() {
  if (!getIsOnline() || !canEdit()) return;
  const p = getActiveProject();
  const wp = getActiveWP();
  if (!p || !wp) return;
  for (let i = 0; i < wp.phases.length; i++) {
    await savePhaseToDb(wp.phases[i], p.id, wp.id, i);
  }
}

/* Online/offline tracking — UI status panel može da se subscribe-uje */
const _connListeners = new Set();
export function subscribeConnState(fn) {
  _connListeners.add(fn);
  fn(getIsOnline());
  const onOnline = () => fn(true);
  const onOffline = () => fn(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  return () => {
    _connListeners.delete(fn);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}

/* ── DELETE wrappers — UI poziva ove, ne direktno services/projects.js ─ */

export async function deletePhaseAndPersist(phaseId) {
  if (!phaseId) return;
  await deletePhaseFromDb(phaseId);
}

export async function deleteWorkPackageAndPersist(wpId) {
  if (!wpId) return;
  await deleteWorkPackageFromDb(wpId);
}

export async function deleteProjectAndPersist(projectId) {
  if (!projectId) return;
  await deleteProjectFromDb(projectId);
}

/* ── Reminder (basic skeleton — ujedinjuje legacy buildReminderPayload) ─ */

export async function callReminderEndpoint(buildPayloadFn) {
  if (!canEdit()) return { ok: false, reason: 'forbidden' };
  const payload = buildPayloadFn ? buildPayloadFn() : [];
  if (!payload.length) return { ok: true, sent: 0, empty: true };
  if (!getIsOnline()) {
    return { ok: true, sent: payload.length, offline: true };
  }
  /* Edge functions endpoint — Authorization je već default kroz sbReq, ali
     Edge Functions koriste poseban path /functions/v1, pa idemo direktno. */
  try {
    const res = await sbReq('rpc/send_reminders', 'POST', { alerts: payload });
    return { ok: !!res, sent: payload.length };
  } catch (e) {
    return { ok: false, reason: 'network', error: String(e) };
  }
}
