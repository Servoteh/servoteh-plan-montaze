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
 *  - `legacy/index.html` se NE bundle-uje (nije u Vite ulazima). Ostaje u
 *    repo-u kao referenca tokom migracije.
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
