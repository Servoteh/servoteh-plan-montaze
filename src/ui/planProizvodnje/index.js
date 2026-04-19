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
 *   - Svi authenticated mogu da otvore i čitaju
 *   - admin + pm mogu da pišu (drag-drop, status, napomena, slike, REASSIGN)
 *   - leadpm/hr/viewer su read-only — sva edit dugmad disabled
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

    <main class="kadrovska-tabpanel" id="ppTabBody" style="padding:24px;max-width:1280px;margin:0 auto"></main>
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

  renderTabBody(container.querySelector('#ppTabBody'), { canEdit });
}

function renderTabBody(host, { canEdit }) {
  const tab = TABS.find(t => t.id === activeTab) || TABS[0];

  if (activeTab === 'po-masini') {
    /* SPRINT F.2: ovo je glavni view — selektor mašine, tabela operacija,
       drag-drop, status pill, napomena, REASSIGN. */
    renderPoMasiniTab(host, { canEdit });
    return;
  }

  /* F.3 / F.4: placeholderi dok ne implementiramo */
  host.innerHTML = `
    <div class="auth-box" style="max-width:none;text-align:left">
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
        <div style="font-size:42px;line-height:1">${tab.icon}</div>
        <div>
          <h2 style="margin:0;font-size:22px;color:var(--text)">${escHtml(tab.label)}</h2>
          <div style="font-size:13px;color:var(--text2);margin-top:4px">${escHtml(tab.desc)}</div>
        </div>
      </div>

      <div style="background:var(--surface3,#1a1d23);border:1px dashed var(--border2,#3a3f47);border-radius:8px;padding:24px;color:var(--text2,#aaa);text-align:center">
        <div style="font-size:32px;margin-bottom:8px">🚧</div>
        <div style="font-size:15px;color:var(--text);margin-bottom:6px">U izradi (Sprint F.3)</div>
        <div style="font-size:13px;line-height:1.6">
          Ovaj tab će prikazati ${activeTab === 'zauzetost'
            ? 'zbirno opterećenje po mašini (broj otvorenih operacija + planirano tehnološko vreme)'
            : 'matricu svih mašina × narednih 5 dana sa hitnošću'}.<br>
          Sledi posle Sprint F.2 testiranja.
        </div>
      </div>

      <div class="auth-footer" style="margin-top:18px">
        ${canEdit
          ? '✅ Tvoja rola dozvoljava edit u "Po mašini" tabu.'
          : '🔒 Ti si u read-only modu. Edit dozvoljen samo za <strong>admin</strong> i <strong>pm</strong>.'}
      </div>
    </div>
  `;
}

function teardownActiveTab() {
  if (activeTab === 'po-masini') teardownPoMasiniTab();
}

export function teardownPlanProizvodnjeModule() {
  teardownActiveTab();
}
