/**
 * Plan Montaže — 3D Model dialog (F5.5).
 *
 * Edituje sidecar `phaseModels[phaseId]` (perzistira u localStorage):
 *   { name, imageUrl, fileUrl, note }
 *
 * Modal je on-demand: kreira se u `document.body`, removuje na close. Prikazuje
 * preview slike (sa graceful onerror), naziv, URL slike, URL 3D fajla, beleška.
 *
 * Dugmad: Sačuvaj, Obriši 3D, Otkaži.
 *
 * Placeholder do trenutka kada backend dobije pravi 3D viewer (.glb/.stp).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  getPhaseModel,
  setPhaseModel,
  deletePhaseModel,
} from '../../state/planMontaze.js';

let _overlayEl = null;

/**
 * Otvori 3D model dialog za fazu.
 * @param {string} phaseId
 * @param {Function} [onSaved]  poziva se po Save/Delete (rerender pogona)
 */
export function openModelDialog(phaseId, onSaved) {
  if (!phaseId) return;
  closeModelDialog();
  const m = getPhaseModel(phaseId) || { name: '', imageUrl: '', fileUrl: '', note: '' };
  const dis = canEdit() ? '' : 'disabled';

  _overlayEl = document.createElement('div');
  _overlayEl.className = 'modal-overlay open';
  _overlayEl.innerHTML = `
    <div class="modal-panel" role="dialog" aria-label="3D model">
      <div class="modal-head">
        <h3>🧩 3D Model — sidecar</h3>
        <button type="button" class="modal-close" data-mdl-action="close" aria-label="Zatvori">✕</button>
      </div>
      <div class="modal-body" id="mdlBody">
        ${_previewHtml(m.imageUrl)}
        <div class="form-grid">
          <label class="form-field">
            <span>Naziv modela</span>
            <input type="text" id="mdlName" value="${escHtml(m.name)}" placeholder="npr. Presa 350t — rama" ${dis}>
          </label>
          <label class="form-field">
            <span>URL preview slike (.png/.jpg)</span>
            <input type="text" id="mdlImg" value="${escHtml(m.imageUrl)}" placeholder="https://..." ${dis}>
          </label>
          <label class="form-field">
            <span>URL 3D fajla (.glb/.stp/.pdf...)</span>
            <input type="text" id="mdlFile" value="${escHtml(m.fileUrl)}" placeholder="https://..." ${dis}>
          </label>
          <label class="form-field">
            <span>Kratka napomena</span>
            <textarea id="mdlNote" rows="3" ${dis}>${escHtml(m.note)}</textarea>
          </label>
        </div>
        <p class="form-hint">Placeholder — kada backend 3D viewer bude spreman, ova kartica će prikazivati interaktivni model. Za sada koristi URL slike kao preview.</p>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-mdl-action="close">Otkaži</button>
        <button type="button" class="btn btn-danger" id="mdlDeleteBtn" ${dis}>🗑 Obriši 3D</button>
        <button type="button" class="btn btn-primary" id="mdlSaveBtn" ${dis}>💾 Sačuvaj</button>
      </div>
    </div>
  `;
  document.body.appendChild(_overlayEl);

  /* Wire — image preview live update */
  const imgInp = _overlayEl.querySelector('#mdlImg');
  imgInp?.addEventListener('input', () => {
    const newUrl = imgInp.value.trim();
    const slot = _overlayEl.querySelector('#mdlPreviewSlot');
    if (slot) slot.outerHTML = _previewHtml(newUrl);
  });

  /* Save */
  _overlayEl.querySelector('#mdlSaveBtn')?.addEventListener('click', () => {
    if (!canEdit()) return;
    setPhaseModel(phaseId, {
      name: _overlayEl.querySelector('#mdlName')?.value || '',
      imageUrl: _overlayEl.querySelector('#mdlImg')?.value || '',
      fileUrl: _overlayEl.querySelector('#mdlFile')?.value || '',
      note: _overlayEl.querySelector('#mdlNote')?.value || '',
    });
    closeModelDialog();
    showToast('✅ 3D sačuvan');
    onSaved?.();
  });

  /* Delete */
  _overlayEl.querySelector('#mdlDeleteBtn')?.addEventListener('click', () => {
    if (!canEdit()) return;
    if (!confirm('Obriši 3D podatke za ovu fazu?')) return;
    deletePhaseModel(phaseId);
    closeModelDialog();
    showToast('🗑 3D obrisan');
    onSaved?.();
  });

  /* Close (X / Otkaži / overlay click / Esc) */
  _overlayEl.querySelectorAll('[data-mdl-action="close"]').forEach(b => {
    b.addEventListener('click', closeModelDialog);
  });
  _overlayEl.addEventListener('click', (ev) => {
    if (ev.target === _overlayEl) closeModelDialog();
  });
  document.addEventListener('keydown', _onEsc);
}

export function closeModelDialog() {
  document.removeEventListener('keydown', _onEsc);
  if (_overlayEl?.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
}

function _onEsc(ev) {
  if (ev.key === 'Escape') closeModelDialog();
}

function _previewHtml(imageUrl) {
  const safe = String(imageUrl || '').trim();
  if (!safe) {
    return '<div class="model-empty" id="mdlPreviewSlot">Nema preview slike</div>';
  }
  return `<div class="model-thumb" id="mdlPreviewSlot"><img src="${escHtml(safe)}" alt="preview" onerror="this.style.display='none';this.parentElement.innerHTML='Slika se ne može učitati';this.parentElement.classList.add('model-empty');this.parentElement.classList.remove('model-thumb');"></div>`;
}
