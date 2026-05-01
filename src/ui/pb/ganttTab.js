/**
 * Gantt tab — timeline po inženjeru, plan vs real trake.
 */

import { escHtml } from '../../lib/dom.js';
import { openTaskEditorModal } from './shared.js';
import { canEditProjektniBiro } from '../../state/auth.js';

/**
 * @param {object} task
 * @param {Date|string} startDate — prvi dan vidljivog opsega
 * @param {number} dayWidthPx
 * @returns {{ left: number, width: number } | null}
 */
export function ganttBarGeometry(task, startDate, dayWidthPx) {
  if (!task.datum_pocetka_plan || !task.datum_zavrsetka_plan) return null;
  const msPerDay = 86400000;
  const viewStart = new Date(startDate);
  viewStart.setHours(0, 0, 0, 0);
  const taskStart = new Date(String(task.datum_pocetka_plan).slice(0, 10) + 'T12:00:00');
  const taskEnd = new Date(String(task.datum_zavrsetka_plan).slice(0, 10) + 'T12:00:00');
  const ts = new Date(taskStart); ts.setHours(0, 0, 0, 0);
  const te = new Date(taskEnd); te.setHours(0, 0, 0, 0);
  const vs = viewStart.getTime();
  const leftDays = Math.max(0, Math.round((ts.getTime() - vs) / msPerDay));
  const spanDays = Math.max(1, Math.round((te.getTime() - ts.getTime()) / msPerDay) + 1);
  return {
    left: leftDays * dayWidthPx,
    width: Math.max(spanDays * dayWidthPx, 8),
  };
}

