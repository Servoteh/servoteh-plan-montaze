/**
 * Modul Održavanje mašina — UI shell + liste (URL: /maintenance, …).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { toggleTheme } from '../../lib/theme.js';
import { logout } from '../../services/auth.js';
import { getAuth, getCurrentUser } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../services/supabase.js';
import {
  fetchMaintMachineStatuses,
  fetchMaintUserProfile,
  fetchMaintMachines,
  fetchMaintMachine,
  fetchMaintTasksForMachine,
  fetchMaintTasksForMachineAll,
  fetchMaintIncidentsForMachine,
  fetchBigtehnMachineRow,
  fetchMaintTaskDueDates,
  fetchMaintMachineNotes,
  insertMaintMachineNote,
  patchMaintMachineNote,
  patchMaintTask,
  fetchMaintMachineOverride,
} from '../../services/maintenance.js';
import { buildMaintenanceMachinePath } from '../../lib/appPaths.js';
import { openConfirmCheckModal, openReportIncidentModal } from './maintDialogs.js';
import { openIncidentDetailModal } from './maintIncidentDialog.js';
import {
  renderMaintTasksTab,
  openMaintTaskModal,
  canManageMaintTasks,
} from './maintTasksTab.js';
import { openMaintOverrideModal, canManageMaintOverride } from './maintOverrideDialog.js';
import {
  renderMaintNotificationsPanel,
  canAccessMaintNotifications,
} from './maintNotificationsTab.js';
import {
  renderMaintCatalogPanel,
  canManageMaintCatalog,
  openMaintMachineModal,
  openMaintMachinesImportDialog,
} from './maintCatalogTab.js';
import { renderMaintFilesTab } from './maintFilesTab.js';

let mountRef = null;
let disposeRef = { disposed: false };

function statusBadgeClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'mnt-badge mnt-badge--running';
  if (s === 'degraded') return 'mnt-badge mnt-badge--degraded';
  if (s === 'down') return 'mnt-badge mnt-badge--down';
  if (s === 'maintenance') return 'mnt-badge mnt-badge--maintenance';
  return 'mnt-badge';
}

function statusKpiClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'mnt-kpi mnt-kpi--running';
  if (s === 'degraded') return 'mnt-kpi mnt-kpi--degraded';
  if (s === 'down') return 'mnt-kpi mnt-kpi--down';
  if (s === 'maintenance') return 'mnt-kpi mnt-kpi--maintenance';
  return 'mnt-kpi';
}

const TAB_LABELS = {
  pregled: 'Pregled',
  kontrole: 'Kontrole',
  incidenti: 'Incidenti',
  napomene: 'Napomene',
  dokumenti: 'Dokumenti',
  sabloni: 'Šabloni',
};

function normalizeTab(tab) {
  const t = (tab || '').toLowerCase();
  if (t === 'checks') return 'kontrole';
  if (t === 'templates' || t === 'šabloni') return 'sabloni';
  if (TAB_LABELS[t]) return t;
  return 'pregled';
}

function severityBadge(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 'mnt-badge mnt-badge--down';
  if (s === 'major') return 'mnt-badge mnt-badge--degraded';
  return 'mnt-badge';
}

function headerHtml() {
  const auth = getAuth();
  return `
    <header class="kadrovska-header">
      <div class="kadrovska-header-left">
        <button type="button" class="btn-hub-back" id="mntBackHubBtn" title="Nazad na module" aria-label="Nazad na module">
          <span class="back-icon" aria-hidden="true">←</span>
          <span>Moduli</span>
        </button>
        <div class="kadrovska-title">
          <span class="ktitle-mark" aria-hidden="true">🛠</span>
          <span>Održavanje mašina</span>
        </div>
      </div>
      <div class="kadrovska-header-right">
        <button type="button" class="theme-toggle" id="mntThemeToggle" title="Promeni temu" aria-label="Promeni temu">
          <span class="theme-icon-dark">🌙</span>
          <span class="theme-icon-light">☀️</span>
        </button>
        <span class="role-indicator role-viewer" id="mntRoleLabel">${escHtml((auth.role || 'viewer').toUpperCase())}</span>
        <button type="button" class="hub-logout" id="mntLogoutBtn">Odjavi se</button>
      </div>
    </header>`;
}

/**
 * @param {Record<string, string>} nameByCode
 */
function subnavHtml(section, machineCode, tab, onNavigateToPath) {
  const dashActive = section === 'dashboard' ? ' mnt-subnav-active' : '';
  const listActive = section === 'machines' ? ' mnt-subnav-active' : '';
  const boardActive = section === 'board' ? ' mnt-subnav-active' : '';
  const notifActive = section === 'notifications' ? ' mnt-subnav-active' : '';
  const catActive = section === 'catalog' ? ' mnt-subnav-active' : '';
  const machActive = section === 'machine' ? ' mnt-subnav-active' : '';
  return `
    <nav class="mnt-subnav" aria-label="Održavanje navigacija">
      <button type="button" class="mnt-subnav-btn${dashActive}" data-mnt-nav="/maintenance">Pregled</button>
      <button type="button" class="mnt-subnav-btn${listActive}" data-mnt-nav="/maintenance/machines">Mašine</button>
      <button type="button" class="mnt-subnav-btn${boardActive}" data-mnt-nav="/maintenance/board">Rokovi</button>
      <button type="button" class="mnt-subnav-btn${notifActive}" data-mnt-nav="/maintenance/notifications">Obaveštenja</button>
      <button type="button" class="mnt-subnav-btn${catActive}" data-mnt-nav="/maintenance/catalog">Katalog mašina</button>
      ${
        section === 'machine' && machineCode
          ? `<button type="button" class="mnt-subnav-btn${machActive}" data-mnt-nav="${buildMaintenanceMachinePath(machineCode, normalizeTab(tab || 'pregled'))}">Ova mašina</button>
             <button type="button" class="mnt-subnav-btn" data-mnt-nav="/maintenance/machines">← Lista mašina</button>`
          : ''
      }
    </nav>`;
}

