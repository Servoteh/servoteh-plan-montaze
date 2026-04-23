/**
 * Plan Proizvodnje — TAB "Zauzetost mašina".
 *
 * Zbirni prikaz po mašini: koliko je otvorenih operacija, distinct crteža,
 * koliko je tehnološkog vremena planirano, koliko već realizovano,
 * breakdown hitnosti (overdue/today/soon), broj reassigned-in operacija,
 * ne-mašinske operacije.
 *
 * Klik na red ⇒ skok u tab "Po mašini" sa tom mašinom već selektovanom.
 *
 * Public API:
 *   renderZauzetostTab(host, { canEdit, onJumpToPoMasini })
 *   teardownZauzetostTab()
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  loadAllOpenOperations,
  loadMachines,
  summarizeByMachine,
  formatSecondsHm,
} from '../../services/planProizvodnje.js';
import {
  MACHINE_GROUPS,
  countMachinesPerGroup,
  getMachineGroup,
} from '../../lib/machineGroups.js';

const STORAGE_KEY_SORT     = 'plan-proizvodnje:zauzetost:sort';
const STORAGE_KEY_FILTER   = 'plan-proizvodnje:zauzetost:filter'; /* 'all' | 'proc' */
const STORAGE_KEY_GROUP    = 'plan-proizvodnje:machine-group';   /* deli se sa svim tabovima */

const state = {
  host: null,
  rows: [],          /* sirove operacije (samo za reload) */
  machinesMap: null, /* Map<rj_code, {name, no_procedure, department_id}> */
  machinesAll: [],   /* lista mašina za chip-bar count-ove */
  summary: [],       /* output summarizeByMachine */
  loading: false,
  error: null,
  sortKey: 'totalOps',
  sortDir: 'desc',
  filter: 'all',
  group: 'all',
  onJumpToPoMasini: null,
};

/* Definicija kolona (label + sortKey + accessor + html builder). */
const COLUMNS = [
  {
    key: 'machineCode',
    label: 'Mašina',
    sortable: true,
    align: 'left',
    accessor: (r) => r.machineCode,
    html: (r) => `
      <div class="zm-cell-machine">
        <div class="zm-machine-code">${escHtml(r.machineCode)}</div>
        <div class="zm-machine-name">${escHtml(r.machineName || '')}</div>
      </div>
    `,
  },
  {
    key: 'totalOps',
    label: 'Otvoreno',
    sortable: true,
    align: 'right',
    accessor: (r) => r.totalOps,
    html: (r) => `<span class="zm-num zm-num-strong">${r.totalOps}</span>`,
  },
  {
    key: 'drawingsCount',
    label: 'Crteža',
    sortable: true,
    align: 'right',
    accessor: (r) => r.drawingsCount,
    html: (r) => `<span class="zm-num">${r.drawingsCount}</span>`,
  },
  {
    key: 'hot',
    label: 'Hitno',
    sortable: true,
    align: 'right',
    accessor: (r) => r.overdueOps + r.todayOps,
    html: (r) => {
      const parts = [];
      if (r.overdueOps > 0) parts.push(`<span class="zm-pill zm-pill-overdue" title="Kasni">${r.overdueOps}</span>`);
      if (r.todayOps   > 0) parts.push(`<span class="zm-pill zm-pill-today"   title="Rok danas">${r.todayOps}</span>`);
      if (r.soonOps    > 0) parts.push(`<span class="zm-pill zm-pill-soon"    title="Rok ≤3 dana">${r.soonOps}</span>`);
      return parts.length ? parts.join(' ') : '<span class="zm-muted">–</span>';
    },
  },
  {
    key: 'plannedSec',
    label: 'Planirano',
    sortable: true,
    align: 'right',
    accessor: (r) => r.plannedSec,
    html: (r) => `<span class="zm-num">${formatSecondsHm(r.plannedSec)}</span>`,
  },
  {
    key: 'realSec',
    label: 'Realizovano',
    sortable: true,
    align: 'right',
    accessor: (r) => r.realSec,
    html: (r) => `<span class="zm-num zm-muted">${formatSecondsHm(r.realSec)}</span>`,
  },
  {
    key: 'reassignedInOps',
    label: 'Premešteno',
    sortable: true,
    align: 'right',
    accessor: (r) => r.reassignedInOps,
    html: (r) => r.reassignedInOps > 0
      ? `<span class="zm-pill zm-pill-reassign" title="Operacije koje su prebačene sa originalne mašine">${r.reassignedInOps}</span>`
      : '<span class="zm-muted">–</span>',
  },
  {
    key: 'nonMachiningOps',
    label: 'Ne-mašinske',
    sortable: true,
    align: 'right',
    accessor: (r) => r.nonMachiningOps,
    html: (r) => r.nonMachiningOps > 0
      ? `<span class="zm-pill zm-pill-nonmach" title="Kontrole, kooperacija, ručne operacije…">${r.nonMachiningOps}</span>`
      : '<span class="zm-muted">–</span>',
  },
];

