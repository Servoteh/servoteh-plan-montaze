/**
 * State za modul Praćenje proizvodnje.
 *
 * Jednostavan pub/sub kao u ostalim vanilla modulima. Podaci se pune iz dva
 * RPC-ja i drže u memoriji dok je modul otvoren.
 */

import {
  canEditPracenje,
  ensureRadniNalogFromBigtehn,
  fetchAktivniNaloziZaPracenje,
  fetchOperativneAktivnostiRaw,
  fetchOperativniPlan,
  fetchPracenjeRn,
  listOdeljenja,
  listRadnici,
  promovisiAkcionuTacku,
  resolveRnId,
  setBlokirano,
  skiniBlokadu,
  subscribePracenjeRn,
  upsertOperativnaAktivnost,
  zatvoriAktivnost,
} from '../services/pracenjeProizvodnje.js';
import { canEdit as authCanEditApp } from '../state/auth.js';
import { showToast } from '../lib/dom.js';

/** UI edit: RPC can_edit_pracenje + fallback na app ulogu (isti pattern kao Plan Montaže). */
function effectiveCanEditPracenje(rpcAllowed) {
  return !!rpcAllowed || authCanEditApp();
}

export const PRACENJE_TABS = ['po_pozicijama', 'operativni_plan'];

export const pracenjeState = {
  rnId: null,
  header: null,
  tab1Data: null,
  tab2Data: { activities: [] },
  dashboard: null,
  canEdit: false,
  activeTab: 'po_pozicijama',
  loading: false,
  saving: false,
  error: null,
  departments: [],
  radnici: [],
  filters: {
    search: '',
    odeljenja: [],
    statusi: [],
    prioriteti: [],
    odgovoran: '',
    dateFrom: '',
    dateTo: '',
    onlyLate: false,
    onlyBlocked: false,
    hideClosed: false,
    quick: '',
  },
  live: {
    active: false,
    mode: 'off',
    reconnecting: false,
  },
  highlightedActivityId: null,
  /** MES aktivni RN-ovi (BigTehn) za picker na prvoj strani */
  aktivniNalozi: [],
  aktivniNaloziLoading: false,
  aktivniNaloziError: null,
  aktivniNaloziLoaded: false,
};

const listeners = new Set();
let realtimeUnsubscribe = null;
let silentRefreshTimer = null;

export function subscribePracenje(callback) {
  listeners.add(callback);
  callback(snapshot());
  return () => listeners.delete(callback);
}

export function getPracenjeSnapshot() {
  return snapshot();
}

export function resetPracenjeState() {
  stopRealtime();
  pracenjeState.rnId = null;
  pracenjeState.header = null;
  pracenjeState.tab1Data = null;
  pracenjeState.tab2Data = { activities: [] };
  pracenjeState.dashboard = null;
  pracenjeState.canEdit = false;
  pracenjeState.loading = false;
  pracenjeState.saving = false;
  pracenjeState.error = null;
  pracenjeState.highlightedActivityId = null;
  pracenjeState.aktivniNalozi = [];
  pracenjeState.aktivniNaloziLoading = false;
  pracenjeState.aktivniNaloziError = null;
  pracenjeState.aktivniNaloziLoaded = false;
  emit();
}

export function setActiveTab(tab) {
  if (!PRACENJE_TABS.includes(tab)) return;
  pracenjeState.activeTab = tab;
  emit();
}

export function setOperativniFilter(name, value) {
  if (!Object.prototype.hasOwnProperty.call(pracenjeState.filters, name)) return;
  pracenjeState.filters[name] = normalizeFilterValue(name, value);
  persistFilters();
  syncFiltersToUrl();
  emit();
}

export function resetOperativniFilters() {
  pracenjeState.filters = defaultFilters();
  persistFilters();
  syncFiltersToUrl();
  emit();
}

/**
 * Učitava MES listu aktivnih BigTehn RN-ova (v_active_bigtehn_work_orders) za tabelu izbora.
 */
