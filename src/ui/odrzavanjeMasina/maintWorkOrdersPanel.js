/**
 * Pregled radnih naloga (CMMS) — tabla / kanban po status grupama.
 * Šema: add_maint_work_orders.sql
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { getCurrentUser, isAdminOrMenadzment } from '../../state/auth.js';
import {
  fetchMaintWorkOrders,
  fetchMaintWorkOrderById,
  fetchMaintWorkOrderEvents,
  fetchMaintWorkOrderParts,
  fetchMaintWorkOrderLabor,
  insertMaintWorkOrderPart,
  insertMaintWorkOrderLabor,
  fetchMaintParts,
  insertMaintPartStockMovement,
  fetchMachineCodeByAssetId,
  patchMaintWorkOrder,
  insertMaintWorkOrderEvent,
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

function eventTypeLabel(t) {
  const m = {
    status_change: 'Promena statusa',
    assigned_change: 'Promena dodele',
    priority_change: 'Promena prioriteta',
    user_note: 'Napomena',
  };
  return m[t] || t;
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

  const canEdit = canEditWorkOrder(prof);
  const myUid = getCurrentUser()?.id || null;
  const sp = new URLSearchParams(window.location.search);
  const state = {
    status: sp.get('status') || 'all',
    priority: sp.get('priority') || 'all',
    mine: sp.get('mine') === '1',
    openOnly: sp.get('open') !== '0',
    search: sp.get('q') || '',
  };

  function syncUrl() {
    const q = new URLSearchParams();
    if (state.status !== 'all') q.set('status', state.status);
    if (state.priority !== 'all') q.set('priority', state.priority);
    if (state.mine) q.set('mine', '1');
    if (!state.openOnly) q.set('open', '0');
    if (state.search.trim()) q.set('q', state.search.trim());
    const next = `/maintenance/work-orders${q.toString() ? '?' + q.toString() : ''}`;
    window.history.replaceState(null, '', next);
  }

  function filterRows() {
    const q = state.search.trim().toLowerCase();
    return raw.filter(w => {
      if (state.status !== 'all' && String(w.status || '') !== state.status) return false;
      if (state.priority !== 'all' && String(w.priority || '') !== state.priority) return false;
      if (state.mine && (!myUid || String(w.assigned_to || '') !== String(myUid))) return false;
      if (state.openOnly && ['zavrsen', 'otkazan'].includes(String(w.status || ''))) return false;
      if (q) {
        const asset = w.maint_assets || {};
        const hay = [
          w.wo_number, w.title, w.description, w.status, w.priority,
          asset.asset_code, asset.name, asset.asset_type,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  const rows = filterRows();
  const byCol = new Map(WO_STATUS_GROUPS.map(g => [g.id, []]));
  for (const w of rows) {
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
    const done = ['zavrsen', 'otkazan'].includes(String(w.status || ''));
    const actions = canEdit && !done
      ? `<div class="mnt-wo-card-actions">
          ${w.status !== 'u_radu' ? `<button type="button" class="mnt-wo-mini" data-mnt-wo-status="u_radu">Započni</button>` : ''}
          <button type="button" class="mnt-wo-mini" data-mnt-wo-status="ceka_deo">Čeka deo</button>
          <button type="button" class="mnt-wo-mini mnt-wo-mini--ok" data-mnt-wo-status="zavrsen">Završi</button>
        </div>`
      : '';
    return `
      <div class="mnt-wo-card" data-mnt-wo-id="${escHtml(String(w.wo_id))}" role="button" tabindex="0" draggable="${canEdit ? 'true' : 'false'}">
        <div class="mnt-wo-card-top">
          <code class="mnt-wo-num">${escHtml(w.wo_number || w.wo_id?.slice(0, 8) || '')}</code>
          <span class="${pri}">${escHtml(woPriorityLabel(String(w.priority || '')))}</span>
        </div>
        <div class="mnt-wo-card-title">${escHtml(w.title || '')}</div>
        <div class="mnt-wo-card-meta mnt-muted">${escHtml(ac)}${an ? ' · ' + escHtml(an) : ''}</div>
        <div class="mnt-wo-card-st">${escHtml(woStatusLabelSr(String(w.status || '')))}</div>
        ${actions}
      </div>`;
  }

  const colHtml = WO_STATUS_GROUPS.map(g => {
    const items = byCol.get(g.id) || [];
    return `
      <div class="mnt-wo-col" data-mnt-wo-group="${g.id}" data-mnt-drop-status="${escHtml(g.statuses[0])}">
        <h3 class="mnt-wo-col-h">${escHtml(g.label)} <span class="mnt-muted">(${items.length})</span></h3>
        <div class="mnt-wo-col-body">${items.length ? items.map(cardHtml).join('') : '<p class="mnt-muted mnt-wo-empty">Nema stavki.</p>'}</div>
      </div>`;
  }).join('');

  const listRows = raw
    .filter(w => rows.includes(w))
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
    <p class="mnt-muted" style="margin:0 0 12px">Radni nalozi povezani s mašinama (assets). Kanban je operativni prikaz; tabela ispod koristi iste filtere.</p>
    <div class="mnt-wo-toolbar">
      <input type="search" class="form-input" id="mntWoSearch" placeholder="Pretraga (broj, naslov, sredstvo)…" value="${escHtml(state.search)}">
      <select class="form-input" id="mntWoStatus">
        <option value="all"${state.status === 'all' ? ' selected' : ''}>Svi statusi</option>
        ${ALL_WO_STATUSES.map(s => `<option value="${escHtml(s)}"${state.status === s ? ' selected' : ''}>${escHtml(woStatusLabelSr(s))}</option>`).join('')}
      </select>
      <select class="form-input" id="mntWoPriority">
        <option value="all"${state.priority === 'all' ? ' selected' : ''}>Svi prioriteti</option>
        ${['p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'].map(p => `<option value="${escHtml(p)}"${state.priority === p ? ' selected' : ''}>${escHtml(woPriorityLabel(p))}</option>`).join('')}
      </select>
      <label class="mnt-wo-check"><input type="checkbox" id="mntWoOpen"${state.openOnly ? ' checked' : ''}> Samo otvoreni</label>
      <label class="mnt-wo-check"><input type="checkbox" id="mntWoMine"${state.mine ? ' checked' : ''}> Samo moji</label>
      <span class="mnt-muted mnt-wo-count">${rows.length} od ${raw.length}</span>
    </div>
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

  const rerender = () => {
    syncUrl();
    void renderMaintWorkOrdersPanel(host, opts);
  };
  host.querySelector('#mntWoSearch')?.addEventListener('input', e => {
    state.search = e.target.value || '';
    rerender();
  });
  host.querySelector('#mntWoStatus')?.addEventListener('change', e => {
    state.status = e.target.value || 'all';
    rerender();
  });
  host.querySelector('#mntWoPriority')?.addEventListener('change', e => {
    state.priority = e.target.value || 'all';
    rerender();
  });
  host.querySelector('#mntWoOpen')?.addEventListener('change', e => {
    state.openOnly = !!e.target.checked;
    rerender();
  });
  host.querySelector('#mntWoMine')?.addEventListener('change', e => {
    state.mine = !!e.target.checked;
    rerender();
  });

  async function quickStatus(woId, status) {
    if (!woId || !status) return;
    const patch = { status };
    if (status === 'u_radu') patch.started_at = new Date().toISOString();
    if (status === 'zavrsen') patch.completed_at = new Date().toISOString();
    const ok = await patchMaintWorkOrder(woId, patch);
    if (!ok) {
      showToast('⚠ Promena statusa nije uspela');
      return;
    }
    showToast('✅ Status promenjen');
    onRefresh?.();
  }

  host.querySelectorAll('[data-mnt-wo-status]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const card = btn.closest('[data-mnt-wo-id]');
      void quickStatus(card?.getAttribute('data-mnt-wo-id'), btn.getAttribute('data-mnt-wo-status'));
    });
  });

  host.querySelectorAll('.mnt-wo-card[draggable="true"]').forEach(card => {
    card.addEventListener('dragstart', ev => {
      ev.dataTransfer?.setData('text/plain', card.getAttribute('data-mnt-wo-id') || '');
    });
  });
  host.querySelectorAll('[data-mnt-drop-status]').forEach(col => {
    col.addEventListener('dragover', ev => {
      if (!canEdit) return;
      ev.preventDefault();
      col.classList.add('mnt-wo-col--drop');
    });
    col.addEventListener('dragleave', () => col.classList.remove('mnt-wo-col--drop'));
    col.addEventListener('drop', ev => {
      ev.preventDefault();
      col.classList.remove('mnt-wo-col--drop');
      const woId = ev.dataTransfer?.getData('text/plain');
      const status = col.getAttribute('data-mnt-drop-status');
      void quickStatus(woId, status);
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

  const [events, parts, labor, partCatalog] = await Promise.all([
    fetchMaintWorkOrderEvents(wo.wo_id),
    fetchMaintWorkOrderParts(wo.wo_id),
    fetchMaintWorkOrderLabor(wo.wo_id),
    fetchMaintParts({ limit: 1000 }).catch(() => []),
  ]);
  const partOptions = Array.isArray(partCatalog)
    ? partCatalog.map(p => `<option value="${escHtml(`${p.part_code || ''} — ${p.name || ''}`)}"></option>`).join('')
    : '';
  const eventsHtml = events.length
    ? events
        .map(
          ev => `<div class="mnt-wo-activity-item">
            <div><strong>${escHtml(eventTypeLabel(String(ev.event_type || '')))}</strong>
              <span class="mnt-muted">${escHtml((ev.at || '').replace('T', ' ').slice(0, 16))}</span></div>
            ${
              ev.from_value || ev.to_value
                ? `<div class="mnt-muted">${escHtml(ev.from_value || '—')} → ${escHtml(ev.to_value || '—')}</div>`
                : ''
            }
            ${ev.comment ? `<div style="white-space:pre-wrap">${escHtml(ev.comment)}</div>` : ''}
          </div>`,
        )
        .join('')
    : '<p class="mnt-muted">Još nema aktivnosti.</p>';
  const partsHtml = parts.length
    ? parts
        .map(
          p => `<tr>
            <td>${escHtml(p.part_name || '')}${p.maint_parts?.part_code ? `<div class="mnt-muted">${escHtml(p.maint_parts.part_code)}</div>` : ''}</td>
            <td>${escHtml(p.quantity ?? '—')}</td>
            <td>${escHtml(p.unit || '—')}</td>
            <td>${escHtml(p.supplier || '—')}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="mnt-muted">Nema evidentiranih delova.</td></tr>';
  const laborHtml = labor.length
    ? labor
        .map(
          l => `<tr>
            <td>${escHtml(l.minutes ?? '—')}</td>
            <td>${escHtml((l.started_at || '').replace('T', ' ').slice(0, 16) || '—')}</td>
            <td>${escHtml((l.ended_at || '').replace('T', ' ').slice(0, 16) || '—')}</td>
            <td>${escHtml(l.notes || '—')}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="mnt-muted">Nema evidentiranih sati.</td></tr>';

  const wrap = document.createElement('div');
  wrap.id = 'mntWoDlg';
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal mnt-wo-drawer">
      <div class="kadr-modal-title">Radni nalog</div>
      <div class="kadr-modal-subtitle">
        <code>${escHtml(wo.wo_number || wo.wo_id)}</code>
        ${machineCode ? ` · <a href="#" id="mntWoDlgMach" style="color:var(--accent)">Otvori mašinu</a>` : ''}
        ${wo.source_incident_id ? ` · <a href="#" id="mntWoDlgInc" style="color:var(--accent)">Otvori incident</a>` : ''}
      </div>
      <div class="mnt-wo-drawer-head">
        <div>
          <p><strong>${escHtml(wo.title || '')}</strong></p>
          <p class="mnt-muted" style="font-size:14px;white-space:pre-wrap">${escHtml(wo.description || '—')}</p>
        </div>
        <div class="mnt-wo-mini">
          <div>Status: <strong>${escHtml(woStatusLabelSr(String(wo.status || '')))}</strong></div>
          <div>Prioritet: <span class="${priorityBadgeClass(wo)}">${escHtml(woPriorityLabel(String(wo.priority || '')))}</span></div>
          <div>Tip: <span class="mnt-muted">${escHtml(String(wo.type || ''))}</span></div>
          <div>Sredstvo: <span class="mnt-muted">${escHtml(wo.maint_assets?.asset_code || '—')} — ${escHtml(wo.maint_assets?.name || '—')}</span></div>
        </div>
      </div>
      <div class="mnt-wo-tabs" role="tablist" aria-label="Radni nalog detalji">
        <button type="button" class="mnt-wo-tab is-active" data-mnt-wo-tab="overview">Pregled</button>
        <button type="button" class="mnt-wo-tab" data-mnt-wo-tab="activity">Aktivnost</button>
        <button type="button" class="mnt-wo-tab" data-mnt-wo-tab="parts">Delovi</button>
        <button type="button" class="mnt-wo-tab" data-mnt-wo-tab="labor">Sati</button>
        <button type="button" class="mnt-wo-tab" data-mnt-wo-tab="docs">Dokumenta</button>
      </div>
      <section class="mnt-wo-tab-panel is-active" data-mnt-wo-panel="overview">
      ${
        canEdit
          ? `<form id="mntWoForm">
        <label class="form-label">Status</label>
        <select class="form-input" name="status" id="mntWoSt">${stOpts}</select>
        <label class="form-label">Dodeljeno</label>
        <select class="form-input" name="assigned_to" id="mntWoAs">${assignOpts}</select>
        <label class="form-label">Komentar promene</label>
        <textarea class="form-input" id="mntWoComment" rows="3" placeholder="Šta je urađeno / razlog promene statusa ili dodele"></textarea>
        <div class="kadr-modal-actions" style="margin-top:16px">
          <button type="button" class="btn" id="mntWoCancel" style="background:var(--surface3)">Zatvori</button>
          <button type="submit" class="btn" id="mntWoSave">Sačuvaj</button>
        </div>
      </form>`
          : `<p><strong>Status:</strong> ${escHtml(woStatusLabelSr(String(wo.status || '')))}</p>
         <p class="mnt-muted">Menjanje statusa: tehničar, šef ili admin održavanja.</p>
         <div class="kadr-modal-actions"><button type="button" class="btn" id="mntWoCancel">Zatvori</button></div>`
      }
      </section>
      <section class="mnt-wo-tab-panel" data-mnt-wo-panel="activity">${eventsHtml}</section>
      <section class="mnt-wo-tab-panel" data-mnt-wo-panel="parts">
        <div class="mnt-table-wrap"><table class="mnt-table"><thead><tr><th>Deo</th><th>Količina</th><th>Jedinica</th><th>Dobavljač</th></tr></thead><tbody>${partsHtml}</tbody></table></div>
        ${
          canEdit
            ? `<form id="mntWoPartForm" class="mnt-wo-inline-form">
          <input class="form-input" name="part_name" list="mntWoPartCatalog" placeholder="Naziv dela ili šifra iz kataloga" required>
          <datalist id="mntWoPartCatalog">${partOptions}</datalist>
          <input class="form-input" name="quantity" type="number" min="0" step="0.0001" placeholder="Količina">
          <input class="form-input" name="unit" placeholder="Jedinica">
          <input class="form-input" name="supplier" placeholder="Dobavljač">
          <button type="submit" class="btn btn-xs">Dodaj deo</button>
        </form>`
            : ''
        }
      </section>
      <section class="mnt-wo-tab-panel" data-mnt-wo-panel="labor">
        <div class="mnt-table-wrap"><table class="mnt-table"><thead><tr><th>Minuta</th><th>Početak</th><th>Kraj</th><th>Napomena</th></tr></thead><tbody>${laborHtml}</tbody></table></div>
        ${
          canEdit
            ? `<form id="mntWoLaborForm" class="mnt-wo-inline-form">
          <input class="form-input" name="minutes" type="number" min="1" step="1" placeholder="Minuta" required>
          <input class="form-input" name="notes" placeholder="Napomena">
          <button type="submit" class="btn btn-xs">Dodaj sate</button>
        </form>`
            : ''
        }
      </section>
      <section class="mnt-wo-tab-panel" data-mnt-wo-panel="docs">
        <p class="mnt-muted">Dokumenta će se povezati kada dodamo storage/povezanu tabelu za priloge radnog naloga.</p>
      </section>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  const reloadDrawer = () => {
    close();
    onSaved?.();
    void openMaintWorkOrderDetailModal(opts);
  };
  wrap.addEventListener('click', e => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#mntWoCancel')?.addEventListener('click', close);
  wrap.querySelectorAll('[data-mnt-wo-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-mnt-wo-tab');
      wrap.querySelectorAll('[data-mnt-wo-tab]').forEach(b => b.classList.toggle('is-active', b === btn));
      wrap
        .querySelectorAll('[data-mnt-wo-panel]')
        .forEach(p => p.classList.toggle('is-active', p.getAttribute('data-mnt-wo-panel') === tab));
    });
  });
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

  wrap.querySelector('#mntWoPartForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(/** @type {HTMLFormElement} */ (e.currentTarget));
    const partName = String(fd.get('part_name') || '').trim();
    const quantityRaw = String(fd.get('quantity') || '').trim();
    const selectedPart = Array.isArray(partCatalog)
      ? partCatalog.find(p => partName === `${p.part_code || ''} — ${p.name || ''}` || partName.toLowerCase() === String(p.part_code || '').toLowerCase())
      : null;
    const unit = String(fd.get('unit') || '').trim() || selectedPart?.unit || '';
    const supplier = String(fd.get('supplier') || '').trim() || selectedPart?.maint_suppliers?.name || '';
    const qty = quantityRaw ? Number(quantityRaw) : null;
    const row = await insertMaintWorkOrderPart({
      wo_id: wo.wo_id,
      part_id: selectedPart?.part_id || null,
      part_name: selectedPart?.name || partName,
      quantity: qty,
      unit: unit || null,
      unit_cost: selectedPart?.unit_cost ?? null,
      supplier: supplier || null,
    });
    if (!row) {
      showToast('⚠ Deo nije dodat');
      return;
    }
    if (selectedPart?.part_id && qty && qty > 0) {
      await insertMaintPartStockMovement({
        part_id: selectedPart.part_id,
        wo_id: wo.wo_id,
        movement_type: 'out',
        quantity: qty,
        unit_cost: selectedPart.unit_cost ?? null,
        note: `WO ${wo.wo_number || wo.wo_id}: ${selectedPart.name}`,
      });
    }
    await insertMaintWorkOrderEvent({
      wo_id: wo.wo_id,
      event_type: 'user_note',
      comment: `Dodat deo: ${selectedPart?.name || partName}`,
    });
    showToast('✅ Deo dodat');
    reloadDrawer();
  });

  wrap.querySelector('#mntWoLaborForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(/** @type {HTMLFormElement} */ (e.currentTarget));
    const minutes = Number(String(fd.get('minutes') || '').trim());
    const notes = String(fd.get('notes') || '').trim();
    const row = await insertMaintWorkOrderLabor({
      wo_id: wo.wo_id,
      minutes,
      notes: notes || null,
    });
    if (!row) {
      showToast('⚠ Sati nisu dodati');
      return;
    }
    await insertMaintWorkOrderEvent({
      wo_id: wo.wo_id,
      event_type: 'user_note',
      comment: `Dodato vreme rada: ${Math.round(minutes)} min${notes ? ` — ${notes}` : ''}`,
    });
    showToast('✅ Sati dodati');
    reloadDrawer();
  });

  wrap.querySelector('#mntWoForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const uid = getCurrentUser()?.id;
    if (!uid) return;
    const st = /** @type {HTMLSelectElement} */ (wrap.querySelector('#mntWoSt'))?.value;
    const asRaw = /** @type {HTMLSelectElement} */ (wrap.querySelector('#mntWoAs'))?.value;
    const comment = /** @type {HTMLTextAreaElement} */ (wrap.querySelector('#mntWoComment'))?.value?.trim();
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
    if (comment) {
      await insertMaintWorkOrderEvent({
        wo_id: wo.wo_id,
        event_type: 'user_note',
        comment,
      });
    }
    showToast('✅ Sačuvano');
    close();
    onSaved?.();
  });
}

export { canEditWorkOrder, woStatusLabelSr, WO_STATUS_GROUPS, ALL_WO_STATUSES };
