/**
 * Modal za kreiranje novog sastanka.
 *
 * Korak 1: izbor tipa (Sedmični vs Projektni).
 * Korak 2: forma sa osnovnim podacima (naslov, datum, vreme, mesto, projekat).
 *
 * Posle uspešnog kreiranja → onCreated(sastanak) callback (obično otvori
 * sastanakModal odmah).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { saveSastanak, SASTANAK_TIPOVI } from '../../services/sastanci.js';
import { getCurrentUser } from '../../state/auth.js';

export function openCreateSastanakModal({ projekti = [], onCreated } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'sast-modal-overlay';
  overlay.innerHTML = `
    <div class="sast-modal" id="newSastModal">
      <header class="sast-modal-header">
        <h3>+ Novi sastanak</h3>
        <button class="sast-modal-close" aria-label="Zatvori">✕</button>
      </header>
      <div class="sast-modal-body" id="newSastBody"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.sast-modal-close').addEventListener('click', close);

  /* Korak 1: izbor tipa. */
  renderStepTip(overlay.querySelector('#newSastBody'));

  function renderStepTip(host) {
    host.innerHTML = `
      <p style="margin:0 0 16px;color:var(--text2)">Izaberi tip sastanka:</p>
      <div class="sast-tip-choice">
        <button type="button" class="sast-tip-card" data-tip="sedmicni">
          <div class="sast-tip-icon">📅</div>
          <div class="sast-tip-name">Sedmični sastanak</div>
          <div class="sast-tip-desc">Standardni cross-project. PM teme, akcioni plan. Ide jednom nedeljno.</div>
        </button>
        <button type="button" class="sast-tip-card" data-tip="projektni">
          <div class="sast-tip-icon">🏗</div>
          <div class="sast-tip-name">Projektni sastanak</div>
          <div class="sast-tip-desc">Per-projekat presek stanja. Hijerarhijski opis radova + slike sa terena.</div>
        </button>
      </div>
    `;
    host.querySelectorAll('[data-tip]').forEach(b => {
      b.addEventListener('click', () => renderStepForm(host, b.dataset.tip));
    });
  }

  function renderStepForm(host, tip) {
    const cu = getCurrentUser();
    const today = new Date().toISOString().slice(0, 10);
    const defNaslov = tip === 'sedmicni'
      ? `Sedmični sastanak — ${formatDateForTitle(today)}`
      : `Presek stanja — `;

    host.innerHTML = `
      <form id="csForm" class="sast-form">
        <div class="sast-step-header">
          <span class="sast-tip-badge sast-tip-${escHtml(tip)}">${escHtml(SASTANAK_TIPOVI[tip])}</span>
          <button type="button" class="sast-link-btn" id="csBack">← promeni tip</button>
        </div>
        <label class="sast-form-row">
          <span>Naslov *</span>
          <input type="text" name="naslov" required maxlength="200" value="${escHtml(defNaslov)}">
        </label>
        ${tip === 'projektni' ? `
          <label class="sast-form-row">
            <span>Projekat *</span>
            <select name="projekatId" required>
              <option value="">— izaberi projekat —</option>
              ${projekti.map(p => `<option value="${p.id}">${escHtml(p.label)}</option>`).join('')}
            </select>
          </label>
        ` : ''}
        <div class="sast-form-grid">
          <label class="sast-form-row">
            <span>Datum *</span>
            <input type="date" name="datum" required value="${today}">
          </label>
          <label class="sast-form-row">
            <span>Vreme</span>
            <input type="time" name="vreme" value="09:00">
          </label>
          <label class="sast-form-row">
            <span>Mesto</span>
            <input type="text" name="mesto" placeholder="Dobanovci, Sala 1" value="Dobanovci">
          </label>
        </div>
        <div class="sast-form-grid">
          <label class="sast-form-row">
            <span>Vodi sastanak</span>
            <input type="text" name="vodioLabel" value="${escHtml(cu?.email || '')}">
          </label>
          <label class="sast-form-row">
            <span>Zapisničar</span>
            <input type="text" name="zapisnicarLabel" value="${escHtml(cu?.email || '')}">
          </label>
        </div>
        <label class="sast-form-row">
          <span>Napomena</span>
          <textarea name="napomena" rows="2" maxlength="500"></textarea>
        </label>
      </form>
      <footer class="sast-modal-footer" style="margin-top:16px">
        <button class="btn" type="button" id="csCancel">Otkaži</button>
        <button class="btn btn-primary" type="button" id="csSave">Kreiraj sastanak</button>
      </footer>
    `;

    host.querySelector('#csBack').addEventListener('click', () => renderStepTip(host));
    host.querySelector('#csCancel').addEventListener('click', close);
    host.querySelector('#csSave').addEventListener('click', async () => {
      const fd = new FormData(host.querySelector('#csForm'));
      const naslov = String(fd.get('naslov') || '').trim();
      const datum = String(fd.get('datum') || '');
      const projekatId = fd.get('projekatId') || null;
      if (!naslov) { showToast('⚠ Naslov je obavezan'); return; }
      if (!datum) { showToast('⚠ Datum je obavezan'); return; }
      if (tip === 'projektni' && !projekatId) { showToast('⚠ Projekat je obavezan za projektni sastanak'); return; }

      const cu = getCurrentUser();
      const payload = {
        tip,
        naslov,
        datum,
        vreme: fd.get('vreme') || null,
        mesto: String(fd.get('mesto') || '').trim(),
        projekatId,
        vodioEmail: cu?.email || null,
        vodioLabel: String(fd.get('vodioLabel') || cu?.email || '').trim() || null,
        zapisnicarEmail: cu?.email || null,
        zapisnicarLabel: String(fd.get('zapisnicarLabel') || '').trim() || null,
        napomena: String(fd.get('napomena') || '').trim(),
        status: 'planiran',
      };
      const r = await saveSastanak(payload);
      if (r) {
        showToast('+ Sastanak kreiran');
        close();
        onCreated?.(r);
      } else {
        showToast('⚠ Greška pri kreiranju');
      }
    });
  }

  function formatDateForTitle(ymd) {
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return ymd;
    return `${m[3]}.${m[2]}.${m[1]}`;
  }
}
