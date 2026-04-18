/**
 * Plan Montaže — Total Gantt (F5.4).
 *
 * Prikazuje agregirani gantogram svih projekata, sa:
 *   - Filterima: projekat, lokacija, vođa, inženjer, datum od / datum do
 *   - Per-WP checkbox listom (kontrola koje pozicije ulaze u prikaz)
 *   - Show finished toggle (deli sa single gantt-om)
 *   - Drag/resize (radi i ovde — koristi isti `wireGanttDrag`)
 *   - Kolona-selekcija (Shift+klik raspon)
 *
 * Raspon datuma: koristi `dateFrom`/`dateTo` ako su zadati, inače pravi
 * realan opseg iz filtriranih faza, klampovan na 730 dana (2 god.) za
 * performanse.
 *
 * Renderuje grupisane redove: projekat header → WP header → faze.
 */

import { escHtml } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  allData,
  totalGanttFilters,
  totalGanttWPs,
  resetTotalGanttFilters,
  selectedDateIndices,
  lastSelectedDateIndex,
  showFinishedInGantt,
  setShowFinishedInGantt,
  getLocationColor,
  ENGINEERS,
  VODJA,
} from '../../state/planMontaze.js';
import { STATUSES } from '../../lib/constants.js';
import { parseDateLocal, today } from '../../lib/date.js';
import { calcRisk, normalizePhaseType } from '../../lib/phase.js';
import { buildDayRange, buildMonthsHeader } from '../../lib/gantt.js';
import { wireGanttDrag } from './ganttDrag.js';

/* WP group header palette (rotira) */
const WP_HEADER_COLORS = ['#1f3a6e', '#1a3a1a', '#3a2800', '#2a0a2a', '#002a2a'];

/* ── PUBLIC ──────────────────────────────────────────────────────────── */

export function totalGanttSectionHtml() {
  if (!(allData.projects || []).length) {
    return `
      <div class="form-card">
        <h3>Nema projekata</h3>
        <p class="form-hint">Total gantogram nema šta da prikaže — kreiraj prvo bar jedan projekat.</p>
      </div>
    `;
  }
  return `
    ${_filtersHtml()}
    ${_wpFilterHtml()}
    ${_toolbarHtml()}
    <div class="gantt-wrap" id="totalGanttWrap">${_tableHtml()}</div>
  `;
}

export function wireTotalGanttSection(root, { onChange } = {}) {
  /* Filter selektori */
  ['projectId', 'loc', 'lead', 'engineer', 'dateFrom', 'dateTo'].forEach(key => {
    const el = root.querySelector(`[data-tg-filter="${key}"]`);
    if (!el) return;
    el.addEventListener('change', () => {
      totalGanttFilters[key] = el.value;
      _clearDaySelection('total');
      onChange?.();
    });
  });

  /* Reset filtera */
  root.querySelector('#tgReset')?.addEventListener('click', () => {
    resetTotalGanttFilters();
    _clearDaySelection('total');
    onChange?.();
  });

  /* Per-WP checkbox-i */
  root.querySelectorAll('[data-tg-wp]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.tgWp;
      totalGanttWPs[id] = cb.checked;
      onChange?.();
    });
  });

  /* Show finished toggle */
  root.querySelector('#tgShowFinished')?.addEventListener('change', (ev) => {
    setShowFinishedInGantt(ev.target.checked);
    onChange?.();
  });

  /* Day header click — selekcija kolone */
  root.querySelectorAll('.gantt-day-hdr').forEach(th => {
    th.addEventListener('click', (ev) => {
      const idx = Number(th.dataset.didx);
      if (Number.isNaN(idx)) return;
      _onDayHeaderClick(ev, 'total', idx, root);
    });
  });

  /* Drag / resize */
  const wrapEl = root.querySelector('#totalGanttWrap');
  wireGanttDrag(wrapEl, { onChange });
}

/* ── INTERNAL: filter UI ────────────────────────────────────────────── */

