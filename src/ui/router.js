/**
 * Mini router — bira koji "screen" se renderuje u root mount-u.
 *
 * URL (History API) je izvor istine za deep linkove; `/*` ide na index.html
 * preko Cloudflare Pages (public/_redirects). Korisnik na `/` i dalje može
 * da dobije poslednji modul iz sessionStorage (ponašanje kao ranije).
 */

import { ssGet, ssSet, ssRemove } from '../lib/storage.js';
import { SESSION_KEYS } from '../lib/constants.js';
import {
  pathnameToRoute,
  pathForModule,
  parseSearchParams,
  buildMaintenanceMachinePath,
} from '../lib/appPaths.js';
import { initTheme } from '../lib/theme.js';
import { renderLoginScreen } from './auth/loginScreen.js';
import {
  renderResetPasswordScreen,
  parseRecoveryUrl,
} from './auth/resetPasswordScreen.js';
import { renderModuleHub } from './hub/moduleHub.js';
import { renderModulePlaceholder } from './modulePlaceholder.js';
import { renderKadrovskaModule } from './kadrovska/index.js';
import { renderPlanMontazeModule, teardownPlanMontazeModule } from './planMontaze/index.js';
import { renderPodesavanjaModule, teardownPodesavanjaModule } from './podesavanja/index.js';
import {
  renderPlanProizvodnjeModule,
  teardownPlanProizvodnjeModule,
} from './planProizvodnje/index.js';
import {
  renderPracenjeProizvodnjeModule,
  teardownPracenjeProizvodnjeModule,
} from './pracenjeProizvodnje/index.js';
import {
  renderSastanciModule,
  teardownSastanciModule,
} from './sastanci/index.js';
import {
  renderLokacijeModule,
  teardownLokacijeModule,
} from './lokacije/index.js';
import {
  renderMobileHome,
  renderMobileScan,
  renderMobileManual,
} from './mobile/mobileHome.js';
import { renderMobileHistory } from './mobile/mobileHistory.js';
import { renderMobileBatch } from './mobile/mobileBatch.js';
import { renderMobileLookup } from './mobile/mobileLookup.js';
import { installAutoFlush } from '../services/offlineQueue.js';
import { registerMobilePWA } from '../lib/pwa.js';
import {
  getAuth,
  canAccessKadrovska,
  canManageUsers,
  canAccessPodesavanja,
  canAccessPlanProizvodnje,
  canAccessSastanci,
  canAccessLokacije,
} from '../state/auth.js';
import { resetKadrovskaState } from '../state/kadrovska.js';
import { resetSastanciState } from '../state/sastanci.js';
import { showToast } from '../lib/dom.js';
import { loadAndApplyUserRole } from '../services/userRoles.js';
import { renderMaintenanceShell, teardownMaintenanceShell } from './odrzavanjeMasina/index.js';

const MODULES = [
  'plan-montaze',
  'lokacije-delova',
  'plan-proizvodnje',
  'pracenje-proizvodnje',
  'kadrovska',
  'sastanci',
  'podesavanja',
  'odrzavanje-masina',
];

let mountEl = null;
let currentScreen = null;
/** Teardown funkcija trenutno aktivnog mobile ekrana (ako postoji). */
let currentMobileTeardown = null;

/**
 * @param {string | null} leavingScreen Ekran koji napuštamo (pre promene currentScreen).
 */
