/**
 * Lokacije delova — shell modula (dashboard, lokacije, stavke, sync).
 * SQL: sql/migrations/add_loc_module.sql
 */

import { escHtml } from '../../lib/dom.js';
import { toggleTheme } from '../../lib/theme.js';
import {
  getLocationKind,
  getLocationKindLabel,
  getLocationTypeLabel,
} from '../../lib/lokacijeTypes.js';
import { logout, restoreSession } from '../../services/auth.js';
import { getAuth, canViewLokacijeSync, isAdmin, canEdit } from '../../state/auth.js';
import {
  loadLokacijeTabFromStorage,
  loadBrowseSortFromStorage,
  loadPredmetStateFromStorage,
  setLokacijeActiveTab,
  getLokacijeUiState,
  setBrowseFilter,
  setBrowseKindFilter,
  setBrowseSort,
  toggleBrowseSortDirection,
  setItemsFilter,
  setItemsPage,
  setItemsPageSize,
  setHistoryFilters,
  resetHistoryFilters,
  setHistoryPage,
  setHistoryPageSize,
  setReportFilters,
  resetReportFilters,
  setReportPage,
  setReportPageSize,
  toggleReportSort,
} from '../../state/lokacije.js';
import { filterLocationsHierarchical, sortLocations } from '../../lib/lokacijeFilters.js';
import { rowsToCsv, CSV_BOM } from '../../lib/csv.js';
import {
  fetchAllMovements,
  fetchAllPlacements,
  fetchLocations,
  fetchMovementsHistory,
  fetchPlacements,
  fetchRecentMovements,
  fetchSyncOutboundEvents,
  fetchLocReportPartsByLocations,
  fetchAllLocReportPartsByLocations,
  fetchBridgeSyncStatus,
  fetchLocationDefinitionsAudit,
} from '../../services/lokacije.js';
import { loadUsersFromDb } from '../../services/users.js';
import { hasSupabaseConfig } from '../../services/supabase.js';
import {
  openItemHistoryModal,
  openLocationModal,
  openNewLocationModal,
  openQuickMoveModal,
  toggleLocationActive,
} from './modals.js';
import { openScanMoveModal } from './scanModal.js';
import {
  openShelfLabelsPrintPicker,
  openTechProcessLabelPrintModal,
  printTechProcessLabelWindow,
  barcodeForPlacementRow,
} from './labelsPrint.js';
import { renderPredmetTab } from './predmetTab.js';
import { renderLabelsPrintPage, resetLabelsPrintPageState } from './labelsPrintPage.js';
import { openTechProcedureModal } from '../planProizvodnje/techProcedureModal.js';

/* Jeftina provera može li kamera — bez uvoza barcode modula (koji vuče ZXing).
 * Barcode.js ima istu logiku; držimo je singleton-level za bundle splitting. */
function canUseCamera() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

const TABS = [
  { id: 'dashboard', label: 'Početna' },
  { id: 'predmet', label: 'Pregled predmeta' },
  { id: 'browse', label: 'Lokacije' },
  { id: 'items', label: 'Stavke' },
  { id: 'report', label: 'Pregled po lokacijama' },
  { id: 'labels', label: '🏷 Štampa nalepnica' },
  { id: 'definitions', label: 'Istorija definicija', manageOnly: true },
  { id: 'history', label: 'Istorija premeštanja' },
  { id: 'sync', label: 'Sync', adminOnly: true },
];

const MOVEMENT_TYPE_LABELS = {
  INITIAL_PLACEMENT: 'Prvo zaduženje',
  TRANSFER: 'Premeštanje',
  RETURN: 'Povrat',
  INVENTORY_ADJUSTMENT: 'Inventar',
  REMOVAL: 'Uklonjeno',
};

/* Cache user-a (id → prikaz) — rekešira se pri svakom mount-u, ali ne per-render. */
let historyUsersCache = null;

let mountRef = null;
/** @type {HTMLElement|null} */
let locPanelHost = null;
/* UI state van state/lokacije.js jer je striktno vezan za trenutni mount. */
let showInactiveLocations = false;
/** @type {'table'|'tree'} */
let browseViewMode = 'table';
let lastSessionRefreshAt = 0;

function isJwtExpiringSoon(token) {
  if (!token || typeof token !== 'string') return false;
  const [, payload] = token.split('.');
  if (!payload) return false;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const json = JSON.parse(atob(padded));
    const expMs = Number(json.exp) * 1000;
    return Number.isFinite(expMs) && expMs - Date.now() < 60 * 1000;
  } catch {
    return false;
  }
}

async function ensureFreshLokacijeSession() {
  const token = getAuth().user?._token;
  const now = Date.now();
  if (!isJwtExpiringSoon(token) || now - lastSessionRefreshAt < 30 * 1000) return;
  lastSessionRefreshAt = now;
  await restoreSession();
}

/**
 * Banner upozorenje ako su BigTehn cache tabele zastarele.
 * Prag je 24h za work_orders/lines/tech_routing (sync na 15min) i 7 dana za
 * drawings (foto-sinhronizacija je rede). Ako je sve sveže — vraća prazan string.
 *
 * @param {Array<{ sync_job: string, last_finished: string }>} statusList
 */
function renderBridgeStaleBanner(statusList) {
  if (!Array.isArray(statusList) || !statusList.length) return '';
  const now = Date.now();
  const thresholds = {
    production_work_orders: 6 * 3600 * 1000,
    production_work_order_lines: 6 * 3600 * 1000,
    production_tech_routing: 6 * 3600 * 1000,
    catalog_items: 36 * 3600 * 1000,
    production_bigtehn_drawings: 7 * 24 * 3600 * 1000,
  };
  const labels = {
    production_work_orders: 'Radni nalozi',
    production_work_order_lines: 'Linije RN',
    production_tech_routing: 'Tehnološki postupci',
    catalog_items: 'Predmeti',
    production_bigtehn_drawings: 'Crteži (PDF)',
  };
  const stale = [];
  for (const it of statusList) {
    const limit = thresholds[it.sync_job];
    if (!limit) continue;
    const t = it.last_finished ? Date.parse(it.last_finished) : NaN;
    if (!Number.isFinite(t)) continue;
    const ageMs = now - t;
    if (ageMs > limit) {
      const days = Math.round(ageMs / (24 * 3600 * 1000));
      const hours = Math.round(ageMs / (3600 * 1000));
      const ageStr = days >= 1 ? `${days} dan${days === 1 ? '' : 'a'}` : `${hours} h`;
      stale.push(`<li><strong>${escHtml(labels[it.sync_job])}</strong> — poslednji sync pre ${escHtml(ageStr)}</li>`);
    }
  }
  if (!stale.length) return '';
  return `
    <div class="loc-warn" role="status" aria-live="polite" style="margin:8px 0">
      <div><strong>BRIDGE sync upozorenje</strong> — neki BigTehn cache nije svež. Pretrage RN/TP/predmeta i kolone u „Pregled” oslanjaju se na ove tabele.</div>
      <ul style="margin:6px 0 0 18px">${stale.join('')}</ul>
    </div>`;
}

function locToolbarHtml({ extra = '' } = {}) {
  const parts = [];
  if (canUseCamera()) {
    parts.push(
      `<button type="button" class="btn btn-primary" id="locBtnScanMove" title="Skeniraj barkod telefonom">📷 Skeniraj</button>`,
    );
  }
  parts.push(
    `<button type="button" class="btn" id="locBtnQuickMove">Brzo premeštanje</button>`,
  );
  /* "Predmet" je sad pun tab (vidi `TABS`), ne dugme. Pretraga po crtežu je
   * deo Predmet taba (filter „Broj crteža"). Globalna pretraga radnih naloga
   * (`openWorkOrderLookupModal`) ostaje u kodu kao dostupna utility funkcija
   * — može da zatreba kasnije, ali se više ne ekspanira u toolbar-u. */
  if (canEdit()) {
    parts.push(`<button type="button" class="btn" id="locBtnNewLoc">Nova lokacija</button>`);
    parts.push(
      `<button type="button" class="btn" id="locBtnLabels" title="Izaberi policu i štampaj nalepnicu (Code128 = šifra police)">🏷 Nalepnica police</button>`,
    );
    parts.push(
      `<button type="button" class="btn" id="locBtnTpLabel" title="Štampa nalepnice za tehnološki postupak (RNZ / kratki barkod)">🏷 Nalepnica TP</button>`,
    );
  }
  if (extra) parts.push(extra);
  return `<div class="loc-toolbar">${parts.join('')}</div>`;
}

function attachLocToolbar() {
  const host = locPanelHost;
  if (!host) return;
  host.querySelector('#locBtnScanMove')?.addEventListener('click', () => {
    openScanMoveModal({ onSuccess: refreshLocPanel });
  });
  host.querySelector('#locBtnQuickMove')?.addEventListener('click', () => {
    openQuickMoveModal({ onSuccess: refreshLocPanel });
  });
  host.querySelector('#locBtnNewLoc')?.addEventListener('click', () => {
    openNewLocationModal({ onSuccess: refreshLocPanel });
  });
  host.querySelector('#locBtnLabels')?.addEventListener('click', () => {
    openShelfLabelsPrintPicker();
  });
  host.querySelector('#locBtnTpLabel')?.addEventListener('click', () => {
    openTechProcessLabelPrintModal();
  });
  const showInactiveCb = host.querySelector('#locBrowseShowInactive');
  if (showInactiveCb) {
    showInactiveCb.addEventListener('change', () => {
      showInactiveLocations = !!showInactiveCb.checked;
      refreshLocPanel();
    });
  }
}

