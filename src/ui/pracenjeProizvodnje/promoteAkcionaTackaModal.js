import { escHtml, showToast } from '../../lib/dom.js';
import { listAkcioneTackeZaProjekat } from '../../services/pracenjeProizvodnje.js';
import { promoteAkcionaTacka } from '../../state/pracenjeProizvodnjeState.js';

export function openPromoteAkcionaTackaModal({ state, onPromoted } = {}) {
  if (!state?.canEdit) { showToast('Pregled — nema promocije'); return; }
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-labelledby="promoteTitle" style="max-width:860px">
      <div class="modal-header">
        <h3 id="promoteTitle">Iz akcione tačke</h3>
        <button type="button" class="modal-close" aria-label="Zatvori">×</button>
      </div>
      <div class="modal-body" id="promoteBody">
        <div class="pp-state"><div class="pp-state-icon">...</div><div class="pp-state-title">Učitavanje akcionih tačaka…</div></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  attachClose(modal);
  loadAkcije(modal, state, onPromoted);
}

async function loadAkcije(modal, state, onPromoted) {
  const body = modal.querySelector('#promoteBody');
  try {
    const akcije = await listAkcioneTackeZaProjekat(state.header?.projekat_id);
    body.innerHTML = formHtml(state, akcije);
    wire(modal, state, akcije, onPromoted);
  } catch (e) {
    body.innerHTML = `<div class="pp-error">Greška pri učitavanju akcionih tačaka: ${escHtml(e?.message || e)}</div>`;
  }
}

function formHtml(state, akcije) {
  return `
    <div class="form-grid">
      <label style="grid-column:1 / -1">Akciona tačka
        <select id="promoteAkcija">
          <option value="">Izaberi otvorenu akcionu tačku…</option>
          ${akcije.map(a => `
            <option value="${escHtml(a.id)}">${escHtml(`#${a.rb || '-'} ${a.naslov} · ${a.odgovoranLabel || 'bez odgovornog'} · ${a.rok || 'bez roka'}${a.sastanak ? ' · ' + (a.sastanak.naziv || a.sastanak.datum || 'sastanak') : ''}`)}</option>
          `).join('')}
        </select>
      </label>
      <label>Odeljenje
        <select id="promoteDept">
          <option value="">Izaberi odeljenje…</option>
          ${(state.departments || []).map(d => `<option value="${escHtml(d.id)}">${escHtml(d.naziv || d.kod)}</option>`).join('')}
        </select>
      </label>
      <label>Planirani početak (opciono)<input type="date" id="promoteStart"></label>
    </div>
    <div class="form-card" id="promotePreview" style="margin-top:12px">Izaberi akcionu tačku za preview.</div>
    <div class="form-actions">
      <button type="button" class="btn btn-primary" id="promoteBtn">Promoviši</button>
    </div>
  `;
}

function wire(modal, state, akcije, onPromoted) {
  const select = modal.querySelector('#promoteAkcija');
  const renderPreview = () => {
    const a = akcije.find(x => x.id === select.value);
    modal.querySelector('#promotePreview').innerHTML = a ? `
      <div class="form-section-title">Preview operativne aktivnosti</div>
      <div><strong>${escHtml(a.naslov)}</strong></div>
      <div class="form-hint">${escHtml(a.opis || 'Bez opisa')}</div>
      <div class="form-hint">Rok: ${escHtml(a.rok || '—')} · Odgovoran: ${escHtml(a.odgovoranLabel || '—')} · Prioritet: ${escHtml(mapPriority(a.prioritet))}</div>
    ` : 'Izaberi akcionu tačku za preview.';
  };
  select?.addEventListener('change', renderPreview);
  modal.querySelector('#promoteBtn')?.addEventListener('click', async () => {
    const akcijaId = select?.value;
    const deptId = modal.querySelector('#promoteDept')?.value;
    if (!akcijaId) { showToast('Izaberi akcionu tačku'); return; }
    if (!deptId) { showToast('Izaberi odeljenje'); return; }
    const id = await promoteAkcionaTacka(akcijaId, deptId);
    if (id) {
      showToast('Akciona tačka promovisana');
      modal.remove();
      onPromoted?.(id);
    }
  });
}

function mapPriority(p) {
  if (Number(p) === 1) return 'visok';
  if (Number(p) === 3) return 'nizak';
  return 'srednji';
}

function attachClose(modal) {
  modal.querySelector('.modal-close')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', ev => { if (ev.target === modal) modal.remove(); });
}
