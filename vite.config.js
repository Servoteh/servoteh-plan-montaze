import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Servoteh ERP — Vite konfiguracija.
 *
 * Napomene:
 *  - Root je root repo-a (postojeći fajlovi). NE seli root u podfolder.
 *  - Build izlaz ide u `dist/`. Cloudflare Pages mora da ima:
 *      Build command: npm run build
 *      Build output:  dist
 *      Env vars:      VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
 *  - `public/` se kopira 1:1 u `dist/` na build-u (Vite default). Tu su:
 *      - `_redirects` / `_headers` (CF Pages SPA fallback + cache rules)
 *      - `legacy/index.html` (arhivska monolitna verzija, dostupna na
 *        `https://<host>/legacy/` kao rollback bez novog deploya)
 *  - `legacy/` (root) se NE bundle-uje — ostaje samo kao referenca
 *    tokom migracije. Vidi MIGRATION.md.
 */
/* `__APP_VERSION__` — stabilan string koji se koristi u mobilnom footer-u da
 * magacioner zna tačno koju verziju aplikacije pokreće (bitno za "reset cache"
 * troubleshooting). Izvor: `VITE_APP_VERSION` env var iz CI-a ili kratki SHA;
 * fallback `dev`. Zamena se radi u build-time (nije JS runtime lookup). */
const appVersion =
  process.env.VITE_APP_VERSION ||
  process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7) ||
  process.env.GITHUB_SHA?.slice(0, 7) ||
  'dev';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
  plugins: [
    VitePWA({
      /* Registracija je ručna (preko src/lib/pwa.js) — automatski bi
       * registrovao SW i za `/` rutu gde nam PWA ne treba (ERP modul
       * radi kao „klasična" SPA). Time kontrolišemo da SW radi samo
       * kad je korisnik na `/m/*` ruti. */
      registerType: 'prompt',
      injectRegister: null,
      strategies: 'generateSW',
      includeAssets: ['icons/servoteh-lokacije.svg'],
      manifest: {
        name: 'Servoteh Lokacije',
        short_name: 'Lokacije',
        description: 'Skeniraj barkod i premesti delove u magacinu Servoteh.',
        lang: 'sr',
        theme_color: '#0a0e14',
        background_color: '#0a0e14',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/m',
        scope: '/m',
        /* Kategorije pomažu PWA store-ovima (Play TWA, Microsoft Store). */
        categories: ['business', 'productivity', 'utilities'],
        icons: [
          {
            src: '/icons/servoteh-lokacije.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        /* Precache samo core assets (HTML + CSS + JS iz /assets/).
         * `clientsClaim + skipWaiting` da novi SW odmah preuzme kontrolu
         * nakon update (inače bi magacioner morao 2x da otvori app da vidi
         * novu verziju — praktično nikad). */
        clientsClaim: true,
        skipWaiting: true,
        globPatterns: ['**/*.{js,css,html,svg}'],
        /* Navigacijski fallback: sve unknown rute pod `/m/*` idu na
         * `index.html` (SPA). Vite-plugin-pwa ovo radi automatski, ali
         * eksplicitno scope-ujemo samo na `/m/*` da ne ometamo ostale
         * rute aplikacije. */
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/(?!m($|\/))/, /* Sve osim `/m` i `/m/*`. */
        ],
        runtimeCaching: [
          {
            /* Supabase REST — NE cache-uj POST/PATCH/DELETE (mutacije),
             * samo GET read-after-write. Ali za premeštanja koristimo
             * offlineQueue → ne zavisimo od SW retry-ja. Ovo služi samo
             * da `fetchLocations` radi i bez WiFi-ja (lokacije se retko
             * menjaju). */
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\/rest\/v1\/loc_locations.*/,
            handler: 'StaleWhileRevalidate',
            method: 'GET',
            options: {
              cacheName: 'loc-locations-cache',
              expiration: {
                maxEntries: 4,
                maxAgeSeconds: 60 * 60 * 24, /* 24h. */
              },
            },
          },
          {
            /* Google Fonts CSS + fajl — obavezno da telefon može offline
             * otvoriti `/m` bez buzz-a font-a. */
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 * 365,
              },
            },
          },
        ],
      },
    }),
  ],
});
