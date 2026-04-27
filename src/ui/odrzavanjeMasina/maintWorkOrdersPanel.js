/**
 * Pregled radnih naloga (CMMS) — tabla / kanban po status grupama.
 * Šema: add_maint_work_orders.sql
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { getCurrentUser, isAdminOrMenadzment } from '../../state/auth.js';
import {
  fetchMaintWorkOrders,
  fetchMaintWorkOrderById,
  fetchMachineCodeByAssetId,
  patchMaintWorkOrder,
  fetchAssignableMaintUsers,
} from '../../services/maintenance.js';
import { buildMaintenanceMachinePath } from '../../lib/appPaths.js';
import { openIncidentDetailModal } from './maintIncidentDialog.js';

const WO_STATUS_GROUPS = [
  { id: 'funnel', label: 'Funnel', statuses: ['novi', 'potvrden'] },
  { id: 'active', label: 'Aktivno', statuses: ['dodeljen', 'u_radu'] },
  { id: 'wait', label: 'Čeka', statuses: ['ceka_deo', 'ceka_dobavljaca', 'ceka_korisnika'] },
  { id: 'check', label: 'Kontrola', statuses: ['kontrola'] },
  { id: 'done', label: 'Završeno', statuses: ['zavrsen', 'otkazan'] },
];

const ALL_WO_STATUSES = WO_STATUS_GROUPS.flatMap(g => g.statuses);

function canEditWorkOrder(maintProf) {
  const erp = isAdminOrMenadzment();
  const r = maintProf?.role;
  return erp || ['technician', 'chief', 'admin'].includes(r);
}

/** @param {string} s */
function woStatusLabelSr(s) {
  const m = {
    novi: 'Novi',
    potvrden: 'Potvrđen',
    dodeljen: 'Dodeljen',
    u_radu: 'U radu',
    ceka_deo: 'Čeka deo',
    ceka_dobavljaca: 'Čeka dobavljača',
    ceka_korisnika: 'Čeka korisnika',
    kontrola: 'Kontrola',
    zavrsen: 'Završen',
    otkazan: 'Otkazan',
  };
  return m[s] || s;
}

/** @param {string} p */
function woPriorityLabel(p) {
  const m = {
    p1_zastoj: 'P1 zastoj',
    p2_smetnja: 'P2 smetnja',
    p3_manje: 'P3 manje',
    p4_planirano: 'P4 planirano',
  };
  return m[p] || p;
}

/**
 * @param {object} row
 * @param {string} [cls]
 */
function priorityBadgeClass(row, cls) {
  const p = String(row?.priority || '');
  if (p === 'p1_zastoj') return cls ? `${cls} mnt-wo-pri--p1` : 'mnt-wo-pri mnt-wo-pri--p1';
  if (p === 'p2_smetnja') return cls ? `${cls} mnt-wo-pri--p2` : 'mnt-wo-pri mnt-wo-pri--p2';
  return cls ? `${cls} mnt-wo-pri--p34` : 'mnt-wo-pri mnt-wo-pri--p34';
}

/**
 * @param {HTMLElement} host
 * @param {{ onNavigateToPath?: (p: string) => void, onRefresh?: () => void, prof: object | null }} opts
 */
