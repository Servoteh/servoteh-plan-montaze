/**
 * Podešavanja — root modula (F5b).
 *
 * Tabovi:
 *   - Korisnici  (admin only — full CRUD osim INSERT)
 *   - Matični podaci (placeholder)
 *   - Sistem (placeholder)
 *
 * Bezbednosna provera — ulaz u modul je već gated u router.js
 * (canManageUsers()), ali ovde duplo proveravamo i pokazujemo lock screen
 * ako neko ipak dođe direktno (npr. preko sessionStorage state-a).
 *
 * Aktivni tab se persistuje u sessionStorage (SETTINGS_TAB), kao u legacy.
 */

import { escHtml } from '../../lib/dom.js';
import { ssGet, ssSet } from '../../lib/storage.js';
import { SESSION_KEYS } from '../../lib/constants.js';
import { toggleTheme } from '../../lib/theme.js';
import { onAuthChange, getAuth, canManageUsers } from '../../state/auth.js';
import { usersState } from '../../state/users.js';
import { renderUsersTab, refreshUsers, wireUsersTab } from './usersTab.js';
import { renderMastersTab } from './mastersTab.js';
import { renderSystemTab } from './systemTab.js';

let _mountEl = null;
let _onLogoutCb = null;
let _onBackToHubCb = null;
let _authUnsubscribe = null;
let _activeTab = 'users';

const TABS = [
  { id: 'users', label: 'Korisnici' },
  { id: 'masters', label: 'Matični podaci' },
  { id: 'system', label: 'Sistem' },
];

export async function renderPodesavanjaModule(mountEl, options = {}) {
  _mountEl = mountEl;
  _onLogoutCb = options.onLogout || null;
  _onBackToHubCb = options.onBackToHub || null;
  _activeTab = ssGet(SESSION_KEYS.SETTINGS_TAB, 'users') || 'users';
  if (!TABS.some(t => t.id === _activeTab)) _activeTab = 'users';

  _renderShell();

  /* Async DB load za Korisnici tab — kada svežih podaci stignu, rerenderuj. */
  if (_activeTab === 'users') {
    refreshUsers().then(() => _renderShell()).catch(e => console.warn('[podesavanja] users load failed', e));
  }

  if (_authUnsubscribe) _authUnsubscribe();
  _authUnsubscribe = onAuthChange(() => _renderShell());
}

export function teardownPodesavanjaModule() {
  if (_authUnsubscribe) { _authUnsubscribe(); _authUnsubscribe = null; }
}

/* ── INTERNAL ─────────────────────────────────────────────────────────── */

function _renderShell() {
  if (!_mountEl) return;

  if (!canManageUsers()) {
    _mountEl.innerHTML = _lockedScreenHtml();
    _mountEl.querySelector('#podBackBtn')?.addEventListener('click', () => _onBackToHubCb?.());
    _mountEl.querySelector('#podLogoutBtn')?.addEventListener('click', () => _onLogoutCb?.());
    return;
  }

  _mountEl.innerHTML = `
    ${_headerHtml()}
    <div class="kadrovska-tabs" role="tablist" aria-label="Podešavanja - sekcije">
      ${TABS.map(t => `
        <button class="kadrovska-tab ${t.id === _activeTab ? 'active' : ''}"
                role="tab"
                aria-selected="${t.id === _activeTab}"
                data-set-tab="${t.id}">
          ${escHtml(t.label)}
          ${t.id === 'users' ? `<span class="kadr-tab-badge" id="setTabCountUsers">${usersState.items.length}</span>` : ''}
        </button>
      `).join('')}
    </div>
    <div class="kadr-panel active" id="setPanel-${_activeTab}" role="tabpanel">
      ${_panelHtml(_activeTab)}
    </div>
  `;
  _wireHeader();
  _wireTabs();
  _wireTabBody();
}

function _headerHtml() {
  const auth = getAuth();
  return `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button class="btn-hub-back" id="podBackBtn" title="Nazad na listu modula" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">⚙</span>
          <span>Podešavanja</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button class="theme-toggle" id="podThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <span class="role-indicator role-${escHtml(auth.role || 'viewer')}" id="podRoleLabel">${escHtml((auth.role || 'viewer').toUpperCase())}</span>
        <button class="hub-logout" id="podLogoutBtn">Odjavi se</button>
      </div>
    </header>
  `;
}

function _panelHtml(tab) {
  if (tab === 'users') return renderUsersTab({ onChange: () => _renderShell() });
  if (tab === 'masters') return renderMastersTab();
  if (tab === 'system') return renderSystemTab();
  return '';
}

function _lockedScreenHtml() {
  const auth = getAuth();
  return `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button class="btn-hub-back" id="podBackBtn">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">🔒</span>
          <span>Podešavanja</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <span class="role-indicator role-viewer">${escHtml((auth.role || 'viewer').toUpperCase())}</span>
        <button class="hub-logout" id="podLogoutBtn">Odjavi se</button>
      </div>
    </header>
    <main style="padding:32px;max-width:640px;margin:0 auto">
      <div class="auth-box" style="max-width:none;text-align:left">
        <div class="auth-brand">
          <div class="auth-title">🔒 Pristup zabranjen</div>
          <div class="auth-subtitle">Podešavanja su dostupna samo korisnicima sa <strong>admin</strong> rolom.</div>
        </div>
        <p class="form-hint" style="margin-top:14px">Ako misliš da bi trebalo da imaš pristup, javi se nekom od admina ili HR-u da ti dodeli odgovarajuću rolu kroz Supabase SQL Editor.</p>
      </div>
    </main>
  `;
}

function _wireHeader() {
  _mountEl.querySelector('#podBackBtn')?.addEventListener('click', () => _onBackToHubCb?.());
  _mountEl.querySelector('#podLogoutBtn')?.addEventListener('click', () => _onLogoutCb?.());
  _mountEl.querySelector('#podThemeToggle')?.addEventListener('click', () => toggleTheme());
}

function _wireTabs() {
  _mountEl.querySelectorAll('[data-set-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.setTab;
      if (!t || t === _activeTab) return;
      _activeTab = t;
      ssSet(SESSION_KEYS.SETTINGS_TAB, t);
      _renderShell();
      if (t === 'users') {
        refreshUsers().then(() => _renderShell()).catch(e => console.warn('[podesavanja] users refresh failed', e));
      }
    });
  });
}

function _wireTabBody() {
  if (_activeTab === 'users') {
    wireUsersTab(_mountEl, { onChange: () => _renderShell() });
  }
}
