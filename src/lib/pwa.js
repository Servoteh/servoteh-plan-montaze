/**
 * PWA helper — registruje Service Worker generisan od `vite-plugin-pwa`,
 * ali samo kada smo na `/m/*` ruti. Glavna ERP aplikacija (hub, plan
 * montaže, kadrovska…) NE želi SW jer:
 *   - često deploy-ujemo manje izmene koje treba da idu odmah u browser;
 *   - kadrovska obradu radi realtime → stari SW cache bi skrivao update.
 *
 * Na `/m/*` rutama, naprotiv, želimo agresivni cache — magacioner ne
 * sme da vidi "beli ekran" ako mu WiFi padne dok je usred premeštanja.
 *
 * API: `registerMobilePWA()` idempotentan; siguran za višestruki poziv.
 * Ako browser ne podržava SW ili smo u dev build-u, tiho no-op.
 */

let _registered = false;

export async function registerMobilePWA() {
  if (_registered) return;
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) {
    console.warn('[pwa] Service Worker API nije dostupan — PWA disabled.');
    return;
  }
  _registered = true;

  try {
    /* `virtual:pwa-register` se generiše tokom build-a od strane
     * vite-plugin-pwa. U dev modu postoji samo ako je `devOptions.enabled`
     * u vite.config.js (zasad nije — da ne zbuni HMR). */
    const { registerSW } = await import('virtual:pwa-register');
    registerSW({
      immediate: true,
      onRegisteredSW(swUrl, registration) {
        console.info('[pwa] SW registered', swUrl);
        /* Periodični update check — svaki put kad radnik otvori app,
         * pokušamo da skinemo novu verziju. Bez ovoga SW bi update-ovao
         * samo kad browser slučajno „odluči". 15 min je razuman kompromis. */
        if (registration) {
          setInterval(() => {
            registration.update().catch(() => {});
          }, 15 * 60 * 1000);
        }
      },
      onOfflineReady() {
        console.info('[pwa] Ready for offline use.');
      },
      onRegisterError(err) {
        console.error('[pwa] SW registration failed', err);
      },
    });
  } catch (e) {
    /* U dev-u (ili ako je plugin uklonjen) import će fail-ovati; to je OK. */
    console.warn('[pwa] registerSW import failed (likely dev mode):', e?.message || e);
  }
}