/**
 * Veže click handlere za Edit/Toggle dugmad u browse tabu.
 * @param {object[]|null} locs
 */
function attachBrowseActions(locs) {
  const host = locPanelHost;
  if (!host || !Array.isArray(locs)) return;
  const byId = new Map(locs.map(l => [String(l.id), l]));

  host.querySelectorAll('[data-loc-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = byId.get(btn.getAttribute('data-loc-edit') || '');
      if (!row) return;
      openLocationModal({ existing: row, onSuccess: refreshLocPanel });
    });
  });

  host.querySelectorAll('[data-loc-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = byId.get(btn.getAttribute('data-loc-toggle') || '');
      if (!row) return;
      toggleLocationActive(row, { onSuccess: refreshLocPanel });
    });
  });
}

/**
 * Render klasične tabele lokacija. Koristi `depth` za indentaciju.
 * @param {object[]|null} locs
 * @param {boolean} canEditLocs
 * @param {string} sortOptions
 */
function renderLocationsTableHtml(locs, canEditLocs, sortOptions = '', sortDirButton = '') {
  const colspan = canEditLocs ? 6 : 5;
  const rows = Array.isArray(locs)
    ? locs
        .map(r => {
          const d = Math.max(0, Math.min(Number(r.depth) || 0, 12));
          const pad = 10 + d * 14;
          const inactiveCls = r.is_active ? '' : ' loc-row-inactive';
          const businessType = getLocationKindLabel(r.location_type);
          const techType = getLocationTypeLabel(r.location_type);
          const actions = canEditLocs
            ? `<td class="loc-actions-cell">
                <button type="button" class="btn btn-xs" data-loc-edit="${escHtml(String(r.id))}">Izmeni</button>
                <button type="button" class="btn btn-xs" data-loc-toggle="${escHtml(String(r.id))}">${r.is_active ? 'Deaktiviraj' : 'Aktiviraj'}</button>
              </td>`
            : '';
          return `<tr class="${inactiveCls}"><td class="loc-code-cell" style="padding-left:${pad}px">${escHtml(r.location_code || '')}</td><td>${escHtml(r.name || '')}</td><td><span class="loc-kind-pill">${escHtml(businessType)}</span></td><td>${escHtml(techType)} <span class="loc-muted">(${escHtml(r.location_type || '')})</span></td><td class="loc-path">${escHtml(r.path_cached || '')}</td>${actions}</tr>`;
        })
        .join('')
      : '';
  const headActions = canEditLocs ? '<th>Akcije</th>' : '';
  const codeHead = sortOptions
    ? `<th><div class="loc-th-sort"><label><span>Šifra</span><select id="locBrowseSortHead" data-loc-browse-sort>${sortOptions}</select></label>${sortDirButton}</div></th>`
    : '<th>Šifra</th>';
  return `
    <div class="loc-table-wrap">
      <table class="loc-table">
        <thead><tr>${codeHead}<th>Naziv</th><th>Poslovno</th><th>Tehnički tip</th><th>Putanja</th>${headActions}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${colspan}" class="loc-muted">Nema lokacija. Unos master lokacija (admin/LeadPM/PM/menadžment) dolazi iz UI ili SQL.</td></tr>`}</tbody>
      </table>
    </div>`;
}

/**
 * Render hijerarhijskog stabla preko <details>/<summary>.
 * @param {object[]|null} locs flat lista (očekuje `parent_id`, `depth`)
 * @param {boolean} canEditLocs
 */
function renderLocationsTreeHtml(locs, canEditLocs) {
  if (!Array.isArray(locs) || locs.length === 0) {
    return `<p class="loc-muted" style="padding:16px 0">Nema lokacija za prikaz.</p>`;
  }
  const childrenByParent = new Map();
  for (const l of locs) {
    const k = l.parent_id || '__root__';
    if (!childrenByParent.has(k)) childrenByParent.set(k, []);
    childrenByParent.get(k).push(l);
  }

  const renderNode = node => {
    const kids = childrenByParent.get(node.id) || [];
    const code = escHtml(node.location_code || '');
    const name = escHtml(node.name || '');
    const type = escHtml(getLocationKindLabel(node.location_type));
    const techType = escHtml(node.location_type || '');
    const inactive = node.is_active ? '' : ' loc-tree-inactive';
    const actions = canEditLocs
      ? `<span class="loc-tree-actions">
          <button type="button" class="btn btn-xs" data-loc-edit="${escHtml(String(node.id))}">Izmeni</button>
          <button type="button" class="btn btn-xs" data-loc-toggle="${escHtml(String(node.id))}">${node.is_active ? 'Deaktiviraj' : 'Aktiviraj'}</button>
        </span>`
      : '';
    const head = `<span class="loc-tree-code">${code}</span>
      <span class="loc-tree-name">${name}</span>
      <span class="loc-tree-type">${type} · ${techType}</span>
      ${actions}`;

    if (kids.length === 0) {
      return `<li class="loc-tree-leaf${inactive}"><span class="loc-tree-bullet" aria-hidden="true">·</span>${head}</li>`;
    }
    /* open atribut za root nivo i 1. nivo, ostalo skupljeno. */
    const openAttr = (node.depth || 0) < 1 ? ' open' : '';
    return `<li class="loc-tree-node${inactive}">
      <details${openAttr}>
        <summary>${head}</summary>
        <ul class="loc-tree">${kids.map(renderNode).join('')}</ul>
      </details>
    </li>`;
  };

  const roots = childrenByParent.get('__root__') || [];
  return `<ul class="loc-tree loc-tree-root">${roots.map(renderNode).join('')}</ul>`;
}

function filterLocationsByKindHierarchical(locs, kind) {
  if (!Array.isArray(locs)) return [];
  if (!kind) return locs.slice();
  const byId = new Map(locs.map(l => [l.id, l]));
  const keep = new Set();
  for (const loc of locs) {
    if (getLocationKind(loc.location_type) !== kind) continue;
    let cur = loc;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
  }
  return locs.filter(l => keep.has(l.id));
}

function attachBrowseViewSwitch() {
  const host = locPanelHost;
  if (!host) return;
  host.querySelectorAll('[data-loc-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-loc-view');
      if (mode !== 'tree' && mode !== 'table') return;
      if (mode === browseViewMode) return;
      browseViewMode = mode;
      refreshLocPanel();
    });
  });
}

/**
 * Pretraga u browse tabu — debounced input + klijentski filter.
 * Debounce 180ms je dovoljan da se re-render ne pokreće na svakom pritisku tastera.
 */
function flipBrowseSortDirection() {
  toggleBrowseSortDirection();
  refreshLocPanel();
}

function attachBrowseSearch() {
  const host = locPanelHost;
  if (!host) return;
  const input = host.querySelector('#locBrowseSearch');
  const kindSel = host.querySelector('#locBrowseKind');
  const sortSelects = host.querySelectorAll('[data-loc-browse-sort]');
  const sortDirButtons = host.querySelectorAll('[data-loc-browse-sort-dir]');
  kindSel?.addEventListener('change', () => {
    setBrowseKindFilter(kindSel.value || '');
    refreshLocPanel();
  });
  sortSelects.forEach(sel => {
    sel.addEventListener('change', () => {
      const { browseSort } = getLokacijeUiState();
      const desc = String(browseSort || '').endsWith('_desc');
      setBrowseSort((sel.value || 'code') + (desc ? '_desc' : '_asc'));
      refreshLocPanel();
    });
  });
  sortDirButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      flipBrowseSortDirection();
    });
  });
  if (!input) return;
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      setBrowseFilter(input.value);
      refreshLocPanel();
    }, 180);
  });
  /* Zadrži fokus posle refresh-a. */
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * Server-side pretraga u items tabu — šalje ILIKE upit nad `item_ref_id`/`item_ref_table`
 * celokupne `loc_item_placements`. Debounce 300ms zbog network trip-a.
 */
function attachReportTabHandlers() {
  const host = locPanelHost;
  if (!host) return;

  host.querySelector('#locRepApply')?.addEventListener('click', () => {
    setReportFilters({
      drawingNo: host.querySelector('#locRepDraw')?.value || '',
      orderNo: host.querySelector('#locRepOrder')?.value || '',
      tpNo: host.querySelector('#locRepTp')?.value || '',
      projectSearch: host.querySelector('#locRepProj')?.value || '',
      locationId: host.querySelector('#locRepLoc')?.value || '',
      locationQ: host.querySelector('#locRepLocQ')?.value || '',
    });
    refreshLocPanel();
  });

  host.querySelector('#locRepReset')?.addEventListener('click', () => {
    resetReportFilters();
    refreshLocPanel();
  });

  host.querySelector('#locRepLoc')?.addEventListener('change', e => {
    setReportFilters({ locationId: e.target.value });
    refreshLocPanel();
  });

  host.querySelectorAll('[data-report-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      const col = btn.getAttribute('data-report-sort');
      if (!col) return;
      toggleReportSort(col);
      refreshLocPanel();
    });
  });

  host.querySelector('#locRepPrev')?.addEventListener('click', () => {
    const { reportPage } = getLokacijeUiState();
    if (reportPage > 0) {
      setReportPage(reportPage - 1);
      refreshLocPanel();
    }
  });
  host.querySelector('#locRepNext')?.addEventListener('click', () => {
    const { reportPage } = getLokacijeUiState();
    setReportPage(reportPage + 1);
    refreshLocPanel();
  });
  host.querySelector('#locRepPageSize')?.addEventListener('change', e => {
    setReportPageSize(Number(e.target.value));
    refreshLocPanel();
  });

  host.querySelectorAll('[data-rep-item-table]').forEach(tr => {
    tr.addEventListener('click', ev => {
      if (ev.target.closest('button')) return;
      const itemRefTable = tr.getAttribute('data-rep-item-table') || '';
      const itemRefId = tr.getAttribute('data-rep-item-id') || '';
      const orderNo = tr.getAttribute('data-rep-order') || '';
      openItemHistoryModal({ itemRefTable, itemRefId, orderNo });
    });
  });

  host.querySelectorAll('[data-rep-open-tp]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const id = Number(btn.getAttribute('data-wo-id'));
      if (Number.isFinite(id)) {
        void openTechProcedureModal({ work_order_id: id });
      }
    });
  });

  host.querySelectorAll('[data-rep-print-tp]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const tr = btn.closest('tr');
      if (!tr) return;
      const p = {
        item_ref_table: tr.getAttribute('data-rep-item-table') || '',
        item_ref_id: tr.getAttribute('data-rep-item-id') || '',
        order_no: tr.getAttribute('data-rep-order') || '',
        drawing_no: tr.getAttribute('data-rep-drawing') || '',
      };
      const bc = barcodeForPlacementRow(p);
      if (!bc) {
        alert('Za ovaj red nema prepoznatljivog barkoda (RNZ / kratki format).');
        return;
      }
      const ident = p.order_no && p.item_ref_id
        ? `${p.order_no}/${p.item_ref_id}`
        : p.order_no || '';
      const today = new Date();
      const pad = n => String(n).padStart(2, '0');
      const datum = `${pad(today.getDate())}-${pad(today.getMonth() + 1)}-${String(today.getFullYear()).slice(-2)}`;
      const qty = tr.getAttribute('data-rep-qty') || '';
      const komRn = tr.getAttribute('data-rep-komrn') || '';
      const kolicinaStr = qty && komRn ? `${qty}/${komRn}` : qty || komRn || '';
      void printTechProcessLabelWindow({
        fields: {
          brojPredmeta: ident,
          komitent: tr.getAttribute('data-rep-customer') || '',
          nazivPredmeta: tr.getAttribute('data-rep-pname') || '',
          nazivDela: tr.getAttribute('data-rep-naziv') || '',
          brojCrteza: p.drawing_no,
          kolicina: kolicinaStr,
          materijal: tr.getAttribute('data-rep-materijal') || '',
          datum,
        },
        barcodeValue: bc,
      });
    });
  });

  const btnEx = host.querySelector('#locRepExport');
  if (btnEx) {
    btnEx.addEventListener('click', async () => {
      const orig = btnEx.textContent || 'Export CSV';
      btnEx.disabled = true;
      btnEx.textContent = 'Export… 0';
      try {
        const ui = getLokacijeUiState();
        const rf = ui.reportFilters;
        const { rows, total, truncated } = await fetchAllLocReportPartsByLocations(
          {
            drawingNo: rf.drawingNo,
            orderNo: rf.orderNo,
            tpNo: rf.tpNo,
            projectSearch: rf.projectSearch,
            locationId: rf.locationId || undefined,
            locationQ: rf.locationQ,
            sort: ui.reportSort,
            desc: ui.reportSortDesc,
          },
          {
            pageSize: 500,
            onProgress: ({ loaded, total: tot }) => {
              btnEx.textContent = tot != null ? `Export… ${loaded}/${tot}` : `Export… ${loaded}`;
            },
          },
        );
        if (!rows.length) {
          alert('Nema redova za export.');
          return;
        }
        const headers = [
          'Predmet kod',
          'Predmet naziv',
          'Kupac',
          'RN',
          'Crtež',
          'Naziv dela',
          'Materijal',
          'Dimenzija materijala',
          'Komada (RN)',
          'Težina obr (kg)',
          'Revizija',
          'Status RN',
          'Rok izrade',
          'TP ref',
          'Tabela',
          'Lokacija šifra',
          'Lokacija naziv',
          'Putanja',
          'Opis police',
          'Kol lok',
          'Ukupno bucket',
          'Status placement',
          'Poslednje',
        ];
        const data = rows.map(r => [
          r.project_code || '',
          r.project_name || '',
          r.customer_name || '',
          r.order_no || '',
          r.drawing_no || r.wo_broj_crteza || '',
          r.naziv_dela || '',
          r.materijal || '',
          r.dimenzija_materijala || '',
          r.komada_rn ?? '',
          r.tezina_obr ?? '',
          r.revizija || '',
          r.status_rn === true ? 'Zatvoren' : r.status_rn === false ? 'Otvoren' : '',
          r.rok_izrade ? String(r.rok_izrade).slice(0, 10) : '',
          r.item_ref_id || '',
          r.item_ref_table || '',
          r.location_code || '',
          r.location_name || '',
          r.location_path || '',
          r.shelf_note || '',
          r.qty_on_location ?? '',
          r.qty_total_for_bucket ?? '',
          r.placement_status || '',
          (r.last_moved_at || r.updated_at || '').replace('T', ' ').slice(0, 19),
        ]);
        const csv = CSV_BOM + rowsToCsv(headers, data);
        downloadCsv(csv, buildReportExportFilename());
        if (truncated) {
          alert(
            `Export prekinut na 50 000 redova. Ukupno u upitu: ${total ?? '?'}. Suzi filtere.`,
          );
        }
      } catch (err) {
        console.error('[lokacije/report] CSV export failed', err);
        alert(`Export neuspešan: ${err?.message || err}`);
      } finally {
        btnEx.disabled = false;
        btnEx.textContent = orig;
      }
    });
  }
}

function buildReportExportFilename() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `lokacije_pregled_po_lokacijama_${ts}.csv`;
}

function attachItemsSearch() {
  const host = locPanelHost;
  if (!host) return;
  const input = host.querySelector('#locItemsSearch');
  if (!input) return;
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      setItemsFilter(input.value);
      refreshLocPanel();
    }, 300);
  });
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * HTML za paginator (items / report tab).
 * @param {{ page: number, pageSize: number, total: number|null, loadedCount: number, idPrefix?: string, ariaLabel?: string }} p
 */
function renderLocPagerHtml({
  page,
  pageSize,
  total,
  loadedCount,
  idPrefix = 'locItems',
  ariaLabel = 'Paginacija',
}) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + loadedCount;
  const totalLabel = total == null ? '?' : String(total);
  const isLast = total != null ? to >= total : loadedCount < pageSize;
  const rangeLabel = total === 0 ? '0–0' : `${from}–${to}`;

  const sizeOpts = [25, 50, 100, 250]
    .map(n => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`)
    .join('');

  return `
    <div class="loc-pager" role="navigation" aria-label="${escHtml(ariaLabel)}">
      <div class="loc-pager-info">
        <span>${rangeLabel} od ${escHtml(totalLabel)}</span>
      </div>
      <div class="loc-pager-controls">
        <label class="loc-pager-size">
          <span>Po stranici:</span>
          <select id="${escHtml(idPrefix)}PageSize">${sizeOpts}</select>
        </label>
        <button type="button" class="btn btn-xs" id="${escHtml(idPrefix)}Prev" ${page === 0 ? 'disabled' : ''}>← Prethodna</button>
        <button type="button" class="btn btn-xs" id="${escHtml(idPrefix)}Next" ${isLast ? 'disabled' : ''}>Sledeća →</button>
      </div>
    </div>`;
}

