/**
 * Modal: detalj incidenta — status, dodela, kratka istorija događaja.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { getCurrentUser, isAdminOrMenadzment } from '../../state/auth.js';
import {
  fetchIncidentById,
  fetchIncidentEvents,
  fetchAssignableMaintUsers,
  patchMaintIncident,
  insertMaintIncidentEvent,
} from '../../services/maintenance.js';
import { buildMaintenanceMachinePath } from '../../lib/appPaths.js';

const STATUSES = [
  'open',
  'acknowledged',
  'in_progress',
  'awaiting_parts',
  'resolved',
  'closed',
];

function canEditIncidentFields(maintProf) {
  const erp = isAdminOrMenadzment();
  const r = maintProf?.role;
  return erp || ['technician', 'chief', 'admin'].includes(r);
}

function canCloseIncident(maintProf) {
  const erp = isAdminOrMenadzment();
  const r = maintProf?.role;
  return erp || r === 'chief' || r === 'admin';
}

function statusLabel(s) {
  const m = {
    open: 'Otvoren',
    acknowledged: 'Priznat',
    in_progress: 'U radu',
    awaiting_parts: 'Čeka delove',
    resolved: 'Rešen',
    closed: 'Zatvoren',
  };
  return m[s] || s;
}

function woStatusLabelForIncident(s) {
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

function eventTypeLabel(t) {
  const m = {
    status_change: 'Promena statusa',
    assigned: 'Dodela',
    user_note: 'Napomena',
    created: 'Kreiran',
  };
  return m[t] || t;
}

/**
 * @param {{ incidentId: string, machineCode: string, maintProf: object|null, onSaved?: () => void, onNavigateToPath?: (p: string) => void }} opts
 */
