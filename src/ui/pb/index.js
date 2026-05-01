/**
 * Projektni biro — root shell (tabs + Plan + Kanban + Gantt + Izveštaji + Analiza).
 * // TODO(PB4): split Gantt header vs row render na filter change — docs/pb_review_report.md E2
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { logout } from '../../services/auth.js';
import { toggleTheme } from '../../lib/theme.js';
import { canEditProjektniBiro, getAuth, isAdmin } from '../../state/auth.js';
import {
  getPbProjects,
  getPbEngineers,
  getPbTasks,
  getPbLoadStats,
  getPbWorkReports,
} from '../../services/pb.js';
import {
  loadPbState,
  savePbState,
  openTaskEditorModal,
  savePbGanttMonth,
  stopPbIzvestajiSpeech,
  pbErrorMessage,
} from './shared.js';
import { renderPlanTab } from './planTab.js';
import { renderKanbanTab } from './kanbanTab.js';
import { renderGanttTab } from './ganttTab.js';
import { renderIzvestaji } from './izvestajiTab.js';
import { renderAnaliza } from './analizaTab.js';
import { renderPbPodesavanja } from './podesavanjaTab.js';

let teardownResize = null;

function mqMobile() {
  return window.matchMedia('(max-width: 767px)');
}

/**
 * @param {HTMLElement} root
 * @param {{ onBackToHub: () => void, onLogout: () => void }} options
 */
