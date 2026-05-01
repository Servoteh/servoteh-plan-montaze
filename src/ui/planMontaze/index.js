/**
 * Plan Montaže — root modula.
 *
 * Faza 5.1.a: header + project bar + WP tabs + view tabs + meta modali.
 * Plan tabela / Gantt / Total se još uvek prikazuju kao "u izradi" placeholder
 * dok ne stignu naredne pod-faze.
 *
 * Bootstrap:
 *   1. Ako još nismo učitali allData (allData.projects prazan), pokušaj
 *      Supabase load (`fetchAllProjectsHierarchy`); ako je offline, fallback
 *      na localStorage cache (`bootstrapFromLocalCache`).
 *   2. Renderuj shell + jednom delegiraj wire-ovanje.
 *
 * Sve promene state-a (switch project, switch WP, edit meta) trigger-uju
 * `rerenderShell()` koji minimalno ponovo gradi project bar + WP tabs +
 * placeholder body.
 */

import { toggleTheme } from '../../lib/theme.js';
import { onAuthChange, getAuth } from '../../state/auth.js';
import {
  allData,
  planMontazeState,
  bootstrapFromLocalCache,
  ensureProjectLocations,
  ensureLocationColorsForProjects,
  ensurePeopleFromProjects,
  getActiveProject,
  setActiveView,
} from '../../state/planMontaze.js';
import { fetchAllProjectsHierarchy } from '../../services/plan.js';
import { planHeaderHtml, viewTabsHtml } from './shared.js';
import { projectContextCardHtml, wireProjectBar } from './projectBar.js';
import { openProjectMetaModal, openWpMetaModal } from './metaModals.js';
import { planSectionHtml, wirePlanSection } from './planTable.js';
import { mobileCardsHtml, wireMobileCards } from './mobileCards.js';
import { reminderZoneHtml, wireReminderZone } from './reminderZone.js';
import { ganttSectionHtml, wireGanttSection } from './gantt.js';
import { totalGanttSectionHtml, wireTotalGanttSection } from './totalGantt.js';
import { mountStatusPanel, unmountStatusPanel } from './statusPanel.js';
import { openExportDialog } from './exportModal.js';

let _mountEl = null;
let _onLogoutCb = null;
let _onBackToHubCb = null;
let _authUnsubscribe = null;

/* ── PUBLIC: render root ─────────────────────────────────────────────── */

export async function renderPlanMontazeModule(mountEl, options = {}) {
  _mountEl = mountEl;
  _onLogoutCb = options.onLogout || null;
  _onBackToHubCb = options.onBackToHub || null;

  /* Ako još nemamo podatke u memoriji — bootstrap. */
  if (!allData.projects?.length) {
    bootstrapFromLocalCache();
  } else {
    /* Već je inicijalizovan u prethodnom mount-u — samo osvežiti meta. */
    allData.projects.forEach(ensureProjectLocations);
    ensureLocationColorsForProjects();
    ensurePeopleFromProjects();
  }

  _renderShell();

  /* Async DB sync — ako smo online, pokušaj učitati svežu hijerarhiju. */
  if (getAuth().isOnline) {
    fetchAllProjectsHierarchy().then(ok => {
      if (ok) {
        /* Sigurno active project pokazuje na nešto što stvarno postoji. */
        const stillExists = allData.projects.some(p => p.id === planMontazeState.activeProjectId);
        if (!stillExists) {
          planMontazeState.activeProjectId = allData.projects[0]?.id || null;
          planMontazeState.activeWpId = allData.projects[0]?.workPackages?.[0]?.id || null;
        }
        _renderShell();
      }
    }).catch(e => console.warn('[plan] DB load failed', e));
  }

  /* Subscribe na auth promene da osvežimo role indicator + dugmad. */
  if (_authUnsubscribe) _authUnsubscribe();
  _authUnsubscribe = onAuthChange(() => _renderShell());

  /* Status panel (singleton) — online/offline + save queue. */
  mountStatusPanel();
}

/* Eksportujemo opcioni cleanup hook za router (kada se modul napušta). */
export function teardownPlanMontazeModule() {
  unmountStatusPanel();
  if (_authUnsubscribe) { _authUnsubscribe(); _authUnsubscribe = null; }
}

/* ── INTERNAL: render + wire ─────────────────────────────────────────── */

function _renderShell() {
  if (!_mountEl) return;

  _mountEl.innerHTML = `
    ${planHeaderHtml()}
    <main class="plan-main" id="planMain">
      <section class="plan-toolbar" id="planToolbar">
        ${projectContextCardHtml()}
        ${viewTabsHtml(planMontazeState.activeView)}
      </section>
      <section class="plan-body" id="planBody">
        ${_planBodyHtml()}
      </section>
    </main>
  `;

  _wireHeader();
  _wireToolbar();
  _wireViewTabs();
  _wireBody();
}

function _wireBody() {
  const body = _mountEl.querySelector('#planBody');
  if (!body) return;
  const onChange = () => _renderShell();
  if (planMontazeState.activeView === 'plan') {
    wireReminderZone(body);
    wirePlanSection(body, { onChange });
    wireMobileCards(body, { onChange });
  } else if (planMontazeState.activeView === 'gantt') {
    wireGanttSection(body, { onChange });
  } else if (planMontazeState.activeView === 'total') {
    wireTotalGanttSection(body, { onChange });
  }
}

/** Body za aktivni view: plan / gantt / total. */
function _planBodyHtml() {
  const p = getActiveProject();
  if (!p) {
    return `
      <div class="form-card">
        <h3>Nema projekata</h3>
        <p class="form-hint">Klikni "＋ Novi" u project baru da kreiraš prvi projekat.</p>
      </div>
    `;
  }
  const view = planMontazeState.activeView;
  if (view === 'plan') {
    return `
      ${reminderZoneHtml()}
      ${planSectionHtml()}
      ${mobileCardsHtml()}
    `;
  }
  if (view === 'gantt') {
    return ganttSectionHtml();
  }
  if (view === 'total') {
    return totalGanttSectionHtml();
  }
  return '';
}

function _wireHeader() {
  _mountEl.querySelector('#planBackBtn')?.addEventListener('click', () => {
    _onBackToHubCb?.();
  });
  _mountEl.querySelector('#planLogoutBtn')?.addEventListener('click', () => {
    _onLogoutCb?.();
  });
  _mountEl.querySelector('#planThemeToggle')?.addEventListener('click', () => {
    toggleTheme();
  });
  _mountEl.querySelector('#planExportBtn')?.addEventListener('click', () => {
    openExportDialog({
      onAfterImport: () => _renderShell(),
      onShellRefresh: () => _renderShell(),
    });
  });
}

function _wireToolbar() {
  const toolbar = _mountEl.querySelector('#planToolbar');
  if (!toolbar) return;
  wireProjectBar(toolbar, {
    onChange: () => _renderShell(),
    onEditProjectMeta: () => openProjectMetaModal(() => _renderShell()),
    onEditWpMeta: () => openWpMetaModal(() => _renderShell()),
  });
}

function _wireViewTabs() {
  _mountEl.querySelectorAll('.view-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (!v) return;
      setActiveView(v);
      _renderShell();
    });
  });
}