export async function loadAktivniNaloziList() {
  if (pracenjeState.aktivniNaloziLoaded || pracenjeState.aktivniNaloziLoading) return;
  pracenjeState.aktivniNaloziLoading = true;
  pracenjeState.aktivniNaloziError = null;
  emit();
  try {
    pracenjeState.aktivniNalozi = await fetchAktivniNaloziZaPracenje();
    pracenjeState.aktivniNaloziError = null;
  } catch (e) {
    pracenjeState.aktivniNalozi = [];
    pracenjeState.aktivniNaloziError = e?.message || String(e);
  } finally {
    pracenjeState.aktivniNaloziLoading = false;
    pracenjeState.aktivniNaloziLoaded = true;
    emit();
  }
}

/**
 * @param {string} rnId - RN broj, UUID, ili privremeni query
 * @param {{ bigtehnWorkOrderId?: number }} [options] - ako je setovan, kreira RN u Fazi 2 iz BigTehn cache-a (MES)
 */
export async function loadPracenje(rnId, options = {}) {
  const { bigtehnWorkOrderId } = options;
  const rnQuery = String(rnId || '').trim();
  if (!rnQuery && bigtehnWorkOrderId == null) {
    pracenjeState.error = 'Unesi RN broj ili RN UUID za učitavanje.';
    emit();
    return false;
  }
  pracenjeState.rnId = rnQuery || `wo:${bigtehnWorkOrderId}`;
  hydrateFilters(pracenjeState.rnId);
  pracenjeState.loading = true;
  pracenjeState.error = null;
  emit();

  try {
    let resolvedRnId;
    if (bigtehnWorkOrderId != null && Number.isFinite(Number(bigtehnWorkOrderId))) {
      resolvedRnId = await ensureRadniNalogFromBigtehn(bigtehnWorkOrderId);
      pracenjeState.rnId = resolvedRnId;
      hydrateFilters(resolvedRnId);
    } else {
      resolvedRnId = await resolveRnId(rnQuery);
      if (resolvedRnId !== rnQuery) {
        pracenjeState.rnId = resolvedRnId;
        hydrateFilters(resolvedRnId);
      }
    }
    const [tab1, tab2, departments, radnici] = await Promise.all([
      fetchPracenjeRn(resolvedRnId),
      fetchOperativniPlan({ rnId: resolvedRnId }),
      listOdeljenja(),
      listRadnici(),
    ]);
    const rawActivities = await fetchOperativneAktivnostiRaw(resolvedRnId);
    const activities = mergeActivityDetails(tab2?.activities || [], rawActivities);
    const header = { ...(tab1?.header || {}), ...(tab2?.header || {}) };
    const rpcCanEdit = await canEditPracenje(header.projekat_id || null, resolvedRnId);

    pracenjeState.header = header;
    pracenjeState.tab1Data = tab1 || { positions: [], summary: {} };
    pracenjeState.tab2Data = { ...(tab2 || {}), activities };
    pracenjeState.dashboard = tab2?.dashboard || null;
    pracenjeState.departments = departments;
    pracenjeState.radnici = radnici;
    pracenjeState.canEdit = effectiveCanEditPracenje(rpcCanEdit);
    pracenjeState.loading = false;
    pracenjeState.error = null;
    emit();
    return true;
  } catch (e) {
    pracenjeState.loading = false;
    pracenjeState.error = e?.message || String(e);
    emit();
    return false;
  }
}

export async function promoteAkcionaTacka(akcioniPlanId, odeljenjeId) {
  const before = cloneState();
  pracenjeState.saving = true;
  emit();
  try {
    const newId = await promovisiAkcionuTacku(akcioniPlanId, odeljenjeId, pracenjeState.rnId);
    await loadPracenje(pracenjeState.rnId);
    pracenjeState.highlightedActivityId = newId;
    emit();
    setTimeout(() => {
      if (pracenjeState.highlightedActivityId === newId) {
        pracenjeState.highlightedActivityId = null;
        emit();
      }
    }, 2000);
    return newId;
  } catch (e) {
    restoreState(before, e);
    return null;
  }
}

