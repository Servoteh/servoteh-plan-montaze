/**
 * Modul Održavanje mašina — UI shell + liste (URL: /maintenance, …).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { toggleTheme } from '../../lib/theme.js';
import { logout } from '../../services/auth.js';
import { getAuth, getCurrentUser, maintHasFloorReadAccess, isAdminOrMenadzment } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../services/supabase.js';
import {
  fetchMaintMachineStatuses,
  fetchMaintUserProfile,
  fetchMaintMachines,
  fetchMaintMachine,
  fetchMaintTasksForMachine,
  fetchMaintTasksForMachineAll,
  fetchMaintIncidentsForMachine,
  fetchMaintChecksForMachine,
  fetchBigtehnMachineRow,
  fetchMaintTaskDueDates,
  fetchMaintMachineNotes,
  fetchMaintMachineLastChecks,
  fetchMaintMachineResponsibles,
  isMaintResponsibleFeatureAvailable,
  fetchAllMaintProfiles,
  insertMaintMachineNote,
  patchMaintMachineNote,
  patchMaintTask,
  fetchMaintMachineOverride,
  fetchMaintWorkOrders,
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
import { renderMaintLocationsPanel } from './maintLocationsTab.js';
import { renderMaintFilesTab } from './maintFilesTab.js';
import { renderMaintWorkOrdersPanel } from './maintWorkOrdersPanel.js';
import { renderMaintAssetsPanel } from './maintAssetsPanel.js';
import { renderMaintVehiclesPanel } from './maintVehiclesPanel.js';
import { renderMaintItAssetsPanel } from './maintItAssetsPanel.js';
import { renderMaintFacilitiesPanel } from './maintFacilitiesPanel.js';
import { renderMaintDocumentsPanel } from './maintDocumentsPanel.js';
import { renderMaintPreventivePanel, renderMaintCalendarPanel } from './maintPreventivePanel.js';
import { renderMaintReportsPanel } from './maintReportsPanel.js';
import { renderMaintInventoryPanel } from './maintInventoryPanel.js';

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

/**
 * Korisničko-prijateljska oznaka statusa (umesto tehničkog running/down/...).
 */
function statusLabel(status, archivedAt) {
  if (archivedAt) return 'Van upotrebe';
  const s = String(status || '').toLowerCase();
  if (s === 'running') return 'Radi';
  if (s === 'maintenance') return 'Planirano održavanje';
  if (s === 'degraded') return 'Smetnje';
  if (s === 'down') return 'Zastoj';
  return status || '—';
}

/**
 * Vraća priority chip (markup) i „sort priority" — manji broj = veći prioritet.
 *
 * Redosled po UX preporuci (Faza 3):
 *   0 Zastoj (down ili otvoreni kvar)
 *   1 Smetnje (degraded bez otvorenih kvarova)
 *   2 U održavanju (planirano)
 *   3 Kasni rok (overdue)
 *   4 Rok danas
 *   5 Rok u narednih 7 dana
 *   6 Radi normalno
 *   9 Arhivirano
 *
 * @param {{ status: string, overdue: number, openInc: number, nextDueAt: Date|null, archived: boolean }} info
 */
function priorityDescriptor(info) {
  const now = new Date();
  if (info.archived) return { rank: 9, html: '' };
  if (info.status === 'down' || info.openInc > 0) {
    return {
      rank: 0,
      html: `<span class="mnt-priority mnt-priority--down">Zastoj</span>`,
    };
  }
  if (info.status === 'degraded') {
    return {
      rank: 1,
      html: `<span class="mnt-priority mnt-priority--warn">Smetnje</span>`,
    };
  }
  if (info.status === 'maintenance') {
    return {
      rank: 2,
      html: `<span class="mnt-priority mnt-priority--maint">Održavanje</span>`,
    };
  }
  if (info.overdue > 0 && info.nextDueAt) {
    const daysLate = Math.floor((now.getTime() - info.nextDueAt.getTime()) / 86400000);
    const txt = daysLate <= 0 ? 'Kasni' : `Kasni ${daysLate} d`;
    return {
      rank: 3,
      html: `<span class="mnt-priority mnt-priority--late">${escHtml(txt)}</span>`,
    };
  }
  if (info.nextDueAt) {
    const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const eod = new Date(sod); eod.setHours(23, 59, 59, 999);
    if (info.nextDueAt <= eod) {
      const hrs = Math.max(0, Math.round((info.nextDueAt.getTime() - now.getTime()) / 3600000));
      return {
        rank: 4,
        html: `<span class="mnt-priority mnt-priority--today">${hrs <= 0 ? 'Servis danas' : `Danas ${hrs}h`}</span>`,
      };
    }
    const diffMs = info.nextDueAt.getTime() - now.getTime();
    const days = Math.ceil(diffMs / 86400000);
    if (days <= 7) {
      return {
        rank: 5,
        html: `<span class="mnt-priority mnt-priority--soon">Za ${days} d</span>`,
      };
    }
  }
  return { rank: 6, html: '' };
}

/**
 * Format kratkog relativnog datuma u sr-Latn ("pre 3 d", "danas", "za 2 d").
 * Vraća '—' za null/undefined.
 */
function relDate(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const now = Date.now();
  const diffDays = Math.round((t - now) / 86400000);
  if (diffDays === 0) return 'danas';
  if (diffDays === -1) return 'juče';
  if (diffDays === 1) return 'sutra';
  if (diffDays < 0) return `pre ${-diffDays} d`;
  return `za ${diffDays} d`;
}

/**
 * Agregira najbliži (najmanji) next_due_at po machine_code iz liste taskova.
 * @param {Array<{machine_code: string, next_due_at: string}>} dues
 * @returns {Map<string, string>}
 */
function aggregateNextDueByMachine(dues) {
  const m = new Map();
  if (!Array.isArray(dues)) return m;
  /* v_maint_task_due_dates je već sortiran ASC po next_due_at — prvi hit je najmanji. */
  for (const d of dues) {
    const k = d?.machine_code;
    const t = d?.next_due_at;
    if (!k || !t) continue;
    if (!m.has(k)) m.set(k, t);
  }
  return m;
}

const TAB_LABELS = {
  pregled: 'Pregled',
  kontrole: 'Zadaci',
  incidenti: 'Istorija',
  napomene: 'Napomene',
  dokumenti: 'Dokumenta',
  sabloni: 'Šabloni',
};

function normalizeTab(tab) {
  const t = (tab || '').toLowerCase();
  if (t === 'checks' || t === 'zadaci') return 'kontrole';
  if (t === 'templates' || t === 'šabloni') return 'sabloni';
  if (t === 'istorija') return 'incidenti';
  if (t === 'dokumenta') return 'dokumenti';
  if (TAB_LABELS[t]) return t;
  return 'pregled';
}

function severityBadge(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 'mnt-badge mnt-badge--down';
  if (s === 'major') return 'mnt-badge mnt-badge--degraded';
  return 'mnt-badge';
}

/**
 * Korisnički naziv ozbiljnosti — srpski, dosledan svuda u modulu.
 * @param {string|null|undefined} sev
 */
function severityLabelSr(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical') return 'Kritično';
  if (s === 'major') return 'Visok';
  if (s === 'minor') return 'Nizak';
  if (s === 'info') return 'Info';
  return sev || '';
}

/**
 * Info banner za nedostatak profila održavanja — pojavljuje se pri vrhu
 * sadržaja (ne u sticky header-u) i ne pominje interne tabele.
 *
 * @param {object|null} prof Profil iz `maint_user_profiles` ili null.
 * @returns {string} HTML (prazan string ako profil postoji).
 */
