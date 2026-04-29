/**
 * Plan Montaže — desktop plan tabela (F5.1.b).
 *
 * Renderuje punu tabelu faza aktivnog WP-a sa kolonama:
 *   #, Naziv (+ tip chip), Lokacija, Početak, Kraj, Trajanje, Inženjer, Vođa,
 *   Status, %, [8x check], Spreman, Rizik, Blokator, Beleška, Akcije.
 *
 * Filter bar (search, lokacija, status, vođa, ready, dates, risk) postavlja
 * `planMontazeState.filteredIndices` na niz indeksa ili null. Sve promene
 * polja faze prolaze kroz `update()` → `applyBusinessRules()` → debouncedi
 * save preko `queuePhaseSaveByIndex(i)`.
 *
 * Add phase bar: input + dugme. Move row, delete row.
 *
 * 3D model dugme i full calendar popup su placeholder-i — biće implementirani
 * u F5.5. Dotada koristimo native <input type="date">.
 */

import { escHtml } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  planMontazeState,
  getActiveWP,
  getActivePhases,
  getProjectLocations,
  getLocationColor,
  getPhaseModel,
  ENGINEERS,
  VODJA,
} from '../../state/planMontaze.js';
import { openModelDialog } from './modelDialog.js';
import { openDescriptionDialog } from './descriptionDialog.js';
import { openLinkedDrawingsDialog } from './linkedDrawingsDialog.js';
import { openDrawingPdf } from '../../services/drawings.js';
import {
  STATUSES,
  CHECK_LABELS,
  CHECK_SHORT,
  NUM_CHECKS,
} from '../../lib/constants.js';
import {
  calcDuration,
  dayDiffFromToday,
} from '../../lib/date.js';
import {
  calcReadiness,
  calcRisk,
  statusClass,
  normalizePhaseType,
} from '../../lib/phase.js';
import {
  updatePhaseField,
  handlePersonChange,
  updateCheck,
  togglePhaseType,
  moveRow,
  movePhaseToIndex,
  deleteRow,
  addPhaseFromInput,
} from './planActions.js';

let _onChangeRoot = null;

/* ── PUBLIC: HTML rendering ──────────────────────────────────────────── */

export function planSectionHtml() {
  const wp = getActiveWP();
  if (!wp) {
    return `
      <div class="form-card">
        <h3>Nema aktivne pozicije</h3>
        <p class="form-hint">Klikni "＋ Pozicija" iznad da dodaš prvu poziciju ovom projektu.</p>
      </div>
    `;
  }
  return `
    ${_planFiltersToolbarHtml()}
    <div class="plan-table-wrap" id="planTableWrap">
      <table class="plan-table">
        <thead>${_planTheadHtml()}</thead>
        <tbody id="planTableBody">${_planTbodyHtml()}</tbody>
      </table>
    </div>
  `;
}

/* ── PUBLIC: WIRE event handlere posle injektovanja HTML-a ───────────── */

export function wirePlanSection(root, { onChange } = {}) {
  _onChangeRoot = onChange || null;

  /* Filter bar */
  ['fSearch', 'fLoc', 'fStatus', 'fPerson', 'fReady', 'fDates', 'fRisk']
    .forEach(id => {
      const el = root.querySelector('#' + id);
      if (!el) return;
      const evt = id === 'fSearch' ? 'input' : 'change';
      el.addEventListener(evt, _applyFilters);
    });
  root.querySelector('#fReset')?.addEventListener('click', _resetFilters);

  /* Add phase */
  root.querySelector('#newPhaseBtn')?.addEventListener('click', _onAddPhaseClick);
  root.querySelector('#newPhaseInput')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') _onAddPhaseClick();
  });

  /* Wire row event listeners on tbody */
  _wireTbody(root);
}

/* ── INTERNAL: HTML helpers ──────────────────────────────────────────── */