export function renderPbModule(root, { onBackToHub, onLogout } = {}) {
  if (!getAuth().user) {
    showToast('Prijavi se da otvoriš Projektovanje');
    onBackToHub?.();
    return;
  }

  const state = loadPbState();
  let projects = [];
  let engineers = [];
  let tasks = [];
  let loadStats = [];
  let workReports = [];
  let workReportsLoaded = false;

  function mergeStoredState() {
    const s = loadPbState();
    state.activeProject = s.activeProject;
    state.activeEngineer = s.activeEngineer;
    state.activeTab = s.activeTab;
    state.moduleSearch = s.moduleSearch ?? '';
    state.moduleShowDone = s.moduleShowDone ?? false;
    state.ganttStartDate = s.ganttStartDate ?? null;
  }

  const ctx = {
    get projects() { return projects; },
    get engineers() { return engineers; },
    get tasks() { return tasks; },
    get loadStats() { return loadStats; },
    get moduleSearch() { return state.moduleSearch ?? ''; },
    get moduleShowDone() { return state.moduleShowDone ?? false; },
    onRefresh: () => loadAll(),
  };

  async function loadWorkReports() {
    const y = new Date().getFullYear();
    const first = `${y}-01-01`;
    const last = `${y}-12-31`;
    const wr = await getPbWorkReports({ dateFrom: first, dateTo: last, limit: 8000 });
    workReports = Array.isArray(wr) ? wr : [];
    workReportsLoaded = true;
  }

  async function loadAll() {
    mergeStoredState();
    const body = root.querySelector('#pbTabBody');
    if (body) {
      body.classList.add('pb-tab-body--loading');
      body.setAttribute('aria-busy', 'true');
    }
    const projFilter = state.activeProject === 'all' ? {} : { projectId: state.activeProject };
    const engFilter = state.activeEngineer === 'all' ? {} : { employeeId: state.activeEngineer };
    try {
      const [p, e, t, l] = await Promise.all([
        getPbProjects(),
        getPbEngineers(),
        getPbTasks({
          ...projFilter,
          ...engFilter,
        }),
        getPbLoadStats(30),
      ]);
      projects = p;
      engineers = e;
      tasks = t;
      loadStats = l;
      paintChrome();
      if (body) {
        body.classList.remove('pb-tab-body--loading');
        body.removeAttribute('aria-busy');
      }
      void mountActiveTab();
    } catch (err) {
      const msg = err?.message || 'Greška pri učitavanju';
      if (body) {
        body.classList.remove('pb-tab-body--loading');
        body.removeAttribute('aria-busy');
        body.innerHTML = `<div class="pb-load-error"><p><strong>Učitavanje nije uspelo</strong></p><p class="pb-muted">${escHtml(msg)}</p><button type="button" class="btn btn-primary" id="pbRetryLoad">Pokušaj ponovo</button></div>`;
        body.querySelector('#pbRetryLoad')?.addEventListener('click', () => loadAll());
      }
    }
  }

  function paintChrome() {
    const hub = root.querySelector('#pbHubSlot');
    if (!hub) return;
    const auth = getAuth();
    hub.innerHTML = `
      <header class="kadrovska-header pb-header">
        <div class="kadrovska-header-left">
          <button type="button" class="btn-hub-back" id="pbBackBtn" aria-label="Nazad na module"><span>←</span> Moduli</button>
          <div class="kadrovska-title"><span class="ktitle-mark" aria-hidden="true">📐</span> Projektovanje <span class="kadrovska-title-sub">Projektni biro</span></div>
        </div>
        <div class="kadrovska-header-right">
          <button type="button" class="theme-toggle" id="pbThemeBtn" aria-label="Tema">🌙</button>
          <span class="role-indicator">${escHtml((auth.role || '').toUpperCase())}</span>
          ${canEditProjektniBiro() ? `<button type="button" class="btn btn-primary pb-new-desktop" id="pbNewDesk">+ Novi zadatak</button>` : ''}
          <button type="button" class="hub-logout" id="pbLogoutBtn">Odjavi se</button>
        </div>
      </header>
      <div class="pb-toolbar">
        <label class="pb-field-inline"><span>Projekat</span>
          <select id="pbProjectSel">
            <option value="all">Svi projekti</option>
            ${projects.map(p => `<option value="${escHtml(p.id)}" ${state.activeProject === p.id ? 'selected' : ''}>${escHtml(p.project_code)} — ${escHtml(p.project_name)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="pb-chip-scroll" id="pbChipHost"></div>
      <nav class="pb-tabs" role="tablist" aria-label="Projektni biro tabovi">
        ${pbTabBtn('plan', 'Plan', state.activeTab === 'plan')}
        ${pbTabBtn('kanban', 'Kanban', state.activeTab === 'kanban')}
        ${pbTabBtn('gantt', 'Gantt', state.activeTab === 'gantt')}
        ${pbTabBtn('izvestaji', 'Izveštaji', state.activeTab === 'izvestaji')}
        ${pbTabBtn('analiza', 'Analiza', state.activeTab === 'analiza')}
        ${isAdmin() ? pbTabBtn('podesavanja', '⚙ Podešavanja', state.activeTab === 'podesavanja') : ''}
      </nav>`;

    root.querySelector('#pbBackBtn')?.addEventListener('click', () => onBackToHub?.());
    root.querySelector('#pbThemeBtn')?.addEventListener('click', () => toggleTheme());
    root.querySelector('#pbLogoutBtn')?.addEventListener('click', async () => {
      await logout();
      onLogout?.();
    });

    root.querySelector('#pbProjectSel')?.addEventListener('change', e => {
      state.activeProject = e.target.value;
      savePbState(state);
      loadAll();
    });

    root.querySelector('#pbNewDesk')?.addEventListener('click', () => {
      openTaskEditorModal({
        task: null,
        projects,
        engineers,
        canEdit: canEditProjektniBiro(),
        onSaved: () => loadAll(),
      });
    });

    root.querySelectorAll('.pb-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.pbTab || 'plan';
        savePbState(state);
        paintChrome();
        void mountActiveTab();
      });
    });

    renderEngineerChips(root.querySelector('#pbChipHost'), state);
  }

  function renderEngineerChips(host, st) {
    if (!host) return;
    host.innerHTML = `
      <button type="button" class="pb-chip ${st.activeEngineer === 'all' ? 'active' : ''}" data-eng="all">Svi</button>
      ${engineers.map(en => `
        <button type="button" class="pb-chip ${st.activeEngineer === en.id ? 'active' : ''}" data-eng="${escHtml(en.id)}">${escHtml(en.full_name)}</button>
      `).join('')}
    `;
    host.querySelectorAll('[data-eng]').forEach(btn => {
      btn.addEventListener('click', () => {
        st.activeEngineer = btn.getAttribute('data-eng') || 'all';
        savePbState(st);
        renderEngineerChips(host, st);
        loadAll();
      });
    });
  }

  function pbTabBtn(id, label, active) {
    return `<button type="button" role="tab" class="pb-tab-btn ${active ? 'active' : ''}" data-pb-tab="${escHtml(id)}" aria-selected="${active}">${escHtml(label)}</button>`;
  }

  function switchToPlanShowDone() {
    state.activeTab = 'plan';
    state.moduleShowDone = true;
    savePbState(state);
    paintChrome();
    void mountActiveTab();
  }

  async function mountActiveTab() {
    const body = root.querySelector('#pbTabBody');
    if (!body) return;
    mergeStoredState();
    const tab = state.activeTab || 'plan';
    if (tab !== 'izvestaji') stopPbIzvestajiSpeech();
    if (tab === 'plan') {
      renderPlanTab(body, ctx);
      return;
    }
    if (tab === 'kanban') {
      renderKanbanTab(body, {
        tasks,
        projects,
        engineers,
        search: state.moduleSearch ?? '',
        showDone: state.moduleShowDone ?? false,
        onRefresh: () => loadAll(),
        onSwitchToPlanShowDone: switchToPlanShowDone,
      });
      return;
    }
    if (tab === 'gantt') {
      let viewMonth = state.ganttStartDate
        ? new Date(state.ganttStartDate)
        : new Date();
      if (Number.isNaN(viewMonth.getTime())) viewMonth = new Date();
      viewMonth.setDate(1);
      renderGanttTab(body, {
        tasks,
        projects,
        engineers,
        search: state.moduleSearch ?? '',
        viewMonth,
        onViewMonthChange: d => {
          const x = new Date(d);
          x.setDate(1);
          x.setHours(0, 0, 0, 0);
          savePbGanttMonth(x.toISOString());
          mergeStoredState();
          void mountActiveTab();
        },
        onRefresh: () => loadAll(),
      });
      return;
    }
    if (tab === 'izvestaji') {
      if (!workReportsLoaded) {
        body.innerHTML = '<p class="pb-muted">Učitavanje…</p>';
        try {
          await loadWorkReports();
        } catch (err) {
          body.innerHTML = `<p class="pb-muted">${escHtml(pbErrorMessage(err))}</p>`;
          return;
        }
      }
      renderIzvestaji(body, {
        getWorkReports: () => workReports,
        engineers,
        canEdit: canEditProjektniBiro(),
        defaultEmployeeId: null,
        actorEmail: getAuth().user?.emailRaw || getAuth().user?.email || null,
        onRefresh: async () => {
          await loadWorkReports();
          void mountActiveTab();
        },
      });
      return;
    }
    if (tab === 'analiza') {
      renderAnaliza(body, {
        tasks,
        engineers,
        projects,
        initialProjectId: state.activeProject !== 'all' ? state.activeProject : null,
      });
      return;
    }
    if (tab === 'podesavanja') {
      if (!isAdmin()) {
        body.innerHTML = '<p class="pb-muted">Samo administrator.</p>';
        return;
      }
      body.innerHTML = '';
      await renderPbPodesavanja(body, {});
      return;
    }
  }

  root.className = 'pb-module kadrovska-section';
  root.innerHTML = `
    <div id="pbHubSlot"></div>
    <main id="pbTabBody" class="pb-tab-body pb-tab-body--loading" aria-busy="true">
      <div class="pb-loading-skel">
        <div class="pb-skel-line pb-skel-line--lg"></div>
        <div class="pb-skel-grid">
          <div class="pb-skel-card"></div><div class="pb-skel-card"></div><div class="pb-skel-card"></div>
        </div>
        <div class="pb-skel-line"></div><div class="pb-skel-line"></div>
      </div>
    </main>
    ${canEditProjektniBiro() ? `<button type="button" class="pb-fab" id="pbFab" aria-label="Novi zadatak">+</button>` : ''}
  `;

  const mm = mqMobile();
  const applyMq = () => {
    root.classList.toggle('pb-module--mobile', mm.matches);
  };
  applyMq();
  mm.addEventListener('change', applyMq);
  teardownResize = () => mm.removeEventListener('change', applyMq);

  root.querySelector('#pbFab')?.addEventListener('click', () => {
    openTaskEditorModal({
      task: null,
      projects,
      engineers,
      canEdit: canEditProjektniBiro(),
      onSaved: () => loadAll(),
    });
  });

  loadAll();
}

export function teardownPbModule() {
  try {
    teardownResize?.();
  } catch {
    /* ignore */
  }
  teardownResize = null;
}
