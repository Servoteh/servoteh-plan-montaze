/**
 * Gantt drag/resize — pointer event-driven.
 *
 * Tri moda:
 *   - 'move'  : klik na bilo koju ćeliju trake → pomera celu traku levo/desno
 *   - 'start' : klik na levi handle → menja samo start
 *   - 'end'   : klik na desni handle → menja samo end
 *
 * Tokom drag-a:
 *   - Računamo `delta` u danima na osnovu pomeraja u px / širina ćelije
 *   - Klampujemo: start ne sme posle end (i obrnuto)
 *   - Tooltip pokazuje "novi datum start → novi datum end"
 *   - Trake dobijaju klasu `bar-dragging`
 *
 * Po release:
 *   - Postavlja phase.start/end → applyBusinessRules → persistState →
 *     queuePhaseSaveByIndex/queueCurrentWpSync (sync)
 *   - Trigger-uje onChange callback (rerender pogona)
 *
 * Bez framework-a, koristi document-level mousemove/mouseup. Mobilni i
 * pointer-based drag će stići u F5.5 ako bude potrebe.
 */

import { showToast } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import { allData, persistState } from '../../state/planMontaze.js';
import { parseDateLocal, dateToYMD, formatDate } from '../../lib/date.js';
import { applyBusinessRules } from '../../lib/phase.js';
import {
  queuePhaseSaveByIndex,
  queueCurrentWpSync,
} from '../../services/plan.js';

let _dragState = null;
let _onChangeCb = null;
let _tipEl = null;

/** Pretraži sve projekte i nađi fazu po ID-u. */
function findPhaseAcrossAll(phaseId) {
  for (const p of allData.projects || []) {
    for (const wp of p.workPackages || []) {
      const idx = (wp.phases || []).findIndex(ph => ph.id === phaseId);
      if (idx >= 0) return { project: p, wp, phase: wp.phases[idx], idx };
    }
  }
  return null;
}

/**
 * Wire-uje sve drag handle / klikabilne trake unutar gantt wrap-a.
 * @param {HTMLElement} wrapEl  div sa data-view, sadrži gantt-cell elemente
 * @param {Object} options
 * @param {Function} options.onChange  callback nakon commit-a (rerender)
 */
export function wireGanttDrag(wrapEl, { onChange } = {}) {
  if (!wrapEl) return;
  _onChangeCb = onChange || null;

  /* Move (klik na bilo koju bar ćeliju, ali ne na handle) */
  wrapEl.querySelectorAll('.gantt-cell.bar-phase').forEach(cell => {
    cell.addEventListener('mousedown', (ev) => {
      if (ev.target?.classList?.contains('gantt-drag-handle-l')) return;
      if (ev.target?.classList?.contains('gantt-drag-handle-r')) return;
      const phaseId = cell.dataset.phaseId;
      if (!phaseId) return;
      _startDrag(ev, wrapEl, phaseId, 'move');
    });
  });

  /* Levi handle */
  wrapEl.querySelectorAll('.gantt-drag-handle-l').forEach(h => {
    h.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      const cell = h.closest('.gantt-cell');
      const phaseId = cell?.dataset.phaseId;
      if (!phaseId) return;
      _startDrag(ev, wrapEl, phaseId, 'start');
    });
  });

  /* Desni handle */
  wrapEl.querySelectorAll('.gantt-drag-handle-r').forEach(h => {
    h.addEventListener('mousedown', (ev) => {
      ev.stopPropagation();
      const cell = h.closest('.gantt-cell');
      const phaseId = cell?.dataset.phaseId;
      if (!phaseId) return;
      _startDrag(ev, wrapEl, phaseId, 'end');
    });
  });
}