function clearMount(leavingScreen) {
  const ls = leavingScreen;
  if (ls === 'plan-montaze') {
    try { teardownPlanMontazeModule(); } catch (e) { /* ignore */ }
  }
  if (ls === 'podesavanja') {
    try { teardownPodesavanjaModule(); } catch (e) { /* ignore */ }
  }
  if (ls === 'plan-proizvodnje') {
    try { teardownPlanProizvodnjeModule(); } catch (e) { /* ignore */ }
  }
  if (ls === 'pracenje-proizvodnje') {
    try { teardownPracenjeProizvodnjeModule(); } catch (e) { /* ignore */ }
  }
  if (ls === 'sastanci') {
    try { teardownSastanciModule(); } catch (e) { /* ignore */ }
  }
  if (ls === 'lokacije-delova') {
    try { teardownLokacijeModule(); } catch (e) { /* ignore */ }
  }
  if (ls === 'odrzavanje-masina') {
    try { teardownMaintenanceShell(); } catch (e) { /* ignore */ }
  }
  if (ls && ls.startsWith('mobile-')) {
    try { currentMobileTeardown?.(); } catch (e) { /* ignore */ }
    currentMobileTeardown = null;
  }
  if (mountEl) mountEl.innerHTML = '';
  document.body.classList.remove(
    'hub-active',
    'kadrovska-active',
    'module-kadrovska',
    'module-settings',
    'plan-active',
    'module-plan',
    'module-plan-proizvodnje',
    'module-pracenje-proizvodnje',
    'module-lokacije',
    'module-sastanci',
    'module-odrzavanje-masina',
    'm-body',
  );
}

/**
 * @param {string} path pathname + optional ?query
 * @param {{ replace?: boolean }} [opts]
 */
