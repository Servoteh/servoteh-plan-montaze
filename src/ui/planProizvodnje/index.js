/**
 * Plan Proizvodnje — modul za šefove mašinske obrade.
 *
 * Sprintovi:
 *   F.1  ✅  Skelet + migracije + Bridge syncTechRouting
 *   F.2  ✅  Per-mašina view: dropdown mašina, tabela operacija, drag-drop,
 *              status pill, napomena, HITNO vizuali, REASSIGN
 *   F.3  ☐  Zauzetost mašina (workload summary), Pregled svih (matrica)
 *   F.4  ☐  Upload skica (Storage), acceptance test
 *
 * Pristup:
 *   - Svi sa canAccessPlanProizvodnje() vide modul
 *   - admin + pm + menadzment pišu (drag-drop, status, napomena, slike, REASSIGN)
 *   - leadpm / hr / viewer read-only — edit dugmad disabled
 */

import { escHtml } from '../../lib/dom.js';
import { toggleTheme } from '../../lib/theme.js';
import { logout } from '../../services/auth.js';
import {
  getAuth,
  canEditPlanProizvodnje,
} from '../../state/auth.js';
import {
  renderPoMasiniTab,
  teardownPoMasiniTab,
} from './poMasiniTab.js';
import {
  renderZauzetostTab,
  teardownZauzetostTab,
} from './zauzetostTab.js';
import {
  renderPregledTab,
  teardownPregledTab,
} from './pregledTab.js';

const STORAGE_KEY_LAST_MACHINE = 'plan-proizvodnje:last-machine';

const TABS = [
  {
    id: 'po-masini',
    label: 'Po mašini',
    icon: '🛠',
    desc: 'Šef bira mašinu i raspoređuje operacije po prioritetu.',
  },
  {
    id: 'zauzetost',
    label: 'Zauzetost mašina',
    icon: '📊',
    desc: 'Ukupno otvorenih operacija i tehnološkog vremena po mašini.',
  },
  {
    id: 'pregled',
    label: 'Pregled svih',
    icon: '🗂',
    desc: 'Matrica svih mašina × narednih 5 dana.',
  },
];

let activeTab = 'po-masini';

export function renderPlanProizvodnjeModule(mountEl, { onBackToHub, onLogout }) {
  const auth = getAuth();
  const canEdit = canEditPlanProizvodnje();

  mountEl.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'kadrovska-section';
  container.id = 'module-plan-proizvodnje';
  container.style.display = 'block';

  container.innerHTML = `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button class="btn-hub-back" id="ppBackBtn" title="Nazad na listu modula" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">🏭</span>
          <span>Planiranje proizvodnje</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button class="theme-toggle" id="ppThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <div class="hub-user">
          <span class="hub-user-email">${escHtml(auth.user?.email || '—')}</span>
          <span class="hub-user-role">${escHtml(auth.role)}${canEdit ? '' : ' · read-only'}</span>
        </div>
        <button class="hub-logout" id="ppLogoutBtn">Odjavi se</button>
      </div>
    </header>

    <nav class="kadrovska-tabs" role="tablist" aria-label="Plan Proizvodnje tabovi">
      ${TABS.map(t => `
        <button type="button" role="tab"
          class="kadrovska-tab${t.id === activeTab ? ' is-active' : ''}"
          data-tab="${t.id}"
          aria-selected="${t.id === activeTab ? 'true' : 'false'}">
          <span aria-hidden="true">${t.icon}</span> ${escHtml(t.label)}
        </button>
      `).join('')}
    </nav>

    <main class="kadrovska-tabpanel pp-tabpanel" id="ppTabBody"></main>
  `;

  mountEl.appendChild(container);

  /* Wire događaji */
  container.querySelector('#ppBackBtn').addEventListener('click', () => onBackToHub?.());
  container.querySelector('#ppThemeToggle').addEventListener('click', toggleTheme);
  container.querySelector('#ppLogoutBtn').addEventListener('click', async () => {
    await logout();
    onLogout?.();
  });

  container.querySelectorAll('button[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      if (tabId === activeTab) return;
      teardownActiveTab();
      activeTab = tabId;
      /* Re-render header (active tab markup) + body */
      renderPlanProizvodnjeModule(mountEl, { onBackToHub, onLogout });
    });
  });

  renderTabBody(container.querySelector('#ppTabBody'), {
    canEdit, mountEl, onBackToHub, onLogout,
  });
}

function renderTabBody(host, { canEdit, mountEl, onBackToHub, onLogout }) {
  /* Callback koji "Zauzetost" i "Pregled" tabovi koriste za skok u
     "Po mašini" sa preselektovanom mašinom. */
  const jumpToPoMasini = (machineCode) => {
    if (machineCode) {
      localStorage.setItem(STORAGE_KEY_LAST_MACHINE, machineCode);
    }
    if (activeTab !== 'po-masini') {
      teardownActiveTab();
      activeTab = 'po-masini';
      renderPlanProizvodnjeModule(mountEl, { onBackToHub, onLogout });
    }
  };

  if (activeTab === 'po-masini') {
    /* SPRINT F.2: glavni view — selektor mašine, tabela operacija,
       drag-drop, status pill, napomena, REASSIGN. */
    renderPoMasiniTab(host, { canEdit });
    return;
  }

  if (activeTab === 'zauzetost') {
    /* SPRINT F.3a: zbirno po mašini (otvorene operacije, planirano vreme,
       hitnost, premešteno…) */
    renderZauzetostTab(host, { canEdit, onJumpToPoMasini: jumpToPoMasini });
    return;
  }

  if (activeTab === 'pregled') {
    /* SPRINT F.3b: matrica MAŠINA × NAREDNIH 5 RADNIH DANA */
    renderPregledTab(host, { canEdit, onJumpToPoMasini: jumpToPoMasini });
    return;
  }

  /* Fallback (ne bi trebalo da se desi) */
  const tab = TABS.find(t => t.id === activeTab) || TABS[0];
  host.innerHTML = `<div class="pp-state"><div class="pp-state-title">${escHtml(tab.label)}</div></div>`;
}

function teardownActiveTab() {
  if (activeTab === 'po-masini') teardownPoMasiniTab();
  if (activeTab === 'zauzetost') teardownZauzetostTab();
  if (activeTab === 'pregled')   teardownPregledTab();
}

export function teardownPlanProizvodnjeModule() {
  teardownActiveTab();
}
