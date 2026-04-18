/**
 * Mini router — bira koji "screen" se renderuje u root mount-u.
 *
 * Stanja (nisu URL-routes — apliakacija je SPA bez hash routing-a, kao i
 * legacy/index.html):
 *   'login'          — auth overlay (renderLoginScreen)
 *   'hub'            — module hub
 *   'plan-montaze'   — placeholder (Faza 5)
 *   'kadrovska'      — placeholder (Faza 4)
 *   'podesavanja'    — placeholder (Faza 5b)
 *
 * Aktivni modul se persistuje u sessionStorage pod SESSION_KEYS.MODULE_HUB
 * (isti ključ kao legacy → omogućava da F5 cutover ne resetuje aktivni tab).
 */

import { ssGet, ssSet, ssRemove } from '../lib/storage.js';
import { SESSION_KEYS } from '../lib/constants.js';
import { initTheme } from '../lib/theme.js';
import { renderLoginScreen } from './auth/loginScreen.js';
import { renderModuleHub } from './hub/moduleHub.js';
import { renderModulePlaceholder } from './modulePlaceholder.js';
import { renderKadrovskaModule } from './kadrovska/index.js';
import { renderPlanMontazeModule, teardownPlanMontazeModule } from './planMontaze/index.js';
import { renderPodesavanjaModule, teardownPodesavanjaModule } from './podesavanja/index.js';
import { getAuth, canAccessKadrovska, canManageUsers } from '../state/auth.js';
import { resetKadrovskaState } from '../state/kadrovska.js';
import { showToast } from '../lib/dom.js';
import { loadAndApplyUserRole } from '../services/userRoles.js';

const MODULES = ['plan-montaze', 'kadrovska', 'podesavanja'];

let mountEl = null;
let currentScreen = null;

function clearMount() {
  /* Cleanup za plan modul (status panel singleton, auth subscription). */
  if (currentScreen === 'plan-montaze') {
    try { teardownPlanMontazeModule(); } catch (e) { /* ignore */ }
  }
  if (currentScreen === 'podesavanja') {
    try { teardownPodesavanjaModule(); } catch (e) { /* ignore */ }
  }
  if (mountEl) mountEl.innerHTML = '';
  /* Skidamo SVE legacy + nove module klase sa body-ja da ne bismo
     ostavili stari display-toggle koji ide preko CSS-a. */
  document.body.classList.remove(
    'hub-active',
    'kadrovska-active',
    'module-kadrovska',
    'module-settings',
    'plan-active',
    'module-plan',
  );
}

function getStoredModule() {
  return ssGet(SESSION_KEYS.MODULE_HUB, null);
}
function setStoredModule(mod) {
  if (mod) ssSet(SESSION_KEYS.MODULE_HUB, mod);
  else ssRemove(SESSION_KEYS.MODULE_HUB);
}

/* ── Screen renderers ── */

function showLogin() {
  currentScreen = 'login';
  clearMount();
  setStoredModule(null);
  const screen = renderLoginScreen({
    onLoginSuccess: async () => {
      /* Posle login-a: skoči na role lookup, pa hub. */
      const auth = getAuth();
      if (auth.user && auth.isOnline) {
        await loadAndApplyUserRole();
      }
      restoreOrShowHub();
    },
  });
  mountEl.appendChild(screen);
}

function showHub() {
  currentScreen = 'hub';
  clearMount();
  document.body.classList.add('hub-active');
  setStoredModule(null);
  const screen = renderModuleHub({
    onModuleSelect: (moduleId) => navigateToModule(moduleId),
    onLogout: () => {
      resetKadrovskaState();
      showLogin();
    },
  });
  mountEl.appendChild(screen);
}

