/**
 * Servoteh ERP — Vite entry point.
 *
 * Faza 0: scaffold + env verifikacija.                      ✓
 * Faza 1: import CSS-a iz legacy fajla u src/styles/legacy.css. ✓
 * Faza 2: lib + services + state moduli izvučeni.           ✓
 * Faza 3: Auth screen + Module hub + Theme manager + router. ← (ovaj fajl)
 * Faza 4: Kadrovska modul UI (zameni placeholder).
 * Faza 5: Plan Montaže modul UI (zameni placeholder) + Podešavanja.
 * Faza 6: Production cutover (Cloudflare Pages → dist/).
 */

import './styles/legacy.css';
import './styles/planProizvodnje.css';
import './styles/sastanci.css';
import './styles/maintenance.css';
import './styles/mobile.css';

import { hasSupabaseConfig } from './lib/constants.js';
import { showToast } from './lib/dom.js';
import { restoreSession } from './services/auth.js';
import { loadAndApplyUserRole } from './services/userRoles.js';
import { initRouter } from './ui/router.js';

const root = document.getElementById('app');
if (!root) {
  throw new Error('Vite mount point #app nije pronađen u index.html');
}

/**
 * Kada aplikaciju pokrećemo kao Capacitor Android APK, WebView startuje sa
 * `index.html` (root `/`). Bez intervencije bi se corisnik uvek video kao
 * ERP hub koji nema smisla na telefonu magacionera. Zato pri svakom cold
 * startu forsiramo rutu `/m` PRE bootstrap-a routera.
 *
 * Detekcija:
 *   - `window.Capacitor?.isNativePlatform()` je dostupan samo unutar
 *     Capacitor runtime-a (inject-uje ga `capacitor-android` plugin).
 *   - Na web build-u vraća `undefined` → nikakav side-effect.
 *   - Ako je user već negde u `/m/*` (npr. PWA shortcut), ostavi ga tamo.
 *
 * Odavde NE treba da se poziva `history.pushState` jer initRouter koristi
 * `window.location.pathname` kao izvor istine — `history.replaceState`
 * je dovoljan i ne kreira lažan back-entry.
 */
function redirectToMobileIfNative() {
  try {
    const isNative = typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.();
    if (!isNative) return;
    const p = window.location.pathname;
    if (!p || p === '/' || p === '/index.html' || p === '/hub') {
      history.replaceState(null, '', '/m');
    }
  } catch (e) {
    /* Capacitor bridge ponekad nije spreman dok se WebView inicijalizuje —
     * u tom slučaju ostavljamo trenutnu rutu. */
    console.warn('[main] capacitor native detection failed', e);
  }
}
redirectToMobileIfNative();

/**
 * Bootstrap sekvenca:
 *   1) (sync) inicijalizuj theme — odmah, da ne bude flash-a.
 *   2) (async) restoreSession → loadAndApplyUserRole.
 *   3) initRouter → ili login, ili hub, ili poslednji modul iz session-a.
 */
async function bootstrap() {
  console.log('[main] Faza 3 bootstrap starting…', {
    mode: import.meta.env.MODE,
    supabase: hasSupabaseConfig() ? 'configured' : 'MISSING (proveri .env)',
  });

  if (hasSupabaseConfig()) {
    try {
      const restored = await restoreSession();
      if (restored) {
        await loadAndApplyUserRole();
      }
    } catch (e) {
      console.error('[main] restoreSession failed', e);
    }
  } else {
    /* Bez Supabase env-a aplikacija može samo u offline modu. */
    console.warn('[main] VITE_SUPABASE_URL/ANON_KEY nisu postavljeni. Aplikacija će raditi samo u offline modu.');
  }

  /* Toast container (renderuje ga prvi `showToast` poziv ako ne postoji,
     ali ovde ga eksplicitno postavljamo da bi imao definisan z-index sloj). */
  if (!document.getElementById('toast')) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.id = 'toast';
    document.body.appendChild(t);
  }

  initRouter(root);

  console.log('[main] Faza 3 bootstrap done.');
}

bootstrap().catch(e => {
  console.error('[main] FATAL bootstrap error', e);
  showToast('⚠ Greška pri pokretanju aplikacije');
  root.innerHTML = `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
      <div class="auth-box" style="max-width:520px">
        <div class="auth-brand">
          <div class="auth-title">Greška pri pokretanju</div>
          <div class="auth-subtitle">${(e && e.message) || String(e)}</div>
        </div>
        <pre style="background:var(--surface3);padding:12px;border-radius:6px;font-family:var(--mono);font-size:11px;color:var(--text2);text-align:left;overflow:auto;max-height:240px">${(e && e.stack) || ''}</pre>
      </div>
    </div>
  `;
});