/* ── Public ── */

export async function renderZauzetostTab(host, { canEdit, onJumpToPoMasini } = {}) {
  state.host = host;
  state.onJumpToPoMasini = onJumpToPoMasini || null;
  void canEdit; /* za sad nema edit-akcija u ovom tabu */

  /* Restore sort + filter iz localStorage */
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_SORT) || '{}');
    if (saved.key) state.sortKey = saved.key;
    if (saved.dir) state.sortDir = saved.dir;
  } catch { /* ignore */ }
  state.filter = localStorage.getItem(STORAGE_KEY_FILTER) || 'all';
  state.group  = localStorage.getItem(STORAGE_KEY_GROUP)  || 'all';

  host.innerHTML = `
    <div class="mg-chipbar" id="zmGroupChipbar" role="tablist" aria-label="Filter mašina po grupi">
      <span class="mg-chipbar-label">Grupa:</span>
      <div class="mg-chipbar-scroll" id="zmGroupChipbarScroll">
        <span class="pp-cell-muted">Učitavanje grupa…</span>
      </div>
    </div>

    <div class="pp-toolbar">
      <span class="pp-toolbar-label">Filter:</span>
      <div class="zm-filter" role="group" aria-label="Filter mašina">
        <button type="button" class="zm-filter-btn${state.filter === 'all'  ? ' is-active' : ''}" data-filter="all">Sve mašine</button>
        <button type="button" class="zm-filter-btn${state.filter === 'proc' ? ' is-active' : ''}" data-filter="proc">Samo proceduralne</button>
      </div>
      <button class="pp-refresh-btn" id="zmRefreshBtn" title="Osveži podatke">
        <span aria-hidden="true">↻</span> Osveži
      </button>
      <div class="pp-toolbar-spacer"></div>
      <span class="pp-counter" id="zmCounter">— mašina · — operacija</span>
    </div>

    <div id="zmErrorBox"></div>

    <div class="pp-table-wrap" id="zmTableWrap">
      <div class="pp-state">
        <div class="pp-state-icon">⏳</div>
        <div class="pp-state-title">Učitavanje zauzetosti…</div>
      </div>
    </div>
  `;

  host.querySelectorAll('button[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.filter;
      if (f === state.filter) return;
      state.filter = f;
      localStorage.setItem(STORAGE_KEY_FILTER, f);
      host.querySelectorAll('button[data-filter]').forEach(b =>
        b.classList.toggle('is-active', b.dataset.filter === f),
      );
      renderTable();
    });
  });
  host.querySelector('#zmRefreshBtn').addEventListener('click', () => {
    if (state.loading) return;
    void reload();
  });

  await reload();
}

export function teardownZauzetostTab() {
  state.host = null;
  state.rows = [];
  state.summary = [];
  state.machinesMap = null;
  state.error = null;
  state.onJumpToPoMasini = null;
}

