import { defineConfig } from 'vite';

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
export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
});
