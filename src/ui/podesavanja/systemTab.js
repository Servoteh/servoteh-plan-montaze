/**
 * Podešavanja → Sistem (placeholder).
 *
 * Kasnije: rezervna kopija, Supabase env info, dijagnostika, sync status.
 */

import { escHtml } from '../../lib/dom.js';
import { hasSupabaseConfig, SUPABASE_CONFIG } from '../../lib/constants.js';
import { getAuth } from '../../state/auth.js';

export function renderSystemTab() {
  const auth = getAuth();
  const url = SUPABASE_CONFIG.url || '—';
  const hasKey = !!SUPABASE_CONFIG.anonKey;
  return `
    <main class="kadrovska-main" style="display:flex;flex-direction:column;gap:14px;max-width:720px">
      <div class="kpi-grid">
        <div class="kpi-card kpi-${auth.isOnline ? 'info' : 'warn'}">
          <div class="kpi-label">Konekcija</div>
          <div class="kpi-value" style="font-size:14px">${auth.isOnline ? 'Online' : 'Offline'}</div>
          <div class="kpi-sub">${auth.isOnline ? 'Supabase REST dostupan' : 'localStorage fallback'}</div>
        </div>
        <div class="kpi-card kpi-${hasSupabaseConfig() ? 'info' : 'warn'}">
          <div class="kpi-label">Supabase config</div>
          <div class="kpi-value" style="font-size:14px">${hasSupabaseConfig() ? 'OK' : 'Nepotpun'}</div>
          <div class="kpi-sub">${hasKey ? 'anon key prisutan' : 'nema anon key-a'}</div>
        </div>
        <div class="kpi-card kpi-neutral">
          <div class="kpi-label">URL</div>
          <div class="kpi-value" style="font-size:11px;font-family:var(--mono);word-break:break-all">${escHtml(url)}</div>
          <div class="kpi-sub">env: VITE_SUPABASE_URL</div>
        </div>
      </div>
      <div class="kadrovska-empty">
        <div class="kadrovska-empty-title">Sistem — u izradi</div>
        <div>Rezervna kopija, dijagnostika, sync status, audit log. Biće dostupno u sledećoj fazi.</div>
      </div>
    </main>
  `;
}
