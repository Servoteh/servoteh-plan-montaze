/**
 * Kadrovska modul — root render + tab dispatcher.
 *
 * Faza 4 milestone (ovaj fajl):
 *   - Header (back/title/theme/role/logout) prikazan ispravno
 *   - Tab strip sa 6 tabova, persist-uje aktivni tab u localStorage
 *     pod istim ključem kao legacy (`pm_kadrovska_active_tab_v1`).
 *   - Zaposleni tab je 100% funkcionalan (CRUD + modal + filteri)
 *   - Ostali tabovi su "coming soon" placeholder dok ne stignu u F4.x
 *
 * Mount:
 *   import { renderKadrovskaModule } from './ui/kadrovska/index.js';
 *   renderKadrovskaModule(rootEl);
 */

import { canAccessKadrovska, canAccessSalary, canEdit, getAuth } from '../../state/auth.js';
import { showToast } from '../../lib/dom.js';
import { logout } from '../../services/auth.js';
import { toggleTheme } from '../../lib/theme.js';

import {
  kadrovskaHeaderHtml,
  kadrTabsHtml,
} from './shared.js';
import { kadrovskaState, setActiveKadrTab } from '../../state/kadrovska.js';
import {
  renderEmployeesTab,
  wireEmployeesTab,
} from './employeesTab.js';
import {
  renderAbsencesTab,
  wireAbsencesTab,
} from './absencesTab.js';
import {
  renderWorkHoursTab,
  wireWorkHoursTab,
} from './workHoursTab.js';
import {
  renderContractsTab,
  wireContractsTab,
} from './contractsTab.js';
import {
  renderGridTab,
  wireGridTab,
} from './gridTab.js';
import {
  renderReportsTab,
  wireReportsTab,
} from './reportsTab.js';
import {
  renderVacationTab,
  wireVacationTab,
} from './vacationTab.js';
import {
  renderSalaryTab,
  wireSalaryTab,
} from './salaryTab.js';
import {
  renderHrNotificationsTab,
  wireHrNotificationsTab,
} from './hrNotificationsTab.js';
import { renderComingSoonTab } from './comingSoon.js';

/**
 * Lista svih tabova. Tabovi sa `adminOnly:true` se prikazuju u strip-u
 * samo admin korisnicima — ostali ih uopšte ne vide.
 */
const ALL_TABS = [
  { id: 'employees', label: 'Zaposleni' },
  { id: 'absences', label: 'Odsustva' },
  { id: 'vacation', label: 'Godišnji odmor' },
  { id: 'grid', label: 'Mesečni grid' },
  { id: 'hours', label: 'Sati (pojedinačno)' },
  { id: 'contracts', label: 'Ugovori' },
  { id: 'salary', label: 'Zarade', adminOnly: true },
  { id: 'notifications', label: 'Notifikacije' },
  { id: 'reports', label: 'Izveštaji' },
];

function visibleTabs() {
  const adminOk = canAccessSalary();
  return ALL_TABS.filter(t => !t.adminOnly || adminOk);
}

let rootEl = null;
let onBackToHubCb = null;
let onLogoutCb = null;

/**
 * Mount Kadrovska modul u dati root element.
 * @param {HTMLElement} root — kontejner (npr. #app)
 * @param {{ onBackToHub: () => void, onLogout: () => void }} options
 */
