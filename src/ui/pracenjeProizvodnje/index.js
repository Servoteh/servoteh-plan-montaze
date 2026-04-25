/**
 * Praćenje proizvodnje — frontend skelet.
 */

import { escHtml } from '../../lib/dom.js';
import { toggleTheme } from '../../lib/theme.js';
import { logout } from '../../services/auth.js';
import { getAuth } from '../../state/auth.js';
import {
  getPracenjeSnapshot,
  loadPracenje,
  resetPracenjeState,
  setActiveTab,
  startRealtime,
  stopRealtime,
  subscribePracenje,
} from '../../state/pracenjeProizvodnjeState.js';
import { pageHeaderHtml } from './pageHeader.js';
import { tab1PozicijeHtml, wireTab1Pozicije } from './tab1Pozicije.js';
import {
  tabFromHash,
  tabSwitcherHtml,
  wireTabSwitcher,
} from './tabSwitcher.js';
import {
  tab2OperativniPlanHtml,
  wireTab2OperativniPlan,
} from './tab2OperativniPlan.js';
import { exportTab1ToExcel } from '../../services/pracenjeExport.js';

const TEST_RN_ID = '55555555-5555-5555-5555-555555555501';

let _mountEl = null;
let _onBackToHub = null;
let _onLogout = null;
let _unsubscribe = null;
let _hashHandler = null;

export function renderPracenjeProizvodnjeModule(mountEl, options = {}) {
  _mountEl = mountEl;
  _onBackToHub = options.onBackToHub || null;
  _onLogout = options.onLogout || null;

  const hashTab = tabFromHash();
  if (hashTab) setActiveTab(hashTab);

  if (_unsubscribe) _unsubscribe();
  _unsubscribe = subscribePracenje(() => renderShell());

  if (_hashHandler) window.removeEventListener('hashchange', _hashHandler);
  _hashHandler = () => {
    const tab = tabFromHash();
    if (tab) setActiveTab(tab);
  };
  window.addEventListener('hashchange', _hashHandler);

  const rnId = new URLSearchParams(window.location.search).get('rn');
  if (rnId && rnId !== getPracenjeSnapshot().rnId) {
    void loadPracenje(rnId).then(ok => { if (ok) startRealtime(); });
  } else {
    renderShell();
    if (rnId) startRealtime();
  }
}

export function teardownPracenjeProizvodnjeModule() {
  stopRealtime();
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
  if (_hashHandler) { window.removeEventListener('hashchange', _hashHandler); _hashHandler = null; }
  resetPracenjeState();
  _mountEl = null;
}

function renderShell() {
  if (!_mountEl) return;
  const state = getPracenjeSnapshot();
  const auth = getAuth();
  _mountEl.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'kadrovska-section';
  container.id = 'module-pracenje-proizvodnje';
  container.style.display = 'block';
  container.innerHTML = `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button class="btn-hub-back" id="pracenjeBackBtn" title="Nazad na listu modula" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">▣</span>
          <span>Praćenje proizvodnje</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button class="theme-toggle" id="pracenjeThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <div class="hub-user">
          <span class="hub-user-email">${escHtml(auth.user?.email || '—')}</span>
          <span class="hub-user-role">${escHtml(auth.role)}${state.rnId && !state.canEdit ? ' · read-only' : ''}</span>
        </div>
        <button class="hub-logout" id="pracenjeLogoutBtn">Odjavi se</button>
      </div>
    </header>
    <main class="kadrovska-tabpanel" style="padding:24px;max-width:1680px;margin:0 auto">
      ${rnLoaderHtml(state)}
      ${state.rnId ? pageHeaderHtml(state) : ''}
      ${state.rnId ? tabSwitcherHtml(state.activeTab) : ''}
      <div id="pracenjeErrorBox">${state.error ? errorHtml(state.error) : ''}</div>
      <section id="pracenjeBody">${bodyHtml(state)}</section>
    </main>
  `;
  _mountEl.appendChild(container);
  wireShell(container, state);
}

