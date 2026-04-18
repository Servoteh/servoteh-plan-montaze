/**
 * Plan Montaže — Single Gantt (F5.3).
 *
 * Renderuje gantogram aktivnog WP-a:
 *   - Mesečni header (rowspan=2 levi label, colspan po danu)
 *   - Day header — klikabilan: klik selektuje kolonu, Shift+klik raspon
 *   - Trake faza obojene bojom lokacije, sa border-style za tip (mech/elec)
 *   - Drag/resize: drag bara → pomera, levi/desni handle → menja start/end
 *   - "Prikaži završene" toggle (perzistira)
 *
 * Selekcija se čuva u `selectedDateIndices.gantt` Set-u (perzistira između
 * rerenders dok god je aktivni WP isti).
 */

import { escHtml } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  getActiveWP,
  getActivePhases,
  getLocationColor,
  selectedDateIndices,
  lastSelectedDateIndex,
  showFinishedInGantt,
  setShowFinishedInGantt,
} from '../../state/planMontaze.js';
import { STATUSES } from '../../lib/constants.js';
import { parseDateLocal, today } from '../../lib/date.js';
import { calcRisk, normalizePhaseType } from '../../lib/phase.js';
import { buildDayRange, buildMonthsHeader, inferGanttBounds } from '../../lib/gantt.js';
import { wireGanttDrag } from './ganttDrag.js';

/* ── PUBLIC ──────────────────────────────────────────────────────────── */

export function ganttSectionHtml() {
  const wp = getActiveWP();
  if (!wp) {
    return `
      <div class="form-card">
        <h3>Nema aktivne pozicije</h3>
        <p class="form-hint">Dodaj poziciju da bi prikazao gantogram.</p>
      </div>
    `;
  }
  return `
    ${_ganttToolbarHtml()}
    <div class="gantt-wrap" id="ganttWrap">${_ganttTableHtml()}</div>
  `;
}

export function wireGanttSection(root, { onChange } = {}) {
  /* Toolbar: show finished toggle */
  root.querySelector('#ganttShowFinished')?.addEventListener('change', (ev) => {
    setShowFinishedInGantt(ev.target.checked);
    onChange?.();
  });

  /* Day header click — single column selekcija + Shift raspon */
  root.querySelectorAll('.gantt-day-hdr').forEach(th => {
    th.addEventListener('click', (ev) => {
      const idx = Number(th.dataset.didx);
      if (Number.isNaN(idx)) return;
      _onDayHeaderClick(ev, 'gantt', idx, root);
    });
  });

  /* Drag/resize */
  const wrapEl = root.querySelector('#ganttWrap');
  wireGanttDrag(wrapEl, { onChange });
}

/* ── INTERNAL: HTML ──────────────────────────────────────────────────── */

function _ganttToolbarHtml() {
  return `
    <div class="gantt-toolbar">
      <label class="gantt-toggle">
        <input type="checkbox" id="ganttShowFinished" ${showFinishedInGantt ? 'checked' : ''}>
        <span>Prikaži završene faze</span>
      </label>
      <span class="gantt-hint">Drag bare za pomeranje · levi/desni handle za promenu datuma · Shift+klik na header za raspon</span>
    </div>
  `;
}

function _ganttTableHtml() {
  const phases = getActivePhases().filter(r => showFinishedInGantt || r.status !== 2);
  if (!phases.length) {
    return '<div class="gantt-empty">Nema faza za prikaz (probaj uključiti "Prikaži završene").</div>';
  }
  const { min, max } = inferGanttBounds(phases, p => p.start, p => p.end);
  const days = buildDayRange(min, max);
  const months = buildMonthsHeader(days);
  const monthsRow = Object.values(months)
    .map(m => `<th class="gantt-month-hdr" colspan="${m.count}">${escHtml(m.label)}</th>`)
    .join('');
  const daysRow = _dayHeaderHtml(days, 'gantt');

  let html = `<table class="gantt-table" data-view="gantt"><thead>
    <tr><th class="gantt-label" rowspan="2">Faza</th>${monthsRow}</tr>
    <tr>${daysRow}</tr>
  </thead><tbody>`;

  const allPhases = getActivePhases();
  phases.forEach(row => {
    const origIdx = allPhases.indexOf(row);
    html += _ganttRowHtml(row, origIdx, days);
  });

  html += '</tbody></table>';
  return html;
}

