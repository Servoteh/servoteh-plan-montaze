/**
 * Akcioni plan tab — lista svih otvorenih akcija sa filterima.
 *
 * Sekcije:
 *   - Toolbar (filteri: status, projekat, samo-otvorene) + dugme "+ Nova akcija"
 *   - Tabela akcija sa inline akcijama (status promena, izmeni, obriši)
 *
 * Pošto akcije obično dolaze sa sastanka, "Nova akcija" iz ovog taba je za
 * ad-hoc unose (bez vezivanja za sastanak).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadAkcije, saveAkcija, deleteAkcija, updateAkcijaStatus,
  AKCIJA_STATUSI, AKCIJA_STATUS_BOJE,
} from '../../services/akcioniPlan.js';
import { loadProjektiLite } from '../../services/projekti.js';

let abortFlag = false;
let cachedRows = [];
let cachedProjekti = [];
let filters = { status: '', projekatId: '', openOnly: true };

export async function renderAkcioniPlanTab(host, { canEdit }) {
  abortFlag = false;
  cachedProjekti = await loadProjektiLite();

  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-toolbar">
        <div class="sast-filters">
          <select id="apFiltStatus" class="sast-input">
            <option value="">Svi statusi (svi)</option>
            ${Object.entries(AKCIJA_STATUSI).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}
          </select>
          <select id="apFiltProjekat" class="sast-input">
            <option value="">Svi projekti</option>
            ${cachedProjekti.map(p => `<option value="${p.id}">${escHtml(p.label)}</option>`).join('')}
          </select>
          <label class="sast-checkbox">
            <input type="checkbox" id="apFiltOpenOnly" ${filters.openOnly ? 'checked' : ''}>
            <span>Samo otvorene</span>
          </label>
        </div>
        <div class="sast-toolbar-actions">
          ${canEdit ? '<button class="btn btn-primary" id="newAkcijaBtn">+ Nova akcija</button>' : ''}
        </div>
      </div>
      <div id="apBody" class="sast-table-wrap"></div>
    </div>
  `;

  if (canEdit) {
    host.querySelector('#newAkcijaBtn')?.addEventListener('click', () => {
      openAkcijaModal(host, { canEdit, mode: 'create' });
    });
  }

  host.querySelector('#apFiltStatus').value = filters.status;
  host.querySelector('#apFiltProjekat').value = filters.projekatId;
  host.querySelector('#apFiltStatus').addEventListener('change', (e) => {
    filters.status = e.target.value; renderAkcije(host, { canEdit });
  });
  host.querySelector('#apFiltProjekat').addEventListener('change', (e) => {
    filters.projekatId = e.target.value; renderAkcije(host, { canEdit });
  });
  host.querySelector('#apFiltOpenOnly').addEventListener('change', (e) => {
    filters.openOnly = e.target.checked; renderAkcije(host, { canEdit });
  });

  await renderAkcije(host, { canEdit });
}

export function teardownAkcioniPlanTab() {
  abortFlag = true;
}

async function renderAkcije(host, { canEdit }) {
  const body = host.querySelector('#apBody');
  body.innerHTML = '<div class="sast-loading">Učitavam akcije…</div>';

  cachedRows = await loadAkcije({
    effectiveStatus: filters.status || null,
    projekatId: filters.projekatId || null,
    openOnly: filters.openOnly && !filters.status ? true : false,
    limit: 1000,
  });

  if (abortFlag) return;

  if (!cachedRows.length) {
    body.innerHTML = '<div class="sast-empty">Nema akcija sa zadatim filterima.</div>';
    return;
  }

  /* Group by effective_status za vizualnu hijerarhiju. */
  const groups = {
    kasni: cachedRows.filter(a => a.effectiveStatus === 'kasni'),
    u_toku: cachedRows.filter(a => a.effectiveStatus === 'u_toku'),
    otvoren: cachedRows.filter(a => a.effectiveStatus === 'otvoren'),
    zavrsen: cachedRows.filter(a => a.effectiveStatus === 'zavrsen'),
    odlozen: cachedRows.filter(a => a.effectiveStatus === 'odlozen'),
    otkazan: cachedRows.filter(a => a.effectiveStatus === 'otkazan'),
  };

  body.innerHTML = `
    <table class="sast-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Naslov</th>
          <th>Odgovoran</th>
          <th>Rok</th>
          <th>Projekat</th>
          <th class="sast-th-actions">Akcije</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(groups).flatMap(([status, rows]) =>
          rows.length ? rows.map(a => renderAkcijaRow(a, canEdit)) : [],
        ).join('')}
      </tbody>
    </table>
  `;

  body.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const akc = cachedRows.find(a => a.id === id);
      if (!akc) return;
      handleAkcijaAction(host, action, akc, { canEdit });
    });
  });
}

