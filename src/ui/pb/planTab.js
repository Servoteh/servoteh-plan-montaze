/**
 * Tab Plan — kartice (mobilni) + tabela (desktop), statistike, alarmi, load meter.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  PB_TASK_STATUS,
  PB_TASK_VRSTA,
  PB_PRIORITET,
  statusBadgeClass,
  prioClass,
  openTaskEditorModal,
  openTextAreaModal,
  confirmDeletePbTask,
  loadPbState,
  syncPbModuleFilters,
} from './shared.js';
import { updatePbTask } from '../../services/pb.js';
import { canEditProjektniBiro } from '../../state/auth.js';

function parseYmd(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Broj radnih dana (pon–pet) između dva datuma uključujući krajeve. */
export function countWorkdaysBetween(a, b) {
  const da = parseYmd(a);
  const db = parseYmd(b);
  if (!da || !db) return null;
  let x = startOfDay(da <= db ? da : db);
  const end = startOfDay(da <= db ? db : da);
  let n = 0;
  while (x <= end) {
    const dow = x.getDay();
    if (dow !== 0 && dow !== 6) n += 1;
    x = new Date(x);
    x.setDate(x.getDate() + 1);
  }
  return n;
}

function delayRealEnd(task) {
  const planEnd = parseYmd(task.datum_zavrsetka_plan);
  const realEnd = parseYmd(task.datum_zavrsetka_real);
  if (!planEnd || !realEnd) return null;
  const diff = Math.round((startOfDay(realEnd) - startOfDay(planEnd)) / 86400000);
  return diff > 0 ? diff : null;
}

function filterTasks(tasks, f) {
  let list = tasks.slice();
  const q = (f.search || '').trim().toLowerCase();
  if (q) {
    list = list.filter(t => String(t.naziv || '').toLowerCase().includes(q));
  }
  if (f.status && f.status !== 'all') {
    list = list.filter(t => t.status === f.status);
  }
  if (f.vrsta && f.vrsta !== 'all') {
    list = list.filter(t => t.vrsta === f.vrsta);
  }
  if (f.prioritet && f.prioritet !== 'all') {
    list = list.filter(t => t.prioritet === f.prioritet);
  }
  if (!f.showDone) {
    list = list.filter(t => t.status !== 'Završeno');
  }
  if (f.problemOnly) {
    list = list.filter(t => String(t.problem || '').trim().length > 0);
  }
  return list;
}

function sortTasks(list, col, dir) {
  const m = dir === 'desc' ? -1 : 1;
  const cmp = (a, b) => {
    if (col === 'naziv') return m * String(a.naziv || '').localeCompare(String(b.naziv || ''), 'sr');
    if (col === 'project') {
      const pa = `${a.project_code || ''} ${a.project_name || ''}`;
      const pb = `${b.project_code || ''} ${b.project_name || ''}`;
      return m * pa.localeCompare(pb, 'sr');
    }
    if (col === 'engineer') return m * String(a.engineer_name || '').localeCompare(String(b.engineer_name || ''), 'sr');
    if (col === 'vrsta') return m * String(a.vrsta || '').localeCompare(String(b.vrsta || ''), 'sr');
    if (col === 'datumi') {
      const da = a.datum_zavrsetka_plan || '';
      const db = b.datum_zavrsetka_plan || '';
      return m * da.localeCompare(db);
    }
    if (col === 'trajanje') {
      const ta = countWorkdaysBetween(a.datum_pocetka_plan, a.datum_zavrsetka_plan) ?? -1;
      const tb = countWorkdaysBetween(b.datum_pocetka_plan, b.datum_zavrsetka_plan) ?? -1;
      return m * (ta - tb);
    }
    if (col === 'status') return m * String(a.status || '').localeCompare(String(b.status || ''), 'sr');
    if (col === 'pct') return m * ((Number(a.procenat_zavrsenosti) || 0) - (Number(b.procenat_zavrsenosti) || 0));
    if (col === 'prio') {
      const order = { Visok: 0, Srednji: 1, Nizak: 2 };
      return m * ((order[a.prioritet] ?? 9) - (order[b.prioritet] ?? 9));
    }
    if (col === 'norma') return m * ((Number(a.norma_sati_dan) || 0) - (Number(b.norma_sati_dan) || 0));
    return 0;
  };
  return list.slice().sort(cmp);
}