function wireSubnav(root, onNavigateToPath) {
  root.querySelectorAll('[data-mnt-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = btn.getAttribute('data-mnt-nav');
      if (path && onNavigateToPath) onNavigateToPath(path);
    });
  });
}

/**
 * @param {Array<object>} rows
 * @param {Map<string, string>} nameByCode
 */
function mergeMachineNames(rows, nameByCode) {
  return (rows || []).map(r => ({
    ...r,
    display_name: nameByCode.get(r.machine_code) || r.machine_code,
  }));
}

/**
 * @param {Array<{ next_due_at: string }>} dues
 */
function bucketTaskDueDates(dues) {
  const now = new Date();
  const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eod = new Date(sod);
  eod.setHours(23, 59, 59, 999);
  const weekEnd = new Date(sod);
  weekEnd.setDate(weekEnd.getDate() + 7);
  weekEnd.setHours(23, 59, 59, 999);
  const list = Array.isArray(dues) ? dues : [];
  const overdue = [];
  const today = [];
  const week = [];
  for (const d of list) {
    const t = new Date(d.next_due_at);
    if (t < sod) overdue.push(d);
    else if (t <= eod) today.push(d);
    else if (t <= weekEnd) week.push(d);
  }
  return { overdue, today, week };
}

function maintCanModerateNotes(prof) {
  const erp = getAuth().role === 'admin';
  const r = prof?.role;
  return erp || r === 'chief' || r === 'admin';
}

/** Sadržaj / brisanje u skladu sa RLS (autor do 24h za operator/tehničar; šef/admin uvek). */
function maintNoteBodyEditable(note, prof) {
  const uid = getCurrentUser()?.id;
  const erp = getAuth().role === 'admin';
  const r = prof?.role;
  if (erp || r === 'chief' || r === 'admin') return true;
  if (String(note.author) !== String(uid || '')) return false;
  if (!['operator', 'technician'].includes(r)) return false;
  return Date.now() - new Date(note.created_at).getTime() < 24 * 3600 * 1000;
}

function maintCanAddNote(prof) {
  const erp = getAuth().role === 'admin';
  const r = prof?.role;
  return erp || ['operator', 'technician', 'chief', 'admin'].includes(r);
}

function sortAttention(rows) {
  const rank = s => {
    if (s === 'down') return 0;
    if (s === 'degraded') return 1;
    if (s === 'maintenance') return 2;
    return 3;
  };
  return [...(rows || [])].sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    const oa = Number(a.overdue_checks_count) || 0;
    const ob = Number(b.overdue_checks_count) || 0;
    if (oa !== ob) return ob - oa;
    return String(a.machine_code).localeCompare(String(b.machine_code));
  });
}

/**
 * @param {() => void | Promise<void>} [onRefreshPanel] ponovno učitaj panel (npr. posle modala)
 */
