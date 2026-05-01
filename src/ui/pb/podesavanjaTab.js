/**
 * Podešavanja PB — samo admin (notifikacije).
 */

import { escHtml } from '../../lib/dom.js';
import { getPbNotifConfig, updatePbNotifConfig } from '../../services/pb.js';
import { pbErrorMessage, showPbToast } from './shared.js';

function parseEmails(s) {
  return String(s || '')
    .split(/[,;\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

/**
 * @param {HTMLElement} root
 * @param {{ onSaved?: () => void }} ctx
 */
export async function renderPbPodesavanja(root, ctx) {
  let cfg;
  try {
    cfg = await getPbNotifConfig();
  } catch (err) {
    root.innerHTML = `<p class="pb-muted">${escHtml(err?.message || 'Greška pri učitavanju')}</p>`;
    return;
  }
  if (!cfg) {
    root.innerHTML = '<p class="pb-muted">Konfiguracija nije dostupna.</p>';
    return;
  }

  function paint() {
    const emails = Array.isArray(cfg.email_recipients) ? cfg.email_recipients : [];
    root.innerHTML = `
      <section class="pb-settings">
        <h3 class="pb-section-title">Email notifikacije (Projektni biro)</h3>
        <div class="pb-settings-grid">
          <label class="pb-check"><input type="checkbox" id="pbCfgEn" ${cfg.enabled ? 'checked' : ''} /> Notifikacije uključene</label>
          <label class="pb-field"><span>Upozorenje pred rok (dana)</span>
            <input type="number" id="pbCfgDw" min="1" max="30" value="${Number(cfg.deadline_warning_days) || 3}" />
          </label>
          <label class="pb-field"><span>Prag preopterećenosti (%)</span>
            <input type="number" id="pbCfgOl" min="50" max="200" value="${Number(cfg.overload_threshold_pct) || 100}" />
          </label>
          <label class="pb-field pb-settings-span2"><span>Email primaoci (zarez ili novi red)</span>
            <textarea id="pbCfgEm" rows="3" class="pb-textarea-lg">${escHtml(emails.join(', '))}</textarea>
          </label>
          <label class="pb-check"><input type="checkbox" id="pbCfgNb" ${cfg.notify_on_blocked ? 'checked' : ''} /> Blokirani zadaci</label>
          <label class="pb-check"><input type="checkbox" id="pbCfgNo" ${cfg.notify_on_overload ? 'checked' : ''} /> Preopterećenost</label>
          <label class="pb-check"><input type="checkbox" id="pbCfgNw" ${cfg.notify_on_deadline_warning ? 'checked' : ''} /> Rok uskoro</label>
          <label class="pb-check"><input type="checkbox" id="pbCfgNd" ${cfg.notify_on_deadline_overdue ? 'checked' : ''} /> Kašnjenje roka</label>
          <label class="pb-check"><input type="checkbox" id="pbCfgNe" ${cfg.notify_on_no_engineer ? 'checked' : ''} /> Bez inženjera (uskoro početak)</label>
        </div>
        <div class="pb-modal-actions">
          <button type="button" class="btn btn-primary" id="pbCfgSave">Sačuvaj</button>
        </div>
      </section>`;

    root.querySelector('#pbCfgSave')?.addEventListener('click', async () => {
      const payload = {
        enabled: root.querySelector('#pbCfgEn')?.checked ?? false,
        deadline_warning_days: Number(root.querySelector('#pbCfgDw')?.value) || 3,
        overload_threshold_pct: Number(root.querySelector('#pbCfgOl')?.value) || 100,
        email_recipients: parseEmails(root.querySelector('#pbCfgEm')?.value),
        notify_on_blocked: root.querySelector('#pbCfgNb')?.checked ?? false,
        notify_on_overload: root.querySelector('#pbCfgNo')?.checked ?? false,
        notify_on_deadline_warning: root.querySelector('#pbCfgNw')?.checked ?? false,
        notify_on_deadline_overdue: root.querySelector('#pbCfgNd')?.checked ?? false,
        notify_on_no_engineer: root.querySelector('#pbCfgNe')?.checked ?? false,
      };
      try {
        const row = await updatePbNotifConfig(payload);
        if (row) Object.assign(cfg, row);
        showPbToast('Sačuvano', 'success');
        ctx.onSaved?.();
      } catch (err) {
        showPbToast(pbErrorMessage(err), 'error');
      }
    });
  }

  paint();
}