function renderAkcijaRow(a, canEdit) {
  const eff = a.effectiveStatus || a.status;
  const color = AKCIJA_STATUS_BOJE[eff] || '#666';
  const projekat = cachedProjekti.find(p => p.id === a.projekatId);
  const projLabel = projekat ? escHtml(projekat.code || projekat.name) : '';
  const rokDispl = a.rokText || (a.rok ? formatDate(a.rok) : '—');
  const rokExtra = a.danaDoRoka != null && eff === 'kasni' ? ` <span style="color:#ef4444">(kasni ${Math.abs(a.danaDoRoka)}d)</span>` : '';
  const actions = [];
  if (canEdit) {
    if (eff !== 'zavrsen') {
      actions.push(`<button class="btn-icon btn-success" data-action="complete" data-id="${a.id}" title="Završi">✓</button>`);
    }
    if (eff !== 'u_toku' && eff !== 'zavrsen') {
      actions.push(`<button class="btn-icon btn-primary" data-action="start" data-id="${a.id}" title="U toku">▶</button>`);
    }
    actions.push(`<button class="btn-icon" data-action="edit" data-id="${a.id}" title="Izmeni">✎</button>`);
    actions.push(`<button class="btn-icon btn-danger" data-action="delete" data-id="${a.id}" title="Obriši">🗑</button>`);
  }
  return `
    <tr class="${eff === 'kasni' ? 'sast-row-late' : ''}">
      <td><span class="sast-status-pill" style="background:${color}">${escHtml(AKCIJA_STATUSI[eff] || eff)}</span></td>
      <td>
        <div><strong>${escHtml(a.naslov)}</strong></div>
        ${a.opis ? `<div class="sast-row-sub">${escHtml(a.opis.slice(0, 200))}${a.opis.length > 200 ? '…' : ''}</div>` : ''}
      </td>
      <td>${escHtml(a.odgovoranLabel || a.odgovoranText || a.odgovoranEmail || '—')}</td>
      <td>${escHtml(rokDispl)}${rokExtra}</td>
      <td>${projLabel}</td>
      <td class="sast-td-actions">${actions.join(' ')}</td>
    </tr>
  `;
}

async function handleAkcijaAction(host, action, akc, { canEdit }) {
  if (action === 'complete') {
    const napomena = prompt('Napomena pri zatvaranju (opciono):', '');
    if (napomena === null) return;
    const r = await updateAkcijaStatus(akc.id, 'zavrsen', napomena);
    if (r) { showToast('✓ Akcija završena'); await renderAkcije(host, { canEdit }); }
    return;
  }
  if (action === 'start') {
    const r = await updateAkcijaStatus(akc.id, 'u_toku');
    if (r) { showToast('▶ Akcija u toku'); await renderAkcije(host, { canEdit }); }
    return;
  }
  if (action === 'edit') {
    openAkcijaModal(host, { canEdit, mode: 'edit', akcija: akc });
    return;
  }
  if (action === 'delete') {
    if (!confirm(`Obriši akciju "${akc.naslov}"?`)) return;
    const ok = await deleteAkcija(akc.id);
    if (ok) { showToast('🗑 Akcija obrisana'); await renderAkcije(host, { canEdit }); }
    return;
  }
}

