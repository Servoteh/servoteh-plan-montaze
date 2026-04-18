/**
 * Placeholder modul UI — privremena stranica za module čiji UI još nije
 * portovan iz legacy/index.html (Plan Montaže → Faza 5, Kadrovska → Faza 4,
 * Podešavanja → Faza 5b).
 *
 * Pokazuje da je modul "izabran", ima header sa back dugmetom, theme toggle,
 * user info i logout — SVE PRAVO funkcionalno (auth tok je gotov u Fazi 3).
 * Telo modula je info kartica sa porukom šta dolazi u sledećoj fazi.
 *
 * Cilj: dokazati da auth/hub/router pipeline radi end-to-end pre nego što
 * se uvuče ~4000 linija UI logike iz legacy-ja.
 */

import { showToast, escHtml } from '../lib/dom.js';
import { toggleTheme } from '../lib/theme.js';
import { logout } from '../services/auth.js';
import { getAuth } from '../state/auth.js';
import { loadAndApplyUserRole } from '../services/userRoles.js';
import { loadEmployeesFromDb } from '../services/employees.js';
import { loadProjectsFromDb } from '../services/projects.js';

const MODULE_META = {
  'plan-montaze': {
    icon: '🛠',
    title: 'Plan Montaže',
    nextPhase: 'Faza 5',
    desc: 'Project bar, WP tabovi, plan tabela, mobilne kartice, gantt, total gantt, kalendar popup, filteri, reminder zona, status panel, dodavanje faze.',
    probes: ['probe-projects'],
  },
  'kadrovska': {
    icon: '👥',
    title: 'Kadrovska',
    nextPhase: 'Faza 4',
    desc: 'Zaposleni + Odsustva + Sati + Ugovori + Mesečni grid + Reports tabovi.',
    probes: ['probe-employees'],
  },
  'podesavanja': {
    icon: '⚙',
    title: 'Podešavanja',
    nextPhase: 'Faza 5b',
    desc: 'Korisnici / uloge tab — sa istim bezbednosnim zaključavanjem kao u legacy-ju (read-only, novi useri se dodaju samo iz Supabase SQL Editor-a).',
    probes: ['reload-roles'],
  },
};

export function renderModulePlaceholder({ moduleId, onBack, onLogout }) {
  const meta = MODULE_META[moduleId] || {
    icon: '❓',
    title: moduleId,
    nextPhase: '?',
    desc: 'Nepoznat modul',
    probes: [],
  };
  const auth = getAuth();

  const container = document.createElement('div');
  container.className = 'kadrovska-section'; // koristi postojeći layout iz legacy CSS-a
  container.id = `module-${moduleId}`;
  container.style.display = 'block';
  container.innerHTML = `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button class="btn-hub-back" id="moduleBackBtn" title="Nazad na listu modula" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">${meta.icon}</span>
          <span>${escHtml(meta.title)}</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button class="theme-toggle" id="moduleThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <div class="hub-user">
          <span class="hub-user-email">${escHtml(auth.user?.email || '—')}</span>
          <span class="hub-user-role">${escHtml(auth.role)}</span>
        </div>
        <button class="hub-logout" id="moduleLogoutBtn">Odjavi se</button>
      </div>
    </header>

    <main style="padding:32px;max-width:920px;margin:0 auto">
      <div class="auth-box" style="max-width:none;text-align:left">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px">
          <div style="font-size:42px;line-height:1">${meta.icon}</div>
          <div>
            <h2 style="margin:0;font-size:22px;color:var(--text)">${escHtml(meta.title)}</h2>
            <div style="font-size:13px;color:var(--text2);margin-top:4px">UI dolazi u <strong style="color:var(--accent)">${escHtml(meta.nextPhase)}</strong> migracije</div>
          </div>
        </div>

        <p style="color:var(--text2);margin:0 0 18px 0;line-height:1.6">${escHtml(meta.desc)}</p>

        <div class="kpi-grid" style="margin-bottom:18px">
          <div class="kpi-card kpi-info">
            <div class="kpi-label">Auth</div>
            <div class="kpi-value" style="font-size:14px">${escHtml(auth.user?.email || '—')}</div>
            <div class="kpi-sub">${escHtml(auth.role)}</div>
          </div>
          <div class="kpi-card kpi-${auth.isOnline ? 'info' : 'warn'}">
            <div class="kpi-label">Online</div>
            <div class="kpi-value" style="font-size:14px">${auth.isOnline ? 'YES' : 'NO'}</div>
            <div class="kpi-sub">${auth.isOnline ? 'Supabase REST' : 'localStorage fallback'}</div>
          </div>
          <div class="kpi-card kpi-neutral">
            <div class="kpi-label">Modul</div>
            <div class="kpi-value" style="font-size:14px">${escHtml(moduleId)}</div>
            <div class="kpi-sub">router OK</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${meta.probes.includes('probe-projects')
              ? `<button class="btn btn-secondary" type="button" data-probe="projects">📦 Probe projects</button>` : ''}
            ${meta.probes.includes('probe-employees')
              ? `<button class="btn btn-secondary" type="button" data-probe="employees">👥 Probe employees</button>` : ''}
            ${meta.probes.includes('reload-roles')
              ? `<button class="btn btn-secondary" type="button" data-probe="roles">🔄 Reload roles</button>` : ''}
          </div>
          <pre id="moduleProbeLog" style="background:var(--surface3);padding:10px;border-radius:6px;border:1px solid var(--border2);font-family:var(--mono);font-size:11px;color:var(--text2);max-height:160px;overflow:auto;margin:6px 0 0 0"></pre>
        </div>

        <div class="auth-footer" style="margin-top:18px">
          Ovo je <strong>privremeni placeholder</strong>. Pravi UI se uvlači u sledećoj fazi migracije.
          Za hitne promene postojeća produkcija je netaknuta na <strong>main</strong> grani (legacy/index.html).
        </div>
      </div>
    </main>
  `;

  /* Wire događaji */
  container.querySelector('#moduleBackBtn').addEventListener('click', () => onBack?.());
  container.querySelector('#moduleThemeToggle').addEventListener('click', toggleTheme);
  container.querySelector('#moduleLogoutBtn').addEventListener('click', async () => {
    await logout();
    onLogout?.();
  });

  const logEl = container.querySelector('#moduleProbeLog');
  function appendLog(line) {
    const ts = new Date().toLocaleTimeString();
    logEl.textContent = `[${ts}] ${line}\n` + logEl.textContent;
  }

  container.querySelectorAll('button[data-probe]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const probe = btn.dataset.probe;
      try {
        if (probe === 'projects') {
          appendLog('probe projects…');
          const list = await loadProjectsFromDb();
          appendLog(list ? `projects=${list.length}` : 'projects: null');
        } else if (probe === 'employees') {
          appendLog('probe employees…');
          const list = await loadEmployeesFromDb();
          appendLog(list ? `employees=${list.length}` : 'employees: null');
        } else if (probe === 'roles') {
          appendLog('reload roles…');
          const { role, matches } = await loadAndApplyUserRole();
          appendLog(`role=${role} matches=${matches.length}`);
        }
      } catch (e) {
        appendLog('ERR ' + (e?.message || String(e)));
        showToast('⚠ ' + (e?.message || 'Greška'));
      }
    });
  });

  return container;
}