function profileInfoBannerHtml(prof) {
  if (prof) return '';
  /* Korisnici sa `maint_has_floor_read_access` (admin/pm/leadpm/menadžment) već
     vide sve mašine u RLS-u — baner o „nedostatku profila” bi bio pogrešan signal. */
  if (maintHasFloorReadAccess()) return '';
  return `
    <div class="mnt-info-banner" role="note">
      <span class="mnt-info-banner-ico" aria-hidden="true">ℹ</span>
      <div class="mnt-info-banner-body">
        <strong>Profil održavanja nije podešen.</strong>
        Prikaz je ograničen na podatke do kojih dopire tvoja ERP uloga.
        Javi šefu održavanja ili ERP administratoru da ti doda profil.
      </div>
    </div>`;
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
  const assetsActive = ['assets', 'assetsMachines', 'assetsVehicles', 'assetsIt', 'assetsFacilities', 'machines', 'catalog', 'locations'].includes(section) ? ' mnt-subnav-active' : '';
  const preventiveActive = ['preventive', 'board'].includes(section) ? ' mnt-subnav-active' : '';
  const calendarActive = section === 'calendar' ? ' mnt-subnav-active' : '';
  const inventoryActive = section === 'inventory' ? ' mnt-subnav-active' : '';
  const docsActive = section === 'documents' ? ' mnt-subnav-active' : '';
  const reportsActive = section === 'reports' ? ' mnt-subnav-active' : '';
  const settingsActive = section === 'settings' ? ' mnt-subnav-active' : '';
  const notifActive = section === 'notifications' ? ' mnt-subnav-active' : '';
  const woActive = section === 'workorders' ? ' mnt-subnav-active' : '';
  const machActive = section === 'machine' ? ' mnt-subnav-active' : '';
  return `
    <nav class="mnt-subnav" aria-label="Održavanje navigacija">
      <button type="button" class="mnt-subnav-btn${dashActive}" data-mnt-nav="/maintenance">Pregled</button>
      <button type="button" class="mnt-subnav-btn${woActive}" data-mnt-nav="/maintenance/work-orders">Radni nalozi</button>
      <button type="button" class="mnt-subnav-btn${assetsActive}" data-mnt-nav="/maintenance/assets">Sredstva</button>
      <button type="button" class="mnt-subnav-btn${preventiveActive}" data-mnt-nav="/maintenance/preventive">Preventiva</button>
      <button type="button" class="mnt-subnav-btn${calendarActive}" data-mnt-nav="/maintenance/calendar">Kalendar</button>
      <button type="button" class="mnt-subnav-btn${inventoryActive}" data-mnt-nav="/maintenance/inventory">Zalihe i dobavljači</button>
      <button type="button" class="mnt-subnav-btn${docsActive}" data-mnt-nav="/maintenance/documents">Dokumenta</button>
      <button type="button" class="mnt-subnav-btn${reportsActive}" data-mnt-nav="/maintenance/reports">Izveštaji</button>
      <button type="button" class="mnt-subnav-btn${settingsActive}" data-mnt-nav="/maintenance/settings">Podešavanja</button>
      <button type="button" class="mnt-subnav-btn${notifActive}" data-mnt-nav="/maintenance/notifications" title="Istorija obaveštenja">🔔</button>
      ${
        section === 'machine' && machineCode
          ? `<button type="button" class="mnt-subnav-btn${machActive}" data-mnt-nav="${buildMaintenanceMachinePath(machineCode, normalizeTab(tab || 'pregled'))}">Ova mašina</button>
             <button type="button" class="mnt-subnav-btn" data-mnt-nav="/maintenance/assets/machines">← Lista mašina</button>`
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
  const erp = isAdminOrMenadzment();
  const r = prof?.role;
  return erp || r === 'chief' || r === 'admin';
}

/** Sadržaj / brisanje u skladu sa RLS (autor do 24h za operator/tehničar; šef/admin uvek). */
function maintNoteBodyEditable(note, prof) {
  const uid = getCurrentUser()?.id;
  const erp = isAdminOrMenadzment();
  const r = prof?.role;
  if (erp || r === 'chief' || r === 'admin') return true;
  if (String(note.author) !== String(uid || '')) return false;
  if (!['operator', 'technician'].includes(r)) return false;
  return Date.now() - new Date(note.created_at).getTime() < 24 * 3600 * 1000;
}

function maintCanAddNote(prof) {
  const erp = isAdminOrMenadzment();
  const r = prof?.role;
  return erp || ['operator', 'technician', 'chief', 'admin'].includes(r);
}

function maintenancePlaceholderHtml(title, items = []) {
  const list = items.length
    ? `<ul class="mnt-list">${items.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="mnt-panel">
      <h3 style="font-size:16px;margin:0 0 8px">${escHtml(title)}</h3>
      <p class="mnt-muted">U izradi — deo CMMS roadmap-a. Postojeći podaci nisu uklonjeni.</p>
      ${list}
    </div>`;
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
 * Operativna lista mašina (/maintenance/machines) — task-first UX.
 * Sticky header sa pretragom i chip filtrima, kompaktan summary, tabela na
 * desktopu / kartice na mobilnom, quick actions po redu bez dubokog routing-a.
 *
 * @param {HTMLElement} host
 * @param {{ onNavigateToPath?: (p:string)=>void, onRefreshPanel?: ()=>void }} opts
 */
async function renderOperationalMachinesList(host, opts) {
  const { onNavigateToPath, onRefreshPanel } = opts;
  host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Učitavam…</p></div>`;

  const [statuses, machines, dues, lastChecks, profiles, myProf, responsibles, respFeature] = await Promise.all([
    fetchMaintMachineStatuses(),
    fetchMaintMachines({ includeArchived: false }),
    fetchMaintTaskDueDates().catch(() => null),
    fetchMaintMachineLastChecks().catch(() => new Map()),
    fetchAllMaintProfiles().catch(() => null),
    fetchMaintUserProfile(),
    /* Best-effort — ako add_maint_machine_responsible.sql nije pokrenut, Map je prazan. */
    fetchMaintMachineResponsibles().catch(() => new Map()),
    isMaintResponsibleFeatureAvailable().catch(() => false),
  ]);
  if (disposeRef.disposed || !host.isConnected) return;

  if (!Array.isArray(statuses) || !Array.isArray(machines)) {
    host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam mašine. Verovatno je u pitanju ograničenje pristupa ili migracija nije primenjena.</p></div>`;
    return;
  }

  const statusByCode = new Map(statuses.map(s => [s.machine_code, s]));
  const nextDueByCode = aggregateNextDueByMachine(Array.isArray(dues) ? dues : []);
  const profileById = new Map(
    (Array.isArray(profiles) ? profiles : []).map(p => [p.user_id, p]),
  );
  const responsibleByCode = responsibles instanceof Map ? responsibles : new Map();
  const hasResponsibleFeature = !!respFeature;

  const myUid = getCurrentUser()?.id || null;
  const canEditCatalog = canManageMaintCatalog(myProf);

  /* Normalizacija po mašini: jedan red = sve što treba za prikaz + filtriranje. */
  const all = machines.map(m => {
    const st = statusByCode.get(m.machine_code) || {};
    const nextDueIso = nextDueByCode.get(m.machine_code) || null;
    const lastIso = lastChecks instanceof Map ? (lastChecks.get(m.machine_code) || null) : null;
    const responsibleUid = responsibleByCode.get(m.machine_code) || null;
    const respProf = responsibleUid ? profileById.get(responsibleUid) : null;
    const statusEff = st.status || 'running';
    const openInc = Number(st.open_incidents_count || 0);
    const overdue = Number(st.overdue_checks_count || 0);
    const nextDueAt = nextDueIso ? new Date(nextDueIso) : null;
    const pri = priorityDescriptor({
      status: statusEff,
      overdue,
      openInc,
      nextDueAt,
      archived: !!m.archived_at,
    });
    /* Sub-row meta: proizvođač + model + tip — kompaktno, samo prvih 60ak chr. */
    const subParts = [];
    if (m.manufacturer || m.model) {
      subParts.push([m.manufacturer, m.model].filter(Boolean).join(' '));
    }
    if (m.type) subParts.push(m.type);
    return {
      code: m.machine_code,
      name: m.name || m.machine_code,
      type: m.type || '',
      manufacturer: m.manufacturer || '',
      model: m.model || '',
      subMeta: subParts.join(' · '),
      location: m.location || '',
      status: statusEff,
      archived: !!m.archived_at,
      overrideReason: st.override_reason || null,
      overrideValidUntil: st.override_valid_until || null,
      openIncidents: openInc,
      overdueChecks: overdue,
      nextDueAt,
      nextDueIso,
      lastCheckIso: lastIso,
      responsibleUserId: responsibleUid,
      responsibleName: respProf?.full_name || null,
      priHtml: pri.html,
      priRank: pri.rank,
      raw: m,
    };
  });

  /* Jedinstvene lokacije za dropdown. */
  const locations = Array.from(
    new Set(all.map(r => r.location).filter(Boolean)),
  ).sort((a, b) => a.localeCompare(b, 'sr', { sensitivity: 'base' }));

  /* === Filter state — Faza 3 ============================================
     Tri nezavisne grupe chipova (Status / Rok / Dodela) + skriveni
     `incidentFilter` koji se pali samo iz URL-a (`?inc=1`) za KPI
     „Otvoreni kvarovi" iz Pregleda. Svi filteri se kombinuju AND-om.

     URL kontrola:
       ?status=radi|smetnje|zastoj|odrzavanje
       ?deadline=kasni|danas|7dana
       ?assign=moje
       ?inc=1
     Backward compat (legacy `?chip=…` od Faze 2):
       chip=kvar      → status=zastoj  (najjača akcija)
       chip=kasni     → deadline=kasni
       chip=danas     → deadline=danas
       chip=preventiva→ deadline=7dana
       chip=moje      → assign=moje
  ====================================================================== */
  const VALID_STATUS = new Set(['sve', 'radi', 'smetnje', 'zastoj', 'odrzavanje']);
  const VALID_DEADLINE = new Set(['sve', 'kasni', 'danas', '7dana']);
  const VALID_ASSIGN = new Set(['sve', 'moje']);
  const sp = new URLSearchParams(window.location.search);
  const state = {
    search: '',
    statusFilter: VALID_STATUS.has(sp.get('status')) ? sp.get('status') : 'sve',
    deadlineFilter: VALID_DEADLINE.has(sp.get('deadline')) ? sp.get('deadline') : 'sve',
    assignFilter: VALID_ASSIGN.has(sp.get('assign')) ? sp.get('assign') : 'sve',
    incidentFilter: sp.get('inc') === '1',
    location: '',
  };
  /* Legacy `?chip=` mapiranje — primenjuje se samo ako nova URL semantika
     nije postavljena za odgovarajuću dimenziju. */
  const legacyChip = sp.get('chip');
  if (legacyChip) {
    if (legacyChip === 'kvar' && state.statusFilter === 'sve') state.statusFilter = 'zastoj';
    else if (legacyChip === 'kasni' && state.deadlineFilter === 'sve') state.deadlineFilter = 'kasni';
    else if (legacyChip === 'danas' && state.deadlineFilter === 'sve') state.deadlineFilter = 'danas';
    else if (legacyChip === 'preventiva' && state.deadlineFilter === 'sve') state.deadlineFilter = '7dana';
    else if (legacyChip === 'moje' && state.assignFilter === 'sve') state.assignFilter = 'moje';
  }

  function filterRows() {
    const now = new Date();
    const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const eod = new Date(sod); eod.setHours(23, 59, 59, 999);
    const weekEnd = new Date(sod); weekEnd.setDate(weekEnd.getDate() + 7); weekEnd.setHours(23, 59, 59, 999);
    const q = state.search.trim().toLowerCase();

    return all.filter(r => {
      if (state.location && r.location !== state.location) return false;
      if (q) {
        const hay = `${r.code} ${r.name} ${r.type} ${r.manufacturer} ${r.model} ${r.location} ${r.responsibleName || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      /* Status grupa */
      switch (state.statusFilter) {
        case 'radi': if (r.status !== 'running') return false; break;
        case 'smetnje': if (r.status !== 'degraded') return false; break;
        case 'zastoj': if (r.status !== 'down') return false; break;
        case 'odrzavanje': if (r.status !== 'maintenance') return false; break;
        /* 'sve' — bez filtera */
      }
      /* Rok grupa */
      switch (state.deadlineFilter) {
        case 'kasni':
          if (r.overdueChecks <= 0) return false;
          break;
        case 'danas':
          if (!r.nextDueAt || r.nextDueAt < sod || r.nextDueAt > eod) return false;
          break;
        case '7dana':
          if (!r.nextDueAt || r.nextDueAt > weekEnd) return false;
          break;
      }
      /* Dodela grupa */
      if (state.assignFilter === 'moje' && (!myUid || r.responsibleUserId !== myUid)) {
        return false;
      }
      /* URL-only: samo mašine sa otvorenim incidentima */
      if (state.incidentFilter && r.openIncidents <= 0) return false;
      return true;
    });
  }

  /* Brojači po dimenzijama — UVEK nad svim (ne nad filtriranim), da budu
     stabilan orijentir bez obzira na trenutno aktivan filter. */
  const nRunning = all.filter(r => r.status === 'running').length;
  const nDegraded = all.filter(r => r.status === 'degraded').length;
  const nDown = all.filter(r => r.status === 'down').length;
  const nMaintCnt = all.filter(r => r.status === 'maintenance').length;
  const nLate = all.filter(r => r.overdueChecks > 0).length;
  const nToday = all.filter(r => {
    if (!r.nextDueAt) return false;
    const now = new Date();
    const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const eod = new Date(sod); eod.setHours(23, 59, 59, 999);
    return r.nextDueAt >= sod && r.nextDueAt <= eod;
  }).length;
  const n7 = all.filter(r => {
    if (!r.nextDueAt) return false;
    const now = new Date();
    const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekEnd = new Date(sod); weekEnd.setDate(weekEnd.getDate() + 7); weekEnd.setHours(23, 59, 59, 999);
    return r.nextDueAt <= weekEnd;
  }).length;
  const nMine = myUid && hasResponsibleFeature
    ? all.filter(r => r.responsibleUserId === myUid).length
    : 0;
  const nIncidents = all.reduce((a, r) => a + r.openIncidents, 0);

  const locOptions = [
    `<option value="">Sve lokacije</option>`,
    ...locations.map(l => `<option value="${escHtml(l)}">${escHtml(l)}</option>`),
  ].join('');

  /* Chip definicije po grupama. „Sve" je prva u svakoj grupi i predstavlja
     „bez filtera". Brojevi se prikazuju samo kad postoje (>0). */
  const chipsStatus = [
    { id: 'sve', label: 'Sve' },
    { id: 'radi', label: `Radi${nRunning ? ` · ${nRunning}` : ''}` },
    { id: 'smetnje', label: `Smetnje${nDegraded ? ` · ${nDegraded}` : ''}`, tone: nDegraded ? 'warn' : null },
    { id: 'zastoj', label: `Zastoj${nDown ? ` · ${nDown}` : ''}`, tone: nDown ? 'down' : null },
    { id: 'odrzavanje', label: `U održavanju${nMaintCnt ? ` · ${nMaintCnt}` : ''}` },
  ];
  const chipsDeadline = [
    { id: 'sve', label: 'Sve' },
    { id: 'kasni', label: `Kasni${nLate ? ` · ${nLate}` : ''}`, tone: nLate ? 'warn' : null },
    { id: 'danas', label: `Danas${nToday ? ` · ${nToday}` : ''}`, tone: nToday ? 'today' : null },
    { id: '7dana', label: `7 dana${n7 ? ` · ${n7}` : ''}` },
  ];
  const chipsAssign = myUid && hasResponsibleFeature
    ? [
        { id: 'sve', label: 'Sve' },
        { id: 'moje', label: `Moje${nMine ? ` · ${nMine}` : ''}` },
      ]
    : null;

  function chipGroupHtml(label, group, items, activeId) {
    return `
      <div class="mnt-chip-group">
        <span class="mnt-chip-group-label">${escHtml(label)}</span>
        <div class="mnt-chip-row" data-mnt-group="${group}">
          ${items.map(c => {
            const act = c.id === activeId ? ' mnt-chip--active' : '';
            const tone = c.tone ? ` mnt-chip--${c.tone}` : '';
            return `<button type="button" class="mnt-chip${act}${tone}" data-mnt-chip="${escHtml(c.id)}">${escHtml(c.label)}</button>`;
          }).join('')}
        </div>
      </div>`;
  }

  /* „Sa otvorenim kvarovima" je URL-only filter (bez chipa); kada je aktivan,
     prikazujemo ga kao removable badge iznad chip-grupa. */
  const incidentBadgeHtml = state.incidentFilter
    ? `<div class="mnt-active-filter">
        <span class="mnt-badge mnt-badge--down">Sa otvorenim kvarovima${nIncidents ? ` · ${nIncidents}` : ''}</span>
        <button type="button" class="mnt-active-filter-x" id="mntOpClearInc" title="Ukloni filter" aria-label="Ukloni filter">×</button>
      </div>`
    : '';

  /* Katalog je sekundarna akcija: ghost tekst link u summary baru. */
  const adminCatalogLink = canEditCatalog
    ? `<button type="button" class="mnt-catalog-link" id="mntOpCatalogBtn" title="Otvori katalog mašina (admin uređivanje)">⚙ Katalog mašina →</button>`
    : '';

  host.innerHTML = `
    ${profileInfoBannerHtml(myProf)}
    <div class="mnt-ops-header">
      <div class="mnt-ops-toolbar">
        <div class="mnt-search-wrap">
          <input type="search" class="form-input mnt-search-input" id="mntOpSearch"
            placeholder="Pretraga (šifra, naziv, lokacija, odgovorni)…"
            autocomplete="off" autocorrect="off" spellcheck="false">
        </div>
        <select class="form-input mnt-loc-select" id="mntOpLoc" title="Filtriraj po lokaciji">${locOptions}</select>
        <button type="button" class="btn mnt-header-cta" id="mntOpReportBtn">+ Prijavi kvar</button>
      </div>
      ${incidentBadgeHtml}
      <div class="mnt-chip-groups">
        ${chipGroupHtml('Status', 'status', chipsStatus, state.statusFilter)}
        ${chipGroupHtml('Rok', 'deadline', chipsDeadline, state.deadlineFilter)}
        ${chipsAssign ? chipGroupHtml('Dodela', 'assign', chipsAssign, state.assignFilter) : ''}
      </div>
      <div class="mnt-summary-bar">
        <span class="mnt-sum-meta" id="mntOpResultCount"></span>
        <span style="flex:1"></span>
        ${adminCatalogLink}
      </div>
    </div>
    <div id="mntOpListHost"></div>
  `;

  const listHost = host.querySelector('#mntOpListHost');
  const searchInp = /** @type {HTMLInputElement} */ (host.querySelector('#mntOpSearch'));
  const locSel = /** @type {HTMLSelectElement} */ (host.querySelector('#mntOpLoc'));

  function renderList() {
    const rows = filterRows();
    /* Default sortiranje po hitnosti (priRank: 0=Zastoj … 6=Radi). U slučaju
       izjednačenja — po nazivu (lokalna sortacija sr-Latn). */
    rows.sort((a, b) => {
      if (a.priRank !== b.priRank) return a.priRank - b.priRank;
      return a.name.localeCompare(b.name, 'sr', { sensitivity: 'base' });
    });

    /* Brojač rezultata u summary baru. */
    const cntEl = host.querySelector('#mntOpResultCount');
    if (cntEl) {
      const total = all.length;
      cntEl.textContent = rows.length === total
        ? `${total} ${total === 1 ? 'mašina' : 'mašina(e)'}`
        : `${rows.length} od ${total}`;
    }

    if (!rows.length) {
      listHost.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Nema mašina koje odgovaraju trenutnim filterima. Probaj da klikneš „Sve" u svakoj grupi ili obriši pretragu.</p></div>`;
      return;
    }
    const rowsHtml = rows.map(r => {
      const path = buildMaintenanceMachinePath(r.code, 'pregled');
      const statusHtml = `<span class="${statusBadgeClass(r.status)}">${escHtml(statusLabel(r.status, r.archived))}</span>`;
      const ovrHtml = r.overrideReason
        ? ` <span class="mnt-badge mnt-badge--maintenance" title="${escHtml(r.overrideReason)}${r.overrideValidUntil ? ' (do ' + r.overrideValidUntil.replace('T', ' ').slice(0, 16) + ')' : ''}">PAUZA</span>`
        : '';
      const waitingParts = r.openIncidents > 0 && /deo|part/i.test(r.overrideReason || '')
        ? ` <span class="mnt-badge mnt-badge--degraded" title="Čeka deo">Čeka deo</span>`
        : '';
      const respHtml = r.responsibleName
        ? `<span title="Odgovorni">${escHtml(r.responsibleName)}</span>`
        : `<span class="mnt-muted">—</span>`;
      return `
        <tr class="mnt-ops-row" data-mnt-code="${escHtml(r.code)}" data-mnt-nav="${path}">
          <td class="mnt-c-code"><code>${escHtml(r.code)}</code></td>
          <td class="mnt-c-name">
            <div class="mnt-name-main">${escHtml(r.name)}</div>
            ${r.subMeta ? `<div class="mnt-name-sub">${escHtml(r.subMeta)}</div>` : ''}
          </td>
          <td class="mnt-c-status">${statusHtml}${ovrHtml}${waitingParts} ${r.priHtml}</td>
          <td class="mnt-c-next"><span class="mnt-muted">${escHtml(relDate(r.nextDueIso))}</span></td>
          <td class="mnt-c-loc">${escHtml(r.location) || '<span class="mnt-muted">—</span>'}</td>
          <td class="mnt-c-resp">${respHtml}</td>
          <td class="mnt-c-act">
            <div class="mnt-quick-actions">
              <button type="button" class="mnt-qa mnt-qa--danger" data-mnt-op="report" title="Prijavi kvar">Kvar</button>
            </div>
          </td>
        </tr>`;
    }).join('');

    const cardsHtml = rows.map(r => {
      const path = buildMaintenanceMachinePath(r.code, 'pregled');
      const statusHtml = `<span class="${statusBadgeClass(r.status)}">${escHtml(statusLabel(r.status, r.archived))}</span>`;
      const ovrHtml = r.overrideReason ? `<span class="mnt-badge mnt-badge--maintenance">PAUZA</span>` : '';
      return `
        <article class="mnt-machine-card" data-mnt-code="${escHtml(r.code)}" data-mnt-nav="${path}">
          <header class="mnt-card-head">
            <div>
              <div class="mnt-card-name">${escHtml(r.name)}</div>
              <div class="mnt-card-meta">
                <code>${escHtml(r.code)}</code>${r.subMeta ? ' · ' + escHtml(r.subMeta) : ''}${r.location ? ' · ' + escHtml(r.location) : ''}
              </div>
            </div>
            <div class="mnt-card-status">${statusHtml}${ovrHtml} ${r.priHtml}</div>
          </header>
          <div class="mnt-card-body">
            <div><span class="mnt-muted">Sledeći rok:</span> ${escHtml(relDate(r.nextDueIso))}</div>
            ${r.responsibleName ? `<div><span class="mnt-muted">Odgovorni:</span> ${escHtml(r.responsibleName)}</div>` : ''}
          </div>
          <div class="mnt-card-actions">
            <button type="button" class="mnt-qa mnt-qa--danger" data-mnt-op="report">Kvar</button>
            <button type="button" class="mnt-qa mnt-qa--primary" data-mnt-op="detail">Detalj →</button>
          </div>
        </article>`;
    }).join('');

    listHost.innerHTML = `
      <div class="mnt-table-wrap mnt-ops-tablewrap">
        <table class="mnt-table mnt-ops-table" aria-label="Operativna lista mašina">
          <thead><tr>
            <th>Šifra</th>
            <th>Mašina</th>
            <th>Status</th>
            <th>Sledeći rok</th>
            <th>Lokacija</th>
            <th>Odgovorni</th>
            <th></th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      <div class="mnt-cards-wrap">${cardsHtml}</div>
    `;

    /* Wire: klik na red/karticu → detalj, osim kad je klik na quick action. */
    listHost.querySelectorAll('.mnt-ops-row, .mnt-machine-card').forEach(el => {
      el.addEventListener('click', ev => {
        if (ev.target.closest('[data-mnt-op]')) return;
        const p = el.getAttribute('data-mnt-nav');
        if (p) onNavigateToPath?.(p);
      });
    });

    /* Wire: quick actions. */
    listHost.querySelectorAll('[data-mnt-op]').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        const op = btn.getAttribute('data-mnt-op');
        const host2 = btn.closest('[data-mnt-code]');
        const code = host2?.getAttribute('data-mnt-code');
        if (!code || !op) return;
        handleQuickAction(op, code);
      });
    });
  }

  async function handleQuickAction(op, code) {
    const row = all.find(r => r.code === code);
    if (!row) return;
    if (op === 'detail') {
      onNavigateToPath?.(buildMaintenanceMachinePath(code, 'pregled'));
      return;
    }
    if (op === 'history') {
      onNavigateToPath?.(buildMaintenanceMachinePath(code, 'incidenti'));
      return;
    }
    if (op === 'report') {
      openReportIncidentModal({
        machineCode: code,
        maintProf: myProf,
        onNavigateToPath,
        onSaved: () => onRefreshPanel?.(),
      });
      return;
    }
    if (op === 'check') {
      const tasks = await fetchMaintTasksForMachine(code);
      const safe = Array.isArray(tasks) ? tasks : [];
      if (!safe.length) {
        showToast('⚠ Nema aktivnih kontrola za ovu mašinu');
        return;
      }
      openConfirmCheckModal({
        machineCode: code,
        tasks: safe,
        onSaved: () => onRefreshPanel?.(),
      });
    }
  }

  /* Debounce pretrage. */
  let searchT = null;
  searchInp?.addEventListener('input', () => {
    if (searchT) clearTimeout(searchT);
    searchT = setTimeout(() => {
      state.search = searchInp.value || '';
      renderList();
    }, 120);
  });
  locSel?.addEventListener('change', () => {
    state.location = locSel.value || '';
    renderList();
  });
  /* Chipovi su grupisani po dimenzijama (Status / Rok / Dodela) — svaka
     dimenzija je nezavisni single-select sa „Sve" kao reset opcijom. */
  host.querySelectorAll('[data-mnt-group]').forEach(groupEl => {
    const groupKey = groupEl.getAttribute('data-mnt-group');
    const stateKey = groupKey === 'status'
      ? 'statusFilter'
      : groupKey === 'deadline'
        ? 'deadlineFilter'
        : groupKey === 'assign'
          ? 'assignFilter'
          : null;
    if (!stateKey) return;
    groupEl.querySelectorAll('[data-mnt-chip]').forEach(btn => {
      btn.addEventListener('click', () => {
        state[stateKey] = btn.getAttribute('data-mnt-chip') || 'sve';
        groupEl.querySelectorAll('[data-mnt-chip]').forEach(b =>
          b.classList.toggle('mnt-chip--active', b === btn),
        );
        renderList();
      });
    });
  });

  /* „Sa otvorenim kvarovima" badge → klik na X ga uklanja i re-renderuje
     listu. Sam badge se ne pojavljuje ponovo dok se URL ne promeni. */
  host.querySelector('#mntOpClearInc')?.addEventListener('click', () => {
    state.incidentFilter = false;
    const wrap = host.querySelector('.mnt-active-filter');
    if (wrap) wrap.remove();
    renderList();
  });

  /* Header CTA: „Prijavi kvar" bez preseleksije → pita koju mašinu. */
  host.querySelector('#mntOpReportBtn')?.addEventListener('click', () => {
    openQuickReportPicker(all, code => {
      if (!code) return;
      openReportIncidentModal({
        machineCode: code,
        maintProf: myProf,
        onNavigateToPath,
        onSaved: () => onRefreshPanel?.(),
      });
    });
  });
  host.querySelector('#mntOpCatalogBtn')?.addEventListener('click', () => {
    onNavigateToPath?.('/maintenance/catalog');
  });

  renderList();
}

