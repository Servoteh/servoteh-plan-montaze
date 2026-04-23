/**
 * Plan Proizvodnje — TAB "Pregled svih".
 *
 * Matrica MAŠINE × NAREDNIH 5 RADNIH DANA.
 * Ćelija sadrži broj otvorenih operacija sa rokom u tom danu.
 * Boja ćelije = hitnost (overdue, today, soon, ok).
 *
 * Dodatne kolone:
 *   - "Kasni"     — operacije sa rokom < danas
 *   - 5 radnih dana (Pon–Pet, preskaču vikende)
 *   - "Kasnije"   — rok dalje od poslednjeg prikazanog dana
 *   - "Bez roka"  — operacije bez postavljenog roka
 *
 * Klik na ćeliju (sa brojem > 0) ⇒ skok u "Po mašini" za tu mašinu.
 *
 * Public API:
 *   renderPregledTab(host, { canEdit, onJumpToPoMasini })
 *   teardownPregledTab()
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  loadAllOpenOperations,
  loadMachines,
  buildDeadlineMatrix,
} from '../../services/planProizvodnje.js';
import {
  MACHINE_GROUPS,
  countMachinesPerGroup,
  getMachineGroup,
} from '../../lib/machineGroups.js';

const state = {
  host: null,
  rows: [],
  machinesMap: null,
  machinesAll: [],
  matrix: { days: [], machines: [] },
  loading: false,
  error: null,
  filter: 'all',
  group: 'all',
  onJumpToPoMasini: null,
};

const STORAGE_KEY_FILTER = 'plan-proizvodnje:pregled:filter';
const STORAGE_KEY_GROUP  = 'plan-proizvodnje:machine-group';

/* ── Public ── */