export function renderKadrovskaModule(root, { onBackToHub, onLogout } = {}) {
  rootEl = root;
  onBackToHubCb = onBackToHub || null;
  onLogoutCb = onLogout || null;

  /* Hard-guard: korisnik bez prava → toast + povratak na hub */
  if (!canAccessKadrovska()) {
    showToast('⚠ Nemaš pristup modulu Kadrovska');
    onBackToHubCb?.();
    return;
  }

  /* UX odluka: pri ulasku u Kadrovsku UVEK otvori Mesečni grid (najčešća radnja).
     Unutar iste sesije korisnik dalje može menjati tab — to se pamti u sessionStorage,
     ali na svaki fresh mount resetujemo na 'grid'. */
  kadrovskaState.activeTab = 'grid';
  setActiveKadrTab('grid');
  const activeTab = 'grid';

  root.innerHTML = `
    <section id="module-kadrovska" class="kadrovska-section" aria-label="Modul Kadrovska">
      ${kadrovskaHeaderHtml()}
      ${kadrTabsHtml(activeTab)}
      <div id="kadrPanelHost"></div>
    </section>
  `;

  /* Header: back / theme / logout */
  root.querySelector('#kadrBackBtn').addEventListener('click', () => {
    onBackToHubCb?.();
  });
  root.querySelector('#kadrThemeToggle').addEventListener('click', () => toggleTheme());
  root.querySelector('#kadrLogoutBtn').addEventListener('click', async () => {
    await logout();
    onLogoutCb?.();
  });

  /* Tab strip — switch */
  root.querySelectorAll('.kadrovska-tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const id = tabBtn.dataset.kadrTab;
      switchTab(id);
    });
  });

  mountTabBody(activeTab);
}

function switchTab(id) {
  if (!rootEl) return;
  if (kadrovskaState.activeTab === id) return;
  kadrovskaState.activeTab = id;
  setActiveKadrTab(id);

  /* Update tab buttons */
  rootEl.querySelectorAll('.kadrovska-tab').forEach(btn => {
    const active = btn.dataset.kadrTab === id;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  mountTabBody(id);
}

function mountTabBody(id) {
  const host = rootEl?.querySelector('#kadrPanelHost');
  if (!host) return;

  /* Menadzment je ograničen na „grid" tab — svaki pokušaj otvaranja drugog
     taba (stari aktivni u storage-u, deep-link) se neutralizuje. */
  if (getAuth().role === 'menadzment' && id !== 'grid') {
    kadrovskaState.activeTab = 'grid';
    setActiveKadrTab('grid');
    mountTabBody('grid');
    return;
  }

  host.innerHTML = `<div class="kadr-panel active" id="kadrPanel-${id}" role="tabpanel" aria-label="${id}"></div>`;
  const panel = host.firstElementChild;

  /* Mapa tab → render + wire (async). Wire može biti async — error u promise-u
     se hvata i logguje. */
  const tabImpl = {
    employees: { render: renderEmployeesTab, wire: wireEmployeesTab },
    absences: { render: renderAbsencesTab, wire: wireAbsencesTab },
    vacation: { render: renderVacationTab, wire: wireVacationTab },
    grid: { render: renderGridTab, wire: wireGridTab },
    hours: { render: renderWorkHoursTab, wire: wireWorkHoursTab },
    contracts: { render: renderContractsTab, wire: wireContractsTab },
    salary: { render: renderSalaryTab, wire: wireSalaryTab, adminOnly: true },
    notifications: { render: renderHrNotificationsTab, wire: wireHrNotificationsTab },
    reports: { render: renderReportsTab, wire: wireReportsTab },
  };

  const impl = tabImpl[id];
  if (impl?.adminOnly && !canAccessSalary()) {
    /* Neovlašćen pokušaj (stari aktivni tab u storage-u) — fallback na grid. */
    kadrovskaState.activeTab = 'grid';
    setActiveKadrTab('grid');
    mountTabBody('grid');
    return;
  }
  if (impl) {
    panel.innerHTML = impl.render();
    Promise.resolve()
      .then(() => impl.wire(panel))
      .catch(e => {
        console.error(`[kadrovska] ${id} wire failed`, e);
        showToast(`⚠ Greška pri učitavanju (${id})`);
      });
    return;
  }

  /* Ostali tabovi (grid, reports): placeholder dok ne stignu u F4.2 / F4.3. */
  const meta = TABS.find(t => t.id === id);
  panel.innerHTML = renderComingSoonTab(
    meta?.label || id,
    meta?.plannedPhase || 'F4.x'
  );
}