function _planFiltersToolbarHtml() {
  const locs = getProjectLocations();
  const ppl = VODJA.filter(v => v);
  const f = planMontazeState.filterValues || {};
  const dis = canEdit() ? '' : 'disabled';
  return `
    <div class="plan-filters-toolbar" role="search" aria-label="Filteri i nova faza">
      <div class="pft-filters filter-bar">
        <label class="fb-field">
          <span>Pretraga</span>
          <input type="search" id="fSearch" placeholder="Naziv faze…" value="${escHtml(f.search || '')}">
        </label>
        <label class="fb-field">
          <span>Lokacija</span>
          <select id="fLoc">
            <option value="">Sve</option>
            ${locs.map(l => `<option value="${escHtml(l)}"${f.loc === l ? ' selected' : ''}>${escHtml(l)}</option>`).join('')}
          </select>
        </label>
        <label class="fb-field">
          <span>Status</span>
          <select id="fStatus">
            <option value="">Sve</option>
            ${STATUSES.map((s, i) => `<option value="${i}"${String(f.status) === String(i) ? ' selected' : ''}>${escHtml(s)}</option>`).join('')}
          </select>
        </label>
        <label class="fb-field">
          <span>Vođa</span>
          <select id="fPerson">
            <option value="">Svi</option>
            <option value="__none__"${f.person === '__none__' ? ' selected' : ''}>— Bez vođe —</option>
            ${ppl.map(p => `<option value="${escHtml(p)}"${f.person === p ? ' selected' : ''}>${escHtml(p)}</option>`).join('')}
          </select>
        </label>
        <label class="fb-field">
          <span>Spremnost</span>
          <select id="fReady">
            <option value="">Sve</option>
            <option value="ready"${f.ready === 'ready' ? ' selected' : ''}>Spremno</option>
            <option value="notready"${f.ready === 'notready' ? ' selected' : ''}>Nije spremno</option>
          </select>
        </label>
        <label class="fb-field">
          <span>Datumi</span>
          <select id="fDates">
            <option value="">Sve</option>
            <option value="hasdate"${f.dates === 'hasdate' ? ' selected' : ''}>Ima datume</option>
            <option value="nodate"${f.dates === 'nodate' ? ' selected' : ''}>Bez datuma</option>
          </select>
        </label>
        <label class="fb-field">
          <span>Rizik</span>
          <select id="fRisk">
            <option value="">Sve</option>
            <option value="hasrisk"${f.risk === 'hasrisk' ? ' selected' : ''}>Sa rizikom</option>
          </select>
        </label>
        <div class="fb-actions">
          <span class="fb-count" id="filterCount">${_filterCountText()}</span>
          <button type="button" class="btn btn-ghost" id="fReset" title="Resetuj filtere">↺</button>
        </div>
      </div>
      <div class="pft-new-phase add-phase-bar">
        <input type="text" id="newPhaseInput" placeholder="Naziv nove faze…" ${dis}>
        <button type="button" class="btn btn-primary" id="newPhaseBtn" ${dis}>＋ FAZA</button>
      </div>
    </div>
  `;
}

function _planTheadHtml() {
  const checkHeads = CHECK_SHORT.map((s, i) => `<th class="th-check" title="${escHtml(CHECK_LABELS[i])}">${escHtml(s)}</th>`).join('');
  return `
    <tr>
      <th class="th-num">#</th>
      <th class="th-name">Naziv</th>
      <th class="th-loc">Lokacija</th>
      <th class="th-date">Početak</th>
      <th class="th-date">Kraj</th>
      <th class="th-dur">Trajanje</th>
      <th class="th-eng">Inženjer</th>
      <th class="th-person">Vođa</th>
      <th class="th-status">Status</th>
      <th class="th-pct">%</th>
      ${checkHeads}
      <th class="th-ready">Spreman</th>
      <th class="th-risk">Rizik</th>
      <th class="th-blocker">Blokator</th>
      <th class="th-note">Beleška</th>
      <th class="th-actions">Akcije</th>
    </tr>
  `;
}

