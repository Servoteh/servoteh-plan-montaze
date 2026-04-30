/**
 * Lokalni UI state za modul Lokacije delova (aktivni tab).
 */

import { lsGetJSON, lsSetJSON } from '../lib/storage.js';
import { STORAGE_KEYS } from '../lib/constants.js';

/* Whitelist legitimnih tab ID-jeva — sprečava da korumpirana LS vrednost dovede
 * do praznog panela (renderPanel ima if-grane po tabId-u). */
const VALID_TABS = new Set([
  'dashboard',
  'predmet',
  'browse',
  'items',
  'report',
  'labels',
  'definitions',
  'history',
  'sync',
]);
const DEFAULT_TAB = 'dashboard';

const VALID_BROWSE_KIND_FILTERS = new Set(['', 'hall', 'shelf', 'other']);
const VALID_BROWSE_SORTS = new Set(['code_asc', 'code_desc', 'name_asc', 'name_desc', 'kind_asc', 'kind_desc']);
const VALID_LOCATION_FILTERS = new Set(['all', 'with', 'without']);

/* Veličine stranice za items paginator — striktan whitelist da se LS ne koristi kao XSS vektor. */
const VALID_PAGE_SIZES = new Set([25, 50, 100, 250]);
const DEFAULT_PAGE_SIZE = 50;