function buildAlarms(tasks, loadRows) {
  const alarms = [];
  const today = startOfDay(new Date());

  for (const t of tasks) {
    const done = t.status === 'Završeno';
    const planEnd = parseYmd(t.datum_zavrsetka_plan);
    const planStart = parseYmd(t.datum_pocetka_plan);
    if (!done && planEnd) {
      const days = Math.round((startOfDay(planEnd) - today) / 86400000);
      if (days < 0) {
        alarms.push({ level: 'red', text: `Rok prošao: ${t.naziv || '(bez naziva)'}` });
      } else if (days <= 3) {
        alarms.push({ level: 'yellow', text: `Rok za ≤3 dana: ${t.naziv || ''}` });
      }
    }
    if (!done && planStart) {
      const ds = Math.round((startOfDay(planStart) - today) / 86400000);
      if (ds >= 0 && ds <= 3 && !t.employee_id) {
        alarms.push({ level: 'yellow', text: `Počinje za ≤3 dana, nema inženjera: ${t.naziv || ''}` });
      }
    }
    if (!done && planStart && startOfDay(planStart) < today && !t.employee_id) {
      alarms.push({ level: 'red', text: `Počelo bez inženjera: ${t.naziv || ''}` });
    }
  }

  const seenLoad = new Set();
  for (const r of loadRows || []) {
    if (Number(r.load_pct) > 100 && r.employee_id && !seenLoad.has(r.employee_id)) {
      seenLoad.add(r.employee_id);
      alarms.push({
        level: 'red',
        text: `Prekoračenje kapaciteta (${r.load_pct}%): ${r.full_name || ''}`,
      });
    }
  }

  return alarms;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   tasks: object[],
 *   projects: object[],
 *   engineers: object[],
 *   loadStats: object[],
 *   onRefresh: () => void,
 * }} ctx
 */