export function startRealtime() {
  stopRealtime();
  if (!pracenjeState.rnId) return;
  pracenjeState.live = { active: true, mode: 'polling', reconnecting: false };
  realtimeUnsubscribe = subscribePracenjeRn(pracenjeState.rnId, () => {
    if (silentRefreshTimer) clearTimeout(silentRefreshTimer);
    silentRefreshTimer = setTimeout(async () => {
      const ok = await silentRefreshPracenje();
      if (ok) showToast('Podaci ažurirani');
    }, 1500);
  });
  emit();
}

export function stopRealtime() {
  if (realtimeUnsubscribe) {
    realtimeUnsubscribe();
    realtimeUnsubscribe = null;
  }
  if (silentRefreshTimer) {
    clearTimeout(silentRefreshTimer);
    silentRefreshTimer = null;
  }
  pracenjeState.live = { active: false, mode: 'off', reconnecting: false };
}

export async function silentRefreshPracenje() {
  if (!pracenjeState.rnId) return false;
  try {
    const [tab1, tab2] = await Promise.all([
      fetchPracenjeRn(pracenjeState.rnId),
      fetchOperativniPlan({ rnId: pracenjeState.rnId }),
    ]);
    const rawActivities = await fetchOperativneAktivnostiRaw(pracenjeState.rnId);
    const activities = mergeActivityDetails(tab2?.activities || [], rawActivities);
    const header = { ...(tab1?.header || {}), ...(tab2?.header || {}) };
    pracenjeState.header = header;
    pracenjeState.tab1Data = tab1 || pracenjeState.tab1Data;
    pracenjeState.tab2Data = { ...(tab2 || {}), activities };
    pracenjeState.dashboard = tab2?.dashboard || null;
    const rpcCanEdit = await canEditPracenje(header.projekat_id || null, pracenjeState.rnId);
    pracenjeState.canEdit = effectiveCanEditPracenje(rpcCanEdit);
    pracenjeState.error = null;
    emit();
    return true;
  } catch (e) {
    console.warn('[pracenje] silent refresh failed', e);
    return false;
  }
}

export async function saveAktivnost(payload) {
  const before = cloneState();
  pracenjeState.saving = true;
  applyOptimisticActivity(payload);
  emit();
  try {
    await upsertOperativnaAktivnost(payload);
    await loadPracenje(pracenjeState.rnId);
    pracenjeState.saving = false;
    emit();
    return true;
  } catch (e) {
    restoreState(before, e);
    return false;
  }
}

export async function closeAktivnost(id, napomena) {
  const before = cloneState();
  pracenjeState.saving = true;
  patchActivity(id, {
    efektivni_status: 'zavrseno',
    status: 'zavrseno',
    zatvoren_napomena: napomena || '',
  });
  emit();
  try {
    await zatvoriAktivnost(id, napomena || '');
    await loadPracenje(pracenjeState.rnId);
    pracenjeState.saving = false;
    emit();
    return true;
  } catch (e) {
    restoreState(before, e);
    return false;
  }
}

export async function blockAktivnost(id, razlog) {
  const before = cloneState();
  pracenjeState.saving = true;
  patchActivity(id, {
    efektivni_status: 'blokirano',
    manual_override_status: 'blokirano',
    blokirano_razlog: razlog,
  });
  emit();
  try {
    await setBlokirano(id, razlog);
    await loadPracenje(pracenjeState.rnId);
    pracenjeState.saving = false;
    emit();
    return true;
  } catch (e) {
    restoreState(before, e);
    return false;
  }
}

export async function unblockAktivnost(id, napomena) {
  const before = cloneState();
  pracenjeState.saving = true;
  patchActivity(id, {
    manual_override_status: null,
    blokirano_razlog: null,
  });
  emit();
  try {
    await skiniBlokadu(id, napomena || '');
    await loadPracenje(pracenjeState.rnId);
    pracenjeState.saving = false;
    emit();
    return true;
  } catch (e) {
    restoreState(before, e);
    return false;
  }
}