/** @param {Parameters<typeof renderLocPagerHtml>[0]} p */
function renderItemsPager(p) {
  return renderLocPagerHtml({ ...p, idPrefix: 'locItems', ariaLabel: 'Paginacija stavki' });
}

function attachItemsPager() {
  const host = locPanelHost;
  if (!host) return;
  host.querySelector('#locItemsPrev')?.addEventListener('click', () => {
    const { itemsPage } = getLokacijeUiState();
    if (itemsPage > 0) {
      setItemsPage(itemsPage - 1);
      refreshLocPanel();
    }
  });
  host.querySelector('#locItemsNext')?.addEventListener('click', () => {
    const { itemsPage } = getLokacijeUiState();
    setItemsPage(itemsPage + 1);
    refreshLocPanel();
  });
  const sizeSel = host.querySelector('#locItemsPageSize');
  if (sizeSel) {
    sizeSel.addEventListener('change', () => {
      setItemsPageSize(Number(sizeSel.value));
      refreshLocPanel();
    });
  }
}

/**
 * Export celog trenutno filtriranog skupa placements u CSV (stream-ovan u batch-ovima).
 * Šalje `Content-Range` count=exact u prvom batch-u da bi progress prikaz imao tačan total.
 */
function attachItemsExport() {
  const host = locPanelHost;
  if (!host) return;
  const btn = host.querySelector('#locItemsExport');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const origLabel = btn.textContent || 'Export CSV';
    btn.disabled = true;
    btn.textContent = 'Export… 0';
    try {
      const ui = getLokacijeUiState();
      /* Lokacije trebaju samo radi resolve code/name/path — nezavisno od filtera. */
      const [{ rows: placements, total, truncated }, locs] = await Promise.all([
        fetchAllPlacements({
          search: ui.itemsFilter,
          pageSize: 500,
          onProgress: ({ loaded, total }) => {
            btn.textContent = total != null
              ? `Export… ${loaded}/${total}`
              : `Export… ${loaded}`;
          },
        }),
        fetchLocations({ activeOnly: false }),
      ]);

      if (!Array.isArray(placements) || placements.length === 0) {
        alert('Nema stavki koje odgovaraju trenutnoj pretrazi.');
        return;
      }

      const locIdx = locationIndex(locs);
      const headers = [
        'Tabela',
        'Crtež',
        'Nalog',
        'Kod lokacije',
        'Naziv lokacije',
        'Putanja',
        'Količina',
        'Status',
        'Napomena',
        'Premeštena u',
        'Poslednja izmena',
      ];
      const dataRows = placements.map(p => {
        const loc = locIdx.get(p.location_id) || {};
        return [
          p.item_ref_table || '',
          p.item_ref_id || '',
          p.order_no || '',
          loc.location_code || '',
          loc.name || '',
          loc.path_cached || '',
          p.quantity == null ? '' : p.quantity,
          p.placement_status || '',
          p.notes || '',
          p.placed_at || '',
          p.updated_at || '',
        ];
      });

      const csv = CSV_BOM + rowsToCsv(headers, dataRows);
      downloadCsv(csv, buildExportFilename(ui.itemsFilter));

      if (truncated) {
        alert(
          `Export prekinut na 50 000 zapisa radi sigurnosti. Ukupno u bazi: ${total ?? '?'}. ` +
            `Suzi pretragu za kompletniji izvoz.`,
        );
      }
    } catch (err) {
      console.error('[lokacije] CSV export failed', err);
      alert(`Export neuspešan: ${err?.message || err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  });
}

/**
 * @param {string} search
 * @returns {string} — sanitizovano ime fajla sa timestampom
 */
function buildExportFilename(search) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const q = (search || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 32);
  const suffix = q ? `_${q}` : '';
  return `lokacije_stavke_${ts}${suffix}.csv`;
}

/**
 * @param {string} text — CSV sadržaj (uključujući BOM)
 * @param {string} filename
 */
function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/** Klik po redu u `items` tabu → istorija premeštanja tog (crtež, nalog) bucketa. */
function attachItemsActions() {
  const host = locPanelHost;
  if (!host) return;
  host.querySelectorAll('[data-loc-item-table]').forEach(tr => {
    tr.addEventListener('click', () => {
      const itemRefTable = tr.getAttribute('data-loc-item-table') || '';
      const itemRefId = tr.getAttribute('data-loc-item-id') || '';
      /* data-loc-item-order sadrži `''` za "bez naloga" — razlikujemo od
       * "svi nalozi" (undefined). Ovde uvek prosleđujemo string. */
      const orderNo = tr.getAttribute('data-loc-item-order') || '';
      openItemHistoryModal({ itemRefTable, itemRefId, orderNo });
    });
  });
}

async function refreshLocPanel() {
  if (!locPanelHost) return;
  await renderPanel(locPanelHost, getLokacijeUiState().activeTab);
}

/** @param {object[]|null|undefined} locs */
function locationIndex(locs) {
  const m = new Map();
  if (!Array.isArray(locs)) return m;
  for (const l of locs) {
    if (l?.id) m.set(l.id, l);
  }
  return m;
}

/** @param {string|null|undefined} id @param {Map<string, object>} idx */
function formatLocBrief(id, idx) {
  if (!id) return '—';
  const l = idx.get(id);
  if (!l) return `${escHtml(String(id).slice(0, 8))}…`;
  const code = escHtml(l.location_code || '');
  return l.name ? `${code} · ${escHtml(l.name)}` : code;
}

function fmtAuditWhen(iso) {
  return (iso || '').replace('T', ' ').slice(0, 16);
}

function auditLocLabel(row, locIdx) {
  const data = row?.new_data || row?.old_data || {};
  const id = row?.record_id || data.id;
  const loc = id ? locIdx.get(id) : null;
  const code = loc?.location_code || data.location_code || String(id || '').slice(0, 8);
  const name = loc?.name || data.name || '';
  const kind = getLocationKindLabel(loc?.location_type || data.location_type || '');
  return `${code}${name ? ' · ' + name : ''} (${kind})`;
}

function auditFieldValue(data, key) {
  if (!data || !(key in data)) return '—';
  const v = data[key];
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function auditDiffSummary(row) {
  const action = row?.action || '';
  if (action === 'INSERT') return 'Kreirano';
  if (action === 'DELETE') return 'Obrisano';
  const keys = Array.isArray(row?.diff_keys) ? row.diff_keys.filter(k => k !== 'updated_at') : [];
  if (!keys.length) return 'Bez vidljivih promena';
  return keys.map(k => {
    const before = auditFieldValue(row.old_data, k);
    const after = auditFieldValue(row.new_data, k);
    return `${k}: ${before} -> ${after}`;
  }).join('; ');
}

function definitionAuditRowsHtml(rows, locIdx) {
  if (!Array.isArray(rows)) {
    return '<tr><td colspan="6" class="loc-muted">Istorija definicija nije dostupna.</td></tr>';
  }
  if (!rows.length) {
    return '<tr><td colspan="6" class="loc-muted">Još nema zabeleženih izmena definicija hala/polica.</td></tr>';
  }
  return rows.map(row => {
    const who = row.actor_email || (row.actor_uid ? String(row.actor_uid).slice(0, 8) + '…' : '—');
    const changed = Array.isArray(row.diff_keys) && row.diff_keys.length
      ? row.diff_keys.filter(k => k !== 'updated_at').join(', ')
      : row.action === 'INSERT'
        ? 'sva polja'
        : '—';
    return `<tr>
      <td class="loc-mov-when">${escHtml(fmtAuditWhen(row.changed_at))}</td>
      <td>${escHtml(who)}</td>
      <td><span class="loc-mov-type">${escHtml(row.action || '')}</span></td>
      <td>${escHtml(auditLocLabel(row, locIdx))}</td>
      <td class="loc-path">${escHtml(changed)}</td>
      <td class="loc-path">${escHtml(auditDiffSummary(row).slice(0, 300))}</td>
    </tr>`;
  }).join('');
}

function headerHtml() {
  const auth = getAuth();
  return `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button type="button" class="btn-hub-back" id="locBackBtn" title="Nazad na listu modula" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">📍</span>
          <span>Lokacije delova</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button type="button" class="theme-toggle" id="locThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <span class="role-indicator ${isAdmin() ? 'role-pm' : 'role-viewer'}" id="locRoleLabel">${escHtml((auth.role || 'viewer').toUpperCase())}</span>
        <button type="button" class="hub-logout" id="locLogoutBtn">Odjavi se</button>
      </div>
    </header>`;
}

function tabsHtml(activeId) {
  const visible = TABS.filter(t => {
    if (t.adminOnly && !canViewLokacijeSync()) return false;
    if (t.manageOnly && !canEdit()) return false;
    return true;
  });
  return `
    <nav class="kadrovska-tabs loc-tabs" role="tablist" aria-label="Lokacije — sekcije">
      ${visible
        .map(
          t => `
        <button type="button" role="tab" class="kadrovska-tab loc-tab${t.id === activeId ? ' active' : ''}"
          data-loc-tab="${escHtml(t.id)}" aria-selected="${t.id === activeId ? 'true' : 'false'}">
          ${escHtml(t.label)}
        </button>`,
        )
        .join('')}
    </nav>`;
}

async function renderPanel(host, tabId) {
  if (!hasSupabaseConfig()) {
    host.innerHTML = `<div class="kadr-panel active loc-panel"><p class="loc-muted">Supabase nije konfigurisan (VITE_SUPABASE_URL / ANON KEY).</p></div>`;
    return;
  }
  await ensureFreshLokacijeSession();

  if (tabId === 'dashboard') {
    const [locs, plac, movs, syncStatus] = await Promise.all([
      fetchLocations(),
      fetchPlacements({ limit: 500 }),
      fetchRecentMovements(20),
      fetchBridgeSyncStatus().catch(() => []),
    ]);
    const locN = Array.isArray(locs) ? locs.length : '—';
    const plN = Array.isArray(plac) ? plac.length : '—';
    const locIdx = locationIndex(locs);
    const recent = Array.isArray(movs)
      ? movs
          .slice(0, 12)
          .map(
            m =>
              `<li><span class="loc-mov-type">${escHtml(m.movement_type || '')}</span> · ${escHtml(m.item_ref_id || '')} → <span class="loc-path">${formatLocBrief(m.to_location_id, locIdx)}</span> · ${escHtml((m.moved_at || '').replace('T', ' ').slice(0, 16))}</li>`,
          )
          .join('')
      : '';

    const err =
      locs === null && plac === null
        ? `<p class="loc-warn">Ne mogu da učitam podatke. Proveri da li je u Supabase-u primenjena migracija <code>add_loc_module.sql</code> i da li si ulogovan.</p>`
        : '';

    /* First-run state — baza je prazna. Nema smisla prikazati "0 lokacija, 0 stavki"
     * bez ikakvog konteksta; dajemo jasan CTA da korisnik zna šta da klikne. */
    const isEmptyFirstRun =
      Array.isArray(locs) && locs.length === 0 && Array.isArray(plac) && plac.length === 0;
    const firstRunHtml = isEmptyFirstRun && canEdit()
      ? `<div class="loc-firstrun" role="note">
           <div class="loc-firstrun-title">Dobrodošao u Lokacije delova</div>
           <p class="loc-firstrun-sub">Baza je trenutno prazna. Da bi modul zaživeo:</p>
           <ol class="loc-firstrun-steps">
             <li>Klikni <strong>Nova lokacija</strong> i dodaj bar jednu master lokaciju (npr. <code>MAG-1</code> — Centralni magacin).</li>
             <li>Otvori karticu <strong>Lokacije</strong> da pregledaš/doteraš hijerarhiju.</li>
             <li>Klikni <strong>Brzo premeštanje</strong> da evidentiraš prvu stavku (INITIAL_PLACEMENT).</li>
           </ol>
         </div>`
      : isEmptyFirstRun
        ? `<p class="loc-muted" style="padding:12px 0">Nema još master lokacija. Korisnici sa ulogom za uređivanje mogu da ih dodaju (admin, LeadPM, PM, menadžment).</p>`
        : '';

    const bridgeBanner = renderBridgeStaleBanner(syncStatus);

    host.innerHTML = `
      <div class="kadr-panel active loc-panel">
        ${err}
        ${locToolbarHtml()}
        ${bridgeBanner}
        ${firstRunHtml}
        <div class="loc-kpi-row">
          <div class="loc-kpi"><span class="loc-kpi-label">Aktivnih lokacija</span><span class="loc-kpi-val">${escHtml(String(locN))}</span></div>
          <div class="loc-kpi"><span class="loc-kpi-label">Placements (stavki)</span><span class="loc-kpi-val">${escHtml(String(plN))}</span></div>
        </div>
        <h3 class="loc-subh">Poslednja premeštanja</h3>
        <ul class="loc-mov-list">${recent || '<li class="loc-muted">Nema podataka.</li>'}</ul>
      </div>`;
    attachLocToolbar();
    return;
  }

  if (tabId === 'predmet') {
    /* Predmet tab je samodovoljan modul — sopstveni renderer u
     * `predmetTab.js` kontroliše ceo host. Ne zovemo locToolbarHtml ovde
     * jer Predmet tab ima sopstvene akcije (Promeni predmet / Print / PDF / CSV);
     * korisnik svejedno može da koristi ostale tabove kroz tab navigaciju iznad. */
    await renderPredmetTab(host, { onRefresh: refreshLocPanel });
    return;
  }

  if (tabId === 'labels') {
    /* „Štampa nalepnica" — multi-select predmeti + TP queue + batch print.
     * Reuse-uje BigTehn search RPC-ove i `printTechProcessLabelsBatch`.
     * Ne zovemo locToolbarHtml jer ovaj tab ima sopstveni „Štampaj N
     * nalepnica" CTA + svoj layout (vidi `labelsPrintPage.js`). */
    await renderLabelsPrintPage(host, { onRefresh: refreshLocPanel });
    return;
  }

  if (tabId === 'browse') {
    const locs = await fetchLocations({ activeOnly: !showInactiveLocations });
    const canEditLocs = canEdit();
    const err = locs === null ? `<p class="loc-warn">Učitavanje neuspešno.</p>` : '';
    const { browseFilter, browseKindFilter, browseSort } = getLokacijeUiState();
    const textFiltered = filterLocationsHierarchical(locs, browseFilter);
    const filtered = filterLocationsByKindHierarchical(textFiltered, browseKindFilter);
    const sorted = sortLocations(filtered, browseSort);
    const matchCount = browseFilter
      ? `<span class="loc-muted loc-filter-hint">Pogodaka: ${Array.isArray(locs) ? filtered.length : 0} / ${Array.isArray(locs) ? locs.length : 0}</span>`
      : '';
    const kindOptions = [
      ['', 'Sve lokacije'],
      ['hall', 'Samo HALE'],
      ['shelf', 'Samo POLICE'],
      ['other', 'Ostalo'],
    ]
      .map(([v, label]) => `<option value="${escHtml(v)}"${browseKindFilter === v ? ' selected' : ''}>${escHtml(label)}</option>`)
      .join('');
    const sortField = String(browseSort || 'code_asc').replace(/_(asc|desc)$/, '');
    const sortDesc = String(browseSort || '').endsWith('_desc');
    const sortOptions = [
      ['code', 'Šifra'],
      ['name', 'Naziv'],
      ['kind', 'Tip'],
    ]
      .map(([v, label]) => `<option value="${escHtml(v)}"${sortField === v ? ' selected' : ''}>${escHtml(label)}</option>`)
      .join('');
    const sortDirLabel = sortDesc ? '↓' : '↑';
    const sortDirTitle = sortDesc ? 'Sort Z→A / 100→0' : 'Sort A→Z / 0→100';
    const sortDirButton = `<button type="button" class="btn btn-xs loc-sort-dir" data-loc-browse-sort-dir title="${escHtml(sortDirTitle)}" aria-label="${escHtml(sortDirTitle)}">${sortDirLabel}</button>`;

    const extraToolbar = `
      <div class="loc-master-heading">
        <strong>Šifarnik hala i polica</strong>
        <span>HALA je veći prostor; POLICA je konkretno mesto unutar hale. Sve izmene se čuvaju kroz istoriju definicija.</span>
      </div>
      <div class="loc-view-switch" role="group" aria-label="Prikaz">
        <button type="button" class="btn btn-xs${browseViewMode === 'table' ? ' is-active' : ''}" data-loc-view="table">Tabela</button>
        <button type="button" class="btn btn-xs${browseViewMode === 'tree' ? ' is-active' : ''}" data-loc-view="tree">Stablo</button>
      </div>
      <label class="loc-inline-check">
        <span>Tip:</span>
        <select id="locBrowseKind">${kindOptions}</select>
      </label>
      <label class="loc-inline-check loc-sort-control">
        <span>Sort:</span>
        <select id="locBrowseSort" data-loc-browse-sort>${sortOptions}</select>
      </label>
      ${sortDirButton}
      <label class="loc-inline-check">
        <input type="checkbox" id="locBrowseShowInactive" ${showInactiveLocations ? 'checked' : ''}>
        <span>Prikaži neaktivne</span>
      </label>
      <div class="loc-search">
        <input type="search" id="locBrowseSearch" class="loc-search-input" placeholder="Pretraga po šifri, nazivu ili putanji…" value="${escHtml(browseFilter)}" autocomplete="off" />
        ${matchCount}
      </div>`;

    const content =
      browseViewMode === 'tree'
        ? renderLocationsTreeHtml(sorted, canEditLocs)
        : renderLocationsTableHtml(sorted, canEditLocs, sortOptions, sortDirButton);

    host.innerHTML = `
      <div class="kadr-panel active loc-panel">
        ${err}
        ${locToolbarHtml({ extra: extraToolbar })}
        ${content}
      </div>`;
    attachLocToolbar();
    attachBrowseActions(sorted);
    attachBrowseViewSwitch();
    attachBrowseSearch();
    return;
  }

  if (tabId === 'items') {
    const ui = getLokacijeUiState();
    const pageSize = ui.itemsPageSize;
    const page = ui.itemsPage;
    const offset = page * pageSize;
    const search = ui.itemsFilter;

    const [placRes, locs] = await Promise.all([
      fetchPlacements({ limit: pageSize, offset, wantCount: true, search }),
      fetchLocations(),
    ]);
    /* placRes = { rows, total } zbog wantCount=true */
    const plac = placRes?.rows ?? null;
    const total = typeof placRes?.total === 'number' ? placRes.total : null;
    const locIdx = locationIndex(locs);

    const rows = Array.isArray(plac)
      ? plac
          .map(r => {
            const loc = locIdx.get(r.location_id);
            const locCell = loc
              ? `<span class="loc-code-strong">${escHtml(loc.location_code || '')}</span><span class="loc-muted"> · ${escHtml(loc.name || '')}</span>`
              : `<span class="loc-path">${escHtml(String(r.location_id || '').slice(0, 8))}…</span>`;
            const tbl = escHtml(r.item_ref_table || '');
            const iid = escHtml(r.item_ref_id || '');
            const ord = escHtml(r.order_no || '');
            const orderCell = r.order_no
              ? `<strong>${ord}</strong>`
              : '<span class="loc-muted">—</span>';
            const qty = r.quantity == null ? '' : escHtml(String(r.quantity));
            return `<tr class="loc-row-click" data-loc-item-table="${tbl}" data-loc-item-id="${iid}" data-loc-item-order="${ord}" title="Klik za istoriju premeštanja"><td>${tbl}</td><td>${iid}</td><td>${orderCell}</td><td>${locCell}</td><td class="loc-qty-cell">${qty}</td><td>${escHtml(r.placement_status || '')}</td></tr>`;
          })
          .join('')
      : '';
    const err = plac === null ? `<p class="loc-warn">Učitavanje neuspešno.</p>` : '';
    const pagerHtml = renderItemsPager({
      page,
      pageSize,
      total,
      loadedCount: Array.isArray(plac) ? plac.length : 0,
    });
    const searchHint = search
      ? `<span class="loc-muted loc-filter-hint">Pretraga: celokupna baza (ILIKE <code>${escHtml(search)}</code>).</span>`
      : `<span class="loc-muted loc-filter-hint">Pretraga ide na server, sortirana po poslednjoj izmeni.</span>`;
    const searchHtml = `
      <div class="loc-search loc-items-search">
        <input type="search" id="locItemsSearch" class="loc-search-input" placeholder="Pretraga: crtež · ID stavke · nalog · tabela (ceo skup)…" value="${escHtml(search)}" autocomplete="off" />
        <button type="button" class="btn btn-xs" id="locItemsExport" title="Preuzmi CSV koji odgovara trenutnoj pretrazi">Export CSV</button>
        ${searchHint}
      </div>`;

    host.innerHTML = `
      <div class="kadr-panel active loc-panel">
        ${err}
        ${locToolbarHtml({ extra: searchHtml })}
        <p class="loc-muted">Klik na red otvara istoriju premeštanja te stavke.</p>
        <div class="loc-table-wrap">
          <table class="loc-table">
            <thead><tr><th>Tabela</th><th>Crtež</th><th>Nalog</th><th>Lokacija</th><th class="loc-qty-cell">Količina</th><th>Status</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6" class="loc-muted" style="padding:18px 12px">
              <div><strong>Nema evidentiranih stavki na lokacijama.</strong></div>
              <div style="margin-top:6px">Tabela <code>loc_item_placements</code> je prazna ili filter nema pogodaka. Da bi se ovde pojavili podaci:</div>
              <ul style="margin:6px 0 0 22px">
                <li>Otvori tab <strong>Pregled predmeta</strong> da pregledaš sve TP-ove jednog predmeta i vidiš da li već imaju lokaciju.</li>
                <li>Klikni <strong>Brzo premeštanje</strong> da evidentiraš prvu lokaciju (zaduženje) za neku stavku.</li>
                <li>Skenirani RNZ barkod automatski pravi <em>placement</em>.</li>
              </ul>
            </td></tr>`}</tbody>
          </table>
        </div>
        ${pagerHtml}
      </div>`;
    attachLocToolbar();
    attachItemsActions();
    attachItemsSearch();
    attachItemsPager();
    attachItemsExport();
    return;
  }

  if (tabId === 'report') {
    const ui = getLokacijeUiState();
    const { reportFilters: rf, reportSort, reportSortDesc, reportPage, reportPageSize } = ui;
    const offset = reportPage * reportPageSize;

    const [repRes, locs] = await Promise.all([
      fetchLocReportPartsByLocations({
        drawingNo: rf.drawingNo,
        orderNo: rf.orderNo,
        tpNo: rf.tpNo,
        projectSearch: rf.projectSearch,
        locationId: rf.locationId || undefined,
        locationQ: rf.locationQ,
        sort: reportSort,
        desc: reportSortDesc,
        limit: reportPageSize,
        offset,
      }),
      fetchLocations({ activeOnly: false }),
    ]);

    const locIdx = locationIndex(locs);
    const total = repRes?.total ?? null;
    const rows = repRes?.rows ?? null;
    const err =
      repRes === null
        ? `<p class="loc-warn">Ne mogu da učitam pregled. Proveri da li je primenjena migracija <code>add_loc_report_by_locations_rpc.sql</code> i RLS prava.</p>`
        : '';

    const locOptions = (Array.isArray(locs) ? locs : [])
      .sort((a, b) => (a.location_code || '').localeCompare(b.location_code || ''))
      .map(
        l =>
          `<option value="${escHtml(l.id)}"${l.id === rf.locationId ? ' selected' : ''}>${escHtml(l.location_code || '')} — ${escHtml(l.name || '')}</option>`,
      )
      .join('');

    const sortMark = col => {
      if (reportSort !== col) return '';
      return reportSortDesc ? ' ▼' : ' ▲';
    };
    const thSort = (col, label) =>
      `<th><button type="button" class="btn btn-xs loc-sort-th${reportSort === col ? ' is-active' : ''}" data-report-sort="${escHtml(col)}">${escHtml(label)}${sortMark(col)}</button></th>`;

    const bodyRows = Array.isArray(rows)
      ? rows
          .map(r => {
            const rawTbl = String(r.item_ref_table || '');
            const rawIid = String(r.item_ref_id || '');
            const rawOrd = String(r.order_no || '');
            const rawDr = String(r.drawing_no || '');
            const tbl = escHtml(rawTbl);
            const iid = escHtml(rawIid);
            const ord = escHtml(rawOrd);
            const locCell = r.location_code
              ? `<strong>${escHtml(r.location_code)}</strong><span class="loc-muted"> · ${escHtml(r.location_name || '')}</span>`
              : formatLocBrief(r.location_id, locIdx);
            const proj = [r.project_code, r.project_name].filter(Boolean).join(' — ');
            const woId = r.work_order_id != null ? String(r.work_order_id) : '';
            const naziv = String(r.naziv_dela || '').slice(0, 40);
            const matCell = [r.materijal, r.dimenzija_materijala]
              .filter(s => s != null && String(s).trim() !== '')
              .join(' · ');
            const rok = r.rok_izrade
              ? String(r.rok_izrade).slice(0, 10)
              : '';
            const tezina = r.tezina_obr != null && Number(r.tezina_obr) > 0
              ? Number(r.tezina_obr).toFixed(2)
              : '';
            const detailsBtn = woId
              ? `<button type="button" class="btn btn-xs" data-rep-open-tp data-wo-id="${escHtml(woId)}" title="Otvori tehnološki postupak (operacije + prijave)">📋 RN/TP</button>`
              : '';
            return `<tr class="loc-row-click" title="Klik za istoriju"
              data-rep-item-table="${tbl}" data-rep-item-id="${iid}" data-rep-order="${ord}" data-rep-drawing="${escHtml(rawDr)}"
              data-rep-customer="${escHtml(String(r.customer_name || ''))}"
              data-rep-naziv="${escHtml(String(r.naziv_dela || ''))}"
              data-rep-materijal="${escHtml(String(r.materijal || ''))}"
              data-rep-pname="${escHtml(String(r.project_name || ''))}"
              data-rep-qty="${escHtml(String(r.qty_on_location ?? ''))}"
              data-rep-komrn="${escHtml(String(r.komada_rn ?? ''))}">
              <td>${escHtml(proj || '—')}</td>
              <td>${escHtml(String(r.customer_name || '—'))}</td>
              <td>${rawOrd ? `<strong>${ord}</strong>` : '<span class="loc-muted">—</span>'}</td>
              <td>${escHtml(String(r.drawing_no || r.wo_broj_crteza || '—'))}${naziv ? `<br><span class="loc-muted">${escHtml(naziv)}</span>` : ''}</td>
              <td>${iid}</td>
              <td>${locCell}</td>
              <td class="loc-muted">${escHtml(matCell)}${tezina ? `<br><span class="loc-muted">${tezina} kg</span>` : ''}</td>
              <td class="loc-qty-cell">${escHtml(String(r.qty_on_location ?? ''))}</td>
              <td class="loc-qty-cell">${escHtml(String(r.qty_total_for_bucket ?? ''))}</td>
              <td>${escHtml(String(r.placement_status || ''))}</td>
              <td>${escHtml(rok)}</td>
              <td class="loc-actions-cell">
                ${detailsBtn}
                <button type="button" class="btn btn-xs" data-rep-print-tp title="Nalepnica TP (barkod)">TP</button>
              </td>
            </tr>`;
          })
          .join('')
      : '';

    const pagerHtml = renderLocPagerHtml({
      page: reportPage,
      pageSize: reportPageSize,
      total,
      loadedCount: Array.isArray(rows) ? rows.length : 0,
      idPrefix: 'locRep',
      ariaLabel: 'Paginacija pregleda',
    });

    host.innerHTML = `
      <div class="kadr-panel active loc-panel">
        ${err}
        ${locToolbarHtml({ extra: '' })}
        <div class="loc-history-filters" role="group" aria-label="Filteri pregleda po lokacijama">
          <label class="loc-filter-field"><span>Broj crteža</span>
            <input type="text" id="locRepDraw" class="loc-search-input" value="${escHtml(rf.drawingNo)}" maxlength="40" />
          </label>
          <label class="loc-filter-field"><span>Broj RN</span>
            <input type="text" id="locRepOrder" class="loc-search-input" value="${escHtml(rf.orderNo)}" maxlength="40" />
          </label>
          <label class="loc-filter-field"><span>Broj TP</span>
            <input type="text" id="locRepTp" class="loc-search-input" value="${escHtml(rf.tpNo)}" maxlength="12" inputmode="numeric" />
          </label>
          <label class="loc-filter-field"><span>Predmet / projekat</span>
            <input type="search" id="locRepProj" class="loc-search-input" value="${escHtml(rf.projectSearch)}" placeholder="Kod ili naziv…" />
          </label>
          <label class="loc-filter-field"><span>Lokacija (master)</span>
            <select id="locRepLoc" class="loc-search-input"><option value="">Sve</option>${locOptions}</select>
          </label>
          <label class="loc-filter-field"><span>Pretraga police</span>
            <input type="search" id="locRepLocQ" class="loc-search-input" value="${escHtml(rf.locationQ)}" placeholder="Šifra ili naziv…" />
          </label>
          <div class="loc-filter-actions">
            <button type="button" class="btn btn-xs" id="locRepApply">Primeni filtere</button>
            <button type="button" class="btn btn-xs" id="locRepReset">Resetuj</button>
            <button type="button" class="btn btn-xs" id="locRepExport" title="CSV trenutnog skupa filtera">Export CSV</button>
          </div>
        </div>
        <p class="loc-muted">Klik na red otvara istoriju. „📋 RN/TP“ otvara tehnološki postupak (operacije + prijave) iz BigTehn cache-a. „TP“ štampa nalepnicu ako postoji prepoznatljiv barkod.</p>
        <div class="loc-table-wrap">
          <table class="loc-table">
            <thead><tr>
              ${thSort('project_code', 'Predmet')}
              ${thSort('customer_name', 'Kupac')}
              ${thSort('order_no', 'RN')}
              ${thSort('drawing_no', 'Crtež / naziv')}
              ${thSort('item_ref_id', 'TP / ref')}
              ${thSort('location_code', 'Lokacija')}
              <th>Materijal · dimenzija</th>
              ${thSort('qty_on_location', 'Kol. lok.')}
              <th>Ukupno</th>
              <th>Status</th>
              ${thSort('rok_izrade', 'Rok')}
              <th>Akcije</th>
            </tr></thead>
            <tbody>${bodyRows || `<tr><td colspan="12" class="loc-muted" style="padding:18px 12px">
              <div><strong>Nema redova za zadate filtere.</strong></div>
              <div style="margin-top:6px">Pregled spaja <code>loc_item_placements</code> sa BigTehn cache-om i filtrira po predmetu/RN/crtežu/lokaciji. Ako baza placement-a još nije puna, otvori tab <strong>Pregled predmeta</strong> da vidiš sve TP-ove jednog predmeta — i tamo ćeš videti koji još nemaju lokaciju.</div>
            </td></tr>`}</tbody>
          </table>
        </div>
        ${pagerHtml}
      </div>`;
    attachLocToolbar();
    attachReportTabHandlers();
    return;
  }

  if (tabId === 'definitions') {
    const [auditRows, locs] = await Promise.all([
      fetchLocationDefinitionsAudit({ limit: 150 }),
      fetchLocations({ activeOnly: false }),
    ]);
    const locIdx = locationIndex(locs);
    const err = auditRows === null
      ? `<p class="loc-warn">Ne mogu da učitam istoriju definicija. Proveri da li je primenjena migracija za audit lokacija.</p>`
      : '';
    host.innerHTML = `
      <div class="kadr-panel active loc-panel">
        ${err}
        ${locToolbarHtml()}
        <div class="loc-master-heading">
          <strong>Istorija definicija hala i polica</strong>
          <span>Prikazuje ko je i kada dodao, promenio ili deaktivirao red u šifarniku <code>loc_locations</code>. Ovo nije istorija premeštanja stavki.</span>
        </div>
        <div class="loc-table-wrap">
          <table class="loc-table loc-history-table">
            <thead><tr>
              <th>Vreme</th>
              <th>Korisnik</th>
              <th>Akcija</th>
              <th>Lokacija</th>
              <th>Promenjeno</th>
              <th>Detalj</th>
            </tr></thead>
            <tbody>${definitionAuditRowsHtml(auditRows, locIdx)}</tbody>
          </table>
        </div>
      </div>`;
    attachLocToolbar();
    return;
  }

  if (tabId === 'history') {
    await renderHistoryTab(host);
    return;
  }

  if (tabId === 'sync') {
    if (!canViewLokacijeSync()) {
      host.innerHTML = `<div class="kadr-panel active loc-panel"><p class="loc-warn">Sync monitor je dostupan samo administratorima.</p></div>`;
      return;
    }
    const ev = await fetchSyncOutboundEvents(100);
    const rows = Array.isArray(ev)
      ? ev
          .map(
            r =>
              `<tr><td>${escHtml(String(r.status || ''))}</td><td>${escHtml(String(r.source_record_id || '').slice(0, 8))}…</td><td>${escHtml((r.created_at || '').replace('T', ' ').slice(0, 19))}</td><td class="loc-path">${escHtml((r.last_error || '—').slice(0, 80))}</td></tr>`,
          )
          .join('')
      : '';
    const err = ev === null ? `<p class="loc-warn">Nema pristupa ili tabela nije kreirana.</p>` : '';
    host.innerHTML = `
      <div class="kadr-panel active loc-panel">
        ${err}
        <p class="loc-muted">Redovi čekaju Node worker na infrastrukturi (MSSQL write-back).</p>
        <div class="loc-table-wrap">
          <table class="loc-table">
            <thead><tr><th>Status</th><th>Movement ID</th><th>Kreirano</th><th>Greška</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4" class="loc-muted">Nema događaja.</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }
}

/**
 * Učitaj listu korisnika za user filter. Za obične korisnike RLS vraća samo
 * njihov red — tada filter nije koristan i sakrivamo ga.
 */
async function loadHistoryUsers() {
  if (historyUsersCache !== null) return historyUsersCache;
  try {
    const rows = await loadUsersFromDb();
    if (!Array.isArray(rows) || rows.length <= 1) {
      historyUsersCache = [];
    } else {
      historyUsersCache = rows
        .map(r => ({
          id: r.id,
          label: r.full_name || r.email || String(r.id).slice(0, 8),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
  } catch {
    historyUsersCache = [];
  }
  return historyUsersCache;
}

function historyRowsHtml(movs, locIdx, userIdx) {
  if (!Array.isArray(movs) || movs.length === 0) {
    return '<tr><td colspan="9" class="loc-muted">Nema premeštanja za zadate filtere.</td></tr>';
  }
  return movs
    .map(m => {
      const when = escHtml((m.moved_at || '').replace('T', ' ').slice(0, 19));
      const who = userIdx.get(String(m.moved_by || '').toLowerCase());
      const whoLabel = who ? escHtml(who) : `<span class="loc-muted">${escHtml(String(m.moved_by || '').slice(0, 8))}…</span>`;
      const type = escHtml(MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type || '');
      const qty = m.quantity == null ? '' : escHtml(String(m.quantity));
      const from = formatLocBrief(m.from_location_id, locIdx);
      const to = formatLocBrief(m.to_location_id, locIdx);
      const item = `${escHtml(m.item_ref_table || '')} · ${escHtml(m.item_ref_id || '')}`;
      const ord = m.order_no
        ? `<strong>${escHtml(m.order_no)}</strong>`
        : '<span class="loc-muted">—</span>';
      const note = escHtml((m.notes || '').slice(0, 80));
      return `<tr>
        <td class="loc-mov-when">${when}</td>
        <td>${whoLabel}</td>
        <td>${type}</td>
        <td class="loc-qty-cell">${qty}</td>
        <td class="loc-path">${from}</td>
        <td class="loc-path">${to}</td>
        <td>${item}</td>
        <td>${ord}</td>
        <td>${note}</td>
      </tr>`;
    })
    .join('');
}

function renderHistoryPager({ page, pageSize, total, loadedCount }) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + loadedCount;
  const totalLabel = total == null ? '?' : String(total);
  const isLast = total != null ? to >= total : loadedCount < pageSize;
  const rangeLabel = total === 0 ? '0–0' : `${from}–${to}`;
  const sizeOpts = [25, 50, 100, 250]
    .map(n => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`)
    .join('');
  return `
    <div class="loc-pager" role="navigation" aria-label="Paginacija istorije">
      <div class="loc-pager-info"><span>${rangeLabel} od ${escHtml(totalLabel)}</span></div>
      <div class="loc-pager-controls">
        <label class="loc-pager-size">
          <span>Po stranici:</span>
          <select id="locHistPageSize">${sizeOpts}</select>
        </label>
        <button type="button" class="btn btn-xs" id="locHistPrev" ${page === 0 ? 'disabled' : ''}>← Prethodna</button>
        <button type="button" class="btn btn-xs" id="locHistNext" ${isLast ? 'disabled' : ''}>Sledeća →</button>
      </div>
    </div>`;
}

async function renderHistoryTab(host) {
  const ui = getLokacijeUiState();
  const { historyFilters: f, historyPage, historyPageSize } = ui;
  const offset = historyPage * historyPageSize;

  const [movsRes, locs, users] = await Promise.all([
    fetchMovementsHistory({
      ...f,
      limit: historyPageSize,
      offset,
      wantCount: true,
    }),
    fetchLocations({ activeOnly: false }),
    loadHistoryUsers(),
  ]);

  const movs = movsRes?.rows ?? null;
  const total = typeof movsRes?.total === 'number' ? movsRes.total : null;
  const locIdx = locationIndex(locs);
  const userIdx = new Map((users || []).map(u => [String(u.id).toLowerCase(), u.label]));

  const err = movs === null ? `<p class="loc-warn">Učitavanje neuspešno.</p>` : '';

  const locOptions = (Array.isArray(locs) ? locs : [])
    .sort((a, b) => (a.location_code || '').localeCompare(b.location_code || ''))
    .map(
      l => `<option value="${escHtml(l.id)}"${l.id === f.locationId ? ' selected' : ''}>${escHtml(l.location_code || '')} — ${escHtml(l.name || '')}</option>`,
    )
    .join('');

  const userOptions = (users || [])
    .map(
      u => `<option value="${escHtml(u.id)}"${u.id === f.userId ? ' selected' : ''}>${escHtml(u.label)}</option>`,
    )
    .join('');
  const userFilterHtml = (users || []).length
    ? `<label class="loc-filter-field">
        <span>Korisnik</span>
        <select id="locHistUser"><option value="">Svi</option>${userOptions}</select>
      </label>`
    : '';

  const typeOptions = Object.entries(MOVEMENT_TYPE_LABELS)
    .map(
      ([v, lbl]) => `<option value="${v}"${v === f.movementType ? ' selected' : ''}>${escHtml(lbl)}</option>`,
    )
    .join('');

  const filtersHtml = `
    <div class="loc-history-filters" role="group" aria-label="Filteri istorije">
      <label class="loc-filter-field">
        <span>Pretraga (crtež ili nalog)</span>
        <input type="search" id="locHistSearch" class="loc-search-input" value="${escHtml(f.search)}" autocomplete="off" placeholder="npr. 1084924 ili 9000" />
      </label>
      <label class="loc-filter-field">
        <span>Samo nalog</span>
        <input type="text" id="locHistOrder" class="loc-search-input" value="${escHtml(f.orderNo)}" autocomplete="off" placeholder="npr. 9000" maxlength="40" />
      </label>
      <label class="loc-filter-field">
        <span>Lokacija (od ili do)</span>
        <select id="locHistLocation"><option value="">Sve</option>${locOptions}</select>
      </label>
      ${userFilterHtml}
      <label class="loc-filter-field">
        <span>Tip</span>
        <select id="locHistType"><option value="">Svi</option>${typeOptions}</select>
      </label>
      <label class="loc-filter-field">
        <span>Od</span>
        <input type="date" id="locHistFrom" value="${escHtml(f.dateFrom)}" />
      </label>
      <label class="loc-filter-field">
        <span>Do</span>
        <input type="date" id="locHistTo" value="${escHtml(f.dateTo)}" />
      </label>
      <div class="loc-filter-actions">
        <button type="button" class="btn btn-xs" id="locHistReset">Resetuj</button>
        <button type="button" class="btn btn-xs" id="locHistExport" title="Preuzmi CSV koji odgovara trenutnim filterima">Export CSV</button>
      </div>
    </div>`;

  const pagerHtml = renderHistoryPager({
    page: historyPage,
    pageSize: historyPageSize,
    total,
    loadedCount: Array.isArray(movs) ? movs.length : 0,
  });

  host.innerHTML = `
    <div class="kadr-panel active loc-panel">
      ${err}
      ${locToolbarHtml({ extra: '' })}
      ${filtersHtml}
      <div class="loc-table-wrap">
        <table class="loc-table loc-history-table">
          <thead><tr>
            <th>Vreme</th>
            <th>Korisnik</th>
            <th>Tip</th>
            <th class="loc-qty-cell">Količina</th>
            <th>Sa lokacije</th>
            <th>Na lokaciju</th>
            <th>Stavka</th>
            <th>Nalog</th>
            <th>Napomena</th>
          </tr></thead>
          <tbody>${historyRowsHtml(movs, locIdx, userIdx)}</tbody>
        </table>
      </div>
      ${pagerHtml}
    </div>`;

  attachLocToolbar();
  attachHistoryFilters();
  attachHistoryPager();
  attachHistoryExport(locs, users);
}

function attachHistoryFilters() {
  const host = locPanelHost;
  if (!host) return;

  const apply = () => refreshLocPanel();

  /* Debounce samo na text input-ima; dropdown-ovi i date reaguju odmah. */
  let t = null;
  let tOrd = null;
  const onInput = () => {
    const el = host.querySelector('#locHistSearch');
    if (!el) return;
    clearTimeout(t);
    t = setTimeout(() => {
      setHistoryFilters({ search: el.value });
      apply();
    }, 300);
  };
  host.querySelector('#locHistSearch')?.addEventListener('input', onInput);
  host.querySelector('#locHistOrder')?.addEventListener('input', () => {
    const el = host.querySelector('#locHistOrder');
    if (!el) return;
    clearTimeout(tOrd);
    tOrd = setTimeout(() => {
      setHistoryFilters({ orderNo: el.value });
      apply();
    }, 300);
  });

  host.querySelector('#locHistLocation')?.addEventListener('change', e => {
    setHistoryFilters({ locationId: e.target.value });
    apply();
  });
  host.querySelector('#locHistUser')?.addEventListener('change', e => {
    setHistoryFilters({ userId: e.target.value });
    apply();
  });
  host.querySelector('#locHistType')?.addEventListener('change', e => {
    setHistoryFilters({ movementType: e.target.value });
    apply();
  });
  host.querySelector('#locHistFrom')?.addEventListener('change', e => {
    setHistoryFilters({ dateFrom: e.target.value });
    apply();
  });
  host.querySelector('#locHistTo')?.addEventListener('change', e => {
    setHistoryFilters({ dateTo: e.target.value });
    apply();
  });

  host.querySelector('#locHistReset')?.addEventListener('click', () => {
    resetHistoryFilters();
    apply();
  });
}

function attachHistoryPager() {
  const host = locPanelHost;
  if (!host) return;
  host.querySelector('#locHistPrev')?.addEventListener('click', () => {
    const { historyPage } = getLokacijeUiState();
    if (historyPage > 0) {
      setHistoryPage(historyPage - 1);
      refreshLocPanel();
    }
  });
  host.querySelector('#locHistNext')?.addEventListener('click', () => {
    const { historyPage } = getLokacijeUiState();
    setHistoryPage(historyPage + 1);
    refreshLocPanel();
  });
  const sel = host.querySelector('#locHistPageSize');
  if (sel) {
    sel.addEventListener('change', () => {
      setHistoryPageSize(Number(sel.value));
      refreshLocPanel();
    });
  }
}

function attachHistoryExport(locs, users) {
  const host = locPanelHost;
  if (!host) return;
  const btn = host.querySelector('#locHistExport');
  if (!btn) return;

  const locIdx = locationIndex(locs);
  const userIdx = new Map((users || []).map(u => [String(u.id).toLowerCase(), u.label]));

  btn.addEventListener('click', async () => {
    const orig = btn.textContent || 'Export CSV';
    btn.disabled = true;
    btn.textContent = 'Export… 0';
    try {
      const { historyFilters } = getLokacijeUiState();
      const { rows, total, truncated } = await fetchAllMovements({
        ...historyFilters,
        pageSize: 500,
        onProgress: ({ loaded, total }) => {
          btn.textContent = total != null
            ? `Export… ${loaded}/${total}`
            : `Export… ${loaded}`;
        },
      });

      if (!Array.isArray(rows) || rows.length === 0) {
        alert('Nema zapisa koji odgovaraju trenutnim filterima.');
        return;
      }

      const headers = [
        'Vreme',
        'Korisnik',
        'Tip',
        'Količina',
        'Sa lokacije',
        'Sa putanje',
        'Na lokaciju',
        'Na putanju',
        'Tabela',
        'Crtež',
        'Nalog',
        'Napomena',
      ];
      const fmtLoc = id => {
        if (!id) return { code: '', path: '' };
        const l = locIdx.get(id);
        return { code: l?.location_code || '', path: l?.path_cached || '' };
      };

      const data = rows.map(m => {
        const from = fmtLoc(m.from_location_id);
        const to = fmtLoc(m.to_location_id);
        const who = userIdx.get(String(m.moved_by || '').toLowerCase()) || '';
        return [
          (m.moved_at || '').replace('T', ' ').slice(0, 19),
          who,
          MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type || '',
          m.quantity == null ? '' : m.quantity,
          from.code,
          from.path,
          to.code,
          to.path,
          m.item_ref_table || '',
          m.item_ref_id || '',
          m.order_no || '',
          m.notes || '',
        ];
      });

      const csv = CSV_BOM + rowsToCsv(headers, data);
      downloadCsv(csv, buildHistoryExportFilename());

      if (truncated) {
        alert(
          `Export prekinut na 50 000 zapisa radi sigurnosti. Ukupno u bazi: ${total ?? '?'}. ` +
            `Suzi filtere za kompletniji izvoz.`,
        );
      }
    } catch (err) {
      console.error('[lokacije/history] CSV export failed', err);
      alert(`Export neuspešan: ${err?.message || err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
}

function buildHistoryExportFilename() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `lokacije_istorija_${ts}.csv`;
}

function wireTabs(container, initialTabId) {
  const host = container.querySelector('#locPanelHost');
  locPanelHost = host;

  container.querySelectorAll('[data-loc-tab]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-loc-tab');
      setLokacijeActiveTab(id);
      container.querySelectorAll('[data-loc-tab]').forEach(b => {
        const on = b.getAttribute('data-loc-tab') === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      host.innerHTML = `<div class="kadr-panel active loc-panel"><p class="loc-muted">Učitavam…</p></div>`;
      await renderPanel(host, id);
    });
  });

  renderPanel(host, initialTabId);
}

/**
 * @param {HTMLElement} mountEl
 * @param {{ onBackToHub?: () => void, onLogout?: () => void }} options
 */
export function renderLokacijeModule(mountEl, { onBackToHub, onLogout } = {}) {
  loadLokacijeTabFromStorage();
  loadBrowseSortFromStorage();
  loadPredmetStateFromStorage();
  let { activeTab: tabId } = getLokacijeUiState();
  if (TABS.find(t => t.id === tabId && t.adminOnly) && !canViewLokacijeSync()) {
    tabId = 'dashboard';
    setLokacijeActiveTab(tabId);
  }

  mountRef = mountEl;
  mountEl.innerHTML = '';
  const wrap = document.createElement('section');
  wrap.className = 'kadrovska-section';
  wrap.id = 'module-lokacije';
  wrap.setAttribute('aria-label', 'Modul Lokacije delova');
  wrap.innerHTML = `
    ${headerHtml()}
    ${tabsHtml(tabId)}
    <div id="locPanelHost"></div>
  `;
  mountEl.appendChild(wrap);

  wrap.querySelector('#locBackBtn')?.addEventListener('click', () => onBackToHub?.());
  wrap.querySelector('#locThemeToggle')?.addEventListener('click', () => toggleTheme());
  wrap.querySelector('#locLogoutBtn')?.addEventListener('click', async () => {
    await logout();
    onLogout?.();
  });

  wireTabs(wrap, tabId);
}

export function teardownLokacijeModule() {
  mountRef = null;
  locPanelHost = null;
  historyUsersCache = null;
  /* In-memory queue za štampu nalepnica nestaje pri logout-u modula. */
  resetLabelsPrintPageState();
}