function _planTbodyHtml() {
  const phases = getActivePhases();
  const indices = planMontazeState.filteredIndices !== null
    ? planMontazeState.filteredIndices
    : phases.map((_, i) => i);
  if (!indices.length) {
    const cols = 9 + NUM_CHECKS + 5; /* approx */
    return `<tr><td colspan="${cols}" class="empty-row">Nema faza za prikazanim filterima.</td></tr>`;
  }
  return indices.map(i => _planRowHtml(phases[i], i)).join('');
}

function _planRowHtml(row, i) {
  const dis = canEdit() ? '' : 'disabled';
  const dur = calcDuration(row.start, row.end);
  const rd = calcReadiness(row);
  const rk = calcRisk(row);
  const locColor = getLocationColor(row.loc);
  const dateErr = dur === -1;
  let durT = '—', durC = 'td-dur';
  if (dur === -1) { durT = '⚠ERR'; durC = 'td-dur dur-error'; }
  else if (dur !== null) durT = dur + ' d';

  let pctC = 'pct-fill-normal';
  if (row.status === 2) pctC = 'pct-fill-done';
  if (row.status === 3) pctC = 'pct-fill-hold';

  /* Risk badge */
  let rI = '✅', rkBadgeCls = 'rk-none', rkLbl = 'OK';
  if (rk.level === 'high') { rI = '🔴'; rkBadgeCls = 'rk-high'; rkLbl = 'VISOK'; }
  else if (rk.level === 'med') { rI = '🟠'; rkBadgeCls = 'rk-med'; rkLbl = 'SREDNJI'; }
  else if (rk.level === 'low') { rI = '🟡'; rkBadgeCls = 'rk-low'; rkLbl = 'NIZAK'; }

  /* Ready badge */
  let rdH;
  if (rd.done) {
    rdH = '<span class="badge-ready-final done">✔ DONE</span>';
  } else if (rd.ready) {
    rdH = '<span class="badge-ready-final ready">✔ Spreman</span>';
  } else {
    const t = rd.reasons.map(r => '• ' + escHtml(r)).join('<br>');
    rdH = `<div class="ready-tooltip"><span class="badge-ready-final not-ready">✘ Nije</span><div class="ready-tip-text">${t}</div></div>`;
  }

  /* Risk badge with reasons tooltip */
  let rkH;
  if (rk.reasons.length > 0) {
    const t = rk.reasons.map(r => escHtml(r)).join('<br>');
    rkH = `<div class="risk-tooltip"><span class="badge-risk ${rkBadgeCls}">${rI} ${rkLbl}</span><div class="risk-tip-text">${t}</div></div>`;
  } else {
    rkH = `<span class="badge-risk ${rkBadgeCls}">${rI} ${rkLbl}</span>`;
  }

  const blkH = (row.status === 3 && !row.blocker?.trim()) ? 'blocker-highlight' : '';
  const rkC = rk.level !== 'none' ? `row-risk-${rk.level}` : 'row-risk-none';
  const finC = row.status === 2 ? ' row-finished' : '';

  /* Reminder dot */
  let remDot = '';
  if (row.start && row.status !== 2) {
    const dd = dayDiffFromToday(row.start);
    if (dd !== null && dd >= 0 && dd <= 3 && !rd.ready) remDot = '<span class="reminder-dot rd-red"></span>';
    else if (dd !== null && dd >= 4 && dd <= 7 && !rd.ready) remDot = '<span class="reminder-dot rd-yellow"></span>';
  }

  /* Phase type chip */
  const pType = normalizePhaseType(row.type);
  const ptCls = pType === 'electrical' ? 'pt-elec' : 'pt-mech';
  const ptLbl = pType === 'electrical' ? 'E' : 'M';
  const ptIc = pType === 'electrical' ? '⚡' : '⚙';
  const ptTitle = pType === 'electrical' ? 'Elektro (klikni za Mašinska)' : 'Mašinska (klikni za Elektro)';

  /* Locations */
  const locOpts = _locationOptionsHtml(row.loc);
  const engOpts = _personOptionsHtml(ENGINEERS, row.engineer);
  const ldOpts = _personOptionsHtml(VODJA, row.person);

  /* Checks */
  const checkCells = row.checks.map((c, ci) => {
    const gCls = ci === 0 ? ' td-check-group-start' : (ci === row.checks.length - 1 ? ' td-check-group-end' : '');
    const disAttr = dis ? ' disabled' : '';
    const title = `${escHtml(CHECK_LABELS[ci])}: ${c ? 'Spremno — klikni za NE' : 'Nije spremno — klikni za DA'}`;
    return `<td class="td-check${gCls}">
      <button type="button" class="check-chip ${c ? 'ok' : 'no'}" data-check-i="${i}" data-check-ci="${ci}" data-check-next="${c ? '0' : '1'}"${disAttr} title="${title}">
        <span class="chip-icon">${c ? '✓' : '○'}</span>${c ? 'DA' : 'NE'}
      </button>
    </td>`;
  }).join('');

  const hasDesc = !!(row.description && row.description.trim());
  const descTitle = hasDesc
    ? 'Opis dodeljen — klikni za izmenu'
    : 'Dodaj detaljan opis faze';

  /* „Veza sa" — povezani crteži za fazu.
   * UX: svaki crtež se renderuje kao zaseban klikabilan chip (📄 SC-XXX) koji
   * direktno otvara PDF u novom tabu. Pored njih je kompaktno ✏️ dugme koje
   * otvara modal za dodavanje/uklanjanje (linkedDrawingsDialog.js). Ako lista
   * još nije popunjena, prikazuje se samo "🔗 ＋ Veza sa" dugme za dodavanje. */
  const linkedNos = Array.isArray(row.linkedDrawings) ? row.linkedDrawings : [];
  const linkedHasAny = linkedNos.length > 0;
  const linkedChipsHtml = linkedNos.map(no => `
    <button type="button" class="phase-linked-chip" data-row-action="open-drawing" data-drawing-no="${escHtml(no)}" title="Otvori PDF crteža u novom tabu">
      <span class="plc-ic">📄</span><span class="plc-no">${escHtml(no)}</span>
    </button>
  `).join('');
  const linkedManageHtml = linkedHasAny
    ? `<button type="button" class="row-btn btn-linked-manage" data-row-action="linked" data-ri="${i}" title="Izmeni listu povezanih crteža">✏️</button>`
    : (canEdit()
      ? `<button type="button" class="row-btn btn-linked" data-row-action="linked" data-ri="${i}" title="Dodaj brojeve crteža potrebnih za ovu fazu"><span class="rb-ic">🔗</span>＋ Veza sa</button>`
      : '');
  const dragHandle = canEdit()
    ? `<span class="row-drag-handle" data-drag-handle="${i}" title="Prevuci za promenu redosleda" aria-label="Prevuci za promenu redosleda">⋮⋮</span>`
    : '';

  return `
    <tr class="${rkC}${finC}" data-ri="${i}" data-phase-id="${escHtml(row.id)}">
      <td class="td-num">
        ${dragHandle}
        <span class="td-num-n">${i + 1}</span>
      </td>
      <td class="td-name">
        <div class="phase-name-row">
          ${remDot}
          <input class="phase-name-input" type="text" value="${escHtml(row.name)}" data-field="name" ${dis}>
        </div>
        <div class="phase-meta-row" aria-label="Akcije i povezani crteži">
          <button type="button" class="phase-type-chip ${ptCls}" data-toggle-type="${i}" title="${ptTitle}" ${dis}>
            <span class="pt-ic">${ptIc}</span>${ptLbl}
          </button>
          <button type="button" class="phase-desc-btn${hasDesc ? ' has-desc' : ''}" data-row-action="desc" data-ri="${i}" title="${descTitle}">
            <span class="pdb-ic">📝</span><span class="pdb-lbl">opis</span>
          </button>
          <button type="button" class="row-btn btn-3d ${getPhaseModel(row.id) ? 'has-model' : ''}" data-row-action="model" data-ri="${i}" title="${getPhaseModel(row.id) ? '3D: ' + escHtml(getPhaseModel(row.id).name || 'model dodeljen') : '3D model (nema)'}">🧩 3D</button>
          ${linkedChipsHtml}
          ${linkedManageHtml}
        </div>
      </td>
      <td class="td-loc">
        <select class="loc-select" data-field="loc" style="border-left:3px solid ${locColor}" ${dis}>${locOpts}</select>
      </td>
      <td class="td-date ${dateErr ? 'date-error' : ''}">
        <input type="date" data-field="start" value="${escHtml(row.start || '')}" ${dis}>
      </td>
      <td class="td-date ${dateErr ? 'date-error' : ''}">
        <input type="date" data-field="end" value="${escHtml(row.end || '')}" ${dis}>
      </td>
      <td class="${durC}">${durT}</td>
      <td class="td-eng">
        <select data-field-person="engineer" ${dis}>${engOpts}</select>
      </td>
      <td class="td-person">
        <select data-field-person="person" ${dis}>${ldOpts}</select>
      </td>
      <td class="td-status">
        <select class="${statusClass(row.status)}" data-field="status" ${dis}>
          ${STATUSES.map((s, si) => `<option value="${si}"${row.status === si ? ' selected' : ''}>${escHtml(s)}</option>`).join('')}
        </select>
      </td>
      <td class="td-pct">
        <div class="pct-bar-wrap">
          <div class="pct-bar"><div class="pct-bar-fill ${pctC}" style="width:${row.pct}%"></div></div>
          <span class="pct-num">${row.pct}%</span>
        </div>
        <input type="range" min="0" max="100" step="5" value="${row.pct}" data-field="pct" ${dis}>
      </td>
      ${checkCells}
      <td class="td-ready">${rdH}</td>
      <td class="td-risk">${rkH}</td>
      <td class="td-blocker ${blkH}">
        <textarea class="note-area" rows="2" data-field="blocker" placeholder="${row.status === 3 ? '⚠!' : ''}" ${dis}>${escHtml(row.blocker || '')}</textarea>
      </td>
      <td class="td-note">
        <textarea class="note-area" rows="2" data-field="note" ${dis}>${escHtml(row.note || '')}</textarea>
      </td>
      <td class="td-actions">
        <button type="button" class="row-btn btn-up" data-row-action="up" data-ri="${i}" title="Pomeri gore">▲</button>
        <button type="button" class="row-btn btn-dn" data-row-action="down" data-ri="${i}" title="Pomeri dole">▼</button>
        <button type="button" class="row-btn btn-del" data-row-action="del" data-ri="${i}" title="Obriši">✕</button>
      </td>
    </tr>
  `;
}

