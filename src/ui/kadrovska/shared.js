/**
 * Deljeni building blocks za sve Kadrovska tabove.
 *
 * - kadrovskaHeaderHtml() vraća HTML za header (back/title/theme/role/logout).
 *   Wire-ovi se vežu u root render-u (renderKadrovskaModule).
 * - renderSummaryChips() popunjava .kadr-summary-strip kroz dati ID.
 * - kadrTabsHtml() — top tab bar (Zaposleni / Odsustva / ...).
 *
 * Sva dugmad rade preko addEventListener (selectori po ID-u/data atributu).
 */

import { escHtml } from '../../lib/dom.js';
import { getAuth, canEdit } from '../../state/auth.js';
import { kadrovskaState } from '../../state/kadrovska.js';

/** Stranica jedne kartice u summary strip-u. */
export function summaryChipHtml(label, value, tone) {
  const cls = tone ? 'kadr-summary-chip ' + tone : 'kadr-summary-chip';
  return `<div class="${cls}"><span class="kscl">${escHtml(label)}</span><span class="kscv">${escHtml(String(value))}</span></div>`;
}

/** Renderuj listu chip-ova u kontejner; sakrij ako je prazno. */
export function renderSummaryChips(containerId, chips) {
  const host = document.getElementById(containerId);
  if (!host) return;
  if (!chips || !chips.length) {
    host.innerHTML = '';
    host.style.display = 'none';
    return;
  }
  host.style.display = 'flex';
  host.innerHTML = chips.map(c => summaryChipHtml(c.label, c.value, c.tone)).join('');
}

/** Header za Kadrovska modul. ID-ovi se koriste za event wire-ovanje. */
export function kadrovskaHeaderHtml() {
  const auth = getAuth();
  return `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button class="btn-hub-back" id="kadrBackBtn" title="Nazad na listu modula" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">👥</span>
          <span>Kadrovska</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button class="theme-toggle" id="kadrThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <span class="role-indicator ${canEdit() ? 'role-pm' : 'role-viewer'}" id="kadrovskaRoleLabel">${escHtml((auth.role || 'viewer').toUpperCase())}</span>
        <button class="hub-logout" id="kadrLogoutBtn">Odjavi se</button>
      </div>
    </header>`;
}

/**
 * HTML <option> liste svih zaposlenih (sortirano po imenu, sr-locale).
 *  - includeBlank: doda prazan top option ('Svi zaposleni' / '— izaberi —').
 *  - blankLabel: tekst praznog opciona.
 *  - selectedId: prefilled value.
 *  - activeOnly: ako true, samo isActive.
 */
export function employeeOptionsHtml({
  includeBlank = true,
  blankLabel = '— izaberi —',
  selectedId = '',
  activeOnly = false,
} = {}) {
  let list = kadrovskaState.employees.slice();
  if (activeOnly) list = list.filter(e => e.isActive);
  list.sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'sr'));
  const opts = [];
  if (includeBlank) {
    opts.push(`<option value="">${escHtml(blankLabel)}</option>`);
  }
  for (const e of list) {
    const sel = String(e.id) === String(selectedId) ? ' selected' : '';
    opts.push(`<option value="${escHtml(e.id)}"${sel}>${escHtml(e.fullName || '—')}</option>`);
  }
  return opts.join('');
}

/** Tab bar sa badge-ovima. Active tab se kontroliše classList.add('active'). */
export function kadrTabsHtml(activeTab) {
  const tabs = [
    { id: 'employees', label: 'Zaposleni', badgeId: 'kadrTabCountEmployees' },
    { id: 'absences', label: 'Odsustva', badgeId: 'kadrTabCountAbsences' },
    { id: 'grid', label: 'Mesečni grid', badgeId: 'kadrTabCountGrid' },
    { id: 'hours', label: 'Sati (pojedinačno)', badgeId: 'kadrTabCountHours' },
    { id: 'contracts', label: 'Ugovori', badgeId: 'kadrTabCountContracts' },
    { id: 'reports', label: 'Izveštaji', badgeId: 'kadrTabCountReports' },
  ];
  return `
    <div class="kadrovska-tabs" role="tablist" aria-label="Kadrovska - sekcije">
      ${tabs.map(t => `
        <button class="kadrovska-tab${t.id === activeTab ? ' active' : ''}" role="tab"
                aria-selected="${t.id === activeTab}" data-kadr-tab="${t.id}">
          ${escHtml(t.label)} <span class="kadr-tab-badge" id="${t.badgeId}">0</span>
        </button>
      `).join('')}
    </div>`;
}