async function renderPanel(host, section, machineCode, tab, onNavigateToPath, onRefreshPanel) {
  if (!hasSupabaseConfig()) {
    host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Supabase nije konfigurisan.</p></div>`;
    return;
  }
  if (disposeRef.disposed || !host.isConnected) return;

  if (section === 'notifications') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    if (!canAccessMaintNotifications(prof)) {
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Pregled obaveštenja je dostupan šefu/rukovodstvu i ERP admin-u.</p></div>`;
      return;
    }
    await renderMaintNotificationsPanel(host, { prof, onNavigateToPath });
    return;
  }

  if (section === 'catalog') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    if (!canManageMaintCatalog(prof)) {
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Katalog mašina može da menja samo šef/admin održavanja ili ERP admin.</p></div>`;
      return;
    }
    await renderMaintCatalogPanel(host, { prof, onNavigateToPath });
    return;
  }

  if (section === 'board') {
    const [dues, prof, names, statuses] = await Promise.all([
      fetchMaintTaskDueDates(),
      fetchMaintUserProfile(),
      fetchMaintMachines(),
      fetchMaintMachineStatuses(),
    ]);
    if (disposeRef.disposed || !host.isConnected) return;
    if (dues === null) {
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam rokove (RLS ili migracija).</p></div>`;
      return;
    }
    const nameByCode = new Map(
      (Array.isArray(names) ? names : []).map(n => [n.machine_code, n.name || n.machine_code]),
    );
    /* View `v_maint_machine_current_status` već filtrira istekle override-e u JOIN-u: ako je `override_reason` ne-NULL, override je aktivan. */
    const overrideByCode = new Map(
      (Array.isArray(statuses) ? statuses : [])
        .filter(s => s && s.override_reason)
        .map(s => [
          s.machine_code,
          { status: s.status, valid_until: s.override_valid_until, reason: s.override_reason },
        ]),
    );
    const { overdue, today, week } = bucketTaskDueDates(dues);
    /* Override-stavke idu na dno svake kolone (ne brišemo ih: bitno je da se vidi šta čeka kad mašina krene). */
    const splitByOverride = arr => {
      const live = [];
      const paused = [];
      for (const d of arr) {
        if (overrideByCode.has(d.machine_code)) paused.push(d);
        else live.push(d);
      }
      return [...live, ...paused];
    };
    const profLine = prof
      ? `<p class="mnt-muted">Profil održavanja: <strong>${escHtml(String(prof.role))}</strong></p>`
      : `<p class="mnt-muted"><em>Nemaš red u <code>maint_user_profiles</code> — vidiš podatke samo ako ERP uloga ima širok pregled (admin/PM).</em></p>`;
    const rowHtml = d => {
      const disp = nameByCode.get(d.machine_code) || d.machine_code;
      const path = buildMaintenanceMachinePath(d.machine_code, 'kontrole');
      const ovr = overrideByCode.get(d.machine_code);
      const ovrBadge = ovr
        ? ` <span class="${statusBadgeClass(ovr.status)}" title="${escHtml(ovr.reason || '')}${ovr.valid_until ? ' (do ' + ovr.valid_until.replace('T', ' ').slice(0, 16) + ')' : ''}">PAUZA · ${escHtml(ovr.status)}</span>`
        : '';
      const liStyle = ovr ? ' style="opacity:.55"' : '';
      return `<li${liStyle}><button type="button" class="mnt-linkish" data-mnt-nav="${path}">${escHtml(disp)}</button>${ovrBadge} — ${escHtml(d.title || '')}
        <span class="mnt-muted">· ${escHtml(String(d.interval_value))} ${escHtml(d.interval_unit || '')}</span>
        <br><span class="mnt-muted">${escHtml((d.next_due_at || '').replace('T', ' ').slice(0, 16))}</span></li>`;
    };
    const col = (title, arr) => {
      const ordered = splitByOverride(arr);
      const live = ordered.filter(d => !overrideByCode.has(d.machine_code)).length;
      const paused = ordered.length - live;
      const cnt = paused > 0 ? `${live} <span class="mnt-muted">(+${paused} pauza)</span>` : `${ordered.length}`;
      return `
        <div class="mnt-board-col">
          <h3 style="font-size:15px;margin:0 0 8px">${escHtml(title)} <span class="mnt-muted">(${cnt})</span></h3>
          <ul class="mnt-list">${ordered.length ? ordered.map(rowHtml).join('') : '<li class="mnt-muted">Nema stavki.</li>'}</ul>
        </div>`;
    };
    host.innerHTML = `
      ${profLine}
      <p class="mnt-muted" style="margin:12px 0">Preventivni taskovi — sledeći rok po mašini (<code>v_maint_task_due_dates</code>). Mašine pod manuelnim override-om (<code>down</code>/<code>maintenance</code>) idu na dno svake kolone i obeležene su badge-om „PAUZA”.</p>
      <div class="mnt-board-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;align-items:start">
        ${col('Prekoračeno', overdue)}
        ${col('Danas', today)}
        ${col('Narednih 7 dana (posle danas)', week)}
      </div>`;
    host.querySelectorAll('.mnt-linkish[data-mnt-nav]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const p = btn.getAttribute('data-mnt-nav');
        if (p) onNavigateToPath?.(p);
      });
    });
    return;
  }

  if (section === 'dashboard' || section === 'machines') {
    const [rows, prof, names] = await Promise.all([
      fetchMaintMachineStatuses(),
      fetchMaintUserProfile(),
      fetchMaintMachines(),
    ]);
    if (disposeRef.disposed || !host.isConnected) return;

    if (rows === null) {
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam status mašina (RLS ili migracija).</p></div>`;
      return;
    }

    const nameByCode = new Map(
      (Array.isArray(names) ? names : []).map(n => [n.machine_code, n.name || n.machine_code]),
    );
    const merged = mergeMachineNames(rows, nameByCode);
    const run = merged.filter(r => r.status === 'running').length;
    const deg = merged.filter(r => r.status === 'degraded').length;
    const down = merged.filter(r => r.status === 'down').length;
    const maint = merged.filter(r => r.status === 'maintenance').length;

    const kpi = `
      <div class="mnt-kpi-row">
        <div class="${statusKpiClass('running')}"><span class="mnt-kpi-label">Radi</span><span class="mnt-kpi-val">${run}</span></div>
        <div class="${statusKpiClass('degraded')}"><span class="mnt-kpi-label">Degradirano</span><span class="mnt-kpi-val">${deg}</span></div>
        <div class="${statusKpiClass('down')}"><span class="mnt-kpi-label">Ne radi</span><span class="mnt-kpi-val">${down}</span></div>
        <div class="${statusKpiClass('maintenance')}"><span class="mnt-kpi-label">Održavanje</span><span class="mnt-kpi-val">${maint}</span></div>
      </div>`;

    const profLine = prof
      ? `<p class="mnt-muted">Profil održavanja: <strong>${escHtml(String(prof.role))}</strong></p>`
      : `<p class="mnt-muted"><em>Nemaš red u <code>maint_user_profiles</code> — vidiš podatke samo ako ERP uloga ima širok pregled (admin/PM).</em></p>`;

    const attention = sortAttention(merged).filter(
      r => r.status !== 'running' || (Number(r.overdue_checks_count) > 0 || Number(r.open_incidents_count) > 0),
    );
    const attRows = attention.slice(0, 12).map(r => {
      const path = buildMaintenanceMachinePath(r.machine_code, 'pregled');
      const ovr = r.override_reason
        ? ` <span class="mnt-badge" title="${escHtml(r.override_reason)}${r.override_valid_until ? ' (do ' + r.override_valid_until.replace('T', ' ').slice(0, 16) + ')' : ''}">OVERRIDE</span>`
        : '';
      return `<li><button type="button" class="mnt-linkish" data-mnt-nav="${path}">${escHtml(r.display_name)}</button>
        <span class="${statusBadgeClass(r.status)}">${escHtml(r.status)}</span>${ovr}
        ${Number(r.open_incidents_count) > 0 ? ` · incidenti: ${escHtml(String(r.open_incidents_count))}` : ''}
        ${Number(r.overdue_checks_count) > 0 ? ` · overdue: ${escHtml(String(r.overdue_checks_count))}` : ''}
      </li>`;
    });

    if (section === 'dashboard') {
      const canEditCatalogDash = canManageMaintCatalog(prof);
      host.innerHTML = `
        ${kpi}
        ${profLine}
        <div class="mnt-attention" style="margin-top:20px">
          <h3>Zahtevaju pažnju (do 12)</h3>
          <ul class="mnt-list">${attRows.length ? attRows.join('') : '<li class="mnt-muted">Nema stavki van „radi” stanja.</li>'}</ul>
        </div>
        <p style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn" id="mntGoMachinesBtn">Otvori listu mašina →</button>
          ${canEditCatalogDash ? '<button type="button" class="btn" id="mntGoCatalogBtn" style="background:var(--surface3)">⚙ Katalog mašina (uredi/dodaj) →</button>' : ''}
        </p>`;
      host.querySelector('#mntGoMachinesBtn')?.addEventListener('click', () => {
        onNavigateToPath?.('/maintenance/machines');
      });
      host.querySelector('#mntGoCatalogBtn')?.addEventListener('click', () => {
        onNavigateToPath?.('/maintenance/catalog');
      });
    } else {
      const canEditCatalog = canManageMaintCatalog(prof);
      /* Katalog detalji (tip/proizvođač/model/lokacija/arhiviranost) po machine_code. */
      const metaByCode = new Map(
        (Array.isArray(names) ? names : []).map(n => [n.machine_code, n]),
      );
      const tableRows = merged
        .map(r => {
          const path = buildMaintenanceMachinePath(r.machine_code, 'pregled');
          const meta = metaByCode.get(r.machine_code) || {};
          const ovr = r.override_reason
            ? ` <span class="mnt-badge" title="${escHtml(r.override_reason)}${r.override_valid_until ? ' (do ' + r.override_valid_until.replace('T', ' ').slice(0, 16) + ')' : ''}">OVERRIDE</span>`
            : '';
          const mfrModel = [meta.manufacturer, meta.model].filter(Boolean).map(escHtml).join(' ');
          const editBtn = canEditCatalog && meta.machine_code
            ? `<button type="button" class="btn" style="padding:2px 10px;font-size:12px" data-mnt-edit-mach="${escHtml(r.machine_code)}">Uredi</button>`
            : '';
          return `<tr data-mnt-nav="${path}">
            <td><code>${escHtml(r.machine_code)}</code></td>
            <td>${escHtml(r.display_name)}</td>
            <td>${escHtml(meta.type || '')}</td>
            <td>${mfrModel}</td>
            <td>${escHtml(meta.location || '')}</td>
            <td><span class="${statusBadgeClass(r.status)}">${escHtml(r.status)}</span>${ovr}</td>
            <td style="text-align:center">${escHtml(String(r.open_incidents_count ?? 0))}</td>
            <td style="text-align:center">${escHtml(String(r.overdue_checks_count ?? 0))}</td>
            ${canEditCatalog ? `<td style="text-align:right">${editBtn}</td>` : ''}
          </tr>`;
        })
        .join('');
      const adminToolbar = canEditCatalog
        ? `<div class="mnt-admin-cta">
            <span class="mnt-admin-cta-text">
              <strong>Režim: admin.</strong> Za brzo uređivanje svih podataka (šifra, naziv, tip, proizvođač, godina, lokacija, kW, kg, napomene) otvori <em>Katalog mašina</em> — tabela sa direktnim upisom, TAB-om kroz ćelije.
            </span>
            <button type="button" class="btn" id="mntMachCatalogBtn">⚙ Otvori katalog (uredi mašine)</button>
            <button type="button" class="btn" id="mntMachAddBtn" style="background:var(--surface3)">+ Dodaj mašinu</button>
            <button type="button" class="btn" id="mntMachImportBtn" style="background:var(--surface3)">Uvezi iz BigTehn-a…</button>
          </div>`
        : '';
      const colCount = canEditCatalog ? 9 : 8;
      host.innerHTML = `
        ${kpi}
        ${profLine}
        ${adminToolbar}
        <div class="mnt-table-wrap" style="margin-top:8px">
          <table class="mnt-table" aria-label="Mašine">
            <thead><tr>
              <th>Šifra</th>
              <th>Naziv</th>
              <th>Tip</th>
              <th>Proizv. · model</th>
              <th>Lokacija</th>
              <th>Status</th>
              <th>Otv.&nbsp;inc.</th>
              <th>Overdue</th>
              ${canEditCatalog ? '<th></th>' : ''}
            </tr></thead>
            <tbody>${tableRows || `<tr><td colspan="${colCount}" class="mnt-muted">Nema redova u cache-u.</td></tr>`}</tbody>
          </table>
        </div>`;
      host.querySelectorAll('.mnt-table tbody tr[data-mnt-nav]').forEach(tr => {
        tr.addEventListener('click', (ev) => {
          /* Klik na dugme „Uredi" ne sme da otvori detalj. */
          if (ev.target.closest('[data-mnt-edit-mach]')) return;
          const p = tr.getAttribute('data-mnt-nav');
          if (p) onNavigateToPath?.(p);
        });
      });
      if (canEditCatalog) {
        host.querySelector('#mntMachAddBtn')?.addEventListener('click', () => {
          openMaintMachineModal({
            mode: 'create',
            existing: null,
            onSaved: () => onRefreshPanel?.(),
          });
        });
        host.querySelector('#mntMachImportBtn')?.addEventListener('click', () => {
          openMaintMachinesImportDialog({
            onImported: () => onRefreshPanel?.(),
          });
        });
        host.querySelector('#mntMachCatalogBtn')?.addEventListener('click', () => {
          onNavigateToPath?.('/maintenance/catalog');
        });
        host.querySelectorAll('[data-mnt-edit-mach]').forEach(btn => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const code = btn.getAttribute('data-mnt-edit-mach');
            const row = metaByCode.get(code);
            if (!row) return;
            openMaintMachineModal({
              mode: 'edit',
              existing: row,
              onSaved: () => onRefreshPanel?.(),
            });
          });
        });
      }
    }

    host.querySelectorAll('.mnt-linkish[data-mnt-nav]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const p = btn.getAttribute('data-mnt-nav');
        if (p) onNavigateToPath?.(p);
      });
    });
    return;
  }

  /* machine detail */
  const t0 = normalizeTab(tab);
  const [mach, btMeta, tasks, tasksAll, incidents, notes, prof, override] = await Promise.all([
    fetchMaintMachine(machineCode),
    fetchBigtehnMachineRow(machineCode),
    fetchMaintTasksForMachine(machineCode),
    t0 === 'sabloni' ? fetchMaintTasksForMachineAll(machineCode) : Promise.resolve([]),
    fetchMaintIncidentsForMachine(machineCode),
    t0 === 'napomene' ? fetchMaintMachineNotes(machineCode) : Promise.resolve([]),
    fetchMaintUserProfile(),
    fetchMaintMachineOverride(machineCode),
  ]);
  if (disposeRef.disposed || !host.isConnected) return;

  const t = t0;
  const tabBase = buildMaintenanceMachinePath(machineCode, '');
  const basePath = tabBase.split('?')[0];
  const canEditTasks = canManageMaintTasks(prof);
  const tabIds = ['pregled', 'kontrole', 'incidenti', 'napomene', 'dokumenti'];
  if (canEditTasks) tabIds.push('sabloni');
  const tabsHtml = tabIds
    .map(
      id =>
        `<a href="#" class="${id === t ? 'mnt-tab-active' : ''}" data-mnt-tab="${escHtml(id)}">${escHtml(TAB_LABELS[id])}</a>`,
    )
    .join('');

  const displayName = mach?.name || btMeta?.name || machineCode;
  const canOverride = canManageMaintOverride(prof);
  const canEditMach = canManageMaintCatalog(prof);
  const machSubtitleParts = [];
  if (mach?.type) machSubtitleParts.push(escHtml(mach.type));
  if (mach?.manufacturer || mach?.model) {
    const mm = [mach.manufacturer, mach.model].filter(Boolean).map(escHtml).join(' ');
    if (mm) machSubtitleParts.push(mm);
  }
  if (mach?.year_of_manufacture) machSubtitleParts.push(`god. ${escHtml(String(mach.year_of_manufacture))}`);
  if (mach?.location) machSubtitleParts.push(`📍 ${escHtml(mach.location)}`);
  const machSubtitle = machSubtitleParts.join(' · ');
  const machArchived = !!mach?.archived_at;
  const ovrActive =
    override && (!override.valid_until || new Date(override.valid_until).getTime() > Date.now())
      ? override
      : null;
  let body = '';
  if (t === 'pregled') {
    const openInc = Array.isArray(incidents)
      ? incidents.filter(i => !['resolved', 'closed'].includes(i.status)).slice(0, 5)
      : [];
    const ovrHtml = ovrActive
      ? `<div class="mnt-ovr-card" style="margin:12px 0;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--surface2)">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span class="${statusBadgeClass(ovrActive.status)}">${escHtml(ovrActive.status || '')}</span>
            <strong>Manuelni override statusa</strong>
            <span class="mnt-muted" style="font-size:12px">${escHtml((ovrActive.set_at || '').replace('T', ' ').slice(0, 16))}${
              ovrActive.valid_until
                ? ` → važi do ${escHtml(ovrActive.valid_until.replace('T', ' ').slice(0, 16))}`
                : ' → trajno'
            }</span>
          </div>
          <div style="margin-top:6px;white-space:pre-wrap">${escHtml(ovrActive.reason || '')}</div>
        </div>`
      : '';
    const metaBits = [];
    if (mach?.serial_number) metaBits.push(`S/N: <code>${escHtml(mach.serial_number)}</code>`);
    if (mach?.year_commissioned) metaBits.push(`puštena u pogon: ${escHtml(String(mach.year_commissioned))}`);
    if (mach?.power_kw != null) metaBits.push(`${escHtml(String(mach.power_kw))} kW`);
    if (mach?.weight_kg != null) metaBits.push(`${escHtml(String(mach.weight_kg))} kg`);
    if (btMeta?.rj_code) metaBits.push(`BigTehn: <code>${escHtml(btMeta.rj_code)}</code>`);
    const metaLine = metaBits.length
      ? `<p class="mnt-muted">${metaBits.join(' · ')}</p>`
      : (mach ? '' : `<p class="mnt-muted"><em>Mašina nije u katalogu — otvori tab Katalog pa je dodaj ili uvezi iz BigTehn-a.</em></p>`);
    const notesBlock = mach?.notes
      ? `<div style="margin:12px 0;padding:10px 12px;border-left:3px solid var(--border);background:var(--surface2);white-space:pre-wrap">${escHtml(mach.notes)}</div>`
      : '';
    body = `
      ${metaLine}
      ${notesBlock}
      ${machArchived ? `<div class="mnt-panel" style="background:var(--red-bg);color:var(--red);padding:10px 12px;margin:12px 0">Ova mašina je <strong>arhivirana</strong> ${escHtml((mach.archived_at || '').replace('T', ' ').slice(0, 16))}. Vrati je iz taba „Katalog” ako treba ponovo da bude aktivna.</div>` : ''}
      ${ovrHtml}
      <h3 style="font-size:15px;margin:16px 0 8px">Otvoreni incidenti (poslednjih 5)</h3>
      <ul class="mnt-list">${openInc.length ? openInc.map(i => `<li>${escHtml(i.title || '')} — <span class="${severityBadge(i.severity)}">${escHtml(i.severity)}</span> · <span class="mnt-muted">${escHtml(i.status || '')}</span></li>`).join('') : '<li class="mnt-muted">Nema otvorenih.</li>'}</ul>
      <h3 style="font-size:15px;margin:16px 0 8px">Aktivni taskovi (preventiva)</h3>
      <ul class="mnt-list">${Array.isArray(tasks) && tasks.length ? tasks.map(x => `<li>${escHtml(x.title || '')} · ${escHtml(String(x.interval_value))} ${escHtml(x.interval_unit || '')}</li>`).join('') : '<li class="mnt-muted">Nema aktivnih šablona.</li>'}</ul>`;
  } else if (t === 'kontrole') {
    body = `<p class="mnt-muted">Brza potvrda: <strong>OK</strong> za pojedinačnu kontrolu. Za drugi rezultat koristi dugme „Potvrdi kontrolu”.</p>
      <ul class="mnt-list">${Array.isArray(tasks) && tasks.length ? tasks.map(x => `<li style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span><strong>${escHtml(x.title || '')}</strong> — ${escHtml(String(x.interval_value))} ${escHtml(x.interval_unit || '')} · ${escHtml(x.severity || '')}</span>
        <button type="button" class="btn" style="padding:4px 10px;font-size:12px" data-mnt-quickcheck="${escHtml(String(x.id))}">OK</button></li>`).join('') : '<li>Nema taskova.</li>'}</ul>`;
  } else if (t === 'sabloni') {
    body = renderMaintTasksTab(Array.isArray(tasksAll) ? tasksAll : [], prof);
  } else if (t === 'dokumenti') {
    body = `<div id="mntFilesMount"><p class="mnt-muted">Učitavanje…</p></div>`;
  } else if (t === 'incidenti') {
    body = `<p class="mnt-muted">Klik na stavku otvara detalj (status, dodela, istorija događaja).</p>
      <ul class="mnt-list">${
        Array.isArray(incidents) && incidents.length
          ? incidents
              .map(
                i =>
                  `<li><button type="button" class="mnt-linkish" data-mnt-incident="${escHtml(String(i.id))}">${escHtml((i.reported_at || '').replace('T', ' ').slice(0, 16))} — ${escHtml(i.title || '')}</button>
          <span class="mnt-muted">${escHtml(i.status || '')}</span> · <span class="${severityBadge(i.severity)}">${escHtml(i.severity)}</span></li>`,
              )
              .join('')
          : '<li>Nema incidenata.</li>'
      }</ul>`;
  } else {
    const modNotes = maintCanModerateNotes(prof);
    const canAdd = maintCanAddNote(prof);
    const noteRows = Array.isArray(notes) ? notes : [];
    const listHtml = noteRows.length
      ? noteRows
          .map(n => {
            const bodyEd = maintNoteBodyEditable(n, prof);
            const pinBtn = modNotes
              ? `<button type="button" class="btn" style="padding:2px 8px;font-size:12px" data-mnt-note-pin="${escHtml(String(n.id))}" data-mnt-note-pinned="${n.pinned ? '1' : '0'}">${n.pinned ? 'Skini pin' : 'Pin'}</button>`
              : '';
            const delBtn = bodyEd
              ? `<button type="button" class="btn" style="padding:2px 8px;font-size:12px;background:var(--surface3)" data-mnt-note-del="${escHtml(String(n.id))}">Obriši</button>`
              : '';
            const saveBtn = bodyEd
              ? `<button type="button" class="btn" style="padding:2px 8px;font-size:12px" data-mnt-note-save="${escHtml(String(n.id))}">Snimi</button>`
              : '';
            const ta = bodyEd
              ? `<textarea class="form-input mnt-note-ta" rows="3" data-mnt-note-ta="${escHtml(String(n.id))}">${escHtml(n.content || '')}</textarea>`
              : `<div style="white-space:pre-wrap">${escHtml(n.content || '')}</div>`;
            return `<li data-mnt-note-li="${escHtml(String(n.id))}" style="margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border)">
          ${n.pinned ? '<span class="mnt-badge mnt-badge--degraded">PIN</span> ' : ''}
          <span class="mnt-muted" style="font-size:12px">${escHtml((n.created_at || '').replace('T', ' ').slice(0, 16))}</span>
          ${ta}
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${pinBtn}${saveBtn}${delBtn}</div>
        </li>`;
          })
          .join('')
      : '<li class="mnt-muted">Nema napomena.</li>';
    const addBlock = canAdd
      ? `<div style="margin-top:16px">
        <label class="form-label">Nova napomena</label>
        <textarea class="form-input" id="mntNewNoteTa" rows="3" placeholder="Tekst napomene"></textarea>
        <p style="margin-top:8px"><button type="button" class="btn" id="mntNewNoteBtn">Dodaj</button></p>
      </div>`
      : `<p class="mnt-muted">Dodavanje napomena zahteva profil održavanja (operator i više).</p>`;
    body = `<p class="mnt-muted">Napomene uz mašinu. Izmena sadržaja: autor do 24h (operator/tehničar) ili šef/admin uvek; pin i moderacija — šef/admin.</p>
      <ul class="mnt-list">${listHtml}</ul>${addBlock}`;
  }

  host.innerHTML = `
    <div class="mnt-machine-head" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;justify-content:space-between">
      <div style="min-width:0">
        <p style="font-size:18px;font-weight:600;margin:0">${escHtml(displayName)} <code class="mnt-muted">${escHtml(machineCode)}</code></p>
        ${machSubtitle ? `<p class="mnt-muted" style="margin:2px 0 0;font-size:13px">${machSubtitle}</p>` : ''}
      </div>
      <div class="mnt-actions" style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn" id="mntBtnCheck">Potvrdi kontrolu</button>
        <button type="button" class="btn" id="mntBtnIncident">Prijavi incident</button>
        ${canOverride ? `<button type="button" class="btn" id="mntBtnOverride">${ovrActive ? 'Uredi override' : 'Postavi status'}</button>` : ''}
        ${canEditMach && mach ? `<button type="button" class="btn" id="mntBtnEditMach" style="background:var(--surface3)">Uredi mašinu</button>` : ''}
      </div>
    </div>
    <div class="mnt-tabs" role="tablist">${tabsHtml}</div>
    <div class="mnt-panel">${body}</div>`;

  host.querySelectorAll('[data-mnt-tab]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const id = a.getAttribute('data-mnt-tab');
      if (id) onNavigateToPath?.(`${basePath}?tab=${encodeURIComponent(id)}`);
    });
  });

  if (t === 'dokumenti') {
    const mount = host.querySelector('#mntFilesMount');
    if (mount) {
      renderMaintFilesTab(mount, machineCode, prof, {
        archived: machArchived,
        onChanged: () => onRefreshPanel?.(),
      });
    }
  }

  const tasksSafe = Array.isArray(tasks) ? tasks : [];
  host.querySelector('#mntBtnCheck')?.addEventListener('click', () => {
    if (!tasksSafe.length) {
      showToast('⚠ Nema aktivnih kontrola za ovu mašinu');
      return;
    }
    openConfirmCheckModal({
      machineCode,
      tasks: tasksSafe,
      onSaved: () => {
        onRefreshPanel?.();
      },
    });
  });
  host.querySelector('#mntBtnIncident')?.addEventListener('click', () => {
    openReportIncidentModal({
      machineCode,
      onSaved: () => {
        onRefreshPanel?.();
      },
    });
  });
  host.querySelector('#mntBtnOverride')?.addEventListener('click', () => {
    openMaintOverrideModal({
      machineCode,
      existing: ovrActive || override || null,
      onSaved: () => onRefreshPanel?.(),
    });
  });
  host.querySelector('#mntBtnEditMach')?.addEventListener('click', () => {
    if (!mach) return;
    openMaintMachineModal({
      mode: 'edit',
      existing: mach,
      onSaved: () => onRefreshPanel?.(),
    });
  });
  host.querySelectorAll('[data-mnt-quickcheck]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tid = btn.getAttribute('data-mnt-quickcheck');
      if (!tid) return;
      openConfirmCheckModal({
        machineCode,
        tasks: tasksSafe,
        preselectTaskId: tid,
        onSaved: () => {
          onRefreshPanel?.();
        },
      });
    });
  });

  host.querySelectorAll('[data-mnt-incident]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.getAttribute('data-mnt-incident');
      if (!id) return;
      openIncidentDetailModal({
        incidentId: id,
        machineCode,
        maintProf: prof,
        onSaved: () => onRefreshPanel?.(),
      });
    });
  });

  if (t === 'sabloni' && canEditTasks) {
    const tasksMap = new Map(
      (Array.isArray(tasksAll) ? tasksAll : []).map(x => [String(x.id), x]),
    );
    host.querySelector('#mntTaskAddBtn')?.addEventListener('click', () => {
      openMaintTaskModal({
        machineCode,
        existing: null,
        onSaved: () => onRefreshPanel?.(),
      });
    });
    host.querySelectorAll('[data-mnt-task-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-mnt-task-edit');
        const existing = id ? tasksMap.get(id) : null;
        if (!existing) return;
        openMaintTaskModal({
          machineCode,
          existing,
          onSaved: () => onRefreshPanel?.(),
        });
      });
    });
    host.querySelectorAll('[data-mnt-task-toggle]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-mnt-task-toggle');
        if (!id) return;
        const nowActive = btn.getAttribute('data-mnt-task-active') === '1';
        const ok = await patchMaintTask(id, { active: !nowActive });
        if (!ok) {
          showToast('⚠ Promena nije dozvoljena');
          return;
        }
        showToast('✅ Ažurirano');
        onRefreshPanel?.();
      });
    });
  }

  if (t === 'napomene') {
    host.querySelector('#mntNewNoteBtn')?.addEventListener('click', async () => {
      const ta = host.querySelector('#mntNewNoteTa');
      const text = ta?.value?.trim();
      if (!text) {
        showToast('⚠ Unesi tekst');
        return;
      }
      const row = await insertMaintMachineNote({ machine_code: machineCode, content: text });
      if (!row) showToast('⚠ Greška pri snimanju');
      else {
        showToast('✅ Napomena dodata');
        ta.value = '';
        onRefreshPanel?.();
      }
    });
    host.querySelectorAll('[data-mnt-note-save]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-mnt-note-save');
        if (!id) return;
        const ta = host.querySelector(`textarea[data-mnt-note-ta="${id}"]`);
        const text = ta?.value?.trim();
        if (!text) {
          showToast('⚠ Tekst ne sme biti prazan');
          return;
        }
        const ok = await patchMaintMachineNote(id, { content: text });
        if (!ok) showToast('⚠ Izmena nije dozvoljena ili greška');
        else {
          showToast('✅ Sačuvano');
          onRefreshPanel?.();
        }
      });
    });
    host.querySelectorAll('[data-mnt-note-pin]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-mnt-note-pin');
        if (!id) return;
        const cur = btn.getAttribute('data-mnt-note-pinned') === '1';
        const ok = await patchMaintMachineNote(id, { pinned: !cur });
        if (!ok) showToast('⚠ Nema ovlašćenja za pin');
        else {
          showToast('✅ Ažurirano');
          onRefreshPanel?.();
        }
      });
    });
    host.querySelectorAll('[data-mnt-note-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-mnt-note-del');
        if (!id) return;
        const ok = await patchMaintMachineNote(id, { deleted_at: new Date().toISOString() });
        if (!ok) showToast('⚠ Brisanje nije dozvoljeno');
        else {
          showToast('✅ Uklonjeno');
          onRefreshPanel?.();
        }
      });
    });
  }
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   section: 'dashboard' | 'machines' | 'machine' | 'board' | 'notifications',
 *   machineCode?: string | null,
 *   tab?: string | null,
 *   onBackToHub: () => void,
 *   onLogout: () => void,
 *   onNavigateToPath?: (path: string) => void,
 * }} opts
 */
export function renderMaintenanceShell(root, opts) {
  disposeRef.disposed = false;
  mountRef = root;
  const { section, machineCode, tab, onBackToHub, onLogout, onNavigateToPath } = opts;

  document.body.classList.add('kadrovska-active', 'module-odrzavanje-masina');

  root.innerHTML = `
    <div class="mnt-wrap" id="mntRoot">
      ${headerHtml()}
      <main class="mnt-main">
        ${subnavHtml(section, machineCode, tab, onNavigateToPath)}
        <div id="mnt-panel-host"></div>
      </main>
    </div>`;

  const host = root.querySelector('#mnt-panel-host');
  root.querySelector('#mntBackHubBtn')?.addEventListener('click', () => onBackToHub?.());
  root.querySelector('#mntThemeToggle')?.addEventListener('click', () => toggleTheme());
  root.querySelector('#mntLogoutBtn')?.addEventListener('click', async () => {
    await logout();
    onLogout?.();
  });

  wireSubnav(root, onNavigateToPath);

  const runPanel = async () => {
    if (disposeRef.disposed || !host?.isConnected) return;
    const tabFromUrl = new URLSearchParams(window.location.search).get('tab');
    await renderPanel(
      host,
      section,
      machineCode,
      tabFromUrl || tab || null,
      onNavigateToPath,
      section === 'machine' ? runPanel : null,
    );
  };

  if (host) {
    renderPanel(host, section, machineCode, tab, onNavigateToPath, section === 'machine' ? runPanel : null).catch(
      err => {
        console.error('[mnt] panel', err);
        if (!disposeRef.disposed && host.isConnected) {
          host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Greška pri učitavanju.</p></div>`;
        }
      },
    );
  }
}

export function teardownMaintenanceShell() {
  disposeRef.disposed = true;
  mountRef = null;
}
