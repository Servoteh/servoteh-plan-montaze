/**
 * Plan Montaže — Reminder send dialog (F5.5).
 *
 * Otvori modal sa preview liste alerts za sve projekte sa
 * `reminderEnabled === true` (faza nije završena, start ≤ 7d, nije ready).
 *
 * Korisnik vidi:
 *   - listu alerts (projekat / WP / faza / datum / dani / urgency / razlozi),
 *   - dugme "📧 Pošalji" (poziva `callReminderEndpoint`).
 *
 * Ako je payload prazan — toast "Nema podsetnika" i ne otvara se modal.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import { allData } from '../../state/planMontaze.js';
import { dayDiffFromToday, formatDate } from '../../lib/date.js';
import { calcReadiness } from '../../lib/phase.js';
import { callReminderEndpoint } from '../../services/plan.js';

let _overlayEl = null;

/**
 * Sastavi payload alerts po istoj logici kao legacy `buildReminderPayload`.
 * Skenira sve projekte sa `reminderEnabled = true` i sve faze koje:
 *   - status !== 2,
 *   - start <= 7 dana,
 *   - nisu ready.
 */
export function buildReminderPayload() {
  const alerts = [];
  (allData.projects || []).forEach(proj => {
    if (!proj.reminderEnabled) return;
    (proj.workPackages || []).forEach(wp => {
      (wp.phases || []).forEach(row => {
        if (row.status === 2 || !row.start) return;
        const d = dayDiffFromToday(row.start);
        if (d === null || d < 0 || d > 7) return;
        const rd = calcReadiness(row);
        if (rd.ready) return;
        alerts.push({
          project_code: proj.code,
          project_id: proj.id,
          work_package: wp.name,
          work_package_id: wp.id,
          rn_code: wp.rnCode,
          phase: row.name,
          phase_id: row.id,
          start_date: row.start,
          days_until: d,
          urgency: d <= 3 ? 'critical' : 'warning',
          reasons: rd.reasons,
          engineer: row.engineer,
          lead: row.person,
          pm_email: proj.pmEmail,
          leadpm_email: proj.leadPmEmail,
        });
      });
    });
  });
  return alerts;
}

/** Otvori reminder dialog. Vraća true ako se modal otvara, false ako je prazan. */
export function openReminderDialog() {
  if (!canEdit()) {
    showToast('⚠ Samo PM/LeadPM šalju podsetnike');
    return false;
  }
  const alerts = buildReminderPayload();
  if (alerts.length === 0) {
    showToast('✅ Nema podsetnika');
    return false;
  }
  closeReminderDialog();
  _renderModal(alerts);
  return true;
}

export function closeReminderDialog() {
  document.removeEventListener('keydown', _onEsc);
  if (_overlayEl?.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
}

function _onEsc(ev) {
  if (ev.key === 'Escape') closeReminderDialog();
}

function _renderModal(alerts) {
  const critical = alerts.filter(a => a.urgency === 'critical').length;
  const warning = alerts.length - critical;

  _overlayEl = document.createElement('div');
  _overlayEl.className = 'modal-overlay open';
  _overlayEl.innerHTML = `
    <div class="modal-panel modal-panel-wide" role="dialog" aria-label="Slanje podsetnika">
      <div class="modal-head">
        <h3>📧 Email podsetnici</h3>
        <button type="button" class="modal-close" data-rmd-action="close" aria-label="Zatvori">✕</button>
      </div>
      <div class="modal-body">
        <p class="form-hint" style="margin-top:0">
          Pronađeno je <b>${alerts.length}</b> faza koje zahtevaju podsetnik
          (<span style="color:#ff6b6b">${critical} kritično</span>,
          <span style="color:#ffd96a">${warning} upozorenje</span>).
          Pregledaj listu i klikni "Pošalji" da pokreneš slanje.
        </p>
        <div class="reminder-list">
          ${alerts.map(a => `
            <div class="reminder-row ${a.urgency === 'critical' ? 'rr-crit' : 'rr-warn'}">
              <div class="rr-head">
                <span class="rr-icon">${a.urgency === 'critical' ? '🔴' : '🟡'}</span>
                <span class="rr-title">${escHtml(a.phase)}</span>
                <span class="rr-days">Za ${a.days_until}d</span>
              </div>
              <div class="rr-meta">
                ${escHtml(a.project_code)} / ${escHtml(a.work_package)}
                · ${escHtml(formatDate(a.start_date))}
                · Ing: ${escHtml(a.engineer || '—')}
                · Vođa: ${escHtml(a.lead || '—')}
              </div>
              ${a.reasons.length ? `<div class="rr-reasons">${a.reasons.slice(0, 3).map(r => `• ${escHtml(r)}`).join(' &nbsp; ')}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-rmd-action="close">Otkaži</button>
        <button type="button" class="btn btn-primary" id="rmdSendBtn">📧 Pošalji ${alerts.length} podsetnika</button>
      </div>
    </div>
  `;
  document.body.appendChild(_overlayEl);

  _overlayEl.querySelectorAll('[data-rmd-action="close"]').forEach(b => {
    b.addEventListener('click', closeReminderDialog);
  });
  _overlayEl.addEventListener('click', (ev) => {
    if (ev.target === _overlayEl) closeReminderDialog();
  });
  document.addEventListener('keydown', _onEsc);

  const sendBtn = _overlayEl.querySelector('#rmdSendBtn');
  sendBtn?.addEventListener('click', async () => {
    sendBtn.disabled = true;
    sendBtn.textContent = '⏳ Šaljem...';
    try {
      const r = await callReminderEndpoint(() => alerts);
      if (r?.ok) {
        if (r.empty) showToast('✅ Nema podsetnika');
        else if (r.offline) showToast('📧 ' + r.sent + ' podsetnika (offline log)');
        else showToast('📧 Poslato: ' + (r.sent || 0));
        closeReminderDialog();
      } else {
        showToast('❌ Greška: ' + (r?.reason || 'unknown'));
        sendBtn.disabled = false;
        sendBtn.textContent = '📧 Pošalji ' + alerts.length + ' podsetnika';
      }
    } catch (e) {
      showToast('❌ ' + String(e?.message || e));
      sendBtn.disabled = false;
      sendBtn.textContent = '📧 Pošalji ' + alerts.length + ' podsetnika';
    }
  });
}
