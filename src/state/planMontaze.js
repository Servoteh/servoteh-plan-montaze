/**
 * Globalno stanje Plan Montaže modula.
 *
 * Čuva ono što UI rendereri (Faza 5) iznova čitaju:
 *  - allData {projects: []}
 *  - activeProjectId / activeWpId / activeView
 *  - locationColorMap (perzistira u localStorage)
 *  - phaseModels sidecar (3D model meta, perzistira u localStorage)
 *  - selectedDateIndices (gantt vertical column selection)
 *  - totalGanttFilters
 *  - showFinishedInGantt toggle (perzistira)
 *  - expandedMobileCards (Set ID-jeva otvorenih mobilnih kartica)
 *
 * Sve perzistencije su lazy: čitaju se prilikom prvog importa.
 */

import { lsGetJSON, lsSetJSON, lsGet, lsSet } from '../lib/storage.js';
import {
  STORAGE_KEYS,
  DEFAULT_LOCATIONS,
  DEFAULT_PHASES,
  NUM_CHECKS,
  LOC_PALETTE,
  ENGINEERS_DEFAULT,
  VODJA_DEFAULT,
} from '../lib/constants.js';

/* ── Glavni in-memory state ── */
export const allData = { projects: [] };

export const planMontazeState = {
  allData,
  activeProjectId: null,
  activeWpId: null,
  /** 'plan' | 'gantt' | 'total' | 'calendar' */
  activeView: 'plan',
  /** Filtrovani indeksi faza ili null. */
  filteredIndices: null,
  /** Vrednosti svih filter polja (čuvaju se kroz rerender tbody-ja). */
  filterValues: {},
  /** Async race protection za switchProject. */
  activeProjectLoadToken: 0,
  /** Save debouncing timers. */
  projectSaveTimer: null,
  wpSyncTimer: null,
  phaseSaveTimers: new Map(),
};

/* ── Persisted: Location → boja ── */
export let locationColorMap = lsGetJSON(STORAGE_KEYS.LOC_COLOR, {}) || {};

export function persistLocationColorMap() {
  lsSetJSON(STORAGE_KEYS.LOC_COLOR, locationColorMap);
}

export function setLocationColor(location, color) {
  locationColorMap[location] = color;
  persistLocationColorMap();
}

/* ── Persisted: Phase 3D model sidecar ── */
export let phaseModels = lsGetJSON(STORAGE_KEYS.PHASE_MODEL, {}) || {};

export function persistPhaseModels() {
  lsSetJSON(STORAGE_KEYS.PHASE_MODEL, phaseModels);
}

export function setPhaseModel(phaseId, model) {
  if (!phaseId) return;
  /* Ako je sve prazno → ukloni umesto da čuvamo prazan zapis */
  const clean = {
    name: String(model?.name || '').trim(),
    imageUrl: String(model?.imageUrl || '').trim(),
    fileUrl: String(model?.fileUrl || '').trim(),
    note: String(model?.note || '').trim(),
  };
  if (!clean.name && !clean.imageUrl && !clean.fileUrl && !clean.note) {
    delete phaseModels[phaseId];
  } else {
    phaseModels[phaseId] = clean;
  }
  persistPhaseModels();
}

export function getPhaseModel(phaseId) {
  return (phaseId && phaseModels[phaseId]) || null;
}

export function deletePhaseModel(phaseId) {
  if (phaseId && phaseModels[phaseId]) {
    delete phaseModels[phaseId];
    persistPhaseModels();
  }
}

/* ── Mobile expand state (NIJE perzistovan — samo session in-memory) ── */
export const expandedMobileCards = new Set();

/* ── Selekcija vertikale u Gantu (po view-u) ── */
export const selectedDateIndices = {
  gantt: new Set(),
  total: new Set(),
};
export const lastSelectedDateIndex = {
  gantt: null,
  total: null,
};

/* ── Total Gantt filteri ── */
export const totalGanttFilters = {
  loc: '',
  lead: '',
  engineer: '',
  projectId: '',
  dateFrom: '',
  dateTo: '',
};

