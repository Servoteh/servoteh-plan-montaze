/**
 * Analiza tab — dashboard po projektu.
 * // TODO(PB4): Workload heatmap — calendar grid po danima, boja = ukupni norma sati — vidi docs/pb_review_report.md F7
 */

import { escHtml } from '../../lib/dom.js';
import {
  statusBadgeClass,
  prioClass,
  openTextAreaModal,
} from './shared.js';
import { countWorkdaysBetween } from './planTab.js';

function parseYmd(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function projectTasks(tasks, projectId) {
  return (tasks || []).filter(t => t.project_id === projectId);
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   tasks: object[],
 *   engineers: object[],
 *   projects: object[],
 *   initialProjectId: string|null,
 * }} ctx
 */
export function renderAnaliza(root, ctx) {
  const withTasks = new Set((ctx.tasks || []).map(t => t.project_id).filter(Boolean));
  const projOpts = (ctx.projects || []).filter(p => withTasks.has(p.id));
  let selectedPid = ctx.initialProjectId && projOpts.some(p => p.id === ctx.initialProjectId)
    ? ctx.initialProjectId
    : (projOpts[0]?.id ?? null);

  function paint() {
    const plist = projOpts;
    const pid = selectedPid;
    const list = pid ? projectTasks(ctx.tasks, pid) : [];

    const stats = {
      total: list.length,
      done: list.filter(t => t.status === 'Završeno').length,
      blocked: list.filter(t => t.status === 'Blokirano').length,
      inProg: list.filter(t => t.status === 'U toku').length,
      normSum: list.filter(t => t.status !== 'Završeno').reduce((s, t) => s + (Number(t.norma_sati_dan) || 0), 0),
    };
    const pctDone = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

    let minStart = null;
    let maxEnd = null;
    for (const t of list) {
      const a = parseYmd(t.datum_pocetka_plan);
      const b = parseYmd(t.datum_zavrsetka_plan);
      if (a && (!minStart || a < minStart)) minStart = a;
      if (b && (!maxEnd || b > maxEnd)) maxEnd = b;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let timelineHtml = '';
    if (minStart && maxEnd) {
      const spanMs = maxEnd - minStart;
      const spanDays = Math.max(1, Math.round(spanMs / 86400000) + 1);
      const elapsed = Math.max(0, Math.min(spanDays, Math.round((today - minStart) / 86400000)));
      const pctTime = Math.min(100, Math.round((elapsed / spanDays) * 100));
      const markerPct = spanMs > 0
        ? Math.min(100, Math.max(0, ((today - minStart) / spanMs) * 100))
        : 0;
      timelineHtml = `
        <div class="pb-an-tl">
          <div class="pb-an-tl-bar">
            <div class="pb-an-tl-fill" style="width:${pctTime}%"></div>
            <div class="pb-an-tl-marker" style="left:${markerPct}%"></div>
          </div>
          <p class="pb-muted">Projekat traje: ${spanDays} dana ukupno · Proteklo: ~${elapsed} dana (${pctTime}%)</p>
        </div>`;
    } else {
      timelineHtml = '<p class="pb-muted">Zadaci nemaju postavljene datume.</p>';
    }

    const byEng = new Map();
    for (const t of list) {
      const eid = t.employee_id || '_none';
      if (!byEng.has(eid)) {
        byEng.set(eid, {
          name: t.engineer_name || '—',
          tasks: [],
        });
      }
      byEng.get(eid).tasks.push(t);
    }
    const engRows = Array.from(byEng.entries()).map(([eid, g]) => {
      const ts = g.tasks;
      const done = ts.filter(x => x.status === 'Završeno').length;
      const norm = ts.filter(x => x.status !== 'Završeno').reduce((s, x) => s + (Number(x.norma_sati_dan) || 0), 0);
      const st = (s) => ts.filter(x => x.status === s).length;
      return `
        <div class="pb-an-eng">
          <div class="pb-an-eng-head">
            <span class="pb-avatar">${escHtml(g.name.slice(0, 1))}</span>
            <strong>${escHtml(g.name)}</strong>
            <span class="pb-muted">${ts.length} zadataka · ${done} završeno · Norma: ${norm}h/dan</span>
          </div>
          <div class="pb-an-badges">
            <span class="pb-badge">${escHtml(String(st('Nije počelo')))} Nije počelo</span>
            <span class="pb-badge pb-badge--warn">${escHtml(String(st('U toku')))} U toku</span>
            <span class="pb-badge pb-badge--warn">${escHtml(String(st('Pregled')))} Pregled</span>
            <span class="pb-badge pb-badge--danger">${escHtml(String(st('Blokirano')))} Blokirano</span>
            <span class="pb-badge pb-badge--ok">${escHtml(String(st('Završeno')))} Završeno</span>
          </div>
        </div>`;
    }).join('');

    const sortedTasks = list.slice().sort((a, b) => {
      const da = a.datum_zavrsetka_plan || '';
      const db = b.datum_zavrsetka_plan || '';
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });

    const taskRows = sortedTasks.map(t => {
      const wd = countWorkdaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan);
      const prob = String(t.problem || '').trim();
      const probCls = prob ? ' pb-an-task--prob' : '';
      return `
        <article class="pb-an-task${probCls}">
          <div class="pb-an-task-head">
            <strong>${escHtml(t.naziv || '')}</strong>
            <span class="${statusBadgeClass(t.status)}">${escHtml(t.status || '')}</span>
          </div>
          <div class="pb-muted">${escHtml(t.engineer_name || '—')} · <span class="${prioClass(t.prioritet)}">${escHtml(t.prioritet || '')}</span> · ${escHtml(t.vrsta || '')}</div>
          <div class="pb-muted">Plan: ${escHtml((t.datum_pocetka_plan || '').slice(0, 10))} — ${escHtml((t.datum_zavrsetka_plan || '').slice(0, 10))}
            · Trajanje: ${wd != null ? wd + ' rd' : '—'} · Norma: ${Number(t.norma_sati_dan) || 0}h/d</div>
          <div class="pb-progress"><div class="pb-progress-fill" style="width:${Math.min(100, Number(t.procenat_zavrsenosti) || 0)}%"></div></div>
          ${String(t.opis || '').trim() ? `<button type="button" class="btn btn-sm pb-an-desc" data-task-id="${escHtml(t.id)}">📄 Opis</button>` : ''}
          ${prob ? `<div class="pb-an-prob">⚠ ${escHtml(prob)}</div>` : ''}
        </article>`;
    }).join('');

    const problems = list.filter(t => String(t.problem || '').trim());
    const probSection = problems.length ? `
      <section class="pb-an-problems">
        <h3 class="pb-an-problems-title">⚠ Aktivni problemi</h3>
        ${problems.map(t => `
          <div class="pb-an-problem-row">
            <strong>${escHtml(t.naziv || '')}</strong> — ${escHtml(t.engineer_name || '—')} — ${escHtml(t.status || '')}
            <p>Problem: ${escHtml(String(t.problem || ''))}</p>
            <p class="pb-muted">Rok: ${escHtml((t.datum_zavrsetka_plan || '').slice(0, 10) || '—')}</p>
          </div>`).join('')}
      </section>` : '';

    root.innerHTML = `
      <div class="pb-an-wrap">
        <label class="pb-field-inline pb-an-proj"><span>Analiza projekta</span>
          <select id="pbAnProj">
            ${plist.length ? plist.map(p => `
              <option value="${escHtml(p.id)}" ${p.id === pid ? 'selected' : ''}>
                ${escHtml(p.project_code)} — ${escHtml(p.project_name)}
              </option>`).join('')
              : '<option value="">— nema projekata sa zadacima —</option>'}
          </select>
        </label>

        ${pid ? `
        <div class="pb-stats-grid pb-an-stats">
          <div class="pb-stat-card"><span>Zadaci</span><strong>${stats.total}</strong><small>${stats.inProg} u toku</small></div>
          <div class="pb-stat-card"><span>Završeno</span><strong>${stats.done} (${pctDone}%)</strong></div>
          <div class="pb-stat-card"><span>Norma ∑</span><strong>${stats.normSum.toFixed(1)}</strong><small>h/dan ukupno</small></div>
          <div class="pb-stat-card"><span>Blokirano</span><strong>${stats.blocked}</strong><small>${stats.blocked ? 'Akcija!' : 'OK'}</small></div>
        </div>
        ${stats.total > 0 && stats.done === stats.total ? '<p class="pb-an-all-done">Svi zadaci su završeni.</p>' : ''}

        <section class="pb-an-sec"><h3 class="pb-section-title">Timeline projekta</h3>${timelineHtml}</section>

        <section class="pb-an-sec"><h3 class="pb-section-title">Inženjeri na projektu</h3>
          ${byEng.size ? engRows : '<p class="pb-muted">Nema dodeljenih inženjera</p>'}
        </section>

        <section class="pb-an-sec"><h3 class="pb-section-title">Zadaci projekta</h3>
          <div class="pb-an-task-list">${taskRows || '<p class="pb-muted">Nema zadataka.</p>'}</div>
        </section>
        ${probSection}` : (plist.length ? '<p class="pb-muted">Izaberi projekat.</p>' : '<p class="pb-muted">Nema projekata sa zadacima. Dodajte zadatke u tabu Plan.</p>')}
      </div>`;

    root.querySelector('#pbAnProj')?.addEventListener('change', e => {
      selectedPid = e.target.value || null;
      paint();
    });

    root.querySelectorAll('.pb-an-desc').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-task-id');
        const t = list.find(x => x.id === id);
        openTextAreaModal({
          title: 'Opis zadatka',
          initial: t?.opis || '',
          canEdit: false,
          onSave: async () => {},
        });
      });
    });
  }

  paint();
}
