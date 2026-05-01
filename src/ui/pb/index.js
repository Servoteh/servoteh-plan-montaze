/**
 * Projektni biro — root shell (tabs + Plan + Coming soon placeholders).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { logout } from '../../services/auth.js';
import { toggleTheme } from '../../lib/theme.js';
import { canEditProjektniBiro, getAuth } from '../../state/auth.js';
import {
  getPbProjects,
  getPbEngineers,
  getPbTasks,
  getPbLoadStats,
} from '../../services/pb.js';
import { loadPbState, savePbState, openTaskEditorModal } from './shared.js';
import { renderPlanTab } from './planTab.js';

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

  const ctx = {
    get projects() { return projects; },
    get engineers() { return engineers; },
    get tasks() { return tasks; },
    get loadStats() { return loadStats; },
    onRefresh: () => loadAll(),
  };

  async function loadAll() {
    const projFilter = state.activeProject === 'all' ? {} : { projectId: state.activeProject };
    const engFilter = state.activeEngineer === 'all' ? {} : { employeeId: state.activeEngineer };
    const [p, e, t, l] = await Promise.all([
      getPbProjects(),
      getPbEngineers(),
      getPbTasks({ ...projFilter, ...engFilter }),
      getPbLoadStats(30),
    ]);
    projects = p;
    engineers = e;
    tasks = t;
    loadStats = l;
    paintChrome();
    mountActiveTab();
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
        mountActiveTab();
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

  function mountActiveTab() {
    const body = root.querySelector('#pbTabBody');
    if (!body) return;
    const tab = state.activeTab || 'plan';
    if (tab === 'plan') {
      renderPlanTab(body, ctx);
      return;
    }
    const labels = {
      kanban: 'Kanban tabla',
      gantt: 'Gantt dijagram',
      izvestaji: 'Izveštaji rada',
      analiza: 'Analiza',
    };
    body.innerHTML = `
      <div class="pb-coming-soon">
        <h3>${escHtml(labels[tab] || 'U pripremi')}</h3>
        <p>Ova funkcija dolazi u sledećim sprintovima (PB2 / PB3).</p>
      </div>`;
  }

  root.className = 'pb-module kadrovska-section';
  root.innerHTML = `
    <div id="pbHubSlot"></div>
    <main id="pbTabBody" class="pb-tab-body"></main>
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