/** Per-WP toggle (id → bool). Default je sve uključeno. */
export const totalGanttWPs = {};

export function resetTotalGanttFilters() {
  totalGanttFilters.loc = '';
  totalGanttFilters.lead = '';
  totalGanttFilters.engineer = '';
  totalGanttFilters.projectId = '';
  totalGanttFilters.dateFrom = '';
  totalGanttFilters.dateTo = '';
}

/* ── Gantt: Prikaži završene faze (persisted bool) ── */
export let showFinishedInGantt = lsGet(STORAGE_KEYS.GANTT_SHOW_DONE) === '1';

export function setShowFinishedInGantt(v) {
  showFinishedInGantt = !!v;
  lsSet(STORAGE_KEYS.GANTT_SHOW_DONE, showFinishedInGantt ? '1' : '0');
}

/* ── Gantt drag session (transient) ── */
export const dragState = {
  current: null, // {ri, wpId, projectId, mode, originX, ...} ili null
};

/* ── Lokalni cache fallback (offline mode) ── */
export function loadLocalCache() {
  return lsGetJSON(STORAGE_KEYS.LOCAL, null);
}
export function persistLocalCache(data) {
  lsSetJSON(STORAGE_KEYS.LOCAL, data);
}

/* ── Helpers za aktivni projekat / WP / faze ── */
export function getActiveProject() {
  if (!planMontazeState.activeProjectId) return null;
  return allData.projects.find(p => p.id === planMontazeState.activeProjectId) || null;
}

export function getActiveWP() {
  const p = getActiveProject();
  if (!p) return null;
  return p.workPackages.find(w => w.id === planMontazeState.activeWpId) || null;
}

export function getActivePhases() {
  return getActiveWP()?.phases || [];
}

export function setActiveProject(projectId) {
  planMontazeState.activeProjectId = projectId;
}

export function setActiveWp(wpId) {
  planMontazeState.activeWpId = wpId;
}

export function setActiveView(view) {
  planMontazeState.activeView = view;
}

/* ─────────────────────────────────────────────────────────────────────
   PEOPLE LISTS — engineers + leads (perzistira u localStorage). Default
   lista se merge-uje sa onim što je korisnik dodao + onim što je harvestovano
   iz prethodno snimljenih projekata (`ensurePeopleFromProjects`).
   ───────────────────────────────────────────────────────────────────── */

function _loadPersonList(key, defaults) {
  const raw = lsGetJSON(key, null);
  if (!Array.isArray(raw)) return defaults.slice();
  const merged = defaults.slice();
  raw.forEach(v => {
    const s = String(v || '').trim();
    if (!s) return;
    if (!merged.some(x => String(x).trim().toLowerCase() === s.toLowerCase())) {
      merged.push(s);
    }
  });
  return merged;
}

function _persistPersonList(key, list) {
  lsSetJSON(key, list);
}

export const VODJA = _loadPersonList(STORAGE_KEYS.LEAD, VODJA_DEFAULT);
export const ENGINEERS = _loadPersonList(STORAGE_KEYS.ENG, ENGINEERS_DEFAULT);

/** @returns {string|null} dodato ime ili null ako prazno. */
export function addEngineerName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const existing = ENGINEERS.find(v => String(v).trim().toLowerCase() === n.toLowerCase());
  if (existing) return existing;
  ENGINEERS.push(n);
  _persistPersonList(STORAGE_KEYS.ENG, ENGINEERS);
  return n;
}

export function addLeadName(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const existing = VODJA.find(v => String(v).trim().toLowerCase() === n.toLowerCase());
  if (existing) return existing;
  VODJA.push(n);
  _persistPersonList(STORAGE_KEYS.LEAD, VODJA);
  return n;
}

/**
 * Harvest engineer/lead vrednosti iz već snimljenih projekata u liste.
 * Spasi se situacija da snimljeno ime nestane iz dropdown-a posle reloda.
 */