/* ── Data ── */

async function reload() {
  if (!state.host) return;
  state.loading = true;
  state.error = null;
  setRefreshSpinning(true);

  try {
    /* paralelno: mašine (za imena) + sve open operacije */
    const [machines, rows] = await Promise.all([
      loadMachines(),
      loadAllOpenOperations(),
    ]);

    state.machinesAll = machines || [];
    state.machinesMap = new Map(
      state.machinesAll.map(m => [m.rj_code, m]),
    );
    state.rows = rows || [];
    state.summary = summarizeByMachine(state.rows).map(s => {
      const meta = state.machinesMap.get(s.machineCode);
      return {
        ...s,
        machineName: meta?.name || '',
        noProcedure: !!meta?.no_procedure,
        groupId: getMachineGroup(meta || { rj_code: s.machineCode }),
      };
    });
    renderGroupChipbar();
    renderTable();
  } catch (e) {
    console.error('[zauzetost] reload failed', e);
    state.error = 'Greška pri učitavanju (' + (e?.message || e) + ')';
    renderTable();
  } finally {
    state.loading = false;
    setRefreshSpinning(false);
  }
}

function setRefreshSpinning(on) {
  const btn = state.host?.querySelector('#zmRefreshBtn');
  if (btn) btn.classList.toggle('is-spinning', !!on);
}

function renderGroupChipbar() {
  const host = state.host?.querySelector('#zmGroupChipbarScroll');
  if (!host) return;
  const counts = countMachinesPerGroup(state.machinesAll);
  const visible = MACHINE_GROUPS.filter(
    (g) => g.id === 'all' || (counts.get(g.id) || 0) > 0,
  );
  host.innerHTML = visible.map((g) => {
    const n = counts.get(g.id) || 0;
    const isActive = g.id === state.group;
    return `
      <button type="button" role="tab"
              class="mg-chip${isActive ? ' is-active' : ''}"
              data-group-id="${escHtml(g.id)}"
              aria-selected="${isActive ? 'true' : 'false'}"
              title="${escHtml(g.label)} — ${n} mašina">
        ${escHtml(g.label)} <span class="mg-chip-count">${n}</span>
      </button>`;
  }).join('');
  host.querySelectorAll('button[data-group-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.groupId;
      if (!id || id === state.group) return;
      state.group = id;
      try { localStorage.setItem(STORAGE_KEY_GROUP, id); } catch { /* ignore */ }
      renderGroupChipbar();
      renderTable();
    });
  });
}

/* ── Render ── */

