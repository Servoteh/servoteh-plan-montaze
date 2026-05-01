/**
 * Kanban tab — kolone po statusu, quick edit, isti filteri kao Plan (search + showDone).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  prioClass,
  statusBadgeClass,
  openTaskEditorModal,
} from './shared.js';
import { quickUpdatePbTaskStatus } from '../../services/pb.js';
import { canEditProjektniBiro } from '../../state/auth.js';

const KANBAN_COLUMNS = [
  'Nije počelo',
  'U toku',
  'Pregled',
  'Blokirano',
  'Završeno',
];

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

/** Datum „završetka” za filter poslednjih 10 dana: real > plan. */
function completionEndDate(t) {
  const r = parseYmd(t.datum_zavrsetka_real);
  const p = parseYmd(t.datum_zavrsetka_plan);
  if (r && p) return r >= p ? r : p;
  return r || p;
}

function filterKanbanTasks(tasks, search) {
  let list = tasks.slice();
  const q = (search || '').trim().toLowerCase();
  if (q) {
    list = list.filter(t => String(t.naziv || '').toLowerCase().includes(q));
  }
  return list;
}

function partitionByStatus(list, showDone) {
  const today = startOfDay(new Date());
  const tenDaysAgo = new Date(today);
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

  const cols = {};
  for (const s of KANBAN_COLUMNS) cols[s] = [];

  let olderDoneCount = 0;

  for (const t of list) {
    const st = t.status || 'Nije počelo';
    if (st === 'Završeno') {
      const endD = completionEndDate(t);
      if (!showDone) {
        if (endD && startOfDay(endD) >= tenDaysAgo) {
          cols['Završeno'].push(t);
        } else {
          olderDoneCount += 1;
        }
      } else {
        cols['Završeno'].push(t);
      }
      continue;
    }
    if (KANBAN_COLUMNS.includes(st)) {
      cols[st].push(t);
    }
  }

  return { cols, olderDoneCount };
}

function colHeaderClass(status) {
  if (status === 'Nije počelo') return 'pb-kanban-col__title pb-kanban-col__title--muted';
  if (status === 'U toku') return 'pb-kanban-col__title pb-kanban-col__title--accent';
  if (status === 'Pregled') return 'pb-kanban-col__title pb-kanban-col__title--purple';
  if (status === 'Blokirano') return 'pb-kanban-col__title pb-kanban-col__title--danger';
  if (status === 'Završeno') return 'pb-kanban-col__title pb-kanban-col__title--done';
  return 'pb-kanban-col__title';
}

function quickActions(status) {
  const m = {
    'Nije počelo': [['U toku', '→ U toku']],
    'U toku': [['Pregled', '→ Pregled'], ['Završeno', '→ Završeno']],
    'Pregled': [['U toku', '→ U toku'], ['Završeno', '→ Završeno']],
    'Blokirano': [['U toku', '→ U toku']],
    'Završeno': [['U toku', '↩ Ponovo otvori']],
  };
  return m[status] || [];
}