const state = {
  activeTab: DEFAULT_TAB,
  browseFilter: '',
  browseKindFilter: '',
  browseSort: 'code_asc',
  itemsFilter: '',
  itemsPage: 0,
  itemsPageSize: DEFAULT_PAGE_SIZE,
  historyFilters: {
    search: '',
    userId: '',
    locationId: '',
    movementType: '',
    orderNo: '',
    dateFrom: '',
    dateTo: '',
  },
  historyPage: 0,
  historyPageSize: DEFAULT_PAGE_SIZE,
  reportFilters: {
    drawingNo: '',
    orderNo: '',
    tpNo: '',
    projectSearch: '',
    locationId: '',
    locationQ: '',
  },
  reportSort: 'updated_at',
  reportSortDesc: true,
  reportPage: 0,
  reportPageSize: DEFAULT_PAGE_SIZE,

  /* "Predmet" tab — izabrani predmet i filteri. Izabrani Predmet i njegovi
   * filteri se perzistiraju u localStorage da korisnik posle reload-a vidi
   * isti kontekst (tipično cele smene radi u istom Predmetu). */
  predmetSelected: null,    // null | { id, broj_predmeta, naziv_predmeta, customer_name }
  predmetFilters: {
    tpNo: '',                // ILIKE filter na drugi deo ident_broj-a (broj TP)
    drawingNo: '',           // ILIKE filter na broj_crteza
    locationFilter: 'all',   // 'all' | 'with' | 'without'
    includeAssembled: false, // false = sakrij UGRADJENO/OTPISANO
    onlyOpen: true,          // legacy: pregledi sada uvek koriste ručno aktivne RN-ove
  },
  predmetPage: 0,
  predmetPageSize: 100,
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

export function setBrowseKindFilter(v) {
  state.browseKindFilter = VALID_BROWSE_KIND_FILTERS.has(v) ? v : '';
}

function normalizeBrowseSort(v) {
  if (v === 'code') return 'code_asc';
  if (v === 'name') return 'name_asc';
  if (v === 'kind') return 'kind_asc';
  return VALID_BROWSE_SORTS.has(v) ? v : 'code_asc';
}

export function loadBrowseSortFromStorage() {
  const v = lsGetJSON(STORAGE_KEYS.LOC_SORT, 'code_asc');
  state.browseSort = normalizeBrowseSort(v);
}

export function setBrowseSort(v) {
  state.browseSort = normalizeBrowseSort(v);
  lsSetJSON(STORAGE_KEYS.LOC_SORT, state.browseSort);
}

export function toggleBrowseSortDirection() {
  const current = normalizeBrowseSort(state.browseSort);
  if (current === 'code_desc') state.browseSort = 'code_asc';
  else if (current === 'code_asc') state.browseSort = 'code_desc';
  else if (current === 'name_desc') state.browseSort = 'name_asc';
  else if (current === 'name_asc') state.browseSort = 'name_desc';
  else if (current === 'kind_desc') state.browseSort = 'kind_asc';
  else if (current === 'kind_asc') state.browseSort = 'kind_desc';
  else state.browseSort = 'code_asc';
  lsSetJSON(STORAGE_KEYS.LOC_SORT, state.browseSort);
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

/* Nalog je kratak TEXT — whitelist 0-9A-Za-z/_- plus do 40 karaktera.
 * Ako je korisnik nalepio "Nalog: 9000" → uzimamo samo ono što je validno.
 * DB CHECK je 40, pa sečemo. */
function normalizeOrderNo(v) {
  if (typeof v !== 'string') return '';
  return v.trim().replace(/[^\w\-/]/g, '').slice(0, 40);
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
    if ('orderNo' in patch) next.orderNo = normalizeOrderNo(patch.orderNo);
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
    orderNo: '',
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

const VALID_REPORT_SORT = new Set([
  'updated_at',
  'drawing_no',
  'order_no',
  'location_code',
  'qty_on_location',
  'customer_name',
  'project_code',
  'item_ref_id',
]);

function normalizeReportSort(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return VALID_REPORT_SORT.has(s) ? s : 'updated_at';
}

/**
 * @param {Partial<{ drawingNo: string, orderNo: string, tpNo: string, projectSearch: string, locationId: string, locationQ: string }>} patch
 */
export function setReportFilters(patch) {
  const next = { ...state.reportFilters };
  if (patch && typeof patch === 'object') {
    if ('drawingNo' in patch) next.drawingNo = normalizeFilter(patch.drawingNo);
    if ('orderNo' in patch) next.orderNo = normalizeOrderNo(patch.orderNo);
    if ('tpNo' in patch) next.tpNo = normalizeFilter(patch.tpNo).replace(/\D/g, '').slice(0, 12);
    if ('projectSearch' in patch) next.projectSearch = normalizeFilter(patch.projectSearch).slice(0, 80);
    if ('locationId' in patch) next.locationId = normalizeUuid(patch.locationId);
    if ('locationQ' in patch) next.locationQ = normalizeFilter(patch.locationQ).slice(0, 80);
  }
  state.reportFilters = next;
  state.reportPage = 0;
}

export function resetReportFilters() {
  state.reportFilters = {
    drawingNo: '',
    orderNo: '',
    tpNo: '',
    projectSearch: '',
    locationId: '',
    locationQ: '',
  };
  state.reportPage = 0;
}

export function setReportSort(sortKey, desc) {
  state.reportSort = normalizeReportSort(sortKey);
  if (typeof desc === 'boolean') state.reportSortDesc = desc;
  state.reportPage = 0;
}

export function toggleReportSort(sortKey) {
  const s = normalizeReportSort(sortKey);
  if (state.reportSort === s) {
    state.reportSortDesc = !state.reportSortDesc;
  } else {
    state.reportSort = s;
    state.reportSortDesc = true;
  }
  state.reportPage = 0;
}

export function setReportPage(n) {
  state.reportPage = Math.max(0, Number(n) || 0);
}

export function setReportPageSize(n) {
  state.reportPageSize = normalizePageSize(n);
  state.reportPage = 0;
}

/* ── Predmet tab ─────────────────────────────────────────────────────────── */

const VALID_PREDMET_PAGE_SIZES = new Set([50, 100, 200, 500]);
const DEFAULT_PREDMET_PAGE_SIZE = 100;

function normalizePredmetPageSize(v) {
  const n = Number(v);
  return VALID_PREDMET_PAGE_SIZES.has(n) ? n : DEFAULT_PREDMET_PAGE_SIZE;
}

function normalizePredmetSelected(v) {
  if (!v || typeof v !== 'object') return null;
  const id = Number(v.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    broj_predmeta: typeof v.broj_predmeta === 'string' ? v.broj_predmeta.slice(0, 40) : '',
    naziv_predmeta: typeof v.naziv_predmeta === 'string' ? v.naziv_predmeta.slice(0, 200) : '',
    customer_name: typeof v.customer_name === 'string' ? v.customer_name.slice(0, 120) : '',
  };
}

function normalizePredmetFilters(v) {
  const f = v && typeof v === 'object' ? v : {};
  const lf = typeof f.locationFilter === 'string' ? f.locationFilter.toLowerCase() : 'all';
  return {
    tpNo: normalizeFilter(f.tpNo).slice(0, 12),
    drawingNo: normalizeFilter(f.drawingNo).slice(0, 40),
    locationFilter: VALID_LOCATION_FILTERS.has(lf) ? lf : 'all',
    includeAssembled: !!f.includeAssembled,
    onlyOpen: true,
  };
}

function persistPredmetState() {
  /* Trenutno je dovoljan plitki snapshot — page se ne perzistira (resetuje
   * se na 0 pri svakoj promeni filtera/predmeta), ostalo da. */
  lsSetJSON(STORAGE_KEYS.LOC_PREDMET, {
    selected: state.predmetSelected,
    filters: state.predmetFilters,
    pageSize: state.predmetPageSize,
  });
}

export function loadPredmetStateFromStorage() {
  const raw = lsGetJSON(STORAGE_KEYS.LOC_PREDMET, null);
  if (!raw || typeof raw !== 'object') return;
  state.predmetSelected = normalizePredmetSelected(raw.selected);
  state.predmetFilters = normalizePredmetFilters(raw.filters);
  state.predmetPageSize = normalizePredmetPageSize(raw.pageSize);
  state.predmetPage = 0;
}

export function setPredmetSelected(item) {
  state.predmetSelected = normalizePredmetSelected(item);
  state.predmetPage = 0;
  persistPredmetState();
}

export function clearPredmetSelected() {
  state.predmetSelected = null;
  state.predmetPage = 0;
  persistPredmetState();
}

export function setPredmetFilters(patch) {
  state.predmetFilters = normalizePredmetFilters({
    ...state.predmetFilters,
    ...(patch || {}),
  });
  state.predmetPage = 0;
  persistPredmetState();
}

export function resetPredmetFilters() {
  state.predmetFilters = normalizePredmetFilters({});
  state.predmetPage = 0;
  persistPredmetState();
}

export function setPredmetPage(n) {
  state.predmetPage = Math.max(0, Number(n) || 0);
}

export function setPredmetPageSize(n) {
  state.predmetPageSize = normalizePredmetPageSize(n);
  state.predmetPage = 0;
  persistPredmetState();
}