/**
 * Mini-modal: izaberi mašinu pre prijavljivanja kvara (kada tehničar krene sa
 * vrha liste i odabere CTA u header-u bez da prvo klikne red).
 *
 * @param {Array<{code:string,name:string,location?:string}>} rows
 * @param {(code: string | null) => void} onPicked
 */
function openQuickReportPicker(rows, onPicked) {
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:520px">
      <div class="kadr-modal-title">Prijavi kvar — izaberi mašinu</div>
      <div class="kadr-modal-subtitle">Kucaj deo šifre ili naziva</div>
      <input class="form-input" id="mntQRPInp" placeholder="npr. 8.3 ili DMG Mori" autofocus>
      <div id="mntQRPList" style="max-height:340px;overflow:auto;margin-top:8px;border:1px solid var(--border);border-radius:6px"></div>
      <div class="kadr-modal-actions" style="margin-top:12px">
        <span style="flex:1"></span>
        <button type="button" class="btn" id="mntQRPCancel" style="background:var(--surface3)">Otkaži</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); onPicked(null); };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#mntQRPCancel')?.addEventListener('click', close);

  const inp = /** @type {HTMLInputElement} */ (wrap.querySelector('#mntQRPInp'));
  const list = wrap.querySelector('#mntQRPList');

  function renderMatches() {
    const q = inp.value.trim().toLowerCase();
    const filtered = rows.filter(r => {
      if (!q) return true;
      return `${r.code} ${r.name} ${r.location || ''}`.toLowerCase().includes(q);
    }).slice(0, 40);
    if (!filtered.length) {
      list.innerHTML = `<p class="mnt-muted" style="padding:10px">Nema pogodaka.</p>`;
      return;
    }
    list.innerHTML = filtered.map(r => `
      <button type="button" class="mnt-qrp-item" data-code="${escHtml(r.code)}"
        style="display:flex;width:100%;gap:10px;align-items:baseline;padding:8px 10px;background:transparent;border:0;border-bottom:1px solid var(--border);cursor:pointer;text-align:left;color:var(--text)">
        <code style="min-width:70px">${escHtml(r.code)}</code>
        <span style="flex:1">${escHtml(r.name)}</span>
        ${r.location ? `<span class="mnt-muted" style="font-size:12px">${escHtml(r.location)}</span>` : ''}
      </button>
    `).join('');
    list.querySelectorAll('[data-code]').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = btn.getAttribute('data-code');
        wrap.remove();
        onPicked(c);
      });
    });
  }

  inp.addEventListener('input', renderMatches);
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') close();
    if (ev.key === 'Enter') {
      const first = list.querySelector('[data-code]');
      if (first) first.click();
    }
  });
  renderMatches();
  setTimeout(() => inp.focus(), 30);
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

  if (section === 'locations') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintLocationsPanel(host, { prof, onNavigateToPath });
    return;
  }

  if (section === 'assets') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintAssetsPanel(host, { prof, onNavigateToPath, forcedType: 'all' });
    return;
  }

  if (section === 'assetsMachines') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    if (canManageMaintCatalog(prof)) {
      await renderMaintCatalogPanel(host, { prof, onNavigateToPath });
    } else {
      await renderOperationalMachinesList(host, { onNavigateToPath, onRefreshPanel });
    }
    return;
  }

  if (section === 'assetsVehicles') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintVehiclesPanel(host, { prof });
    return;
  }

  if (section === 'assetsIt') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintItAssetsPanel(host, { prof });
    return;
  }

  if (section === 'assetsFacilities') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintFacilitiesPanel(host, { prof });
    return;
  }

  if (section === 'documents') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintDocumentsPanel(host, { prof });
    return;
  }

  if (section === 'preventive') {
    await renderMaintPreventivePanel(host, { onNavigateToPath });
    return;
  }

  if (section === 'calendar') {
    await renderMaintCalendarPanel(host, { onNavigateToPath });
    return;
  }

  if (section === 'reports') {
    await renderMaintReportsPanel(host, { onNavigateToPath });
    return;
  }

  if (section === 'inventory') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintInventoryPanel(host, { prof });
    return;
  }

  if (['settings'].includes(section)) {
    const titleMap = {
      settings: 'Podešavanja održavanja',
    };
    const hintMap = {
      settings: ['Kasnije: šabloni statusa, notifikacije, default uloge i CMMS podešavanja.'],
    };
    host.innerHTML = maintenancePlaceholderHtml(titleMap[section], hintMap[section] || []);
    return;
  }

  if (section === 'workorders') {
    const prof = await fetchMaintUserProfile();
    if (disposeRef.disposed || !host.isConnected) return;
    await renderMaintWorkOrdersPanel(host, { prof, onNavigateToPath, onRefresh: onRefreshPanel });
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
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam rokove. Verovatno je u pitanju ograničenje pristupa ili migracija nije primenjena.</p></div>`;
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
    const rowHtml = d => {
      const disp = nameByCode.get(d.machine_code) || d.machine_code;
      const path = buildMaintenanceMachinePath(d.machine_code, 'kontrole');
      const ovr = overrideByCode.get(d.machine_code);
      const ovrBadge = ovr
        ? ` <span class="${statusBadgeClass(ovr.status)}" title="${escHtml(ovr.reason || '')}${ovr.valid_until ? ' (do ' + ovr.valid_until.replace('T', ' ').slice(0, 16) + ')' : ''}">PAUZA · ${escHtml(statusLabel(ovr.status))}</span>`
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
      ${profileInfoBannerHtml(prof)}
      <p class="mnt-muted" style="margin:4px 0 12px">Preventivni taskovi — sledeći rok po mašini. Mašine u pauzi (npr. čekaju deo, planirano održavanje) prikazane su na dnu svake kolone i obeležene značkom „PAUZA”.</p>
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

  if (section === 'dashboard') {
    const [rows, prof, names, dues, workOrders] = await Promise.all([
      fetchMaintMachineStatuses(),
      fetchMaintUserProfile(),
      fetchMaintMachines(),
      /* Dues treba za KPI „Rokovi danas" — best-effort, ako RPC nije dostupan
         kartica će samo pokazati 0, ne ruši dashboard. */
      fetchMaintTaskDueDates().catch(() => []),
      fetchMaintWorkOrders({ limit: 250 }).catch(() => null),
    ]);
    if (disposeRef.disposed || !host.isConnected) return;

    if (rows === null) {
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam status mašina. Verovatno je u pitanju ograničenje pristupa ili migracija nije primenjena.</p></div>`;
      return;
    }
    const nameByCode = new Map(
      (Array.isArray(names) ? names : []).map(n => [n.machine_code, n.name || n.machine_code]),
    );
    const merged = mergeMachineNames(rows, nameByCode);

    /* Operativno-orijentisani KPI za Sprint 1.7: statusi + WO + preventiva. */
    const nDown = merged.filter(r => r.status === 'down').length;
    const nDegraded = merged.filter(r => r.status === 'degraded').length;
    const nRunning = merged.filter(r => r.status === 'running').length;
    const nOpenIncMachines = merged.filter(r => Number(r.open_incidents_count) > 0).length;
    const nLate = merged.filter(r => Number(r.overdue_checks_count) > 0).length;
    const woRows = Array.isArray(workOrders) ? workOrders : [];
    const isWoOpen = w => !['zavrsen', 'otkazan'].includes(String(w.status || '').toLowerCase());
    const activeWo = woRows.filter(isWoOpen);
    const nSafetyWo = activeWo.filter(w => !!w.safety_marker).length;

    const now = new Date();
    const sod = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const eod = new Date(sod); eod.setHours(23, 59, 59, 999);
    const dueList = Array.isArray(dues) ? dues : [];
    const nextDueByCode = aggregateNextDueByMachine(dueList);
    let nToday = 0;
    for (const iso of nextDueByCode.values()) {
      const t = new Date(iso);
      if (Number.isFinite(t.getTime()) && t >= sod && t <= eod) nToday += 1;
    }
    const dueBuckets = bucketTaskDueDates(dueList);

    const kpiDef = [
      {
        label: 'Otvoreni kvarovi',
        val: nOpenIncMachines,
        tone: 'down',
        nav: '/maintenance/machines?inc=1',
        title: 'Mašine sa otvorenim incidentima',
      },
      {
        label: 'U zastoju',
        val: nDown,
        tone: 'down',
        nav: '/maintenance/machines?status=zastoj',
        title: 'Mašine trenutno u zastoju',
      },
      {
        label: 'Kasni rokovi',
        val: nLate,
        tone: 'late',
        nav: '/maintenance/machines?deadline=kasni',
        title: 'Mašine sa prekoračenim preventivnim rokovima',
      },
      {
        label: 'Rokovi danas',
        val: nToday,
        tone: 'today',
        nav: '/maintenance/machines?deadline=danas',
        title: 'Mašine kojima sledeći preventivni zadatak pada danas',
      },
      {
        label: 'Aktivni WO',
        val: activeWo.length,
        tone: 'maintenance',
        nav: '/maintenance/work-orders?open=1',
        title: 'Radni nalozi koji nisu završeni ili otkazani',
      },
      {
        label: 'Safety WO',
        val: nSafetyWo,
        tone: 'down',
        nav: '/maintenance/work-orders?open=1',
        title: 'Otvoreni radni nalozi sa safety markerom',
      },
      {
        label: 'Radi normalno',
        val: nRunning,
        tone: 'running',
        nav: '/maintenance/machines?status=radi',
        title: 'Mašine bez zastoja u trenutnom statusu',
      },
      {
        label: 'Smetnje',
        val: nDegraded,
        tone: 'degraded',
        nav: '/maintenance/machines?status=smetnje',
        title: 'Mašine koje rade otežano',
      },
    ];
    const kpiRowHtml = kpiDef.map(k => {
      const zero = !k.val;
      return `<button type="button" class="mnt-kpi mnt-kpi--${k.tone}${zero ? ' mnt-kpi--zero' : ''} mnt-kpi--clickable"
        data-mnt-nav="${escHtml(k.nav)}" title="${escHtml(k.title)}"
        aria-label="${escHtml(k.label)}: ${k.val}">
        <span class="mnt-kpi-label">${escHtml(k.label)}</span>
        <span class="mnt-kpi-val">${k.val}</span>
      </button>`;
    }).join('');

    const attention = sortAttention(merged).filter(
      r => r.status !== 'running' || (Number(r.overdue_checks_count) > 0 || Number(r.open_incidents_count) > 0),
    );
    const attRowsHtml = attention.slice(0, 12).map(r => {
      const path = buildMaintenanceMachinePath(r.machine_code, 'pregled');
      const statusChip = `<span class="${statusBadgeClass(r.status)}">${escHtml(statusLabel(r.status))}</span>`;
      const ovrChip = r.override_reason
        ? ` <span class="mnt-badge mnt-badge--maintenance" title="${escHtml(r.override_reason)}${r.override_valid_until ? ' (do ' + r.override_valid_until.replace('T', ' ').slice(0, 16) + ')' : ''}">PAUZA</span>`
        : '';
      const problemParts = [];
      const nInc = Number(r.open_incidents_count) || 0;
      const nOverdue = Number(r.overdue_checks_count) || 0;
      if (nInc > 0) problemParts.push(`${nInc} ${nInc === 1 ? 'otvoreni kvar' : 'otvorena kvara/ova'}`);
      if (nOverdue > 0) problemParts.push(`${nOverdue} kasni rok${nOverdue === 1 ? '' : 'a'}`);
      const problemTxt = problemParts.length ? problemParts.join(' · ') : '—';
      return `<li class="mnt-att-row">
        <button type="button" class="mnt-att-name mnt-linkish" data-mnt-nav="${escHtml(path)}" title="Otvori detalj mašine">${escHtml(r.display_name)}</button>
        <span class="mnt-att-status">${statusChip}${ovrChip}</span>
        <span class="mnt-att-problem">${escHtml(problemTxt)}</span>
        <button type="button" class="mnt-att-action" data-mnt-nav="${escHtml(path)}">Otvori →</button>
      </li>`;
    }).join('');
    const woStatusSr = s => {
      const m = {
        novi: 'Novi',
        potvrden: 'Potvrđen',
        u_radu: 'U radu',
        ceka_deo: 'Čeka deo',
        ceka_izvodjaca: 'Čeka izvođača',
        zavrsen: 'Završen',
        otkazan: 'Otkazan',
      };
      return m[s] || s || '—';
    };
    const woRowsHtml = activeWo.slice(0, 8).map(w => {
      const asset = w.maint_assets || {};
      return `<li class="mnt-dash-mini-row">
        <button type="button" class="mnt-linkish" data-mnt-nav="/maintenance/work-orders">${escHtml(w.wo_number || 'WO')}</button>
        <span>${escHtml(w.title || '')}</span>
        <span class="mnt-muted">${escHtml(asset.asset_code || '—')} · ${escHtml(woStatusSr(String(w.status || '')))}</span>
      </li>`;
    }).join('');
    const dueRowsHtml = [...dueBuckets.overdue, ...dueBuckets.today].slice(0, 8).map(d => {
      const path = buildMaintenanceMachinePath(d.machine_code, 'kontrole');
      const disp = nameByCode.get(d.machine_code) || d.machine_code;
      return `<li class="mnt-dash-mini-row">
        <button type="button" class="mnt-linkish" data-mnt-nav="${escHtml(path)}">${escHtml(disp)}</button>
        <span>${escHtml(d.title || '')}</span>
        <span class="mnt-muted">${escHtml(relDate(d.next_due_at))}</span>
      </li>`;
    }).join('');
    const downRowsHtml = merged
      .filter(r => ['down', 'degraded', 'maintenance'].includes(String(r.status || '')))
      .slice(0, 8)
      .map(r => {
        const path = buildMaintenanceMachinePath(r.machine_code, 'pregled');
        return `<li class="mnt-dash-mini-row">
          <button type="button" class="mnt-linkish" data-mnt-nav="${escHtml(path)}">${escHtml(r.display_name)}</button>
          <span class="${statusBadgeClass(r.status)}">${escHtml(statusLabel(r.status))}</span>
          <span class="mnt-muted">${escHtml(r.override_reason || '—')}</span>
        </li>`;
      })
      .join('');

    const canEditCatalogDash = canManageMaintCatalog(prof);
    host.innerHTML = `
      ${profileInfoBannerHtml(prof)}
      <div class="mnt-kpi-row">${kpiRowHtml}</div>
      <div class="mnt-dash-grid">
        <section class="mnt-attention mnt-dash-card">
          <div class="mnt-att-head">
            <h3>Zahtevaju pažnju</h3>
            ${attention.length > 0 ? `<span class="mnt-muted mnt-att-count">${attention.length > 12 ? `prikazano 12 od ${attention.length}` : `${attention.length} ${attention.length === 1 ? 'stavka' : 'stavki'}`}</span>` : ''}
          </div>
          ${attRowsHtml
            ? `<ul class="mnt-att-list" role="list">${attRowsHtml}</ul>`
            : `<div class="mnt-att-empty"><strong>Sve mašine rade normalno.</strong><span class="mnt-muted">Nema otvorenih kvarova ni kašnjenja.</span></div>`}
        </section>
        <section class="mnt-dash-card">
          <div class="mnt-att-head">
            <h3>Aktivni radni nalozi</h3>
            <button type="button" class="mnt-catalog-link" data-mnt-nav="/maintenance/work-orders">Svi WO →</button>
          </div>
          <ul class="mnt-dash-mini-list">${woRowsHtml || '<li class="mnt-muted">Nema aktivnih radnih naloga.</li>'}</ul>
        </section>
        <section class="mnt-dash-card">
          <div class="mnt-att-head">
            <h3>Preventiva: kasni / danas</h3>
            <button type="button" class="mnt-catalog-link" data-mnt-nav="/maintenance/preventive">Preventiva →</button>
          </div>
          <ul class="mnt-dash-mini-list">${dueRowsHtml || '<li class="mnt-muted">Nema rokova za akciju.</li>'}</ul>
        </section>
        <section class="mnt-dash-card">
          <div class="mnt-att-head">
            <h3>Zastoji i smetnje</h3>
            <button type="button" class="mnt-catalog-link" data-mnt-nav="/maintenance/machines?status=zastoj">Lista →</button>
          </div>
          <ul class="mnt-dash-mini-list">${downRowsHtml || '<li class="mnt-muted">Nema zastoja ni smetnji.</li>'}</ul>
        </section>
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
    /* Jedan wire i za KPI kartice i za linkove u „Zahtevaju pažnju" (klik na ime
       i klik na „Otvori →" idu na isti path). */
    host.querySelectorAll('[data-mnt-nav]').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const p = el.getAttribute('data-mnt-nav');
        if (p) onNavigateToPath?.(p);
      });
    });
    return;
  }

  if (section === 'machines') {
    await renderOperationalMachinesList(host, {
      onNavigateToPath,
      onRefreshPanel,
    });
    return;
  }

  /* machine detail */
  const t0 = normalizeTab(tab);
  const [mach, btMeta, tasks, tasksAll, incidents, notes, prof, override, checks, profilesAll] = await Promise.all([
    fetchMaintMachine(machineCode),
    fetchBigtehnMachineRow(machineCode),
    fetchMaintTasksForMachine(machineCode),
    t0 === 'sabloni' ? fetchMaintTasksForMachineAll(machineCode) : Promise.resolve([]),
    fetchMaintIncidentsForMachine(machineCode),
    t0 === 'napomene' ? fetchMaintMachineNotes(machineCode) : Promise.resolve([]),
    fetchMaintUserProfile(),
    fetchMaintMachineOverride(machineCode),
    /* „Istorija" tab spaja kontrole (maint_checks) i incidente u jedan timeline. */
    t0 === 'incidenti' ? fetchMaintChecksForMachine(machineCode).catch(() => []) : Promise.resolve([]),
    /* Profili su potrebni da se u Pregledu prikaže ime odgovornog (mali skup). */
    t0 === 'pregled' ? fetchAllMaintProfiles().catch(() => null) : Promise.resolve(null),
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
      ? incidents.filter(i => !['resolved', 'closed'].includes(i.status)).slice(0, 3)
      : [];
    const activeTasks = Array.isArray(tasks) ? tasks.filter(x => x.active !== false) : [];
    const ovrHtml = ovrActive
      ? `<div class="mnt-ovr-card">
          <div class="mnt-ovr-head">
            <span class="${statusBadgeClass(ovrActive.status)}">${escHtml(statusLabel(ovrActive.status))}</span>
            <strong>Manuelni override statusa</strong>
            <span class="mnt-muted mnt-ovr-when">${escHtml((ovrActive.set_at || '').replace('T', ' ').slice(0, 16))}${
              ovrActive.valid_until
                ? ` → važi do ${escHtml(ovrActive.valid_until.replace('T', ' ').slice(0, 16))}`
                : ' → trajno'
            }</span>
          </div>
          <div class="mnt-ovr-reason">${escHtml(ovrActive.reason || '')}</div>
        </div>`
      : '';
    /* Odgovorni (ime iz profila). */
    const respProfile = mach?.responsible_user_id && Array.isArray(profilesAll)
      ? profilesAll.find(p => p.user_id === mach.responsible_user_id)
      : null;
    const responsibleLine = mach?.responsible_user_id
      ? `<div class="mnt-ov-resp">👤 Odgovorni: <strong>${escHtml(respProfile?.full_name || '— (nepoznat korisnik)')}</strong>${respProfile?.role ? ` <span class="mnt-muted">(${escHtml(respProfile.role)})</span>` : ''}</div>`
      : `<div class="mnt-ov-resp mnt-muted">👤 Odgovorni nije postavljen${canEditMach ? ' — uredi u Katalogu.' : ''}</div>`;

    /* Ključna meta (samo visoko-vredne bite: SN, lokacija, kW). */
    const metaBits = [];
    if (mach?.serial_number) metaBits.push(`S/N: <code>${escHtml(mach.serial_number)}</code>`);
    if (mach?.power_kw != null) metaBits.push(`${escHtml(String(mach.power_kw))} kW`);
    if (mach?.weight_kg != null) metaBits.push(`${escHtml(String(mach.weight_kg))} kg`);
    if (mach?.year_commissioned) metaBits.push(`pogon ${escHtml(String(mach.year_commissioned))}`);
    if (btMeta?.rj_code && btMeta.rj_code !== machineCode) metaBits.push(`BigTehn: <code>${escHtml(btMeta.rj_code)}</code>`);
    const metaLine = metaBits.length
      ? `<p class="mnt-muted mnt-ov-meta">${metaBits.join(' · ')}</p>`
      : (mach ? '' : `<p class="mnt-muted"><em>Mašina nije u katalogu — otvori tab Katalog pa je dodaj ili uvezi iz BigTehn-a.</em></p>`);

    /* Sledeći servis — najmanji next_due_at iz aktivnih taskova. Ne učitavamo
       ponovo; koristimo dues iz liste nećemo; umesto toga izračunaj iz tasks (koji imaju interval) + last check, ali to je komplikovano. Jednostavnije:
       prikazujemo „najbrojniji preventivni plan" sa procenom na bazi intervala. */
    const tasksLine = activeTasks.length
      ? `<div class="mnt-ov-tasks"><strong>Aktivne preventivne kontrole:</strong> ${activeTasks.length}</div>`
      : `<div class="mnt-ov-tasks mnt-muted">Nema aktivnih preventivnih kontrola.</div>`;

    const notesBlock = mach?.notes
      ? `<div class="mnt-ov-notes">${escHtml(mach.notes)}</div>`
      : '';

    body = `
      <div class="mnt-overview">
        ${ovrHtml}
        ${machArchived ? `<div class="mnt-panel" style="background:var(--red-bg);color:var(--red);padding:10px 12px;margin:0 0 12px">Ova mašina je <strong>arhivirana</strong> ${escHtml((mach.archived_at || '').replace('T', ' ').slice(0, 16))}. Vrati je iz „Kataloga”.</div>` : ''}
        <div class="mnt-ov-grid">
          <div class="mnt-ov-col">
            ${responsibleLine}
            ${metaLine}
            ${tasksLine}
          </div>
          <div class="mnt-ov-col">
            <div class="mnt-ov-subtitle">Otvoreni kvarovi</div>
            ${openInc.length
              ? `<ul class="mnt-list mnt-ov-list">${openInc.map(i => `
                  <li><button type="button" class="mnt-linkish" data-mnt-incident="${escHtml(String(i.id))}">${escHtml(i.title || '')}</button>
                    <span class="${severityBadge(i.severity)}">${escHtml(i.severity)}</span>
                    <span class="mnt-muted">${escHtml(relDate(i.reported_at))}</span></li>
                `).join('')}</ul>`
              : `<p class="mnt-muted">Nema otvorenih kvarova.</p>`}
          </div>
        </div>
        ${notesBlock}
      </div>`;
  } else if (t === 'kontrole') {
    /* „Zadaci" tab — preventiva grupisana po intervalnoj jedinici (dnevno/nedeljno/
       mesečno) za bolji skan. Veća OK-dugmad za prst na telefonu. */
    const activeTasks = Array.isArray(tasks) ? tasks.filter(x => x.active !== false) : [];
    const groupOrder = ['hours', 'days', 'weeks', 'months'];
    const groupLabels = { hours: 'Po satima', days: 'Dnevno', weeks: 'Nedeljno', months: 'Mesečno' };
    const grouped = {};
    activeTasks.forEach(x => {
      const k = x.interval_unit || 'days';
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(x);
    });
    const groupsHtml = groupOrder
      .filter(g => grouped[g]?.length)
      .map(g => {
        const items = grouped[g].map(x => `
          <li class="mnt-task-item">
            <div class="mnt-task-info">
              <strong>${escHtml(x.title || '')}</strong>
              <div class="mnt-muted" style="font-size:12px">
                ${escHtml(String(x.interval_value))} ${escHtml(x.interval_unit || '')}
                · <span class="${severityBadge(x.severity)}">${escHtml(x.severity || '')}</span>
                ${x.required_role ? ` · uloga: ${escHtml(x.required_role)}` : ''}
              </div>
            </div>
            <button type="button" class="btn mnt-task-ok" data-mnt-quickcheck="${escHtml(String(x.id))}">✓ OK</button>
          </li>
        `).join('');
        return `
          <section class="mnt-task-group">
            <h4 class="mnt-task-group-h">${escHtml(groupLabels[g])} <span class="mnt-muted">(${grouped[g].length})</span></h4>
            <ul class="mnt-list mnt-task-list">${items}</ul>
          </section>`;
      }).join('');
    body = activeTasks.length
      ? `<p class="mnt-muted">Brza potvrda „✓ OK" upisuje kontrolu bez napomene. Za drugi rezultat koristi dugme <strong>Potvrdi kontrolu</strong> gore.</p>
         ${groupsHtml}`
      : `<p class="mnt-muted">Nema aktivnih preventivnih kontrola za ovu mašinu.</p>`;
  } else if (t === 'sabloni') {
    body = renderMaintTasksTab(Array.isArray(tasksAll) ? tasksAll : [], prof);
  } else if (t === 'dokumenti') {
    body = `<div id="mntFilesMount"><p class="mnt-muted">Učitavanje…</p></div>`;
  } else if (t === 'incidenti') {
    /* „Istorija" — merged timeline: incidenti + urađene kontrole, sortirano po
       datumu desc. Read-only pregled; klik na incident otvara modal sa detaljem. */
    const incList = Array.isArray(incidents) ? incidents : [];
    const chkList = Array.isArray(checks) ? checks : [];
    const taskTitleById = new Map(
      (Array.isArray(tasksAll) && tasksAll.length ? tasksAll : (Array.isArray(tasks) ? tasks : []))
        .map(x => [String(x.id), x.title || '']),
    );
    /** @type {Array<{ kind: 'inc'|'chk', at: number, html: string }>} */
    const items = [];
    for (const i of incList) {
      const ts = new Date(i.reported_at).getTime();
      if (!Number.isFinite(ts)) continue;
      const dateTxt = (i.reported_at || '').replace('T', ' ').slice(0, 16);
      const wStub = i.maint_work_orders;
      const wOne = Array.isArray(wStub) ? wStub[0] : wStub;
      const woHtml = wOne
        ? ` <a href="#" class="mnt-wo-tiny" data-mnt-wo-id="${escHtml(String(wOne.wo_id))}" title="Radni nalog">${escHtml(wOne.wo_number || 'RN')}</a>`
        : '';
      items.push({
        kind: 'inc',
        at: ts,
        html: `<li class="mnt-hist-item mnt-hist-item--inc">
          <div class="mnt-hist-when">${escHtml(dateTxt)}</div>
          <div class="mnt-hist-body">
            <span class="mnt-hist-kind mnt-hist-kind--inc">Kvar</span>
            <button type="button" class="mnt-linkish" data-mnt-incident="${escHtml(String(i.id))}">${escHtml(i.title || '')}</button>${woHtml}
            <span class="${severityBadge(i.severity)}">${escHtml(i.severity)}</span>
            <span class="mnt-muted">${escHtml(i.status || '')}</span>
          </div>
        </li>`,
      });
    }
    for (const c of chkList) {
      const ts = new Date(c.performed_at).getTime();
      if (!Number.isFinite(ts)) continue;
      const dateTxt = (c.performed_at || '').replace('T', ' ').slice(0, 16);
      const title = taskTitleById.get(String(c.task_id)) || '(kontrola)';
      const resultBadge = c.result === 'ok'
        ? '<span class="mnt-badge mnt-badge--running">OK</span>'
        : c.result === 'warning'
          ? '<span class="mnt-badge mnt-badge--degraded">WARN</span>'
          : c.result === 'fail'
            ? '<span class="mnt-badge mnt-badge--down">FAIL</span>'
            : `<span class="mnt-badge">${escHtml(c.result || '—')}</span>`;
      items.push({
        kind: 'chk',
        at: ts,
        html: `<li class="mnt-hist-item mnt-hist-item--chk">
          <div class="mnt-hist-when">${escHtml(dateTxt)}</div>
          <div class="mnt-hist-body">
            <span class="mnt-hist-kind mnt-hist-kind--chk">Kontrola</span>
            <strong>${escHtml(title)}</strong>
            ${resultBadge}
            ${c.notes ? `<div class="mnt-muted mnt-hist-note">${escHtml(c.notes)}</div>` : ''}
          </div>
        </li>`,
      });
    }
    items.sort((a, b) => b.at - a.at);
    body = items.length
      ? `<p class="mnt-muted">Spojena istorija kvarova i urađenih kontrola. Klik na naslov kvara otvara detalj.</p>
         <ul class="mnt-list mnt-hist-list">${items.map(x => x.html).join('')}</ul>`
      : `<p class="mnt-muted">Nema zapisa u istoriji.</p>`;
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
      maintProf: prof,
      onNavigateToPath,
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
        onNavigateToPath,
        onSaved: () => onRefreshPanel?.(),
      });
    });
  });

  host.querySelectorAll('.mnt-hist-list [data-mnt-wo-id]').forEach(el => {
    el.addEventListener('click', async e => {
      e.preventDefault();
      e.stopPropagation();
      const wid = el.getAttribute('data-mnt-wo-id');
      if (!wid) return;
      const m = await import('./maintWorkOrdersPanel.js');
      await m.openMaintWorkOrderDetailModal({
        woId: wid,
        maintProf: prof,
        onNavigateToPath,
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
 *   section: 'dashboard' | 'machines' | 'machine' | 'board' | 'notifications' | 'catalog' | 'locations' | 'workorders' | 'assets' | 'assetsMachines' | 'assetsVehicles' | 'assetsIt' | 'assetsFacilities' | 'preventive' | 'calendar' | 'inventory' | 'documents' | 'reports' | 'settings',
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
      section === 'machine' || section === 'workorders' ? runPanel : null,
    );
  };

  if (host) {
    renderPanel(
      host,
      section,
      machineCode,
      tab,
      onNavigateToPath,
      section === 'machine' || section === 'workorders' ? runPanel : null,
    ).catch(
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