function rnLoaderHtml(state) {
  return `
    <section class="form-card" style="margin-bottom:14px">
      <div class="pp-toolbar" style="margin:0">
        <label class="pp-rn-filter">
          <span>RN broj ili UUID</span>
          <input type="text" id="pracenjeRnInput" value="${escHtml(state.rnId || '')}" placeholder="npr. RN-PRAC-TEST-001 ili ${TEST_RN_ID}">
        </label>
        <button type="button" class="pp-refresh-btn" id="pracenjeLoadBtn">${state.loading ? 'Učitavanje…' : 'Učitaj RN'}</button>
        <button type="button" class="pp-refresh-btn" id="pracenjeSeedBtn" title="Test RN iz Inkrementa 1">Test RN</button>
        <div class="pp-toolbar-spacer"></div>
        ${state.live?.active ? `<span class="pp-counter">Live: ${escHtml(state.live.mode || 'polling')}</span>` : ''}
        ${state.saving ? '<span class="pp-counter">Snimanje u toku…</span>' : ''}
      </div>
    </section>
  `;
}

function bodyHtml(state) {
  if (!state.rnId) {
    return `
      <div class="pp-state">
        <div class="pp-state-icon">...</div>
        <div class="pp-state-title">Izaberi radni nalog</div>
        <div class="pp-state-desc">Otvori modul sa <code>?rn=&lt;uuid&gt;</code> ili unesi RN broj/UUID u polje iznad.</div>
      </div>
    `;
  }
  if (state.loading && !state.tab1Data) {
    return `<div class="pp-state"><div class="pp-state-icon">...</div><div class="pp-state-title">Učitavanje proizvodnje…</div></div>`;
  }
  if (state.activeTab === 'operativni_plan') return tab2OperativniPlanHtml(state);
  return tab1PozicijeHtml(state);
}

function wireShell(container, state) {
  container.querySelector('#pracenjeBackBtn')?.addEventListener('click', () => _onBackToHub?.());
  container.querySelector('#pracenjeThemeToggle')?.addEventListener('click', toggleTheme);
  container.querySelector('#pracenjeLogoutBtn')?.addEventListener('click', async () => {
    await logout();
    _onLogout?.();
  });
  container.querySelector('#pracenjeLoadBtn')?.addEventListener('click', () => {
    const rnId = container.querySelector('#pracenjeRnInput')?.value?.trim();
    loadFromInput(rnId);
  });
  container.querySelector('#pracenjeRnInput')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') loadFromInput(ev.target.value?.trim());
  });
  container.querySelector('#pracenjeSeedBtn')?.addEventListener('click', () => loadFromInput(TEST_RN_ID));
  wireTabSwitcher(container, renderShell);
  if (state.activeTab === 'operativni_plan') {
    wireTab2OperativniPlan(container, state, renderShell);
  } else {
    wireTab1Pozicije(container, state);
    container.querySelector('#exportTab1Btn')?.addEventListener('click', () => {
      void exportTab1ToExcel(state.rnId, state.tab1Data || {});
    });
  }
  container.querySelector('#pracenjeRetryBtn')?.addEventListener('click', () => {
    if (state.rnId) void loadPracenje(state.rnId);
  });
}

function loadFromInput(rnId) {
  if (!rnId) return;
  const params = new URLSearchParams(window.location.search);
  params.set('rn', rnId);
  const hash = window.location.hash || '#tab=po_pozicijama';
  history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${hash}`);
  void loadPracenje(rnId).then(ok => { if (ok) startRealtime(); });
}

function errorHtml(message) {
  return `
    <div class="pp-error" style="margin-bottom:14px">
      ${escHtml(message)}
      <button type="button" class="btn btn-ghost" id="pracenjeRetryBtn" style="margin-left:8px">Pokušaj ponovo</button>
    </div>
  `;
}
