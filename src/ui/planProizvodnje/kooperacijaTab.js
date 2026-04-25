/**
 * Plan Proizvodnje — TAB "Kooperacija".
 *
 * Prikazuje operacije koje su efektivno u kooperaciji:
 *   - AUTO: RJ je u production_auto_cooperation_groups
 *   - MANUAL: operacija je ručno poslata kroz production_overlays
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  clearCooperationManual,
  filterOperationsByRnOrDrawing,
  formatSecondsHm,
  listForCooperation,
  plannedSeconds,
} from '../../services/planProizvodnje.js';

const STORAGE_KEY_RN_FILTER = 'plan-proizvodnje:filter-rn:kooperacija';

const state = {
  host: null,
  canEdit: false,
  rows: [],
  rnFilter: '',
  rnFilterTimer: null,
  loading: false,
  error: null,
};

export async function renderKooperacijaTab(host, { canEdit } = {}) {
  state.host = host;
  state.canEdit = !!canEdit;
  state.rnFilter = localStorage.getItem(STORAGE_KEY_RN_FILTER) || '';

  host.innerHTML = `
    <div class="pp-toolbar">
      <span class="pp-toolbar-title">Kooperacija</span>
      <button class="pp-refresh-btn" id="koopRefreshBtn" title="Osveži podatke">
        <span aria-hidden="true">↻</span> Osveži
      </button>
      <label class="pp-rn-filter" title="Filtriraj po RN-u ili broju crteža">
        <span>RN</span>
        <input type="search" id="koopRnFilter" value="${escHtml(state.rnFilter)}"
               placeholder="RN ili crtež…" autocomplete="off">
      </label>
      <div class="pp-toolbar-spacer"></div>
      <span class="pp-counter" id="koopCounter">— operacija</span>
    </div>

    <div id="koopErrorBox"></div>
    <div class="pp-table-wrap" id="koopTableWrap">
      <div class="pp-state">
        <div class="pp-state-icon">⏳</div>
        <div class="pp-state-title">Učitavanje kooperacije…</div>
      </div>
    </div>
  `;

  host.querySelector('#koopRefreshBtn')?.addEventListener('click', () => {
    if (!state.loading) void reload();
  });
  host.querySelector('#koopRnFilter')?.addEventListener('input', (e) => {
    state.rnFilter = e.target.value || '';
    localStorage.setItem(STORAGE_KEY_RN_FILTER, state.rnFilter);
    if (state.rnFilterTimer) clearTimeout(state.rnFilterTimer);
    state.rnFilterTimer = setTimeout(renderTable, 200);
  });

  await reload();
}

export function teardownKooperacijaTab() {
  state.host = null;
  state.rows = [];
  state.error = null;
  if (state.rnFilterTimer) clearTimeout(state.rnFilterTimer);
  state.rnFilterTimer = null;
}

async function reload() {
  if (!state.host) return;
  state.loading = true;
  state.error = null;
  setRefreshSpinning(true);
  try {
    state.rows = await listForCooperation('');
    renderTable();
  } catch (e) {
    console.error('[kooperacija] reload failed', e);
    state.error = 'Greška pri učitavanju (' + (e?.message || e) + ')';
    renderTable();
  } finally {
    state.loading = false;
    setRefreshSpinning(false);
  }
}

function setRefreshSpinning(on) {
  const btn = state.host?.querySelector('#koopRefreshBtn');
  if (btn) btn.classList.toggle('is-spinning', !!on);
}

function renderTable() {
  const host = state.host;
  if (!host) return;

  const errBox = host.querySelector('#koopErrorBox');
  const wrap = host.querySelector('#koopTableWrap');
  const counter = host.querySelector('#koopCounter');
  const rows = filterOperationsByRnOrDrawing(state.rows, state.rnFilter);
  const autoCount = rows.filter(r => r.cooperation_source === 'auto').length;
  const manualCount = rows.filter(r => r.cooperation_source === 'manual').length;
  const bothCount = rows.filter(r => r.cooperation_source === 'auto+manual').length;

  errBox.innerHTML = state.error ? `<div class="pp-error">${escHtml(state.error)}</div>` : '';
  counter.textContent = `${rows.length} operacija · auto ${autoCount} · manual ${manualCount}${bothCount ? ` · auto+manual ${bothCount}` : ''}`;

  if (!rows.length) {
    const filterActive = !!String(state.rnFilter || '').trim();
    wrap.innerHTML = `
      <div class="pp-state">
        <div class="pp-state-icon">📭</div>
        <div class="pp-state-title">${filterActive ? 'Nema rezultata za filter' : 'Nema operacija u kooperaciji'}</div>
        ${filterActive
          ? `<div class="pp-state-desc">Nema operacija koje sadrže <strong>${escHtml(state.rnFilter.trim())}</strong> u RN-u ili broju crteža.</div>`
          : '<div class="pp-state-desc">Auto-kooperacijske grupe i ručno poslate operacije pojaviće se ovde.</div>'}
      </div>
    `;
    return;
  }

  wrap.innerHTML = `
    <table class="pp-table koop-table">
      <thead>
        <tr>
          <th>RN</th>
          <th>Crtež</th>
          <th>Operacija</th>
          <th>RJ grupa</th>
          <th>Izvor</th>
          <th>Partner</th>
          <th>Povratak</th>
          <th class="pp-cell-num">Plan</th>
          <th>Akcije</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(rowHtml).join('')}
      </tbody>
    </table>
    <div class="zm-hint">
      Auto redovi dolaze iz eksplicitne liste RJ grupa. Dugme „Skini manual”
      skida samo ručni flag; auto-kooperacija ostaje dok admin ne promeni lookup listu.
    </div>
  `;

  wrap.querySelectorAll('button[data-action="clear-manual"]').forEach(btn => {
    btn.addEventListener('click', () => onClearManual(btn));
  });
}

function rowHtml(r) {
  const source = r.cooperation_source || 'none';
  const status = r.cooperation_status || 'none';
  const canClear = state.canEdit && (source === 'manual' || source === 'auto+manual');
  return `
    <tr data-wo="${escHtml(String(r.work_order_id))}" data-line="${escHtml(String(r.line_id))}">
      <td class="pp-cell-strong">${escHtml(r.rn_ident_broj || '—')}</td>
      <td class="pp-cell-muted">${escHtml(r.broj_crteza || '—')}</td>
      <td>
        <div class="koop-op">
          <strong>${escHtml(String(r.operacija || '—'))}</strong>
          <span>${escHtml(r.opis_rada || '')}</span>
        </div>
      </td>
      <td>
        <div class="koop-op">
          <strong>${escHtml(r.rj_group_code || r.original_machine_code || '—')}</strong>
          <span>${escHtml(r.rj_group_label || r.original_machine_name || '')}</span>
        </div>
      </td>
      <td>${sourceBadge(source)}</td>
      <td>${escHtml(r.cooperation_partner || '—')}</td>
      <td>${r.cooperation_expected_return ? escHtml(formatDate(r.cooperation_expected_return)) : '—'}</td>
      <td class="pp-cell-num">${escHtml(formatSecondsHm(plannedSeconds(r)))}</td>
      <td>
        ${canClear
          ? `<button type="button" class="pp-reassign-btn" data-action="clear-manual">
               Skini manual
             </button>`
          : `<span class="pp-cell-muted" title="${source === 'auto' ? 'Auto-grupa se menja samo kroz lookup listu' : ''}">${statusLabel(status)}</span>`}
      </td>
    </tr>
  `;
}

function sourceBadge(source) {
  if (source === 'auto') {
    return '<span class="zm-pill zm-pill-coop-auto" title="Cela RJ grupa je u kooperaciji">AUTO</span>';
  }
  if (source === 'manual') {
    return '<span class="zm-pill zm-pill-coop-manual" title="Ručno označeno kao kooperacija">MANUAL</span>';
  }
  if (source === 'auto+manual') {
    return '<span class="zm-pill zm-pill-coop-auto">AUTO</span><span class="zm-pill zm-pill-coop-manual">MANUAL</span>';
  }
  return '<span class="zm-muted">—</span>';
}

function statusLabel(status) {
  switch (status) {
    case 'external': return 'Eksterno';
    case 'external_in_progress': return 'U kooperaciji';
    case 'external_done': return 'Vraćeno';
    default: return '—';
  }
}

async function onClearManual(btn) {
  const tr = btn.closest('tr');
  const workOrderId = Number(tr?.dataset.wo);
  const lineId = Number(tr?.dataset.line);
  if (!workOrderId || !lineId) return;

  btn.disabled = true;
  const res = await clearCooperationManual({ workOrderId, lineId });
  if (res === null) {
    btn.disabled = false;
    showToast('⚠ Manual kooperacija nije skinuta');
    return;
  }

  showToast('✓ Manual kooperacija skinuta');
  await reload();
}