export async function renderMaintWorkOrdersPanel(host, opts) {
  const { onNavigateToPath, onRefresh, prof } = opts;
  host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Učitavam radne naloge…</p></div>`;

  const raw = await fetchMaintWorkOrders({ limit: 500 });
  if (!Array.isArray(raw)) {
    host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam radne naloge (migracija ili RLS).</p></div>`;
    return;
  }

  const byCol = new Map(WO_STATUS_GROUPS.map(g => [g.id, []]));
  for (const w of raw) {
    const st = String(w.status || '');
    const g = WO_STATUS_GROUPS.find(x => x.statuses.includes(st));
    if (g) {
      byCol.get(g.id).push(w);
    } else {
      if (!byCol.has('funnel')) byCol.set('funnel', []);
      byCol.get('funnel').push(w);
    }
  }

  function cardHtml(w) {
    const asset = w.maint_assets;
    const ac = asset?.asset_code || '—';
    const an = asset?.name || '';
    const pri = priorityBadgeClass(w);
    return `
      <div class="mnt-wo-card" data-mnt-wo-id="${escHtml(String(w.wo_id))}" role="button" tabindex="0">
        <div class="mnt-wo-card-top">
          <code class="mnt-wo-num">${escHtml(w.wo_number || w.wo_id?.slice(0, 8) || '')}</code>
          <span class="${pri}">${escHtml(woPriorityLabel(String(w.priority || '')))}</span>
        </div>
        <div class="mnt-wo-card-title">${escHtml(w.title || '')}</div>
        <div class="mnt-wo-card-meta mnt-muted">${escHtml(ac)}${an ? ' · ' + escHtml(an) : ''}</div>
        <div class="mnt-wo-card-st">${escHtml(woStatusLabelSr(String(w.status || '')))}</div>
      </div>`;
  }

  const colHtml = WO_STATUS_GROUPS.map(g => {
    const items = byCol.get(g.id) || [];
    return `
      <div class="mnt-wo-col" data-mnt-wo-group="${g.id}">
        <h3 class="mnt-wo-col-h">${escHtml(g.label)} <span class="mnt-muted">(${items.length})</span></h3>
        <div class="mnt-wo-col-body">${items.length ? items.map(cardHtml).join('') : '<p class="mnt-muted mnt-wo-empty">Nema stavki.</p>'}</div>
      </div>`;
  }).join('');

  const listRows = raw
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(w => {
      const asset = w.maint_assets;
      return `<tr class="mnt-wo-row" data-mnt-wo-id="${escHtml(String(w.wo_id))}" style="cursor:pointer">
        <td><code>${escHtml(w.wo_number || '—')}</code></td>
        <td>${escHtml(woStatusLabelSr(String(w.status || '')))}</td>
        <td><span class="${priorityBadgeClass(w, 'mnt-wo-pri')}">${escHtml(woPriorityLabel(String(w.priority || '')))}</span></td>
        <td>${escHtml(w.title || '')}</td>
        <td class="mnt-muted">${escHtml(asset?.asset_code || '—')}</td>
        <td>${escHtml((w.created_at || '').replace('T', ' ').slice(0, 16))}</td>
      </tr>`;
    })
    .join('');

  host.innerHTML = `
    <p class="mnt-muted" style="margin:0 0 12px">Radni nalozi povezani s mašinama (assets). Klik na karticu ili red za detalj i promenu statusa (ovlašćenja: tehničar/šef/admin).</p>
    <div class="mnt-wo-board" role="region" aria-label="Kanban po statusu">
      ${colHtml}
    </div>
    <details class="mnt-wo-table-details" style="margin-top:20px">
      <summary class="mnt-muted" style="cursor:pointer">Tabela (svi prikazani redovi)</summary>
      <div class="mnt-table-wrap" style="margin-top:10px;overflow:auto">
        <table class="mnt-table" aria-label="Radni nalozi tabela">
          <thead><tr>
            <th>Broj</th><th>Status</th><th>Prioritet</th><th>Naslov</th><th>Šifra sredstva</th><th>Kreiran</th>
          </tr></thead>
          <tbody>${listRows || '<tr><td colspan="6" class="mnt-muted">Nema podataka</td></tr>'}</tbody>
        </table>
      </div>
    </details>`;

  const openDet = id => {
    if (!id) return;
    void openMaintWorkOrderDetailModal({
      woId: id,
      maintProf: prof,
      onNavigateToPath,
      onSaved: () => onRefresh?.(),
    });
  };

  host.querySelectorAll('.mnt-wo-card, .mnt-wo-row').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-mnt-wo-id');
      openDet(id);
    });
  });
}

/**
 * @param {{ woId: string, maintProf: object|null, onNavigateToPath?: (p:string)=>void, onSaved?: () => void }} opts
 */