function _filtersHtml() {
  const projects = allData.projects || [];
  const projOpts = ['<option value="">Svi projekti</option>'].concat(
    projects.map(p => `<option value="${escHtml(p.id)}"${totalGanttFilters.projectId === p.id ? ' selected' : ''}>${escHtml(p.code)} — ${escHtml(p.name)}</option>`)
  ).join('');

  const allLocs = new Set();
  projects.forEach(p => (p.locations || []).forEach(l => l && allLocs.add(l)));
  projects.forEach(p => (p.workPackages || []).forEach(wp => (wp.phases || []).forEach(ph => ph.loc && allLocs.add(ph.loc))));
  const locOpts = ['<option value="">Sve lokacije</option>'].concat(
    Array.from(allLocs).sort().map(l => `<option value="${escHtml(l)}"${totalGanttFilters.loc === l ? ' selected' : ''}>${escHtml(l)}</option>`)
  ).join('');

  const leadOpts = ['<option value="">Svi vođe</option>'].concat(
    VODJA.filter(v => v).map(v => `<option value="${escHtml(v)}"${totalGanttFilters.lead === v ? ' selected' : ''}>${escHtml(v)}</option>`)
  ).join('');
  const engOpts = ['<option value="">Svi inženjeri</option>'].concat(
    ENGINEERS.filter(v => v).map(v => `<option value="${escHtml(v)}"${totalGanttFilters.engineer === v ? ' selected' : ''}>${escHtml(v)}</option>`)
  ).join('');

  return `
    <div class="filter-bar tg-filter-bar" id="totalGanttFilters">
      <label class="fb-field"><span>Projekat</span><select data-tg-filter="projectId">${projOpts}</select></label>
      <label class="fb-field"><span>Lokacija</span><select data-tg-filter="loc">${locOpts}</select></label>
      <label class="fb-field"><span>Vođa montaže</span><select data-tg-filter="lead">${leadOpts}</select></label>
      <label class="fb-field"><span>Odg. inženjer</span><select data-tg-filter="engineer">${engOpts}</select></label>
      <label class="fb-field"><span>Datum od</span><input type="date" data-tg-filter="dateFrom" value="${escHtml(totalGanttFilters.dateFrom || '')}"></label>
      <label class="fb-field"><span>Datum do</span><input type="date" data-tg-filter="dateTo" value="${escHtml(totalGanttFilters.dateTo || '')}"></label>
      <div class="fb-actions">
        <button type="button" class="btn btn-ghost" id="tgReset" title="Resetuj filtere">↺ Reset</button>
      </div>
    </div>
  `;
}

function _wpFilterHtml() {
  const projects = (allData.projects || []).filter(p => !totalGanttFilters.projectId || p.id === totalGanttFilters.projectId);
  const allWPs = [];
  projects.forEach(p => (p.workPackages || []).forEach(wp => {
    allWPs.push({ wp, project: p });
    if (totalGanttWPs[wp.id] === undefined) totalGanttWPs[wp.id] = true;
  }));
  if (!allWPs.length) {
    return '<div class="tg-wp-filter"><span class="tg-wp-empty">Nema pozicija</span></div>';
  }
  return `
    <div class="tg-wp-filter">
      <span class="tg-wp-label">Pozicije:</span>
      ${allWPs.map(({ wp, project }) => `
        <label class="tg-wp-chip">
          <input type="checkbox" data-tg-wp="${escHtml(wp.id)}" ${totalGanttWPs[wp.id] ? 'checked' : ''}>
          ${escHtml(project.code)}/${escHtml(wp.name)}
        </label>
      `).join('')}
    </div>
  `;
}

function _toolbarHtml() {
  return `
    <div class="gantt-toolbar">
      <label class="gantt-toggle">
        <input type="checkbox" id="tgShowFinished" ${showFinishedInGantt ? 'checked' : ''}>
        <span>Prikaži završene faze</span>
      </label>
      <span class="gantt-hint">Drag bare za pomeranje · ručice za promenu datuma · Shift+klik na header za raspon</span>
    </div>
  `;
}

/* ── INTERNAL: table rendering ──────────────────────────────────────── */