export function ensurePeopleFromProjects() {
  let addedEng = 0, addedLead = 0;
  const addIfMissing = (list, val) => {
    if (!val) return false;
    const v = String(val).trim();
    if (!v) return false;
    if (list.some(x => String(x).trim().toLowerCase() === v.toLowerCase())) return false;
    list.push(v);
    return true;
  };
  (allData.projects || []).forEach(p => {
    (p.workPackages || []).forEach(wp => {
      if (addIfMissing(ENGINEERS, wp.defaultEngineer)) addedEng++;
      if (addIfMissing(VODJA, wp.defaultLead)) addedLead++;
      (wp.phases || []).forEach(ph => {
        if (addIfMissing(ENGINEERS, ph.engineer)) addedEng++;
        if (addIfMissing(VODJA, ph.person)) addedLead++;
      });
    });
  });
  if (addedEng) _persistPersonList(STORAGE_KEYS.ENG, ENGINEERS);
  if (addedLead) _persistPersonList(STORAGE_KEYS.LEAD, VODJA);
}

/* ─────────────────────────────────────────────────────────────────────
   LOCATIONS — po-projektne liste sa fallback-om na DEFAULT_LOCATIONS.
   ───────────────────────────────────────────────────────────────────── */

/** Vrati slice liste lokacija aktivnog projekta (ili dat). */
export function getProjectLocations(project) {
  const p = project || getActiveProject();
  if (!p) return DEFAULT_LOCATIONS.slice();
  if (!Array.isArray(p.locations) || !p.locations.length) p.locations = DEFAULT_LOCATIONS.slice();
  return p.locations.slice();
}

export function ensureProjectLocations(project) {
  if (!project) return;
  if (!Array.isArray(project.locations) || !project.locations.length) {
    project.locations = DEFAULT_LOCATIONS.slice();
  }
  const seen = new Set(project.locations.map(x => String(x).trim()));
  (project.workPackages || []).forEach(wp => {
    if (wp.location && !seen.has(String(wp.location).trim())) {
      project.locations.push(wp.location);
      seen.add(String(wp.location).trim());
    }
    (wp.phases || []).forEach(ph => {
      if (ph.loc && !seen.has(String(ph.loc).trim())) {
        project.locations.push(ph.loc);
        seen.add(String(ph.loc).trim());
      }
    });
  });
}

export function defaultLocation() {
  const list = getProjectLocations();
  return list[0] || 'Dobanovci';
}

export function isLocationInUse(project, locName) {
  if (!project) return false;
  return (project.workPackages || []).some(
    wp => wp.location === locName || (wp.phases || []).some(p => p.loc === locName)
  );
}

export function renameLocationEverywhere(project, oldName, newName) {
  if (!project || oldName === newName) return;
  (project.workPackages || []).forEach(wp => {
    if (wp.location === oldName) wp.location = newName;
    (wp.phases || []).forEach(p => {
      if (p.loc === oldName) p.loc = newName;
    });
  });
  transferLocationColor(oldName, newName);
}

/* ─────────────────────────────────────────────────────────────────────
   LOCATION COLORS — stable color assignment po lokaciji.
   ───────────────────────────────────────────────────────────────────── */

export function getLocationColor(loc) {
  const k = String(loc || '').trim();
  if (!k) return '#5a6578';
  if (locationColorMap[k]) return locationColorMap[k];
  const used = new Set(Object.values(locationColorMap));
  let pick = LOC_PALETTE.find(c => !used.has(c));
  if (!pick) {
    /* All used — deterministic hash → palette index. */
    let h = 0;
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
    pick = LOC_PALETTE[h % LOC_PALETTE.length];
  }
  locationColorMap[k] = pick;
  persistLocationColorMap();
  return pick;
}

export function transferLocationColor(oldName, newName) {
  const o = String(oldName || '').trim();
  const n = String(newName || '').trim();
  if (!o || !n || o === n) return;
  if (locationColorMap[o] && !locationColorMap[n]) {
    locationColorMap[n] = locationColorMap[o];
    delete locationColorMap[o];
    persistLocationColorMap();
  }
}