export async function renderPregledTab(host, { canEdit, onJumpToPoMasini } = {}) {
  state.host = host;
  state.onJumpToPoMasini = onJumpToPoMasini || null;
  void canEdit;

  state.filter = localStorage.getItem(STORAGE_KEY_FILTER) || 'all';
  state.group  = localStorage.getItem(STORAGE_KEY_GROUP)  || 'all';

  host.innerHTML = `
    <div class="mg-chipbar" id="pmGroupChipbar" role="tablist" aria-label="Filter mašina po grupi">
      <span class="mg-chipbar-label">Grupa:</span>
      <div class="mg-chipbar-scroll" id="pmGroupChipbarScroll">
        <span class="pp-cell-muted">Učitavanje grupa…</span>
      </div>
    </div>

    <div class="pp-toolbar">
      <span class="pp-toolbar-label">Filter:</span>
      <div class="zm-filter" role="group" aria-label="Filter mašina">
        <button type="button" class="zm-filter-btn${state.filter === 'all'  ? ' is-active' : ''}" data-filter="all">Sve mašine</button>
        <button type="button" class="zm-filter-btn${state.filter === 'proc' ? ' is-active' : ''}" data-filter="proc">Samo proceduralne</button>
      </div>
      <button class="pp-refresh-btn" id="pmRefreshBtn" title="Osveži podatke">
        <span aria-hidden="true">↻</span> Osveži
      </button>
      <div class="pp-toolbar-spacer"></div>
      <span class="pp-counter" id="pmCounter">— mašina · — dana</span>
    </div>

    <div id="pmErrorBox"></div>

    <div class="pp-table-wrap" id="pmTableWrap">
      <div class="pp-state">
        <div class="pp-state-icon">⏳</div>
        <div class="pp-state-title">Učitavanje matrice…</div>
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
      renderMatrix();
    });
  });
  host.querySelector('#pmRefreshBtn').addEventListener('click', () => {
    if (state.loading) return;
    void reload();
  });

  await reload();
}

export function teardownPregledTab() {
  state.host = null;
  state.rows = [];
  state.machinesMap = null;
  state.matrix = { days: [], machines: [] };
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
    const [machines, rows] = await Promise.all([
      loadMachines(),
      loadAllOpenOperations(),
    ]);
    state.machinesAll = machines || [];
    state.machinesMap = new Map(state.machinesAll.map(m => [m.rj_code, m]));
    state.rows = rows || [];
    state.matrix = buildDeadlineMatrix(state.rows, 5);
    /* Obogati machines metadatom */
    state.matrix.machines = state.matrix.machines.map(m => {
      const meta = state.machinesMap.get(m.machineCode);
      return {
        ...m,
        machineName: meta?.name || '',
        noProcedure: !!meta?.no_procedure,
        groupId: getMachineGroup(meta || { rj_code: m.machineCode }),
      };
    });
    renderGroupChipbar();
    renderMatrix();
  } catch (e) {
    console.error('[pregled] reload failed', e);
    state.error = 'Greška pri učitavanju (' + (e?.message || e) + ')';
    renderMatrix();
  } finally {
    state.loading = false;
    setRefreshSpinning(false);
  }
}

function setRefreshSpinning(on) {
  const btn = state.host?.querySelector('#pmRefreshBtn');
  if (btn) btn.classList.toggle('is-spinning', !!on);
}

function renderGroupChipbar() {
  const host = state.host?.querySelector('#pmGroupChipbarScroll');
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
      renderMatrix();
    });
  });
}

/* ── Render ── */

function renderMatrix() {
  const host = state.host;
  if (!host) return;
  const errBox = host.querySelector('#pmErrorBox');
  const wrap   = host.querySelector('#pmTableWrap');
  const counter = host.querySelector('#pmCounter');

  errBox.innerHTML = state.error
    ? `<div class="pp-error">${escHtml(state.error)}</div>`
    : '';

  const { days } = state.matrix;
  let { machines } = state.matrix;
  if (state.group && state.group !== 'all') {
    machines = machines.filter(m => m.groupId === state.group);
  }
  if (state.filter === 'proc') {
    machines = machines.filter(m => m.noProcedure === false);
  }
  /* Sortiraj mašine po totalOps DESC, pa po machineCode ASC */
  machines = [...machines].sort((a, b) => {
    if (b.totalOps !== a.totalOps) return b.totalOps - a.totalOps;
    return String(a.machineCode).localeCompare(String(b.machineCode), 'sr', { numeric: true });
  });

  counter.textContent = `${machines.length} mašina · ${days.length} dana`;

  if (!machines.length) {
    wrap.innerHTML = `
      <div class="pp-state">
        <div class="pp-state-icon">📭</div>
        <div class="pp-state-title">Nema otvorenih operacija</div>
      </div>
    `;
    return;
  }

  /* Header: Mašina | Ukupno | Kasni | day1..dayN | Kasnije | Bez roka */
  const headHtml = `
    <th class="pm-th pm-th-machine">Mašina</th>
    <th class="pm-th pm-th-total">Otvoreno</th>
    <th class="pm-th pm-th-bucket pm-th-overdue">Kasni</th>
    ${days.map(d => `
      <th class="pm-th pm-th-bucket${d.isToday ? ' is-today' : ''}">
        <div class="pm-day-label">${escHtml(d.label)}</div>
      </th>
    `).join('')}
    <th class="pm-th pm-th-bucket pm-th-future">Kasnije</th>
    <th class="pm-th pm-th-bucket pm-th-none">Bez roka</th>
  `;

  /* Body */
  const bodyHtml = machines.map(m => {
    const cellsDays = days.map(d => {
      const n = m.buckets[d.date] || 0;
      const cls = bucketClass(d, n);
      return `<td class="pm-cell ${cls}${n > 0 ? ' is-clickable' : ''}"
                  data-machine="${escHtml(m.machineCode)}"
                  data-bucket="${escHtml(d.date)}">
                ${n > 0 ? `<span class="pm-cell-num">${n}</span>` : '<span class="pm-cell-empty">·</span>'}
              </td>`;
    }).join('');
    return `
      <tr class="pm-row" data-machine="${escHtml(m.machineCode)}">
        <td class="pm-td-machine">
          <div class="zm-machine-code">${escHtml(m.machineCode)}</div>
          <div class="zm-machine-name">${escHtml(m.machineName || '')}</div>
        </td>
        <td class="pm-td-total"><span class="zm-num zm-num-strong">${m.totalOps}</span></td>
        <td class="pm-cell pm-cell-overdue${m.buckets.overdue > 0 ? ' is-clickable' : ''}"
            data-machine="${escHtml(m.machineCode)}" data-bucket="overdue">
          ${m.buckets.overdue > 0 ? `<span class="pm-cell-num">${m.buckets.overdue}</span>` : '<span class="pm-cell-empty">·</span>'}
        </td>
        ${cellsDays}
        <td class="pm-cell pm-cell-future${m.buckets.future > 0 ? ' is-clickable' : ''}"
            data-machine="${escHtml(m.machineCode)}" data-bucket="future">
          ${m.buckets.future > 0 ? `<span class="pm-cell-num">${m.buckets.future}</span>` : '<span class="pm-cell-empty">·</span>'}
        </td>
        <td class="pm-cell pm-cell-none${m.buckets.noDeadline > 0 ? ' is-clickable' : ''}"
            data-machine="${escHtml(m.machineCode)}" data-bucket="none">
          ${m.buckets.noDeadline > 0 ? `<span class="pm-cell-num">${m.buckets.noDeadline}</span>` : '<span class="pm-cell-empty">·</span>'}
        </td>
      </tr>
    `;
  }).join('');

  /* Total row */
  const totals = {
    total: machines.reduce((s, m) => s + m.totalOps, 0),
    overdue: machines.reduce((s, m) => s + m.buckets.overdue, 0),
    future: machines.reduce((s, m) => s + m.buckets.future, 0),
    noDeadline: machines.reduce((s, m) => s + m.buckets.noDeadline, 0),
    perDay: days.map(d => machines.reduce((s, m) => s + (m.buckets[d.date] || 0), 0)),
  };
  const totalRow = `
    <tr class="pm-row pm-row-total">
      <td class="pm-td-machine"><strong>UKUPNO</strong></td>
      <td class="pm-td-total"><strong>${totals.total}</strong></td>
      <td class="pm-cell pm-cell-overdue"><strong>${totals.overdue || ''}</strong></td>
      ${totals.perDay.map(n => `<td class="pm-cell"><strong>${n || ''}</strong></td>`).join('')}
      <td class="pm-cell pm-cell-future"><strong>${totals.future || ''}</strong></td>
      <td class="pm-cell pm-cell-none"><strong>${totals.noDeadline || ''}</strong></td>
    </tr>
  `;

  wrap.innerHTML = `
    <div class="pm-table-scroll">
      <table class="pm-table">
        <thead><tr>${headHtml}</tr></thead>
        <tbody>${bodyHtml}${totalRow}</tbody>
      </table>
    </div>
    <div class="pm-legend">
      <span class="pm-legend-item"><span class="pm-legend-swatch pm-cell-overdue"></span> Kasni</span>
      <span class="pm-legend-item"><span class="pm-legend-swatch pm-cell-today"></span> Danas</span>
      <span class="pm-legend-item"><span class="pm-legend-swatch pm-cell-soon"></span> ≤3 dana</span>
      <span class="pm-legend-item"><span class="pm-legend-swatch pm-cell-warn"></span> 4–7 dana</span>
      <span class="pm-legend-item"><span class="pm-legend-swatch pm-cell-ok"></span> &gt;7 dana</span>
      <span class="pm-legend-item">💡 Klikni ćeliju ili red da otvoriš „Po mašini”.</span>
    </div>
  `;

  /* Wire klik na red ili ćeliju za skok u Po mašini */
  wrap.querySelectorAll('[data-machine]').forEach(el => {
    el.addEventListener('click', () => {
      const mc = el.dataset.machine;
      if (!mc) return;
      if (typeof state.onJumpToPoMasini === 'function') {
        state.onJumpToPoMasini(mc);
      } else {
        showToast(`Skok na "Po mašini" za ${mc} (handler nije povezan)`, 'warn');
      }
    });
  });
}

/**
 * Klasa ćelije za boju (zavisi od urgency dana i broja).
 * Današnji dan = "today", sledeća 3 dana = "soon", 4–7 = "warn", >7 = "ok".
 */
function bucketClass(day, n) {
  if (n === 0) return 'pm-cell-empty';
  if (day.isToday) return 'pm-cell-today';
  /* Razlika između dana i danas */
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dDate = new Date(day.date);
  const diff = Math.floor((dDate - today) / (24 * 3600 * 1000));
  if (diff <= 3) return 'pm-cell-soon';
  if (diff <= 7) return 'pm-cell-warn';
  return 'pm-cell-ok';
}