function _dayHeaderHtml(days, viewKey) {
  const sel = selectedDateIndices[viewKey];
  return days.map((d, idx) => {
    const isT = d.getTime() === today.getTime();
    const isW = d.getDay() === 0 || d.getDay() === 6;
    const isSel = sel.has(idx);
    const cls = ['gantt-day-hdr'];
    if (isT) cls.push('today-col');
    if (isW) cls.push('wknd');
    if (isSel) cls.push('col-selected');
    const title = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} (klikni za selekciju, Shift+klik za raspon)`;
    return `<th class="${cls.join(' ')}" data-view="${viewKey}" data-didx="${idx}" title="${title}">${d.getDate()}</th>`;
  }).join('');
}

function _ganttRowHtml(row, origIdx, days) {
  const _sD = parseDateLocal(row.start);
  const _eD = parseDateLocal(row.end);
  const sMs = _sD ? _sD.getTime() : null;
  const eMs = _eD ? _eD.getTime() : null;
  const rk = calcRisk(row);
  const rkC = rk.level !== 'none' ? ' gantt-row-risk' : '';
  const eng = row.engineer ? row.engineer.split(' ').pop() : '';
  const ld = row.person ? row.person.split(' ').pop() : '';
  const locColor = getLocationColor(row.loc);
  const sel = selectedDateIndices.gantt;
  const editable = canEdit();
  const phaseId = escHtml(row.id);

  const cells = days.map((d, didx) => {
    const dMs = d.getTime();
    const isT = dMs === today.getTime();
    const isW = d.getDay() === 0 || d.getDay() === 6;
    const inB = sMs !== null && eMs !== null && dMs >= sMs && dMs <= eMs;
    const isS = sMs !== null && dMs === sMs;
    const isE = eMs !== null && dMs === eMs;
    const isColSel = sel.has(didx);
    const cls = ['gantt-cell'];
    if (isW) cls.push('wknd');
    if (isT) cls.push('today-col');
    if (isColSel) cls.push('col-selected');
    let style = '';
    if (inB) {
      cls.push('bar-phase');
      if (isS && isE) cls.push('bar-phase-start', 'bar-phase-end');
      else if (isS) cls.push('bar-phase-start');
      else if (isE) cls.push('bar-phase-end');
      cls.push(normalizePhaseType(row.type) === 'electrical' ? 'bar-elec' : 'bar-mech');
      style = `style="background-color:${locColor} !important"`;
    }
    let handles = '';
    if (inB && editable) {
      if (isS) handles += '<div class="gantt-drag-handle-l"></div>';
      if (isE) handles += '<div class="gantt-drag-handle-r"></div>';
    }
    return `<td class="${cls.join(' ')}" data-didx="${didx}" data-phase-id="${phaseId}" ${style}>${handles}</td>`;
  }).join('');

  return `<tr class="gantt-row${rkC}" data-phase-id="${phaseId}" data-ri="${origIdx}">
    <td class="gantt-label" style="background:var(--surface2);border-right:2px solid var(--border2);border-left:3px solid ${locColor}">
      <div class="gantt-label-name">${escHtml(row.name)}</div>
      <div class="gantt-label-sub">
        <span class="gantt-label-loc-dot" style="background:${locColor}"></span>${escHtml(row.loc || '—')}
        ${eng ? '· ' + escHtml(eng) : ''} ${ld ? '· ' + escHtml(ld) : ''} ·
        <span class="gantt-label-status gs-${row.status}">${escHtml(STATUSES[row.status])} ${row.pct}%</span>
      </div>
    </td>
    ${cells}
  </tr>`;
}

/* ── INTERNAL: column selection ──────────────────────────────────────── */

function _onDayHeaderClick(ev, viewKey, idx, root) {
  const sel = selectedDateIndices[viewKey];
  if (ev.shiftKey && lastSelectedDateIndex[viewKey] !== null) {
    const from = Math.min(lastSelectedDateIndex[viewKey], idx);
    const to = Math.max(lastSelectedDateIndex[viewKey], idx);
    for (let k = from; k <= to; k++) sel.add(k);
  } else {
    if (sel.has(idx) && sel.size === 1) {
      sel.clear();
      lastSelectedDateIndex[viewKey] = null;
    } else {
      if (!ev.ctrlKey && !ev.metaKey) sel.clear();
      sel.add(idx);
      lastSelectedDateIndex[viewKey] = idx;
    }
  }
  _applyDaySelectionStyles(viewKey, root);
}

function _applyDaySelectionStyles(viewKey, root) {
  const wrapId = viewKey === 'gantt' ? 'ganttWrap' : 'totalGanttWrap';
  const wrap = root.querySelector('#' + wrapId);
  if (!wrap) return;
  const sel = selectedDateIndices[viewKey];
  wrap.querySelectorAll('.gantt-day-hdr').forEach(el => {
    const idx = parseInt(el.dataset.didx, 10);
    if (Number.isNaN(idx)) return;
    el.classList.toggle('col-selected', sel.has(idx));
  });
  wrap.querySelectorAll('.gantt-cell').forEach(el => {
    const idx = parseInt(el.dataset.didx, 10);
    if (Number.isNaN(idx)) return;
    el.classList.toggle('col-selected', sel.has(idx));
  });
}