function _locationOptionsHtml(currentValue) {
  const list = getProjectLocations();
  let has = false;
  const opts = list.map(l => {
    const sel = l === currentValue;
    if (sel) has = true;
    return `<option value="${escHtml(l)}"${sel ? ' selected' : ''}>${escHtml(l)}</option>`;
  }).join('');
  if (currentValue && !has) {
    return `<option value="${escHtml(currentValue)}" selected>${escHtml(currentValue)}</option>` + opts;
  }
  return opts;
}

function _personOptionsHtml(list, currentValue) {
  const cur = String(currentValue || '');
  let has = false;
  const opts = list.map(v => {
    const sel = v === cur;
    if (sel) has = true;
    return `<option value="${escHtml(v)}"${sel ? ' selected' : ''}>${escHtml(v) || '—'}</option>`;
  }).join('');
  const unknownOpt = (cur && !has) ? `<option value="${escHtml(cur)}" selected>${escHtml(cur)}</option>` : '';
  return unknownOpt + opts
    + '<option value="__add__" style="font-weight:600;color:var(--accent)">➕ Dodaj novog…</option>';
}

/* ── INTERNAL: state helpers ─────────────────────────────────────────── */

function _filterCountText() {
  const phases = getActivePhases();
  const fi = planMontazeState.filteredIndices;
  return fi !== null ? `${fi.length}/${phases.length}` : '';
}