export async function openMaintWorkOrderDetailModal(opts) {
  const { woId, maintProf, onNavigateToPath, onSaved } = opts;
  const wo = await fetchMaintWorkOrderById(woId);
  if (!wo) {
    showToast('⚠ Nalog nije učitan');
    return;
  }
  const machineCode = await fetchMachineCodeByAssetId(wo.asset_id);
  const canEdit = canEditWorkOrder(maintProf);
  const assignList = canEdit ? await fetchAssignableMaintUsers() : null;
  const assignOpts =
    '<option value="">— nije dodeljen —</option>' +
    (Array.isArray(assignList)
      ? assignList
          .map(
            u =>
              `<option value="${escHtml(String(u.user_id))}"${String(wo.assigned_to || '') === String(u.user_id) ? ' selected' : ''}>${escHtml(u.full_name || '')} (${escHtml(u.maint_role || '')})</option>`,
          )
          .join('')
      : '');

  const stOpts = ALL_WO_STATUSES.map(
    s =>
      `<option value="${escHtml(s)}"${String(wo.status) === s ? ' selected' : ''}>${escHtml(woStatusLabelSr(s))}</option>`,
  ).join('');

  const wrap = document.createElement('div');
  wrap.id = 'mntWoDlg';
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:540px">
      <div class="kadr-modal-title">Radni nalog</div>
      <div class="kadr-modal-subtitle">
        <code>${escHtml(wo.wo_number || wo.wo_id)}</code>
        ${machineCode ? ` · <a href="#" id="mntWoDlgMach" style="color:var(--accent)">Otvori mašinu</a>` : ''}
        ${wo.source_incident_id ? ` · <a href="#" id="mntWoDlgInc" style="color:var(--accent)">Otvori incident</a>` : ''}
      </div>
      <p><strong>${escHtml(wo.title || '')}</strong></p>
      <p class="mnt-muted" style="font-size:14px;white-space:pre-wrap">${escHtml(wo.description || '—')}</p>
      <p>Prioritet: <span class="${priorityBadgeClass(wo)}">${escHtml(woPriorityLabel(String(wo.priority || '')))}</span>
        · Tip: <span class="mnt-muted">${escHtml(String(wo.type || ''))}</span></p>
      <p class="mnt-muted" style="font-size:12px">Sredstvo: ${escHtml(wo.maint_assets?.asset_code || '—')}
        — ${escHtml(wo.maint_assets?.name || '—')}</p>
      ${
        canEdit
          ? `<form id="mntWoForm">
        <label class="form-label">Status</label>
        <select class="form-input" name="status" id="mntWoSt">${stOpts}</select>
        <label class="form-label">Dodeljeno</label>
        <select class="form-input" name="assigned_to" id="mntWoAs">${assignOpts}</select>
        <div class="kadr-modal-actions" style="margin-top:16px">
          <button type="button" class="btn" id="mntWoCancel" style="background:var(--surface3)">Zatvori</button>
          <button type="submit" class="btn" id="mntWoSave">Sačuvaj</button>
        </div>
      </form>`
          : `<p><strong>Status:</strong> ${escHtml(woStatusLabelSr(String(wo.status || '')))}</p>
         <p class="mnt-muted">Menjanje statusa: tehničar, šef ili admin održavanja.</p>
         <div class="kadr-modal-actions"><button type="button" class="btn" id="mntWoCancel">Zatvori</button></div>`
      }
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.addEventListener('click', e => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#mntWoCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntWoDlgMach')?.addEventListener('click', e => {
    e.preventDefault();
    if (machineCode) {
      onNavigateToPath?.(buildMaintenanceMachinePath(machineCode, 'pregled'));
    }
    close();
  });
  wrap.querySelector('#mntWoDlgInc')?.addEventListener('click', e => {
    e.preventDefault();
    if (wo.source_incident_id) {
      void openIncidentDetailModal({
        incidentId: String(wo.source_incident_id),
        machineCode: machineCode || '',
        maintProf,
        onNavigateToPath,
        onSaved: () => onSaved?.(),
      });
    }
    close();
  });

  wrap.querySelector('#mntWoForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const uid = getCurrentUser()?.id;
    if (!uid) return;
    const st = /** @type {HTMLSelectElement} */ (wrap.querySelector('#mntWoSt'))?.value;
    const asRaw = /** @type {HTMLSelectElement} */ (wrap.querySelector('#mntWoAs'))?.value;
    const assigned_to = asRaw && asRaw.length > 10 ? asRaw : null;
    const patch = {
      status: st,
      assigned_to,
      updated_by: uid,
    };
    if (st === 'u_radu' && !wo.started_at) {
      patch.started_at = new Date().toISOString();
    }
    if (st === 'zavrsen' && !wo.completed_at) {
      patch.completed_at = new Date().toISOString();
    }
    const ok = await patchMaintWorkOrder(wo.wo_id, patch);
    if (!ok) {
      showToast('⚠ Snimanje nije uspelo (RLS)');
      return;
    }
    showToast('✅ Sačuvano');
    close();
    onSaved?.();
  });
}

export { canEditWorkOrder, woStatusLabelSr, WO_STATUS_GROUPS, ALL_WO_STATUSES };