function openAkcijaModal(host, { canEdit, mode = 'create', akcija = null }) {
  const isEdit = mode === 'edit' && akcija;
  const overlay = document.createElement('div');
  overlay.className = 'sast-modal-overlay';
  overlay.innerHTML = `
    <div class="sast-modal">
      <header class="sast-modal-header">
        <h3>${isEdit ? '✎ Izmeni akciju' : '+ Nova akcija'}</h3>
        <button class="sast-modal-close" aria-label="Zatvori">✕</button>
      </header>
      <div class="sast-modal-body">
        <form id="apForm" class="sast-form">
          <label class="sast-form-row">
            <span>Naslov *</span>
            <input type="text" name="naslov" required maxlength="200" value="${escHtml(akcija?.naslov || '')}">
          </label>
          <label class="sast-form-row">
            <span>Opis</span>
            <textarea name="opis" rows="3" maxlength="2000">${escHtml(akcija?.opis || '')}</textarea>
          </label>
          <div class="sast-form-grid">
            <label class="sast-form-row">
              <span>Odgovoran (email)</span>
              <input type="text" name="odgovoranEmail" value="${escHtml(akcija?.odgovoranEmail || '')}" placeholder="ime@servoteh.com">
            </label>
            <label class="sast-form-row">
              <span>Odgovoran (slobodno)</span>
              <input type="text" name="odgovoranText" value="${escHtml(akcija?.odgovoranText || '')}" placeholder="M. Stojadinović + V. Petrović">
            </label>
          </div>
          <div class="sast-form-grid">
            <label class="sast-form-row">
              <span>Rok (datum)</span>
              <input type="date" name="rok" value="${escHtml(akcija?.rok || '')}">
            </label>
            <label class="sast-form-row">
              <span>Rok (slobodno)</span>
              <input type="text" name="rokText" value="${escHtml(akcija?.rokText || '')}" placeholder="kraj aprila, po dogovoru">
            </label>
            <label class="sast-form-row">
              <span>Prioritet</span>
              <select name="prioritet">
                <option value="1"${akcija?.prioritet === 1 ? ' selected' : ''}>🔴 Visok</option>
                <option value="2"${(!akcija || akcija.prioritet === 2) ? ' selected' : ''}>🟡 Srednji</option>
                <option value="3"${akcija?.prioritet === 3 ? ' selected' : ''}>🟢 Nizak</option>
              </select>
            </label>
            <label class="sast-form-row">
              <span>Status</span>
              <select name="status">
                ${Object.entries(AKCIJA_STATUSI).filter(([k]) => k !== 'kasni').map(([k, v]) => `<option value="${k}"${(akcija?.status === k || (!akcija && k === 'otvoren')) ? ' selected' : ''}>${escHtml(v)}</option>`).join('')}
              </select>
            </label>
          </div>
          <label class="sast-form-row">
            <span>Projekat</span>
            <select name="projekatId">
              <option value="">— bez projekta —</option>
              ${cachedProjekti.map(p => `<option value="${p.id}"${akcija?.projekatId === p.id ? ' selected' : ''}>${escHtml(p.label)}</option>`).join('')}
            </select>
          </label>
        </form>
      </div>
      <footer class="sast-modal-footer">
        <button class="btn" data-action="cancel">Otkaži</button>
        <button class="btn btn-primary" data-action="save">${isEdit ? 'Sačuvaj izmene' : 'Kreiraj akciju'}</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.sast-modal-close').addEventListener('click', close);
  overlay.querySelector('[data-action=cancel]').addEventListener('click', close);
  overlay.querySelector('[data-action=save]').addEventListener('click', async () => {
    const form = overlay.querySelector('#apForm');
    const fd = new FormData(form);
    const naslov = String(fd.get('naslov') || '').trim();
    if (!naslov) { showToast('⚠ Naslov je obavezan'); return; }

    const payload = {
      ...(isEdit ? akcija : {}),
      naslov,
      opis: fd.get('opis'),
      odgovoranEmail: fd.get('odgovoranEmail'),
      odgovoranText: fd.get('odgovoranText'),
      rok: fd.get('rok') || null,
      rokText: fd.get('rokText'),
      prioritet: Number(fd.get('prioritet')) || 2,
      status: fd.get('status') || 'otvoren',
      projekatId: fd.get('projekatId') || null,
    };
    const r = await saveAkcija(payload);
    if (r) {
      showToast(isEdit ? '✎ Akcija izmenjena' : '+ Akcija kreirana');
      close();
      await renderAkcije(host, { canEdit });
    } else {
      showToast('⚠ Greška pri snimanju');
    }
  });
}
