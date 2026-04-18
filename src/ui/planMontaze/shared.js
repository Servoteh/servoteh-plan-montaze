/**
 * Plan Montaže — deljeni building blocks.
 *
 * - planHeaderHtml() — header sa back/title/role/theme/logout (ID-jevi za wire)
 * - viewTabsHtml(active) — Plan / Gantt / Total tab strip
 * - personOptionsHtml(list, currentValue) — <select> options sa "+ Dodaj novog…"
 *   sentinel, koji UI handler treba da prepozna i pita prompt.
 * - locationOptionsHtml(currentValue) — <select> options za lokacije aktivnog projekta.
 *
 * Sva dugmad rade preko addEventListener (selektori po ID-u/data atributu).
 */

import { escHtml } from '../../lib/dom.js';
import { getAuth, canEdit } from '../../state/auth.js';
import { getProjectLocations } from '../../state/planMontaze.js';

/** Header za Plan Montaže modul. ID-ovi se koriste za event wire-ovanje. */
export function planHeaderHtml() {
  const auth = getAuth();
  return `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button class="btn-hub-back" id="planBackBtn" title="Nazad na listu modula" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">📋</span>
          <span>Plan Montaže</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button class="theme-toggle" id="planThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <span class="role-indicator ${canEdit() ? 'role-pm' : 'role-viewer'}" id="planRoleLabel">${escHtml((auth.role || 'viewer').toUpperCase())}</span>
        <button class="hub-logout" id="planLogoutBtn">Odjavi se</button>
      </div>
    </header>`;
}

/** View tab strip: Plan / Gantt / Total. */
export function viewTabsHtml(activeView) {
  const tabs = [
    { id: 'plan', label: '📋 Plan' },
    { id: 'gantt', label: '📊 Gantt' },
    { id: 'total', label: '🌐 Ukupan Gant' },
  ];
  return `
    <div class="kadrovska-tabs" role="tablist" aria-label="Plan Montaže — pogled">
      ${tabs.map(t => `
        <button class="kadrovska-tab view-tab${t.id === activeView ? ' active' : ''}" role="tab"
                aria-selected="${t.id === activeView}" data-view="${t.id}">
          ${escHtml(t.label)}
        </button>
      `).join('')}
    </div>`;
}

/**
 * <option> liste za izbor osobe (engineer ili lead). Append-uje sentinel
 * "+ Dodaj novog..." sa value="__add__". UI handler mora da prepozna
 * tu vrednost i otvori prompt.
 *
 * Ako trenutna vrednost (currentValue) nije u listi, dodaje se na vrh
 * sa selected da ne nestane (npr. uneta ručno kroz drugi browser).
 */
export function personOptionsHtml(list, currentValue) {
  const cur = String(currentValue || '');
  let has = false;
  const opts = list.map(v => {
    const sel = v === cur;
    if (sel) has = true;
    return `<option value="${escHtml(v)}"${sel ? ' selected' : ''}>${escHtml(v) || '—'}</option>`;
  }).join('');
  const unknownOpt = (cur && !has)
    ? `<option value="${escHtml(cur)}" selected>${escHtml(cur)}</option>`
    : '';
  return unknownOpt + opts
    + '<option value="__add__" style="font-weight:600;color:var(--accent)">➕ Dodaj novog…</option>';
}

/** <option> liste lokacija aktivnog projekta. */
export function locationOptionsHtml(currentValue) {
  const list = getProjectLocations();
  let has = false;
  const opts = list.map(l => {
    const sel = l === currentValue;
    if (sel) has = true;
    return `<option value="${escHtml(l)}"${sel ? ' selected' : ''}>${escHtml(l)}</option>`;
  }).join('');
  if (currentValue && !has) {
    return `<option value="${escHtml(currentValue)}" selected>${escHtml(currentValue)}</option>` + opts;
  }
  return opts;
}