export function ensureLocationColorsForProjects() {
  (allData.projects || []).forEach(p => {
    (p.locations || []).forEach(l => getLocationColor(l));
    (p.workPackages || []).forEach(wp => {
      if (wp.location) getLocationColor(wp.location);
      (wp.phases || []).forEach(ph => {
        if (ph.loc) getLocationColor(ph.loc);
      });
    });
  });
}

/* ─────────────────────────────────────────────────────────────────────
   FACTORY: blank objekti za novu fazu / WP / projekat.
   ───────────────────────────────────────────────────────────────────── */

function _normalizePhaseType(t) {
  const v = String(t || '').toLowerCase();
  return v === 'electrical' || v === 'elektro' || v === 'e' ? 'electrical' : 'mechanical';
}

export function createBlankPhase(name, wp) {
  const w = wp || getActiveWP();
  const inferType = String(name || '').toLowerCase().includes('elektro') ? 'electrical' : 'mechanical';
  return {
    id: crypto.randomUUID(),
    name: name || '',
    loc: (w?.location) || defaultLocation(),
    start: null,
    end: null,
    engineer: (w?.defaultEngineer) || '',
    person: (w?.defaultLead) || '',
    status: 0,
    pct: 0,
    checks: new Array(NUM_CHECKS).fill(false),
    note: '',
    blocker: '',
    type: _normalizePhaseType(inferType),
  };
}

export function createBlankWP(name, rnCode, order) {
  const wp = {
    id: crypto.randomUUID(),
    rnCode: rnCode || '',
    rnOrder: order || 1,
    name: name || 'Nova pozicija',
    location: defaultLocation(),
    defaultEngineer: '',
    defaultLead: '',
    deadline: '',
    isActive: true,
    phases: [],
  };
  wp.phases = DEFAULT_PHASES.map(n => createBlankPhase(n, wp));
  return wp;
}

export function createBlankProject(code, name) {
  return {
    id: crypto.randomUUID(),
    code: code || '',
    name: name || 'Novi projekat',
    projectM: '',
    deadline: '',
    pmEmail: '',
    leadPmEmail: '',
    reminderEnabled: false,
    status: 'active',
    locations: DEFAULT_LOCATIONS.slice(),
    workPackages: [createBlankWP('Presa 350t', code ? code + '/1' : '', 1)],
  };
}

/* ─────────────────────────────────────────────────────────────────────
   STATE PERSIST — kad UI promeni nešto u allData, pozove `persistState()`.
   ───────────────────────────────────────────────────────────────────── */

export function persistState() {
  persistLocalCache(allData);
}

/**
 * Bootstrap: vraća allData iz localStorage (sa migration sa starog v5 ključa)
 * ili kreira novi projekat sa default WP-om. Setuje aktivni project/wp.
 */
export function bootstrapFromLocalCache() {
  /* Nova ključ */
  const fresh = loadLocalCache();
  if (fresh?.projects?.length > 0) {
    allData.projects = fresh.projects;
    allData._phaseTypeSchemaSupported = fresh._phaseTypeSchemaSupported !== false;
    planMontazeState.activeProjectId = allData.projects[0].id;
    planMontazeState.activeWpId = allData.projects[0].workPackages?.[0]?.id || null;
    allData.projects.forEach(ensureProjectLocations);
    return;
  }
  /* Migracija sa starog v5 ključa */
  const legacy = lsGetJSON('plan_montaze_v5', null);
  if (legacy?.projects?.length > 0) {
    allData.projects = legacy.projects;
    planMontazeState.activeProjectId = allData.projects[0].id;
    planMontazeState.activeWpId = allData.projects[0].workPackages?.[0]?.id || null;
    allData.projects.forEach(ensureProjectLocations);
    return;
  }
  /* Brand new */
  allData.projects = [createBlankProject('RN 9000', 'Kovačka linija')];
  planMontazeState.activeProjectId = allData.projects[0].id;
  planMontazeState.activeWpId = allData.projects[0].workPackages[0].id;
}