function renderTable() {
  const host = state.host;
  if (!host) return;
  const errBox = host.querySelector('#zmErrorBox');
  const wrap   = host.querySelector('#zmTableWrap');
  const counter = host.querySelector('#zmCounter');

  errBox.innerHTML = state.error
    ? `<div class="pp-error">${escHtml(state.error)}</div>`
    : '';

  /* Filter (po grupi mašina + samo proceduralne) */
  let data = state.summary;
  if (state.group && state.group !== 'all') {
    data = data.filter(r => r.groupId === state.group);
  }
  if (state.filter === 'proc') {
    data = data.filter(r => r.noProcedure === false);
  }

  /* Counter */
  const totalMach = data.length;
  const totalOps  = data.reduce((s, r) => s + r.totalOps, 0);
  const totalPlanned = data.reduce((s, r) => s + r.plannedSec, 0);
  counter.textContent = `${totalMach} mašina · ${totalOps} ops · ${formatSecondsHm(totalPlanned)} plan`;

  if (!data.length) {
    wrap.innerHTML = `
      <div class="pp-state">
        <div class="pp-state-icon">📭</div>
        <div class="pp-state-title">Nema otvorenih operacija</div>
        <div class="pp-state-desc">Sve mašine su trenutno bez aktivnih radnih naloga,
          ili Bridge još nije popunio cache.</div>
      </div>
    `;
    return;
  }

  /* Sort */
  const sorted = sortData(data, state.sortKey, state.sortDir);

  /* Build HTML */
  const headHtml = COLUMNS.map(c => {
    const isActive = c.sortable && c.key === state.sortKey;
    const arrow = isActive ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
    return `<th class="zm-th zm-th-${c.align}${c.sortable ? ' zm-th-sortable' : ''}${isActive ? ' is-sorted' : ''}"
              data-sort-key="${c.sortable ? c.key : ''}">
              <span>${escHtml(c.label)}</span>
              ${arrow ? `<span class="zm-sort-arrow">${arrow}</span>` : ''}
            </th>`;
  }).join('');

  const bodyHtml = sorted.map(r => {
    const cells = COLUMNS.map(c =>
      `<td class="zm-td zm-td-${c.align}">${c.html(r)}</td>`,
    ).join('');
    return `<tr class="zm-row" data-machine="${escHtml(r.machineCode)}">${cells}</tr>`;
  }).join('');

  /* Total row */
  const totalRow = `
    <tr class="zm-row zm-row-total">
      <td class="zm-td zm-td-left"><strong>UKUPNO</strong></td>
      <td class="zm-td zm-td-right"><strong>${totalOps}</strong></td>
      <td class="zm-td zm-td-right"><strong>${data.reduce((s, r) => s + r.drawingsCount, 0)}</strong></td>
      <td class="zm-td zm-td-right"><strong>${data.reduce((s, r) => s + r.overdueOps + r.todayOps, 0)}</strong></td>
      <td class="zm-td zm-td-right"><strong>${formatSecondsHm(totalPlanned)}</strong></td>
      <td class="zm-td zm-td-right"><strong>${formatSecondsHm(data.reduce((s, r) => s + r.realSec, 0))}</strong></td>
      <td class="zm-td zm-td-right"><strong>${data.reduce((s, r) => s + r.reassignedInOps, 0)}</strong></td>
      <td class="zm-td zm-td-right"><strong>${data.reduce((s, r) => s + r.nonMachiningOps, 0)}</strong></td>
    </tr>
  `;

  wrap.innerHTML = `
    <table class="zm-table">
      <thead><tr>${headHtml}</tr></thead>
      <tbody>${bodyHtml}${totalRow}</tbody>
    </table>
    <div class="zm-hint">💡 Klikni na red da otvoriš mašinu u tabu „Po mašini”.</div>
  `;

  /* Wire sort */
  wrap.querySelectorAll('th[data-sort-key]').forEach(th => {
    const key = th.dataset.sortKey;
    if (!key) return;
    th.addEventListener('click', () => {
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        /* Default DESC za brojčane, ASC za tekstualne */
        state.sortDir = key === 'machineCode' ? 'asc' : 'desc';
      }
      localStorage.setItem(STORAGE_KEY_SORT, JSON.stringify({
        key: state.sortKey, dir: state.sortDir,
      }));
      renderTable();
    });
  });

  /* Wire row click → jump to po-masini */
  wrap.querySelectorAll('tr.zm-row[data-machine]').forEach(tr => {
    tr.addEventListener('click', () => {
      const mc = tr.dataset.machine;
      if (!mc) return;
      if (typeof state.onJumpToPoMasini === 'function') {
        state.onJumpToPoMasini(mc);
      } else {
        showToast(`Skok na "Po mašini" za ${mc} (handler nije povezan)`, 'warn');
      }
    });
  });
}

function sortData(data, key, dir) {
  const col = COLUMNS.find(c => c.key === key);
  if (!col) return data;
  const factor = dir === 'asc' ? 1 : -1;
  return [...data].sort((a, b) => {
    const va = col.accessor(a);
    const vb = col.accessor(b);
    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * factor;
    }
    return String(va || '').localeCompare(String(vb || ''), 'sr', { numeric: true }) * factor;
  });
}