export function getFilteredActivities() {
  const f = pracenjeState.filters;
  const search = String(f.search || '').trim().toLowerCase();
  return (pracenjeState.tab2Data?.activities || [])
    .filter(a => {
      if (search) {
        const hay = [
          a.naziv_aktivnosti,
          a.opis,
          a.broj_tp,
          a.kolicina_text,
          a.odgovoran,
          a.odgovoran_label,
          a.rizik_napomena,
        ].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      if (f.odeljenja.length && !f.odeljenja.includes(String(a.odeljenje || a.odeljenje_naziv || ''))) return false;
      if (f.statusi.length && !f.statusi.includes(String(a.efektivni_status || a.status || ''))) return false;
      if (f.prioriteti.length && !f.prioriteti.includes(String(a.prioritet || ''))) return false;
      if (f.odgovoran) {
        const who = String(a.odgovoran || a.odgovoran_label || a.odgovoran_radnik_id || a.odgovoran_user_id || '').toLowerCase();
        if (!who.includes(String(f.odgovoran).toLowerCase())) return false;
      }
      if (f.dateFrom && (!a.planirani_zavrsetak || a.planirani_zavrsetak < f.dateFrom)) return false;
      if (f.dateTo && (!a.planirani_zavrsetak || a.planirani_zavrsetak > f.dateTo)) return false;
      if (f.onlyLate && !a.kasni) return false;
      if (f.onlyBlocked && String(a.efektivni_status || a.status || '') !== 'blokirano') return false;
      if (f.hideClosed && String(a.efektivni_status || a.status || '') === 'zavrseno') return false;
      if (f.quick === 'visok' && String(a.prioritet || '') !== 'visok') return false;
      if (f.quick === 'kasni7' && !(a.kasni && Number(a.rezerva_dani) < -7)) return false;
      if (f.quick === 'bez_odgovornog' && (a.odgovoran || a.odgovoran_label || a.odgovoran_radnik_id || a.odgovoran_user_id)) return false;
      return true;
    })
    .sort((a, b) => Number(a.rb || 0) - Number(b.rb || 0));
}

function defaultFilters() {
  return {
    search: '',
    odeljenja: [],
    statusi: [],
    prioriteti: [],
    odgovoran: '',
    dateFrom: '',
    dateTo: '',
    onlyLate: false,
    onlyBlocked: false,
    hideClosed: false,
    quick: '',
  };
}

function normalizeFilterValue(name, value) {
  if (['odeljenja', 'statusi', 'prioriteti'].includes(name)) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
  }
  if (['onlyLate', 'onlyBlocked', 'hideClosed'].includes(name)) return !!value;
  return value || '';
}

function hydrateFilters(rnId) {
  const defaults = defaultFilters();
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(`pracenje:${rnId}:filters`) || '{}') || {};
  } catch {
    stored = {};
  }
  const url = new URLSearchParams(window.location.search);
  pracenjeState.filters = {
    ...defaults,
    ...stored,
    odeljenja: splitParam(url.get('dept')) || stored.odeljenja || [],
    statusi: splitParam(url.get('status')) || stored.statusi || [],
    prioriteti: splitParam(url.get('prioritet')) || stored.prioriteti || [],
    onlyLate: url.get('kasni') === '1' || !!stored.onlyLate,
    onlyBlocked: url.get('blokirano') === '1' || !!stored.onlyBlocked,
    hideClosed: url.get('hideClosed') === '1' || !!stored.hideClosed,
    search: url.get('q') ?? stored.search ?? '',
    odgovoran: url.get('odgovoran') ?? stored.odgovoran ?? '',
    dateFrom: url.get('od') ?? stored.dateFrom ?? '',
    dateTo: url.get('do') ?? stored.dateTo ?? '',
    quick: url.get('quick') ?? stored.quick ?? '',
  };
}

function splitParam(value) {
  if (value == null) return null;
  return value.split(',').map(x => x.trim()).filter(Boolean);
}