export async function openIncidentDetailModal(opts) {
  const { incidentId, machineCode, maintProf, onSaved, onNavigateToPath } = opts;
  document.getElementById('mntIncDlg')?.remove();

  const [inc, events, assignList] = await Promise.all([
    fetchIncidentById(incidentId),
    fetchIncidentEvents(incidentId),
    fetchAssignableMaintUsers(),
  ]);

  if (!inc) {
    showToast('⚠ Incident nije učitan');
    return;
  }

  const rawWo = inc.maint_work_orders;
  const woRef = Array.isArray(rawWo) ? rawWo[0] : rawWo;

  const canEdit = canEditIncidentFields(maintProf);
  const canClose = canCloseIncident(maintProf);

  const statusOpts = STATUSES.filter(st => {
    if (st === 'closed' && !canClose) return false;
    return true;
  })
    .map(
      st =>
        `<option value="${escHtml(st)}"${String(inc.status) === st ? ' selected' : ''}>${escHtml(statusLabel(st))}</option>`,
    )
    .join('');

  const assignOpts =
    '<option value="">— nije dodeljen —</option>' +
    (Array.isArray(assignList)
      ? assignList
          .map(
            u =>
              `<option value="${escHtml(String(u.user_id))}"${String(inc.assigned_to || '') === String(u.user_id) ? ' selected' : ''}>${escHtml(u.full_name || '')} (${escHtml(u.maint_role || '')})</option>`,
          )
          .join('')
      : '');

  const assignRead =
    (Array.isArray(assignList) &&
      assignList.find(u => String(u.user_id) === String(inc.assigned_to || ''))) ||
    null;
  const assignReadLabel = assignRead
    ? `${assignRead.full_name || ''} (${assignRead.maint_role || ''})`.trim()
    : inc.assigned_to
      ? String(inc.assigned_to).slice(0, 8) + '…'
      : '—';

  const assignRpcHint =
    assignList === null
      ? `<p class="mnt-muted" style="font-size:12px">Padajuća lista zahteva RPC <code>maint_assignable_users</code> (vidi <code>sql/migrations/add_maint_assignable_users_rpc.sql</code>).</p>`
      : '';

  const timeline = (Array.isArray(events) ? events : [])
    .map(ev => {
      const typeKey = String(ev.event_type || '');
      const typeShown = eventTypeLabel(typeKey);
      const hasEnds = ev.from_value != null && ev.from_value !== '' || ev.to_value != null && ev.to_value !== '';
      const ends = hasEnds
        ? ` <span class="mnt-muted">${escHtml([ev.from_value, ev.to_value].filter(v => v != null && v !== '').join(' → '))}</span>`
        : '';
      const com = ev.comment ? `<div>${escHtml(ev.comment)}</div>` : '';
      return `<li><span class="mnt-muted">${escHtml((ev.at || '').replace('T', ' ').slice(0, 19))}</span> · ${escHtml(typeShown)}${ends}${com}</li>`;
    })
    .join('');

  const wrap = document.createElement('div');
  wrap.id = 'mntIncDlg';
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:520px">
      <div class="kadr-modal-title">Incident</div>
      <div class="kadr-modal-subtitle"><code>${escHtml(machineCode)}</code> · <a href="#" id="mntIncDlgLink" style="color:var(--accent)">Otvori mašinu</a></div>
      <div class="kadr-modal-err" id="mntIncDlgErr"></div>
      <p><strong>${escHtml(inc.title || '')}</strong></p>
      <p class="mnt-muted" style="font-size:14px">${escHtml(inc.description || '—')}</p>
      <p>Ozbiljnost: <span class="mnt-muted">${escHtml(String(inc.severity || ''))}</span></p>
      ${
        woRef
          ? `<p>Radni nalog: <button type="button" class="mnt-linkish" id="mntIncDlgOpenWo" style="padding:0;border:0;background:transparent;font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer">${escHtml(woRef.wo_number || String(woRef.wo_id).slice(0, 8) || 'RN')}</button>
        <span class="mnt-muted">· ${escHtml(woStatusLabelForIncident(String(woRef.status || '')))}</span></p>`
          : inc.work_order_id
            ? `<p class="mnt-muted">Radni nalog: <code>${escHtml(String(inc.work_order_id))}</code></p>`
            : ''
      }
      ${
        canEdit
          ? `<form id="mntIncDlgForm">
        ${assignRpcHint}
        <label class="form-label">Status</label>
        <select class="form-input" id="mntIncDlgStatus" name="status">${statusOpts}</select>
        <label class="form-label">Dodeljeno</label>
        <select class="form-input" id="mntIncDlgAssign" name="assigned_to">${assignOpts}</select>
        <label class="form-label">Napomena pri promeni (opciono)</label>
        <textarea class="form-input" id="mntIncDlgComment" rows="2" placeholder="Kratko obrazloženje za istoriju"></textarea>
        <div class="kadr-modal-actions" style="margin-top:16px">
          <button type="button" class="btn" id="mntIncDlgCancel" style="background:var(--surface3)">Zatvori</button>
          <button type="submit" class="btn" id="mntIncDlgSave">Sačuvaj</button>
        </div>
      </form>`
          : `<p><strong>Status:</strong> ${escHtml(statusLabel(inc.status))}</p>
        <p><strong>Dodeljeno:</strong> ${escHtml(assignReadLabel)}</p>
        <p class="mnt-muted">Menjanje statusa i dodele: profil <em>tehničar</em>, <em>šef</em> ili <em>admin</em> u održavanju (ili ERP admin).</p>
        <div class="kadr-modal-actions"><button type="button" class="btn" id="mntIncDlgCancel">Zatvori</button></div>`
      }
      <h3 style="font-size:14px;margin-top:20px">Istorija</h3>
      <ul class="mnt-list">${timeline || '<li class="mnt-muted">Nema događaja.</li>'}</ul>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.remove();
  wrap.addEventListener('click', e => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#mntIncDlgCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntIncDlgLink')?.addEventListener('click', e => {
    e.preventDefault();
    window.location.href = buildMaintenanceMachinePath(machineCode, 'incidenti');
    close();
  });

  wrap.querySelector('#mntIncDlgOpenWo')?.addEventListener('click', async e => {
    e.preventDefault();
    if (!woRef?.wo_id) return;
    const m = await import('./maintWorkOrdersPanel.js');
    close();
    await m.openMaintWorkOrderDetailModal({
      woId: String(woRef.wo_id),
      maintProf,
      onNavigateToPath,
      onSaved: () => onSaved?.(),
    });
  });

  wrap.querySelector('#mntIncDlgForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = wrap.querySelector('#mntIncDlgErr');
    if (errEl) errEl.textContent = '';
    const uid = getCurrentUser()?.id;
    if (!uid) return;

    const newStatus = wrap.querySelector('#mntIncDlgStatus')?.value;
    const assignRaw = wrap.querySelector('#mntIncDlgAssign')?.value;
    const assigned_to = assignRaw && assignRaw.length > 10 ? assignRaw : null;
    const comment = wrap.querySelector('#mntIncDlgComment')?.value?.trim() || null;

    const oldStatus = inc.status;

    const patch = {
      status: newStatus,
      assigned_to,
      updated_by: uid,
    };
    const OPEN_STATES = ['open', 'acknowledged', 'in_progress', 'awaiting_parts'];
    if (newStatus === 'resolved' && oldStatus !== 'resolved') {
      patch.resolved_at = new Date().toISOString();
    }
    if (newStatus === 'closed' && oldStatus !== 'closed') {
      patch.closed_at = new Date().toISOString();
    }
    /* Reopen: vraćanje u otvorena stanja poništava markere (da naredno rešenje/zatvaranje imaju tačan timestamp). */
    if (OPEN_STATES.includes(newStatus)) {
      if (inc.resolved_at) patch.resolved_at = null;
      if (inc.closed_at) patch.closed_at = null;
    }

    const btn = wrap.querySelector('#mntIncDlgSave');
    if (btn) btn.disabled = true;
    const ok = await patchMaintIncident(incidentId, patch);
    if (btn) btn.disabled = false;
    if (!ok) {
      if (errEl) errEl.textContent = 'Ažuriranje nije uspelo (RLS ili nevalidan prelaz).';
      showToast('⚠ Greška');
      return;
    }
    /* status_change / assigned — baza (trigger maint_incidents_audit); ovde samo slobodna napomena */
    if (comment) {
      await insertMaintIncidentEvent({
        incident_id: incidentId,
        event_type: 'user_note',
        from_value: null,
        to_value: null,
        comment,
      });
    }
    showToast('✅ Sačuvano');
    close();
    onSaved?.();
  });
}