function parseYmd(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstOfMonth(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function lastDayOfMonth(base, monthOffset) {
  const x = new Date(base.getFullYear(), base.getMonth() + monthOffset + 1, 0);
  x.setHours(0, 0, 0, 0);
  return x;
}

function eachDay(from, to) {
  const out = [];
  const c = new Date(from);
  c.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (c <= end) {
    out.push(new Date(c));
    c.setDate(c.getDate() + 1);
  }
  return out;
}

function filterGanttTasks(tasks, search) {
  let list = tasks.slice();
  const q = (search || '').trim().toLowerCase();
  if (q) list = list.filter(t => String(t.naziv || '').toLowerCase().includes(q));
  return list;
}

function statusBarClass(status) {
  const s = String(status || '');
  if (s === 'Završeno') return 'pb-gantt-bar--done';
  if (s === 'Blokirano') return 'pb-gantt-bar--blocked';
  if (s === 'Pregled') return 'pb-gantt-bar--review';
  if (s === 'U toku') return 'pb-gantt-bar--progress';
  return 'pb-gantt-bar--new';
}

function groupTasks(tasks) {
  const byEng = new Map();
  const unassigned = [];
  for (const t of tasks) {
    if (!t.employee_id) {
      unassigned.push(t);
      continue;
    }
    const k = t.employee_id;
    if (!byEng.has(k)) byEng.set(k, []);
    byEng.get(k).push(t);
  }
  const engIds = Array.from(byEng.keys()).sort((a, b) => {
    const ta = tasks.find(x => x.employee_id === a);
    const tb = tasks.find(x => x.employee_id === b);
    return String(ta?.engineer_name || '').localeCompare(String(tb?.engineer_name || ''), 'sr');
  });
  for (const id of engIds) {
    byEng.get(id).sort((a, b) => {
      const da = a.datum_pocetka_plan || '';
      const db = b.datum_pocetka_plan || '';
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });
  }
  unassigned.sort((a, b) => (a.datum_pocetka_plan || '').localeCompare(b.datum_pocetka_plan || ''));
  return { engIds, byEng, unassigned };
}

function monthSpans(days) {
  const spans = [];
  let i = 0;
  while (i < days.length) {
    const m = days[i].getMonth();
    let len = 0;
    while (i + len < days.length && days[i + len].getMonth() === m) len += 1;
    const label = days[i].toLocaleString('sr-Latn', { month: 'long', year: 'numeric' });
    spans.push({ label, len });
    i += len;
  }
  return spans;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   tasks: object[],
 *   projects: object[],
 *   engineers: object[],
 *   search: string,
 *   viewMonth: Date,
 *   onViewMonthChange: (d: Date) => void,
 *   onRefresh: () => void,
 * }} ctx
 */
export function renderGanttTab(root, ctx) {
  const canEdit = canEditProjektniBiro();
  const mobile = window.matchMedia('(max-width: 767px)').matches;
  const dayW = mobile ? 20 : 28;
  const leftColW = mobile ? 130 : 180;

  const baseMonth = ctx.viewMonth ? new Date(ctx.viewMonth) : firstOfMonth();
  baseMonth.setDate(1);
  baseMonth.setHours(0, 0, 0, 0);

  const rangeStart = firstOfMonth(baseMonth);
  const rangeEnd = lastDayOfMonth(baseMonth, 1);
  const days = eachDay(rangeStart, rangeEnd);
  const totalW = days.length * dayW;
  const nDays = days.length;

  const list = filterGanttTasks(ctx.tasks || [], ctx.search);
  const { engIds, byEng, unassigned } = groupTasks(list);

  let tipTimer = null;
  let tipNode = null;

  function hideTip() {
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = null;
    tipNode?.remove();
    tipNode = null;
  }

  function showTip(html, clientX, clientY) {
    hideTip();
    tipNode = document.createElement('div');
    tipNode.className = 'pb-gantt-tip';
    tipNode.innerHTML = html;
    const x = Math.max(8, Math.min(clientX, window.innerWidth - 220));
    const y = clientY + 8;
    tipNode.style.left = `${x}px`;
    tipNode.style.top = `${y}px`;
    document.body.appendChild(tipNode);
    tipTimer = setTimeout(hideTip, 2000);
  }

  function tooltipHtml(task) {
    const pct = Math.min(100, Number(task.procenat_zavrsenosti) || 0);
    const dur =
      task.datum_pocetka_plan && task.datum_zavrsetka_plan
        ? Math.max(
          1,
          Math.round(
            (parseYmd(task.datum_zavrsetka_plan).getTime() - parseYmd(task.datum_pocetka_plan).getTime()) / 86400000,
          ) + 1,
        )
        : '—';
    return [
      escHtml(task.naziv || ''),
      `Projekat: ${escHtml(task.project_code || '—')}`,
      `Plan: ${escHtml((task.datum_pocetka_plan || '').slice(0, 10))} — ${escHtml((task.datum_zavrsetka_plan || '').slice(0, 10))}`,
      `Trajanje: ${dur} dana`,
      `Status: ${escHtml(task.status || '')}`,
      `Inženjer: ${escHtml(task.engineer_name || '—')}`,
      `Završenost: ${pct}%`,
    ].join('<br/>');
  }

  function barsHtml(task) {
    const geo = ganttBarGeometry(task, rangeStart, dayW);
    const pct = Math.min(100, Number(task.procenat_zavrsenosti) || 0);
    const cls = statusBarClass(task.status);
    let inner = '';
    if (geo) {
      inner += `<div class="pb-gantt-bar ${cls}" style="left:${geo.left}px;width:${geo.width}px" tabindex="0">
        <div class="pb-gantt-bar__prog" style="width:${pct}%"></div>
      </div>`;
      if (task.datum_pocetka_real && task.datum_zavrsetka_real) {
        const tReal = {
          ...task,
          datum_pocetka_plan: task.datum_pocetka_real,
          datum_zavrsetka_plan: task.datum_zavrsetka_real,
        };
        const g2 = ganttBarGeometry(tReal, rangeStart, dayW);
        if (g2) {
          inner += `<div class="pb-gantt-real" style="left:${g2.left}px;width:${g2.width}px"></div>`;
        }
      }
    }
    return `<div class="pb-gantt-bar-host" style="width:${totalW}px">${inner}</div>`;
  }

  const spans = monthSpans(days);
  const monthRow = spans.map(s =>
    `<th class="pb-gantt-th-month" colspan="${s.len}" style="min-width:${s.len * dayW}px">${escHtml(s.label)}</th>`,
  ).join('');

  const today = new Date();
  const dayRow = days.map(d => {
    const dow = d.getDay();
    const isW = dow === 0 || dow === 6;
    const isToday =
      d.getDate() === today.getDate()
      && d.getMonth() === today.getMonth()
      && d.getFullYear() === today.getFullYear();
    let cls = 'pb-gantt-daycell';
    if (isW) cls += ' pb-gantt-daycell--wknd';
    if (isToday) cls += ' pb-gantt-daycell--today';
    return `<th class="${cls}" style="width:${dayW}px;min-width:${dayW}px">${escHtml(String(d.getDate()).padStart(2, '0'))}</th>`;
  }).join('');

  let todayIdx = -1;
  days.forEach((d, i) => {
    if (
      d.getDate() === today.getDate()
      && d.getMonth() === today.getMonth()
      && d.getFullYear() === today.getFullYear()
    ) todayIdx = i;
  });

  const tbodyRows = [];

  for (const eid of engIds) {
    const ts = byEng.get(eid);
    const name = ts[0]?.engineer_name || '—';
    tbodyRows.push(`<tr class="pb-gantt-group">
      <td class="pb-gantt-label pb-gantt-label--grp pb-gantt-sticky-col">${escHtml(name)}</td>
      <td class="pb-gantt-track pb-gantt-track--grp" colspan="${nDays}" style="min-width:${totalW}px"></td>
    </tr>`);
    for (const t of ts) {
      tbodyRows.push(`<tr class="pb-gantt-task-row" data-task-id="${escHtml(t.id)}">
        <td class="pb-gantt-label pb-gantt-name pb-gantt-sticky-col">${escHtml(t.naziv || '')}</td>
        <td class="pb-gantt-track" colspan="${nDays}" style="min-width:${totalW}px">${barsHtml(t)}</td>
      </tr>`);
    }
  }

  if (unassigned.length) {
    tbodyRows.push(`<tr class="pb-gantt-group">
      <td class="pb-gantt-label pb-gantt-label--grp pb-gantt-sticky-col">Bez inženjera</td>
      <td class="pb-gantt-track pb-gantt-track--grp" colspan="${nDays}" style="min-width:${totalW}px"></td>
    </tr>`);
    for (const t of unassigned) {
      tbodyRows.push(`<tr class="pb-gantt-task-row" data-task-id="${escHtml(t.id)}">
        <td class="pb-gantt-label pb-gantt-name pb-gantt-sticky-col">${escHtml(t.naziv || '')}</td>
        <td class="pb-gantt-track" colspan="${nDays}" style="min-width:${totalW}px">${barsHtml(t)}</td>
      </tr>`);
    }
  }

  const navLabel = baseMonth.toLocaleString('sr-Latn', { month: 'long', year: 'numeric' });

  const legend = list.length ? `
    <div class="pb-gantt-legend">
      <span><span class="pb-gantt-dot pb-gantt-bar--new"></span> Nije počelo</span>
      <span><span class="pb-gantt-dot pb-gantt-bar--progress"></span> U toku</span>
      <span><span class="pb-gantt-dot pb-gantt-bar--review"></span> Pregled</span>
      <span><span class="pb-gantt-dot pb-gantt-bar--blocked"></span> Blokirano</span>
      <span><span class="pb-gantt-dot pb-gantt-bar--done"></span> Završeno</span>
      <span><span class="pb-gantt-real-leg"></span> Ostvareni period</span>
      <span><span class="pb-gantt-today-mark"></span> Danas</span>
    </div>` : '';

  const empty = !list.length ? `
    <div class="pb-gantt-empty">
      <div class="pb-gantt-empty-icon" aria-hidden="true">📅</div>
      <p>Nema zadataka za prikaz</p>
      <p class="pb-muted">Promenite filtere ili dodajte novi zadatak.</p>
      ${canEdit ? '<button type="button" class="btn btn-primary" id="pbGanttNew">+ Novi zadatak</button>' : ''}
    </div>` : '';

  const scrollBlock = list.length ? `
    ${legend}
    <div class="pb-gantt-toolbar">
      <button type="button" class="btn btn-sm" id="pbGanttPrev">← Prethodni mesec</button>
      <strong id="pbGanttMonthLabel">${escHtml(navLabel)}</strong>
      <button type="button" class="btn btn-sm" id="pbGanttNext">Sledeći mesec →</button>
      <button type="button" class="btn btn-sm" id="pbGanttToday">Danas</button>
    </div>
    <div class="pb-gantt-scroll" style="--pb-gantt-left:${leftColW}px">
      <table class="pb-gantt-table">
        <thead>
          <tr>
            <th class="pb-gantt-corner pb-gantt-sticky-col" rowspan="2">Inženjer / Zadatak</th>
            ${monthRow}
          </tr>
          <tr>${dayRow}</tr>
        </thead>
        <tbody>${tbodyRows.join('')}</tbody>
      </table>
      ${todayIdx >= 0 ? `<div class="pb-gantt-today-line" style="left:calc(var(--pb-gantt-left) + ${todayIdx * dayW + dayW / 2}px)"></div>` : ''}
    </div>` : '';

  root.innerHTML = empty || scrollBlock;

  const scrollEl = root.querySelector('.pb-gantt-scroll');

  root.querySelector('#pbGanttPrev')?.addEventListener('click', () => {
    const d = new Date(baseMonth);
    d.setMonth(d.getMonth() - 1);
    ctx.onViewMonthChange?.(d);
  });
  root.querySelector('#pbGanttNext')?.addEventListener('click', () => {
    const d = new Date(baseMonth);
    d.setMonth(d.getMonth() + 1);
    ctx.onViewMonthChange?.(d);
  });
  root.querySelector('#pbGanttToday')?.addEventListener('click', () => {
    if (!scrollEl || todayIdx < 0) return;
    const target = Math.max(0, todayIdx * dayW - 4 * dayW);
    scrollEl.scrollTo({ left: target, behavior: 'smooth' });
  });

  root.querySelector('#pbGanttNew')?.addEventListener('click', () => {
    openTaskEditorModal({
      task: null,
      projects: ctx.projects,
      engineers: ctx.engineers,
      canEdit,
      onSaved: () => ctx.onRefresh?.(),
    });
  });

  root.querySelectorAll('.pb-gantt-task-row .pb-gantt-name').forEach(td => {
    td.addEventListener('click', () => {
      const tr = td.closest('.pb-gantt-task-row');
      const id = tr?.getAttribute('data-task-id');
      const task = list.find(x => x.id === id);
      if (!task) return;
      openTaskEditorModal({
        task,
        projects: ctx.projects,
        engineers: ctx.engineers,
        canEdit,
        onSaved: () => ctx.onRefresh?.(),
      });
    });
  });

  root.querySelectorAll('.pb-gantt-bar').forEach(bar => {
    const row = bar.closest('.pb-gantt-task-row');
    const id = row?.getAttribute('data-task-id');
    const task = list.find(x => x.id === id);
    if (!task) return;
    const html = tooltipHtml(task);

    bar.addEventListener('touchstart', e => {
      const touch = e.changedTouches?.[0];
      if (touch) showTip(html, touch.clientX, touch.clientY);
    }, { passive: true });

    bar.addEventListener('mouseenter', e => {
      if (!mobile) showTip(html, e.clientX, e.clientY);
    });

    bar.addEventListener('click', e => {
      e.stopPropagation();
      hideTip();
      openTaskEditorModal({
        task,
        projects: ctx.projects,
        engineers: ctx.engineers,
        canEdit,
        onSaved: () => ctx.onRefresh?.(),
      });
    });
  });

  root.addEventListener('click', e => {
    if (!e.target.closest('.pb-gantt-bar') && !e.target.closest('.pb-gantt-tip')) hideTip();
  });
}