export function renderPlanTab(root, ctx) {
  const canEdit = canEditProjektniBiro();
  const pbMod = loadPbState();
  let filters = {
    search: pbMod.moduleSearch ?? '',
    status: 'all',
    vrsta: 'all',
    prioritet: 'all',
    showDone: pbMod.moduleShowDone ?? false,
    problemOnly: false,
  };
  let sortCol = 'datumi';
  let sortDir = 'asc';

  function filtered() {
    return filterTasks(ctx.tasks || [], filters);
  }

  function paint() {
    const tasks = filtered();
    const sorted = sortTasks(tasks, sortCol, sortDir);
    const alarms = buildAlarms(ctx.tasks || [], ctx.loadStats || []);

    const total = tasks.length;
    const doneN = tasks.filter(t => t.status === 'Završeno').length;
    const pctDone = total ? Math.round((doneN / total) * 100) : 0;
    const blockedN = tasks.filter(t => t.status === 'Blokirano').length;
    const normSum = tasks
      .filter(t => t.status !== 'Završeno')
      .reduce((s, t) => s + (Number(t.norma_sati_dan) || 0), 0);

    const alarmHtml = alarms.length
      ? `<div class="pb-alarm-box" role="alert">
          ${alarms.map(a => `<div class="pb-alarm pb-alarm--${escHtml(a.level)}">${escHtml(a.text)}</div>`).join('')}
        </div>`
      : '';

    const loadHtml = (ctx.loadStats || []).map(r => {
      const p = Number(r.load_pct) || 0;
      let bar = 'pb-load-bar__fill';
      if (p >= 80 && p <= 100) bar += ' pb-load-bar__fill--warn';
      if (p > 100) bar += ' pb-load-bar__fill--danger';
      else if (p < 80) bar += ' pb-load-bar__fill--ok';
      return `
        <div class="pb-load-row">
          <span class="pb-load-name">${escHtml(r.full_name || '')}</span>
          <div class="pb-load-bar" aria-hidden="true"><div class="${bar}" style="width:${Math.min(p, 150)}%"></div></div>
          <span class="pb-load-pct">${p}%</span>
        </div>`;
    }).join('');

    const statsHtml = `
      <div class="pb-stats-grid">
        <div class="pb-stat-card"><span>Ukupno zadataka</span><strong>${total}</strong></div>
        <div class="pb-stat-card"><span>Završeno</span><strong>${pctDone}%</strong></div>
        <div class="pb-stat-card"><span>Norma ∑ (h/dan)</span><strong>${normSum}</strong></div>
        <div class="pb-stat-card"><span>Blokirano</span><strong>${blockedN}</strong></div>
      </div>`;

    const filterHtml = `
      <div class="pb-filter-bar">
        <input type="search" class="pb-search" placeholder="Pretraži naziv…" id="pbSearch" value="${escHtml(filters.search)}" />
        <select id="pbFStatus">
          <option value="all">Status: svi</option>
          ${PB_TASK_STATUS.map(s => `<option value="${escHtml(s)}" ${filters.status === s ? 'selected' : ''}>${escHtml(s)}</option>`).join('')}
        </select>
        <select id="pbFVrsta">
          <option value="all">Vrsta: sve</option>
          ${PB_TASK_VRSTA.map(s => `<option value="${escHtml(s)}" ${filters.vrsta === s ? 'selected' : ''}>${escHtml(s)}</option>`).join('')}
        </select>
        <select id="pbFPrio">
          <option value="all">Prioritet: svi</option>
          ${PB_PRIORITET.map(s => `<option value="${escHtml(s)}" ${filters.prioritet === s ? 'selected' : ''}>${escHtml(s)}</option>`).join('')}
        </select>
        <label class="pb-check"><input type="checkbox" id="pbFDone" ${filters.showDone ? 'checked' : ''} /> Prikaži završene</label>
        <button type="button" class="btn btn-sm" id="pbFProb">${filters.problemOnly ? '✓ ' : ''}Samo sa problemom</button>
        <button type="button" class="btn btn-sm" id="pbFReset">Resetuj</button>
      </div>`;

    const cardsHtml = sorted.map(t => {
      const strike = t.status === 'Završeno' ? ' style="text-decoration:line-through;opacity:.85"' : '';
      const projLabel = [t.project_code, t.project_name].filter(Boolean).join(' — ');
      const wd = countWorkdaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan);
      const delay = delayRealEnd(t);
      const delayTxt = delay ? `+${delay}d` : '';
      return `
        <article class="pb-card">
          <div class="pb-card-head">
            <h3 class="pb-card-title"${strike}>${escHtml(t.naziv || '')}</h3>
            <span class="${statusBadgeClass(t.status)}">${escHtml(t.status || '')}</span>
          </div>
          <div class="pb-card-meta">${escHtml(projLabel)} · ${escHtml(t.vrsta || '')}</div>
          ${String(t.problem || '').trim() ? `<div class="pb-problem-badge">⚠ problem</div>` : ''}
          <div class="pb-card-engineer">
            <span class="pb-avatar">${escHtml((t.engineer_name || '?').slice(0, 1))}</span>
            <span>${escHtml(t.engineer_name || '—')}</span>
          </div>
          <div class="pb-card-dates">
            <span>Plan poč.</span><span>${escHtml((t.datum_pocetka_plan || '').slice(0, 10) || '—')}</span>
            <span>Plan rok</span><span>${escHtml((t.datum_zavrsetka_plan || '').slice(0, 10) || '—')}</span>
            <span>Real poč.</span><span>${escHtml((t.datum_pocetka_real || '').slice(0, 10) || '—')}</span>
            <span>Real zavr.</span><span>${escHtml((t.datum_zavrsetka_real || '').slice(0, 10) || '—')} ${delayTxt ? `<em>${escHtml(delayTxt)}</em>` : ''}</span>
          </div>
          <div class="pb-card-metrics">
            <span>Trajanje</span><strong>${wd != null ? wd + ' rd' : '—'}</strong>
            <span>Norma</span><strong>${Number(t.norma_sati_dan) || 0} h/d</strong>
            <span class="${prioClass(t.prioritet)}">${escHtml(t.prioritet || '')}</span>
          </div>
          <div class="pb-progress"><div class="pb-progress-fill" style="width:${Math.min(100, Number(t.procenat_zavrsenosti) || 0)}%"></div></div>
          <div class="pb-card-actions">
            ${canEdit ? `<button type="button" class="btn btn-sm pb-act-edit" data-id="${escHtml(t.id)}">✏ Izmeni</button>` : ''}
            <button type="button" class="btn btn-sm pb-act-desc" data-id="${escHtml(t.id)}">📄 Opis</button>
            ${canEdit ? `<button type="button" class="btn btn-sm pb-act-prob" data-id="${escHtml(t.id)}">⚠ Problem</button>` : ''}
            ${canEdit ? `<button type="button" class="btn btn-sm pb-act-del" data-id="${escHtml(t.id)}">✕ Briši</button>` : ''}
          </div>
        </article>`;
    }).join('');

    const th = (col, label) => {
      const active = sortCol === col;
      const arrow = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      return `<th scope="col"><button type="button" class="pb-th" data-sort="${escHtml(col)}">${escHtml(label)}${arrow}</button></th>`;
    };

    const rowsHtml = sorted.map((t, i) => {
      const wd = countWorkdaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan);
      const proj = [t.project_code, t.project_name].filter(Boolean).join(' ');
      const strike = t.status === 'Završeno' ? ' class="pb-done"' : '';
      return `<tr${strike}>
        <td>${i + 1}</td>
        <td>${escHtml(t.naziv || '')}</td>
        <td>${escHtml(proj)}</td>
        <td>${escHtml(t.engineer_name || '—')}</td>
        <td>${escHtml(t.vrsta || '')}</td>
        <td>${escHtml((t.datum_pocetka_plan || '').slice(0, 10))} → ${escHtml((t.datum_zavrsetka_plan || '').slice(0, 10))}</td>
        <td>${wd != null ? wd : '—'}</td>
        <td><span class="${statusBadgeClass(t.status)}">${escHtml(t.status || '')}</span></td>
        <td>${Number(t.procenat_zavrsenosti) || 0}%</td>
        <td><span class="${prioClass(t.prioritet)}">${escHtml(t.prioritet || '')}</span></td>
        <td>${Number(t.norma_sati_dan) || 0}</td>
        <td class="pb-row-actions">
          ${canEdit ? `<button type="button" class="btn btn-sm pb-act-edit" data-id="${escHtml(t.id)}">✏</button>` : ''}
          <button type="button" class="btn btn-sm pb-act-desc" data-id="${escHtml(t.id)}">📄</button>
          ${canEdit ? `<button type="button" class="btn btn-sm pb-act-prob" data-id="${escHtml(t.id)}">⚠</button>` : ''}
          ${canEdit ? `<button type="button" class="btn btn-sm pb-act-del" data-id="${escHtml(t.id)}">✕</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    root.innerHTML = `
      ${statsHtml}
      ${alarmHtml}
      <section class="pb-load-section" aria-label="Opterećenje inženjera">
        <h3 class="pb-section-title">Load meter (30 radnih dana)</h3>
        <div class="pb-load-list">${loadHtml || '<p class="pb-muted">Nema podataka</p>'}</div>
      </section>
      ${filterHtml}
      <div class="pb-plan-split">
        <div class="pb-cards-wrap">${cardsHtml || '<p class="pb-muted">Nema zadataka za filter.</p>'}</div>
        <div class="pb-table-wrap">
          <table class="pb-table">
            <thead><tr>
              <th>#</th>
              ${th('naziv', 'Naziv')}
              ${th('project', 'Projekat')}
              ${th('engineer', 'Inženjer')}
              ${th('vrsta', 'Vrsta')}
              ${th('datumi', 'Datumi')}
              ${th('trajanje', 'Trajanje')}
              ${th('status', 'Status')}
              ${th('pct', '%')}
              ${th('prio', 'Prio')}
              ${th('norma', 'Norma')}
              <th></th>
            </tr></thead>
            <tbody>${rowsHtml || ''}</tbody>
          </table>
        </div>
      </div>`;

    root.querySelector('#pbSearch')?.addEventListener('input', e => {
      filters.search = e.target.value;
      syncPbModuleFilters({ moduleSearch: filters.search });
      paint();
    });
    root.querySelector('#pbFStatus')?.addEventListener('change', e => {
      filters.status = e.target.value;
      paint();
    });
    root.querySelector('#pbFVrsta')?.addEventListener('change', e => {
      filters.vrsta = e.target.value;
      paint();
    });
    root.querySelector('#pbFPrio')?.addEventListener('change', e => {
      filters.prioritet = e.target.value;
      paint();
    });
    root.querySelector('#pbFDone')?.addEventListener('change', e => {
      filters.showDone = e.target.checked;
      syncPbModuleFilters({ moduleShowDone: filters.showDone });
      paint();
    });
    root.querySelector('#pbFProb')?.addEventListener('click', () => {
      filters.problemOnly = !filters.problemOnly;
      paint();
    });
    root.querySelector('#pbFReset')?.addEventListener('click', () => {
      filters = { search: '', status: 'all', vrsta: 'all', prioritet: 'all', showDone: false, problemOnly: false };
      syncPbModuleFilters({ moduleSearch: '', moduleShowDone: false });
      paint();
    });

    root.querySelectorAll('.pb-th').forEach(btn => {
      btn.addEventListener('click', () => {
        const col = btn.getAttribute('data-sort');
        if (sortCol === col) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else {
          sortCol = col;
          sortDir = 'asc';
        }
        paint();
      });
    });

    const findTask = id => (ctx.tasks || []).find(x => x.id === id);

    root.querySelectorAll('.pb-act-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const task = findTask(id);
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

    root.querySelectorAll('.pb-act-desc').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const task = findTask(id);
        if (!task) return;
        openTextAreaModal({
          title: 'Opis zadatka',
          initial: task.opis || '',
          canEdit,
          onSave: async v => {
            if (!canEdit) return;
            const ok = await updatePbTask(id, { opis: v });
            if (ok) {
              showToast('Opis sačuvan');
              ctx.onRefresh?.();
            } else showToast('Greška');
          },
        });
      });
    });

    root.querySelectorAll('.pb-act-prob').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const task = findTask(id);
        if (!task) return;
        openTextAreaModal({
          title: 'Problem / prepreka',
          initial: task.problem || '',
          hint: 'Ako postoji problem, razmotri status „Blokirano".',
          canEdit,
          onSave: async v => {
            if (!canEdit) return;
            const ok = await updatePbTask(id, { problem: v });
            if (ok) {
              showToast('Problem sačuvan');
              ctx.onRefresh?.();
            } else showToast('Greška');
          },
        });
      });
    });

    root.querySelectorAll('.pb-act-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        confirmDeletePbTask(id, () => ctx.onRefresh?.());
      });
    });
  }

  paint();
}