function _tableHtml() {
  const f = totalGanttFilters;
  const projects = (allData.projects || []).filter(p => !f.projectId || p.id === f.projectId);

  const rows = [];
  projects.forEach(project => {
    (project.workPackages || []).forEach(wp => {
      if (!totalGanttWPs[wp.id]) return;
      (wp.phases || []).forEach(ph => {
        if (!showFinishedInGantt && ph.status === 2) return;
        if (f.loc && ph.loc !== f.loc) return;
        if (f.lead && ph.person !== f.lead) return;
        if (f.engineer && ph.engineer !== f.engineer) return;
        if (f.dateFrom || f.dateTo) {
          if (!ph.start && !ph.end) return;
          const _sD = parseDateLocal(ph.start);
          const _eD = parseDateLocal(ph.end);
          const s = _sD ? _sD.getTime() : null;
          const e = _eD ? _eD.getTime() : s;
          if (f.dateTo) {
            const _to = parseDateLocal(f.dateTo);
            if (_to && s !== null && s > _to.getTime()) return;
          }
          if (f.dateFrom) {
            const _from = parseDateLocal(f.dateFrom);
            const cmp = e !== null ? e : s;
            if (_from && cmp !== null && cmp < _from.getTime()) return;
          }
        }
        rows.push({ project, wp, phase: ph });
      });
    });
  });

  if (!rows.length) {
    return '<div class="gantt-empty">Nema faza po trenutnim filterima.</div>';
  }

  /* Raspon datuma */
  let min, max;
  if (f.dateFrom) {
    min = parseDateLocal(f.dateFrom) || new Date(today);
  } else {
    min = new Date(today);
    rows.forEach(r => { const d = parseDateLocal(r.phase.start); if (d && d < min) min = d; });
    min.setDate(min.getDate() - 3);
  }
  if (f.dateTo) {
    max = parseDateLocal(f.dateTo) || new Date(today);
  } else {
    max = new Date(today); max.setDate(max.getDate() + 60);
    rows.forEach(r => { const d = parseDateLocal(r.phase.end); if (d && d > max) max = d; });
    max.setDate(max.getDate() + 5);
  }
  min.setHours(0, 0, 0, 0); max.setHours(0, 0, 0, 0);
  const daysBetween = Math.round((max - min) / 864e5);
  if (daysBetween > 730) { max = new Date(min); max.setDate(min.getDate() + 730); }

  const days = buildDayRange(min, max);
  const months = buildMonthsHeader(days);
  const monthsRow = Object.values(months).map(m => `<th class="gantt-month-hdr" colspan="${m.count}">${escHtml(m.label)}</th>`).join('');
  const daysRow = _dayHeaderHtml(days, 'total');

  /* Grupiši po projektu → poziciji */
  const grouped = new Map();
  rows.forEach(r => {
    const pk = r.project.id;
    if (!grouped.has(pk)) grouped.set(pk, { project: r.project, wps: new Map() });
    const wpMap = grouped.get(pk).wps;
    if (!wpMap.has(r.wp.id)) wpMap.set(r.wp.id, { wp: r.wp, phases: [] });
    wpMap.get(r.wp.id).phases.push(r.phase);
  });

  const tc = days.length;
  let html = `<table class="gantt-table" data-view="total"><thead>
    <tr><th class="gantt-label" rowspan="2" style="min-width:260px">Projekat / Pozicija / Faza</th>${monthsRow}</tr>
    <tr>${daysRow}</tr>
  </thead><tbody>`;

  grouped.forEach(({ project, wps }) => {
    html += `<tr class="gantt-machine-hdr"><td colspan="${tc + 1}" class="tg-project-hdr">📁 ${escHtml(project.code)} — ${escHtml(project.name)}</td></tr>`;
    let wpIdx = 0;
    wps.forEach(({ wp, phases }) => {
      const bg = WP_HEADER_COLORS[wpIdx % WP_HEADER_COLORS.length];
      html += `<tr class="gantt-machine-hdr"><td colspan="${tc + 1}" class="tg-wp-hdr" style="background:${bg}">⚙ ${escHtml(wp.name)} <span class="tg-wp-rn">${escHtml(wp.rnCode || '')}</span></td></tr>`;
      phases.forEach(row => {
        html += _phaseRowHtml(row, project, wp, days);
      });
      wpIdx++;
    });
  });
  html += '</tbody></table>';
  return html;
}

function _phaseRowHtml(row, project, wp, days) {
  const _sD = parseDateLocal(row.start);
  const _eD = parseDateLocal(row.end);
  const sMs = _sD ? _sD.getTime() : null;
  const eMs = _eD ? _eD.getTime() : null;
  const rk = calcRisk(row);
  const rkC = rk.level !== 'none' ? ' gantt-row-risk' : '';
  const eng = row.engineer ? row.engineer.split(' ').pop() : '';
  const ld = row.person ? row.person.split(' ').pop() : '';
  const locColor = getLocationColor(row.loc);
  const sel = selectedDateIndices.total;
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

  return `<tr class="gantt-row${rkC}" data-phase-id="${phaseId}" data-project-id="${escHtml(project.id)}" data-wp-id="${escHtml(wp.id)}">
    <td class="gantt-label tg-phase-label" style="border-left:3px solid ${locColor}">
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

/* ── INTERNAL: column selection ─────────────────────────────────────── */

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

function _clearDaySelection(viewKey) {
  selectedDateIndices[viewKey].clear();
  lastSelectedDateIndex[viewKey] = null;
}