function syncBrowserUrl(path, opts = {}) {
  const next = path.startsWith('/') ? path : `/${path}`;
  const cur = window.location.pathname + window.location.search;
  if (cur === next) return;
  if (opts.replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
}

function canAccessMaintenance() {
  const auth = getAuth();
  return !!(auth.user && auth.isOnline);
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
  const leaving = currentScreen;
  currentScreen = 'login';
  clearMount(leaving);
  setStoredModule(null);
  const screen = renderLoginScreen({
    onLoginSuccess: async () => {
      const auth = getAuth();
      if (auth.user && auth.isOnline) {
        await loadAndApplyUserRole();
      }
      const saved = ssGet(SESSION_KEYS.POST_LOGIN_REDIRECT, null);
      if (saved) {
        ssRemove(SESSION_KEYS.POST_LOGIN_REDIRECT);
        history.replaceState(null, '', saved);
        applyRouteFromLocation();
      } else {
        restoreOrShowHub();
      }
    },
    onForgotPassword: () => {
      history.pushState(null, '', '/reset-password');
      showResetPassword();
    },
  });
  mountEl.appendChild(screen);
}

/**
 * Reset password ekran — javan (ne zahteva login). Otvara se kad korisnik:
 *   1. klikne "Zaboravljena lozinka?" na login ekranu → prazna forma za
 *      slanje mail-a;
 *   2. otvori magic link iz Supabase email-a → forma za novu lozinku.
 */
function showResetPassword() {
  const leaving = currentScreen;
  currentScreen = 'reset-password';
  clearMount(leaving);
  setStoredModule(null);
  const screen = renderResetPasswordScreen({
    onSuccess: async () => {
      /* Posle uspešnog reseta, sesija je već persistovana u state/localStorage.
       * Primeni ulogu pa idi na hub. */
      try {
        await loadAndApplyUserRole();
      } catch (e) {
        /* ignore — ako nije moguće, korisnik može ručno da ode na hub */
      }
      history.replaceState(null, '', '/');
      restoreOrShowHub();
    },
    onCancel: () => {
      /* Očisti URL od starog query-ja i vrati na login. */
      history.replaceState(null, '', '/');
      showLogin();
    },
  });
  mountEl.appendChild(screen);
}

function showHub() {
  const leaving = currentScreen;
  currentScreen = 'hub';
  clearMount(leaving);
  syncBrowserUrl('/');
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

function showModulePlaceholder(moduleId, options = {}) {
  const leaving = currentScreen;
  currentScreen = moduleId;
  clearMount(leaving);
  if (!options.skipUrlSync) {
    const path = (moduleId === 'sastanci' && options.sastanakId)
      ? `/sastanci/${options.sastanakId}`
      : pathForModule(moduleId);
    syncBrowserUrl(path);
  }
  const opts = options;
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
  if (moduleId === 'plan-proizvodnje') {
    /* Koristimo isti kadrovska body class jer modul deli layout primitive-e
       (kadrovska-section, kadrovska-header, kadrovska-tabs). */
    document.body.classList.add('kadrovska-active', 'module-plan-proizvodnje');
  }
  if (moduleId === 'pracenje-proizvodnje') {
    document.body.classList.add('kadrovska-active', 'module-pracenje-proizvodnje');
  }
  if (moduleId === 'sastanci') {
    document.body.classList.add('kadrovska-active', 'module-sastanci');
  }
  if (moduleId === 'lokacije-delova') {
    document.body.classList.add('kadrovska-active', 'module-lokacije');
  }
  if (moduleId === 'odrzavanje-masina') {
    document.body.classList.add('kadrovska-active', 'module-odrzavanje-masina');
  }
  setStoredModule(moduleId);

  if (moduleId === 'odrzavanje-masina') {
    try {
      renderMaintenanceShell(mountEl, {
        section: 'dashboard',
        machineCode: null,
        tab: null,
        onBackToHub: () => {
          syncBrowserUrl('/');
          showHub();
        },
        onLogout: () => {
          resetKadrovskaState();
          showLogin();
        },
        onNavigateToPath: navigateToAppPath,
      });
    } catch (e) {
      console.error('[router] Održavanje render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u modulu Održavanje</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="maintErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      mountEl.querySelector('#maintErrBackBtn')?.addEventListener('click', () => showHub());
    }
    return;
  }

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

  /* Sprint F.1: Plan Proizvodnje (skelet sa 3 taba). */
  if (moduleId === 'plan-proizvodnje') {
    try {
      renderPlanProizvodnjeModule(mountEl, {
        onBackToHub: () => showHub(),
        onLogout: () => {
          resetKadrovskaState();
          showLogin();
        },
      });
    } catch (e) {
      console.error('[router] Plan Proizvodnje render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u Plan Proizvodnje modulu</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <pre style="background:var(--surface3,#222);padding:12px;border-radius:6px;font-family:var(--mono,monospace);font-size:11px;color:var(--text2,#ccc);text-align:left;overflow:auto;max-height:280px">${(e && e.stack) || ''}</pre>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="ppErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      const back = mountEl.querySelector('#ppErrBackBtn');
      back?.addEventListener('click', () => showHub());
    }
    return;
  }

  /* Praćenje proizvodnje — Faza 2 vertikalni isečak nad production RPC-jima. */
  if (moduleId === 'pracenje-proizvodnje') {
    try {
      renderPracenjeProizvodnjeModule(mountEl, {
        onBackToHub: () => showHub(),
        onLogout: () => {
          resetKadrovskaState();
          showLogin();
        },
      });
    } catch (e) {
      console.error('[router] Praćenje Proizvodnje render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u Praćenje proizvodnje modulu</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <pre style="background:var(--surface3,#222);padding:12px;border-radius:6px;font-family:var(--mono,monospace);font-size:11px;color:var(--text2,#ccc);text-align:left;overflow:auto;max-height:280px">${(e && e.stack) || ''}</pre>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="pracenjeErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      const back = mountEl.querySelector('#pracenjeErrBackBtn');
      back?.addEventListener('click', () => showHub());
    }
    return;
  }

  /* Lokacije delova (loc_* tabele + RPC). */
  if (moduleId === 'lokacije-delova') {
    try {
      renderLokacijeModule(mountEl, {
        onBackToHub: () => showHub(),
        onLogout: () => {
          resetKadrovskaState();
          showLogin();
        },
      });
    } catch (e) {
      console.error('[router] Lokacije delova render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u modulu Lokacije delova</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <pre style="background:var(--surface3,#222);padding:12px;border-radius:6px;font-family:var(--mono,monospace);font-size:11px;color:var(--text2,#ccc);text-align:left;overflow:auto;max-height:280px">${(e && e.stack) || ''}</pre>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="locErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      const back = mountEl.querySelector('#locErrBackBtn');
      back?.addEventListener('click', () => showHub());
    }
    return;
  }

  /* Modul Sastanci. */
  if (moduleId === 'sastanci') {
    try {
      renderSastanciModule(mountEl, {
        sastanakId: opts.sastanakId || null,
        sastanciTab: opts.sastanciTab || null,
        onBackToHub: () => showHub(),
        onLogout: () => {
          resetKadrovskaState();
          resetSastanciState();
          showLogin();
        },
      });
    } catch (e) {
      console.error('[router] Sastanci render failed', e);
      mountEl.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
          <div class="auth-box" style="max-width:640px">
            <div class="auth-brand">
              <div class="auth-title">Greška u Sastanci modulu</div>
              <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
            </div>
            <pre style="background:var(--surface3,#222);padding:12px;border-radius:6px;font-family:var(--mono,monospace);font-size:11px;color:var(--text2,#ccc);text-align:left;overflow:auto;max-height:280px">${(e && e.stack) || ''}</pre>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn" id="sastErrBackBtn">← Nazad na hub</button>
            </div>
          </div>
        </div>
      `;
      const back = mountEl.querySelector('#sastErrBackBtn');
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

/* ── Mobilni shell (magacin/viljuškar app) ── */

/**
 * Render mobilnog ekrana po `mobileScreen`. Instaluje auto-flush queue-a
 * jednom (idempotentno) da se offline zapisi automatski pošalju kad se WiFi
 * vrati. Za sve ekrane koristi jedan `#app` mount — pojedinačni render-i
 * sami vraćaju teardown funkciju koju čuvamo u `currentMobileTeardown`.
 *
 * @param {'home'|'scan'|'manual'|'history'|'batch'} screen
 * @param {{ skipUrlSync?: boolean }} [opts]
 */
async function showMobile(screen, opts = {}) {
  const leaving = currentScreen;
  const nextScreen = `mobile-${screen}`;
  currentScreen = nextScreen;
  clearMount(leaving);
  if (!opts.skipUrlSync) {
    const path =
      screen === 'home' ? '/m' : `/m/${screen}`;
    syncBrowserUrl(path);
  }
  setStoredModule(null);
  installAutoFlush();
  /* Registruj PWA service worker tek kada smo prvi put na `/m/*` — glavni
   * hub (ERP) namerno NE koristi SW (vidi src/lib/pwa.js). */
  void registerMobilePWA();

  const navCtx = {
    onNavigate: path => navigateToAppPath(path),
    onLogout: () => {
      resetKadrovskaState();
      showLogin();
    },
  };

  try {
    let result;
    if (screen === 'home') {
      result = renderMobileHome(mountEl, navCtx);
    } else if (screen === 'scan') {
      result = renderMobileScan(mountEl, navCtx);
    } else if (screen === 'manual') {
      result = renderMobileManual(mountEl, navCtx);
    } else if (screen === 'history') {
      result = await renderMobileHistory(mountEl, navCtx);
    } else if (screen === 'batch') {
      result = await renderMobileBatch(mountEl, navCtx);
    } else if (screen === 'lookup') {
      result = await renderMobileLookup(mountEl, navCtx);
    } else {
      navigateToAppPath('/m');
      return;
    }
    currentMobileTeardown = result?.teardown || null;
  } catch (e) {
    console.error('[router] Mobile render failed', e);
    mountEl.innerHTML = `
      <div class="m-shell">
        <header class="m-header">
          <div class="m-brand">
            <div class="m-brand-title">Greška</div>
            <div class="m-brand-sub">${escMsg(e)}</div>
          </div>
        </header>
        <main class="m-main">
          <button type="button" class="m-cta m-cta-primary" id="mErrBack">← Nazad</button>
        </main>
      </div>
    `;
    document.body.classList.add('m-body');
    mountEl.querySelector('#mErrBack')?.addEventListener('click', () => navigateToAppPath('/m'));
  }
}

function escMsg(e) {
  const s = (e && e.message) || String(e);
  return s.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
}

/* ── Navigation guards + URL sync ── */

/** @param {string} moduleId @returns {boolean} */
function assertModuleAllowed(moduleId) {
  if (!MODULES.includes(moduleId)) {
    showToast('⚠ Nepoznat modul: ' + moduleId);
    return false;
  }
  if (moduleId === 'kadrovska' && !canAccessKadrovska()) {
    showToast('🔒 Kadrovska je dostupna samo HR/admin korisnicima');
    return false;
  }
  if (moduleId === 'podesavanja' && !canAccessPodesavanja()) {
    showToast('🔒 Podešavanja su dostupna samo admin i menadžment korisnicima');
    return false;
  }
  if (moduleId === 'plan-proizvodnje' && !canAccessPlanProizvodnje()) {
    showToast('🔒 Plan Proizvodnje zahteva validnu autentifikaciju');
    return false;
  }
  if (moduleId === 'pracenje-proizvodnje' && !getAuth().user) {
    showToast('🔒 Praćenje proizvodnje zahteva validnu autentifikaciju');
    return false;
  }
  if (moduleId === 'sastanci' && !canAccessSastanci()) {
    showToast('🔒 Sastanci zahtevaju validnu autentifikaciju');
    return false;
  }
  if (moduleId === 'lokacije-delova' && !canAccessLokacije()) {
    showToast('🔒 Lokacije delova zahtevaju prijavu');
    return false;
  }
  if (moduleId === 'odrzavanje-masina' && !canAccessMaintenance()) {
    showToast('🔒 Održavanje zahteva prijavu');
    return false;
  }
  return true;
}

/**
 * Podruta održavanja (deep link), npr. /maintenance/machines/8.3?tab=checks
 * @param {{ kind: 'maintenance', moduleId: string, section: string, machineCode?: string }} route
 * @param {{ tab: string | null }} searchParsed
 * @param {{ skipUrlSync?: boolean }} [opts]
 */
function showMaintenanceFromRoute(route, searchParsed, opts = {}) {
  const leaving = currentScreen;
  currentScreen = 'odrzavanje-masina';
  clearMount(leaving);
  if (!opts.skipUrlSync) {
    let wantPath = '/maintenance';
    if (route.section === 'machines') wantPath = '/maintenance/machines';
    else if (route.section === 'board') wantPath = '/maintenance/board';
    else if (route.section === 'notifications') wantPath = '/maintenance/notifications';
    else if (route.section === 'catalog') wantPath = '/maintenance/catalog';
    else if (route.section === 'locations') wantPath = '/maintenance/locations';
    else if (route.section === 'workorders') wantPath = '/maintenance/work-orders';
    else if (route.section === 'machine' && route.machineCode) {
      wantPath = buildMaintenanceMachinePath(route.machineCode, searchParsed.tab);
    }
    syncBrowserUrl(wantPath);
  }
  document.body.classList.add('kadrovska-active', 'module-odrzavanje-masina');
  setStoredModule('odrzavanje-masina');
  const section =
    route.section === 'machines'
      ? 'machines'
      : route.section === 'machine'
        ? 'machine'
        : route.section === 'board'
          ? 'board'
          : route.section === 'notifications'
            ? 'notifications'
            : route.section === 'catalog'
              ? 'catalog'
              : route.section === 'locations'
                ? 'locations'
                : route.section === 'workorders'
                  ? 'workorders'
                  : 'dashboard';
  renderMaintenanceShell(mountEl, {
    section,
    machineCode: route.machineCode || null,
    tab: searchParsed.tab,
    onBackToHub: () => {
      syncBrowserUrl('/');
      showHub();
    },
    onLogout: () => {
      resetKadrovskaState();
      showLogin();
    },
    onNavigateToPath: navigateToAppPath,
  });
}

function applyRouteFromLocation() {
  const route = pathnameToRoute(window.location.pathname);
  const search = parseSearchParams(window.location.search);

  /* Reset password je javna ruta — uvek je obradi pre auth guard-a,
   * bez obzira da li korisnik ima sesiju. Supabase magic link može stići
   * i dok je druga sesija aktivna (npr. admin resetuje svoju lozinku). */
  if (route.kind === 'reset-password') {
    showResetPassword();
    return;
  }

  const auth = getAuth();
  if (!auth.user || !auth.isOnline) {
    return;
  }

  if (route.kind === 'unknown') {
    syncBrowserUrl('/', { replace: true });
    restoreOrShowHub();
    return;
  }

  if (route.kind === 'session') {
    restoreOrShowHub();
    return;
  }

  if (route.kind === 'hub') {
    showHub();
    return;
  }

  if (route.kind === 'maintenance') {
    if (!canAccessMaintenance()) {
      showToast('🔒 Održavanje zahteva prijavu.');
      syncBrowserUrl('/', { replace: true });
      showHub();
      return;
    }
    showMaintenanceFromRoute(route, search, { skipUrlSync: true });
    return;
  }

  if (route.kind === 'mobile') {
    if (!canAccessLokacije()) {
      showToast('🔒 Za mobilni shell je potrebna prijava.');
      syncBrowserUrl('/', { replace: true });
      showHub();
      return;
    }
    showMobile(route.mobileScreen || 'home', { skipUrlSync: true });
    return;
  }

  if (route.kind === 'module' && route.moduleId) {
    if (!assertModuleAllowed(route.moduleId)) {
      syncBrowserUrl('/', { replace: true });
      showHub();
      return;
    }
    showModulePlaceholder(route.moduleId, {
      skipUrlSync: true,
      sastanakId: route.sastanakId || null,
      sastanciTab: route.sastanciTab || null,
    });
  }
}

function navigateToModule(moduleId) {
  if (!assertModuleAllowed(moduleId)) return;
  syncBrowserUrl(pathForModule(moduleId));
  showModulePlaceholder(moduleId, { skipUrlSync: true });
}

/** Posle login-a — poslednji modul iz session-a ili hub; URL se usklađuje. */
function restoreOrShowHub() {
  const last = getStoredModule();
  if (last && MODULES.includes(last)) {
    if (last === 'kadrovska' && !canAccessKadrovska()) return showHub();
    if (last === 'podesavanja' && !canAccessPodesavanja()) return showHub();
    if (last === 'plan-proizvodnje' && !canAccessPlanProizvodnje()) return showHub();
    if (last === 'pracenje-proizvodnje' && !getAuth().user) return showHub();
    if (last === 'lokacije-delova' && !canAccessLokacije()) return showHub();
    if (last === 'sastanci' && !canAccessSastanci()) return showHub();
    if (last === 'odrzavanje-masina' && !canAccessMaintenance()) return showHub();
    syncBrowserUrl(pathForModule(last), { replace: true });
    return showModulePlaceholder(last, { skipUrlSync: true });
  }
  showHub();
}

/* ── Public API ── */

/**
 * Programska navigacija punom putanjom (npr. iz Telegram linka u budućem kodu).
 * @param {string} pathWithQuery npr. /maintenance/machines/8.3?tab=checks
 */
export function navigateToAppPath(pathWithQuery) {
  const auth = getAuth();
  const normalized = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  if (!auth.user || !auth.isOnline) {
    ssSet(SESSION_KEYS.POST_LOGIN_REDIRECT, normalized);
    showLogin();
    return;
  }
  history.pushState(null, '', normalized);
  applyRouteFromLocation();
}

export function initRouter(rootEl) {
  if (!rootEl) throw new Error('initRouter: rootEl je obavezan');
  mountEl = rootEl;
  initTheme();

  window.addEventListener('popstate', () => {
    const route = pathnameToRoute(window.location.pathname);
    if (route.kind === 'reset-password') {
      showResetPassword();
      return;
    }
    const auth = getAuth();
    if (!auth.user || !auth.isOnline) {
      showLogin();
      return;
    }
    applyRouteFromLocation();
  });

  /* Prepoznaj Supabase recovery flow: i kad je URL upravo `/` ali hash
   * sadrži `#access_token=...&type=recovery` (stariji Supabase email template
   * redirektuje na site URL bez path-a). U tom slučaju skreni na
   * /reset-password bez dodatnog koraka. */
  const recovery = parseRecoveryUrl();
  const isRecovery =
    recovery.type === 'recovery' ||
    (!!recovery.accessToken && !!recovery.refreshToken);
  if (isRecovery && window.location.pathname !== '/reset-password') {
    /* Sačuvaj hash — tu su access_token / refresh_token. */
    const hash = window.location.hash || '';
    history.replaceState(null, '', '/reset-password' + hash);
    showResetPassword();
    return;
  }

  const route = pathnameToRoute(window.location.pathname);
  if (route.kind === 'reset-password') {
    showResetPassword();
    return;
  }

  const auth = getAuth();
  if (auth.user) {
    applyRouteFromLocation();
  } else {
    if (route.kind !== 'session') {
      ssSet(SESSION_KEYS.POST_LOGIN_REDIRECT, window.location.pathname + window.location.search);
    }
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