function _readFilterValues(root) {
  return {
    search: (root.querySelector('#fSearch')?.value || '').toLowerCase().trim(),
    loc: root.querySelector('#fLoc')?.value || '',
    status: root.querySelector('#fStatus')?.value || '',
    person: root.querySelector('#fPerson')?.value || '',
    ready: root.querySelector('#fReady')?.value || '',
    dates: root.querySelector('#fDates')?.value || '',
    risk: root.querySelector('#fRisk')?.value || '',
  };
}

function _applyFilters(ev) {
  const root = ev.target.closest('.plan-body') || ev.target.closest('main') || document;
  const f = _readFilterValues(root);
  planMontazeState.filterValues = f;
  const phases = getActivePhases();
  const indices = [];
  phases.forEach((row, i) => {
    if (f.search && !row.name.toLowerCase().includes(f.search)) return;
    if (f.loc && row.loc !== f.loc) return;
    if (f.status !== '' && row.status !== parseInt(f.status, 10)) return;
    if (f.person === '__none__' && row.person !== '') return;
    if (f.person && f.person !== '__none__' && row.person !== f.person) return;
    const rd = calcReadiness(row);
    if (f.ready === 'ready' && !rd.ready) return;
    if (f.ready === 'notready' && rd.ready) return;
    if (f.dates === 'nodate' && row.start && row.end) return;
    if (f.dates === 'hasdate' && (!row.start || !row.end)) return;
    if (f.risk === 'hasrisk' && calcRisk(row).level === 'none') return;
    indices.push(i);
  });
  const any = f.search || f.loc || f.status !== '' || f.person || f.ready || f.dates || f.risk;
  planMontazeState.filteredIndices = any ? indices : null;
  _rerenderTbody(root);
}