function showModulePlaceholder(moduleId) {
  currentScreen = moduleId;
  clearMount();
  /* Legacy CSS koristi body.module-* klase za visibility (display:none !important
     na #module-kadrovska / #module-settings ako odgovarajuća klasa nije setovana).
     Dok ne migriramo te selektore u Vite-only verziju, postavi obe klase. */
  if (moduleId === 'kadrovska') {
    document.body.classList.add('kadrovska-active', 'module-kadrovska');
  }
  if (moduleId === 'podesavanja') {
    document.body.classList.add('module-settings');
  }
  if (moduleId === 'plan-montaze') {
    document.body.classList.add('plan-active', 'module-plan');
  }
  setStoredModule(moduleId);

  /* Faza 4: Kadrovska više nije placeholder — renderuje real modul. */
  if (moduleId === 'kadrovska') {
    try {
      renderKadrovskaModule(mountEl, {
        onBackToHub: () => showHub(),
        onLogout: () => {
          resetKadrovskaState();
          showLogin();
        },
      });
    } catch (e) {
      console.error('[router] Kadrovska render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u Kadrovska modulu</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <pre style="background:var(--surface3,#222);padding:12px;border-radius:6px;font-family:var(--mono,monospace);font-size:11px;color:var(--text2,#ccc);text-align:left;overflow:auto;max-height:280px">${(e && e.stack) || ''}</pre>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="kadrErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      const back = mountEl.querySelector('#kadrErrBackBtn');
      back?.addEventListener('click', () => showHub());
    }
    return;
  }

  /* Faza 5.1.a: Plan Montaže shell (project bar + WP tabs + meta). */
  if (moduleId === 'plan-montaze') {
    try {
      renderPlanMontazeModule(mountEl, {
        onBackToHub: () => showHub(),
        onLogout: () => {
          resetKadrovskaState();
          showLogin();
        },
      });
    } catch (e) {
      console.error('[router] Plan Montaže render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u Plan Montaže modulu</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <pre style="background:var(--surface3,#222);padding:12px;border-radius:6px;font-family:var(--mono,monospace);font-size:11px;color:var(--text2,#ccc);text-align:left;overflow:auto;max-height:280px">${(e && e.stack) || ''}</pre>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="planErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      const back = mountEl.querySelector('#planErrBackBtn');
      back?.addEventListener('click', () => showHub());
    }
    return;
  }

  /* Faza 5b: Podešavanja (Korisnici tab + placeholderi). */
  if (moduleId === 'podesavanja') {
    try {
      renderPodesavanjaModule(mountEl, {
        onBackToHub: () => showHub(),
        onLogout: () => {
          resetKadrovskaState();
          showLogin();
        },
      });
    } catch (e) {
      console.error('[router] Podešavanja render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u Podešavanja modulu</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <pre style="background:var(--surface3,#222);padding:12px;border-radius:6px;font-family:var(--mono,monospace);font-size:11px;color:var(--text2,#ccc);text-align:left;overflow:auto;max-height:280px">${(e && e.stack) || ''}</pre>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="podErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      const back = mountEl.querySelector('#podErrBackBtn');
      back?.addEventListener('click', () => showHub());
    }
    return;
  }

  /* Fallback: placeholder za nepoznate module (ne bi trebalo da se desi). */
  const screen = renderModulePlaceholder({
    moduleId,
    onBack: () => showHub(),
    onLogout: () => {
      resetKadrovskaState();
      showLogin();
    },
  });
  mountEl.appendChild(screen);
}

/* ── Navigation guards ── */

function navigateToModule(moduleId) {
  if (!MODULES.includes(moduleId)) {
    showToast('⚠ Nepoznat modul: ' + moduleId);
    return;
  }
  if (moduleId === 'kadrovska' && !canAccessKadrovska()) {
    showToast('🔒 Kadrovska je dostupna samo HR/admin korisnicima');
    return;
  }
  if (moduleId === 'podesavanja' && !canManageUsers()) {
    showToast('🔒 Podešavanja su dostupna samo admin korisnicima');
    return;
  }
  showModulePlaceholder(moduleId);
}

/** Posle login-a — vrati korisnika na poslednji aktivan modul, ili na hub. */
function restoreOrShowHub() {
  const last = getStoredModule();
  if (last && MODULES.includes(last)) {
    if (last === 'kadrovska' && !canAccessKadrovska()) return showHub();
    if (last === 'podesavanja' && !canManageUsers()) return showHub();
    return showModulePlaceholder(last);
  }
  showHub();
}

/* ── Public API ── */

export function initRouter(rootEl) {
  if (!rootEl) throw new Error('initRouter: rootEl je obavezan');
  mountEl = rootEl;
  initTheme();

  const auth = getAuth();
  if (auth.user) {
    /* Već smo ulogovani (restoreSession u bootstrap-u je uspeo). */
    restoreOrShowHub();
  } else {
    showLogin();
  }
}

export function getCurrentScreen() {
  return currentScreen;
}

/** Ručno (npr. iz logout call-back-a) — vrati na login. */
export function navigateToLogin() {
  showLogin();
}