function kanbanCardHtml(t, columnStatus, canEdit) {
  const projLabel = [t.project_code, t.vrsta].filter(Boolean).join(' · ');
  const showStatusBadge = (t.status || '') !== columnStatus;
  const qa = quickActions(columnStatus).slice(0, 2);
  const qaHtml = canEdit && qa.length
    ? `<div class="pb-kanban-quick">${qa.map(([to, label]) => `
        <button type="button" class="btn btn-sm pb-kanban-q" data-task="${escHtml(t.id)}" data-to="${escHtml(to)}">${escHtml(label)}</button>`).join('')}</div>`
    : '';

  return `
    <article class="pb-kanban-card" data-task-id="${escHtml(t.id)}">
      <div class="pb-kanban-card-head">
        <span class="${prioClass(t.prioritet)} pb-kanban-prio" aria-hidden="true">●</span>
        <h4 class="pb-kanban-card-title">${escHtml(t.naziv || '')}</h4>
        ${showStatusBadge ? `<span class="${statusBadgeClass(t.status)}">${escHtml(t.status || '')}</span>` : ''}
      </div>
      <div class="pb-kanban-meta">${escHtml(projLabel)}</div>
      ${String(t.problem || '').trim() ? `<div class="pb-problem-badge">⚠ problem</div>` : ''}
      <div class="pb-kanban-row">
        <span class="pb-avatar">${escHtml((t.engineer_name || '?').slice(0, 1))}</span>
        <span>${escHtml(t.engineer_name || '—')}</span>
        <span class="pb-kanban-rok">Plan rok: ${escHtml((t.datum_zavrsetka_plan || '').slice(0, 10) || '—')}</span>
      </div>
      <div class="pb-progress"><div class="pb-progress-fill" style="width:${Math.min(100, Number(t.procenat_zavrsenosti) || 0)}%"></div></div>
      <div class="pb-kanban-metrics"><span>${Number(t.procenat_zavrsenosti) || 0}%</span><span>${Number(t.norma_sati_dan) || 0} h/d</span></div>
      ${qaHtml}
    </article>`;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   tasks: object[],
 *   projects: object[],
 *   engineers: object[],
 *   search: string,
 *   showDone: boolean,
 *   onRefresh: () => void,
 *   onSwitchToPlanShowDone: () => void,
 * }} ctx
 */
export function renderKanbanTab(root, ctx) {
  const canEdit = canEditProjektniBiro();

  function buildHtml() {
    const list = filterKanbanTasks(ctx.tasks || [], ctx.search);
    const { cols, olderDoneCount } = partitionByStatus(list, ctx.showDone);

    const columnsHtml = KANBAN_COLUMNS.map(st => {
      const tasks = cols[st] || [];
      const count = tasks.length;
      const cards = tasks.map(t => kanbanCardHtml(t, st, canEdit)).join('');
      const addCard = canEdit
        ? `<button type="button" class="pb-kanban-add" data-add-status="${escHtml(st)}" aria-label="Novi zadatak">+</button>`
        : '';

      let footerOlder = '';
      if (st === 'Završeno' && !ctx.showDone && olderDoneCount > 0) {
        footerOlder = `<p class="pb-kanban-older"><button type="button" class="btn btn-link" id="pbKanbanOlder">Još ${olderDoneCount} starijih završenih zadataka (skriveno)</button></p>`;
      }

      return `
        <div class="pb-kanban-column" data-status="${escHtml(st)}">
          <div class="pb-kanban-col-head">
            <span class="${colHeaderClass(st)}">${escHtml(st)}</span>
            <span class="pb-kanban-count">${count}</span>
          </div>
          <div class="pb-kanban-cards">
            ${cards}
            ${addCard}
          </div>
          ${footerOlder}
        </div>`;
    }).join('');

    return `<div class="pb-kanban-scroll"><div class="pb-kanban-board">${columnsHtml}</div></div>`;
  }

  function wire() {
    root.querySelectorAll('.pb-kanban-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.pb-kanban-q,.pb-kanban-add')) return;
        const id = card.getAttribute('data-task-id');
        const task = (ctx.tasks || []).find(x => x.id === id);
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

    root.querySelectorAll('.pb-kanban-q').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.getAttribute('data-task');
        const to = btn.getAttribute('data-to');
        if (!id || !to) return;
        const res = await quickUpdatePbTaskStatus(id, to);
        if (res.ok) {
          showToast('Status ažuriran');
          ctx.onRefresh?.();
        } else if (res.status === 401 || res.status === 403) {
          showToast('Nemate pravo da menjate ovaj zadatak.');
        } else {
          showToast('Izmena nije uspela');
        }
      });
    });

    root.querySelectorAll('[data-add-status]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const st = btn.getAttribute('data-add-status');
        openTaskEditorModal({
          task: { status: st },
          projects: ctx.projects,
          engineers: ctx.engineers,
          canEdit,
          onSaved: () => ctx.onRefresh?.(),
        });
      });
    });

    root.querySelector('#pbKanbanOlder')?.addEventListener('click', () => {
      ctx.onSwitchToPlanShowDone?.();
    });
  }

  root.innerHTML = buildHtml();
  wire();
}
