/**
 * Lokalni UI state za modul Lokacije delova (aktivni tab).
 */

import { lsGetJSON, lsSetJSON } from '../lib/storage.js';
import { STORAGE_KEYS } from '../lib/constants.js';

/* Whitelist legitimnih tab ID-jeva — sprečava da korumpirana LS vrednost dovede
 * do praznog panela (renderPanel ima if-grane po tabId-u). */
const VALID_TABS = new Set(['dashboard', 'browse', 'items', 'history', 'sync']);
const DEFAULT_TAB = 'dashboard';

/* Veličine stranice za items paginator — striktan whitelist da se LS ne koristi kao XSS vektor. */
const VALID_PAGE_SIZES = new Set([25, 50, 100, 250]);
const DEFAULT_PAGE_SIZE = 50;

const state = {
  activeTab: DEFAULT_TAB,
  browseFilter: '',
  itemsFilter: '',
  itemsPage: 0,
  itemsPageSize: DEFAULT_PAGE_SIZE,
  historyFilters: {
    search: '',
    userId: '',
    locationId: '',
    movementType: '',
    dateFrom: '',
    dateTo: '',
  },
  historyPage: 0,
  historyPageSize: DEFAULT_PAGE_SIZE,
};

function normalizeTab(v) {
  return typeof v === 'string' && VALID_TABS.has(v) ? v : DEFAULT_TAB;
}

function normalizeFilter(v) {
  if (typeof v !== 'string') return '';
  /* Ograničavamo dužinu i strippujemo kontrol znakove. */
  return v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
}

function normalizePageSize(v) {
  const n = Number(v);
  return VALID_PAGE_SIZES.has(n) ? n : DEFAULT_PAGE_SIZE;
}

export function getLokacijeUiState() {
  return { ...state };
}

export function setLokacijeActiveTab(tabId) {
  state.activeTab = normalizeTab(tabId);
  lsSetJSON(STORAGE_KEYS.LOC_TAB, state.activeTab);
}

export function loadLokacijeTabFromStorage() {
  const v = lsGetJSON(STORAGE_KEYS.LOC_TAB, null);
  state.activeTab = normalizeTab(v);
}

export function setBrowseFilter(v) {
  state.browseFilter = normalizeFilter(v);
}

export function setItemsFilter(v) {
  state.itemsFilter = normalizeFilter(v);
  /* Pri promeni filtera reset paginacije je očekivano UX ponašanje. */
  state.itemsPage = 0;
}

export function setItemsPage(n) {
  const p = Math.max(0, Number(n) || 0);
  state.itemsPage = p;
}

export function setItemsPageSize(n) {
  state.itemsPageSize = normalizePageSize(n);
  state.itemsPage = 0;
}

const VALID_MOVEMENT_TYPES = new Set([
  '',
  'INITIAL_PLACEMENT',
  'TRANSFER',
  'RETURN',
  'INVENTORY_ADJUSTMENT',
  'REMOVAL',
]);

function normalizeUuid(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  /* Ako ne liči na UUID, ignorišemo. Sprečava da se korumpirana vrednost pošalje u REST. */
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s) ? s : '';
}

function normalizeIsoDate(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export function setHistoryFilters(patch) {
  const next = { ...state.historyFilters };
  if (patch && typeof patch === 'object') {
    if ('search' in patch) next.search = normalizeFilter(patch.search);
    if ('userId' in patch) next.userId = normalizeUuid(patch.userId);
    if ('locationId' in patch) next.locationId = normalizeUuid(patch.locationId);
    if ('movementType' in patch) {
      const t = typeof patch.movementType === 'string' ? patch.movementType : '';
      next.movementType = VALID_MOVEMENT_TYPES.has(t) ? t : '';
    }
    if ('dateFrom' in patch) next.dateFrom = normalizeIsoDate(patch.dateFrom);
    if ('dateTo' in patch) next.dateTo = normalizeIsoDate(patch.dateTo);
  }
  state.historyFilters = next;
  state.historyPage = 0;
}

export function resetHistoryFilters() {
  state.historyFilters = {
    search: '',
    userId: '',
    locationId: '',
    movementType: '',
    dateFrom: '',
    dateTo: '',
  };
  state.historyPage = 0;
}

export function setHistoryPage(n) {
  state.historyPage = Math.max(0, Number(n) || 0);
}

export function setHistoryPageSize(n) {
  state.historyPageSize = normalizePageSize(n);
  state.historyPage = 0;
}