function persistFilters() {
  if (!pracenjeState.rnId) return;
  localStorage.setItem(`pracenje:${pracenjeState.rnId}:filters`, JSON.stringify(pracenjeState.filters));
}

function syncFiltersToUrl() {
  if (!pracenjeState.rnId || typeof window === 'undefined') return;
  const f = pracenjeState.filters;
  const params = new URLSearchParams(window.location.search);
  params.set('rn', pracenjeState.rnId);
  setOrDelete(params, 'q', f.search);
  setOrDelete(params, 'dept', f.odeljenja.join(','));
  setOrDelete(params, 'status', f.statusi.join(','));
  setOrDelete(params, 'prioritet', f.prioriteti.join(','));
  setOrDelete(params, 'odgovoran', f.odgovoran);
  setOrDelete(params, 'od', f.dateFrom);
  setOrDelete(params, 'do', f.dateTo);
  setOrDelete(params, 'quick', f.quick);
  setOrDelete(params, 'kasni', f.onlyLate ? '1' : '');
  setOrDelete(params, 'blokirano', f.onlyBlocked ? '1' : '');
  setOrDelete(params, 'hideClosed', f.hideClosed ? '1' : '');
  history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash || ''}`);
}

function setOrDelete(params, key, value) {
  if (value) params.set(key, value);
  else params.delete(key);
}

function mergeActivityDetails(rpcActivities, rawActivities) {
  const rawById = new Map((rawActivities || []).map(a => [a.id, a]));
  return (rpcActivities || []).map(a => {
    const raw = rawById.get(a.id) || {};
    return {
      ...raw,
      ...a,
      odeljenje_id: raw.odeljenje_id || a.odeljenje_id || null,
      odeljenje: a.odeljenje || raw.odeljenje_naziv || raw.dashboard_odeljenje || '',
      efektivni_status: a.efektivni_status || raw.efektivni_status || raw.status || 'nije_krenulo',
      status_is_auto: Boolean(a.status_is_auto ?? raw.status_is_auto),
      status_detail: a.status_detail || raw.status_detail || '',
      blokirano_razlog: raw.blokirano_razlog || a.blokirano_razlog || '',
    };
  });
}

function applyOptimisticActivity(payload) {
  const id = payload.id || `temp-${Date.now()}`;
  const dept = pracenjeState.departments.find(d => d.id === payload.odeljenje_id);
  const next = {
    ...payload,
    id,
    odeljenje: dept?.naziv || payload.odeljenje || '',
    efektivni_status: payload.status || 'nije_krenulo',
    status_is_auto: payload.status_mode && payload.status_mode !== 'manual',
  };
  const list = pracenjeState.tab2Data.activities || [];
  const idx = list.findIndex(a => a.id === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...next };
  else list.push(next);
}

function patchActivity(id, patch) {
  const list = pracenjeState.tab2Data.activities || [];
  const idx = list.findIndex(a => a.id === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...patch };
}

function cloneState() {
  return JSON.parse(JSON.stringify({
    tab2Data: pracenjeState.tab2Data,
    dashboard: pracenjeState.dashboard,
    error: pracenjeState.error,
  }));
}

function restoreState(before, err) {
  pracenjeState.tab2Data = before.tab2Data;
  pracenjeState.dashboard = before.dashboard;
  pracenjeState.saving = false;
  pracenjeState.error = err?.message || String(err);
  emit();
}

function snapshot() {
  return {
    ...pracenjeState,
    filters: { ...pracenjeState.filters },
    live: { ...pracenjeState.live },
    departments: [...pracenjeState.departments],
    radnici: [...pracenjeState.radnici],
    aktivniNalozi: [...(pracenjeState.aktivniNalozi || [])],
    tab2Data: {
      ...pracenjeState.tab2Data,
      activities: [...(pracenjeState.tab2Data?.activities || [])],
    },
  };
}

function emit() {
  const s = snapshot();
  for (const fn of listeners) {
    try { fn(s); } catch (e) { console.error('[pracenje-state] listener error', e); }
  }
}
