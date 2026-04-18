/**
 * Servoteh ERP — Vite entry point.
 *
 * Faza 0: samo placeholder koji potvrđuje da Vite radi i da su env vars
 * dostupne. U Fazi 1 dolaze CSS importi, u Fazi 3 pravi auth + hub mount.
 *
 * Production aplikacija i dalje radi na `legacy/index.html` deploy-u dok
 * Faza 6 (cutover) ne završi.
 */

const root = document.getElementById('app');

if (!root) {
  throw new Error('Vite mount point #app nije pronađen u index.html');
}

const supaUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supaKeyPresent = !!import.meta.env.VITE_SUPABASE_ANON_KEY;

root.innerHTML = `
  <main style="
    min-height:100vh;
    display:flex;
    align-items:center;
    justify-content:center;
    flex-direction:column;
    gap:16px;
    background:#0a0e14;
    color:#e6edf3;
    font-family:'IBM Plex Sans', system-ui, sans-serif;
    padding:24px;
    text-align:center;
  ">
    <div style="font-size:48px">🏭</div>
    <h1 style="margin:0;font-size:28px;font-weight:600">Servoteh — Vite migracija u toku</h1>
    <p style="margin:0;color:#8b949e;max-width:520px;line-height:1.5">
      Ovo je <strong>razvojna instanca</strong> nove modularne verzije aplikacije.
      Korisnici i dalje koriste <code>legacy/index.html</code> deploy.
    </p>
    <pre style="
      background:#161b22;
      padding:12px 16px;
      border-radius:8px;
      border:1px solid #30363d;
      font-family:'IBM Plex Mono', monospace;
      font-size:12px;
      color:#8b949e;
      text-align:left;
      max-width:640px;
      overflow:auto;
    ">VITE_SUPABASE_URL       = ${supaUrl ? supaUrl : '<span style="color:#f85149">missing</span>'}
VITE_SUPABASE_ANON_KEY  = ${supaKeyPresent ? '✓ loaded (length=' + import.meta.env.VITE_SUPABASE_ANON_KEY.length + ')' : '<span style="color:#f85149">missing</span>'}
NODE_ENV / MODE         = ${import.meta.env.MODE}</pre>
    <p style="margin:0;color:#6e7681;font-size:12px">
      Faza 0 — Setup ✓<br>
      Sledeće: Faza 1 (CSS) → Faza 2 (services) → Faza 3 (auth + hub) → Faza 4 (Kadrovska) → Faza 5 (Plan Montaže) → Faza 6 (cutover)
    </p>
  </main>
`;

console.log('[main] Vite scaffold ready. ENV check:', {
  VITE_SUPABASE_URL: supaUrl ? '✓' : 'missing',
  VITE_SUPABASE_ANON_KEY: supaKeyPresent ? '✓' : 'missing',
  MODE: import.meta.env.MODE,
});