function _resetFilters() {
  planMontazeState.filterValues = {};
  planMontazeState.filteredIndices = null;
  _onChangeRoot?.();
}

function _rerenderTbody(root) {
  const tbody = root.querySelector('#planTableBody');
  if (tbody) tbody.innerHTML = _planTbodyHtml();
  const fc = root.querySelector('#filterCount');
  if (fc) fc.textContent = _filterCountText();
  /* Posle rerender-a tbody-ja, ponovo wire-ujemo handlere */
  _wireTbody(root);
}

/* ── INTERNAL: row-level handlers (delegiraju na planActions.js) ─────── */

function _wireTbody(root) {
  const tbody = root.querySelector('#planTableBody');
  if (!tbody) return;

  /* Field updates */
  tbody.querySelectorAll('[data-field]').forEach(el => {
    const evt = (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'date'))
      || el.tagName === 'TEXTAREA'
      ? 'change'
      : (el.type === 'range' ? 'input' : 'change');
    el.addEventListener(evt, () => {
      const tr = el.closest('tr');
      const i = Number(tr?.dataset.ri);
      if (Number.isNaN(i)) return;
      const field = el.dataset.field;
      let val = el.value;
      if (field === 'status' || field === 'pct') val = parseInt(val, 10);
      updatePhaseField(i, field, val);
      _onChangeRoot?.();
    });
  });

  /* Person selects (engineer / lead) — handle "__add__" sentinel */
  tbody.querySelectorAll('[data-field-person]').forEach(el => {
    el.addEventListener('change', () => {
      const tr = el.closest('tr');
      const i = Number(tr?.dataset.ri);
      if (Number.isNaN(i)) return;
      const field = el.dataset.fieldPerson;
      handlePersonChange(el, i, field);
      _onChangeRoot?.();
    });
  });

  /* Check chips */
  tbody.querySelectorAll('[data-check-i]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.checkI);
      const ci = Number(btn.dataset.checkCi);
      const next = btn.dataset.checkNext === '1';
      updateCheck(i, ci, next);
      _onChangeRoot?.();
    });
  });

  /* Phase type toggle */
  tbody.querySelectorAll('[data-toggle-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.toggleType);
      togglePhaseType(i);
      _onChangeRoot?.();
    });
  });

  /* Row actions */
  tbody.querySelectorAll('[data-row-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.rowAction;
      const i = Number(btn.dataset.ri);
      if (action === 'up') moveRow(i, -1);
      else if (action === 'down') moveRow(i, 1);
      else if (action === 'del') deleteRow(i);
      else if (action === 'model') {
        const tr = btn.closest('tr');
        const phaseId = tr?.dataset.phaseId;
        if (phaseId) openModelDialog(phaseId, () => _onChangeRoot?.());
        return;
      }
      else if (action === 'desc') {
        openDescriptionDialog(i, () => _onChangeRoot?.());
        return;
      }
      else if (action === 'linked') {
        openLinkedDrawingsDialog(i, () => _onChangeRoot?.());
        return;
      }
      else if (action === 'open-drawing') {
        const no = btn.dataset.drawingNo;
        if (no) openDrawingPdf(no);
        return;
      }
      _onChangeRoot?.();
    });
  });

  /* Drag & drop: promena redosleda faza preko handle-a ⋮⋮ */
  _wireRowDragDrop(tbody);
}