function _startDrag(ev, wrapEl, phaseId, mode) {
  if (!canEdit()) return;
  const ref = findPhaseAcrossAll(phaseId);
  if (!ref) return;
  if (!ref.phase.start || !ref.phase.end) {
    showToast('⚠ Faza mora imati start/end pre drag-a');
    return;
  }
  ev.preventDefault();
  const firstCell = wrapEl.querySelector('.gantt-cell');
  const cellWidth = firstCell ? firstCell.getBoundingClientRect().width : 22;

  _dragState = {
    phaseId, mode,
    originX: ev.clientX,
    startISO: ref.phase.start,
    endISO: ref.phase.end,
    cellWidth,
    lastDelta: 0,
    pendingStartISO: ref.phase.start,
    pendingEndISO: ref.phase.end,
    changed: false,
    wrapEl,
    projectId: ref.project.id,
    wpId: ref.wp.id,
    phaseIdx: ref.idx,
  };

  document.addEventListener('mousemove', _onMove);
  document.addEventListener('mouseup', _onEnd);

  /* Vizuelni indicator */
  wrapEl.querySelectorAll(`.gantt-cell[data-phase-id="${CSS.escape(phaseId)}"]`)
    .forEach(c => c.classList.add('bar-dragging'));

  _showTip(ev, ref.phase.start, ref.phase.end);
}

function _onMove(ev) {
  if (!_dragState) return;
  const delta = Math.round((ev.clientX - _dragState.originX) / _dragState.cellWidth);
  if (delta === _dragState.lastDelta) {
    _showTip(ev, _dragState.pendingStartISO, _dragState.pendingEndISO);
    return;
  }
  _dragState.lastDelta = delta;
  const sD = parseDateLocal(_dragState.startISO);
  const eD = parseDateLocal(_dragState.endISO);
  if (!sD || !eD) return;
  let newS = new Date(sD), newE = new Date(eD);
  if (_dragState.mode === 'move') {
    newS.setDate(sD.getDate() + delta);
    newE.setDate(eD.getDate() + delta);
  } else if (_dragState.mode === 'start') {
    newS.setDate(sD.getDate() + delta);
    if (newS > eD) newS = new Date(eD);
  } else if (_dragState.mode === 'end') {
    newE.setDate(eD.getDate() + delta);
    if (newE < sD) newE = new Date(sD);
  }
  _dragState.pendingStartISO = dateToYMD(newS);
  _dragState.pendingEndISO = dateToYMD(newE);
  _dragState.changed = delta !== 0;
  _showTip(ev, _dragState.pendingStartISO, _dragState.pendingEndISO);
}

function _onEnd() {
  if (!_dragState) return;
  document.removeEventListener('mousemove', _onMove);
  document.removeEventListener('mouseup', _onEnd);
  _hideTip();

  const d = _dragState;
  _dragState = null;

  /* Cleanup: skini bar-dragging klasu */
  if (d.wrapEl) {
    d.wrapEl.querySelectorAll('.bar-dragging').forEach(c => c.classList.remove('bar-dragging'));
  }

  if (!d.changed) return;

  const ref = findPhaseAcrossAll(d.phaseId);
  if (!ref) return;
  ref.phase.start = d.pendingStartISO;
  ref.phase.end = d.pendingEndISO;
  applyBusinessRules(ref.phase);
  persistState();
  /* Save: za faze u aktivnom WP-u koristimo phase index, inače full WP sync */
  /* (jednostavnije: uvek queueCurrentWpSync ako je projektu/wp drugi nego aktivni;
     za aktivni — queuePhaseSaveByIndex po ref.idx) */
  queuePhaseSaveByIndex(ref.idx);
  queueCurrentWpSync();

  showToast('📅 ' + formatDate(d.pendingStartISO) + ' → ' + formatDate(d.pendingEndISO));
  _onChangeCb?.();
}

function _showTip(ev, sISO, eISO) {
  if (!_tipEl) {
    _tipEl = document.createElement('div');
    _tipEl.id = 'ganttDragTip';
    _tipEl.className = 'gantt-drag-tip';
    document.body.appendChild(_tipEl);
  }
  _tipEl.textContent = formatDate(sISO) + ' → ' + formatDate(eISO);
  _tipEl.style.left = (ev.clientX + 12) + 'px';
  _tipEl.style.top = (ev.clientY + 12) + 'px';
  _tipEl.style.display = 'block';
}

function _hideTip() {
  if (_tipEl) _tipEl.style.display = 'none';
}