/**
 * Handle-scoped drag & drop: red se postaje `draggable` tek posle `mousedown`
 * na `.row-drag-handle`, kako klik u phase-name-input ili druge kontrole ne bi
 * pokretao drag. Vizuelni feedback: `phase-row-dragging` na izvornom redu +
 * `phase-drop-above` / `phase-drop-below` insert indikator na meti.
 */
function _wireRowDragDrop(tbody) {
  let draggingIdx = null;

  tbody.querySelectorAll('[data-drag-handle]').forEach(h => {
    h.addEventListener('mousedown', () => {
      const tr = h.closest('tr');
      if (tr) tr.setAttribute('draggable', 'true');
    });
  });

  tbody.querySelectorAll('tr[data-ri]').forEach(tr => {
    tr.addEventListener('dragstart', (ev) => {
      const fromStr = tr.dataset.ri;
      if (fromStr == null) return;
      draggingIdx = Number(fromStr);
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', fromStr);
      }
      tr.classList.add('phase-row-dragging');
    });

    tr.addEventListener('dragover', (ev) => {
      if (draggingIdx === null) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const rect = tr.getBoundingClientRect();
      const above = (ev.clientY - rect.top) < rect.height / 2;
      tr.classList.toggle('phase-drop-above', above);
      tr.classList.toggle('phase-drop-below', !above);
    });

    tr.addEventListener('dragleave', () => {
      tr.classList.remove('phase-drop-above', 'phase-drop-below');
    });

    tr.addEventListener('drop', (ev) => {
      ev.preventDefault();
      tr.classList.remove('phase-drop-above', 'phase-drop-below');
      if (draggingIdx === null) return;
      const targetRi = Number(tr.dataset.ri);
      if (Number.isNaN(targetRi)) return;
      const rect = tr.getBoundingClientRect();
      const above = (ev.clientY - rect.top) < rect.height / 2;
      const to = above ? targetRi : targetRi + 1;
      const changed = movePhaseToIndex(draggingIdx, to);
      draggingIdx = null;
      if (changed) _onChangeRoot?.();
    });

    tr.addEventListener('dragend', () => {
      tr.classList.remove('phase-row-dragging');
      tr.removeAttribute('draggable');
      tbody.querySelectorAll('.phase-drop-above, .phase-drop-below')
        .forEach(el => el.classList.remove('phase-drop-above', 'phase-drop-below'));
      draggingIdx = null;
    });
  });
}

function _onAddPhaseClick() {
  if (addPhaseFromInput()) _onChangeRoot?.();
}
