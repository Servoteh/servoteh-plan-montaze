/**
 * PM Teme tab — predlog → odobravanje → dodela sastanku.
 *
 * Sekcije:
 *   - Toolbar (filteri: status, oblast, vrsta) + dugme "+ Nova tema"
 *   - Tabela tema sa inline akcijama (Odobri / Odbij / Dodeli sastanku / Izmeni / Obriši)
 *
 * Kreiranje/izmena teme je u modal-u (themeModal).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadPmTeme, saveTema, deleteTema, dodeliTemuSastanku, odbijTemu,
  TEMA_VRSTE, TEMA_OBLASTI, TEMA_STATUSI, TEMA_STATUS_BOJE, PRIORITETI,
} from '../../services/pmTeme.js';
import { loadSastanci } from '../../services/sastanci.js';
import { loadProjektiLite } from '../../services/projekti.js';
import { getCurrentUser } from '../../state/auth.js';

let abortFlag = false;
let cachedTeme = [];
let cachedProjekti = [];
let filters = { status: '', oblast: '', vrsta: '' };

export async function renderPmTemeTab(host, { canEdit }) {
  abortFlag = false;
  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-toolbar">
        <div class="sast-filters">
          <select id="filtStatus" class="sast-input">
            <option value="">Svi statusi</option>
            ${Object.entries(TEMA_STATUSI).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}
          </select>
          <select id="filtOblast" class="sast-input">
            <option value="">Sve oblasti</option>
            ${Object.entries(TEMA_OBLASTI).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}
          </select>
          <select id="filtVrsta" class="sast-input">
            <option value="">Sve vrste</option>
            ${Object.entries(TEMA_VRSTE).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}
          </select>
        </div>
        <div class="sast-toolbar-actions">
          ${canEdit ? '<button class="btn btn-primary" id="newTemaBtn">+ Nova tema</button>' : ''}
        </div>
      </div>

      <div id="temeBody" class="sast-table-wrap"></div>
    </div>
  `;

  if (canEdit) {
    host.querySelector('#newTemaBtn')?.addEventListener('click', () => {
      openTemaModal(host, { canEdit, mode: 'create' });
    });
  }

  ['filtStatus', 'filtOblast', 'filtVrsta'].forEach(id => {
    const el = host.querySelector('#' + id);
    el?.addEventListener('change', () => {
      filters[id.replace('filt', '').toLowerCase()] = el.value;
      renderTeme(host, { canEdit });
    });
  });
  /* Restore selektovanih filtera. */
  if (filters.status) host.querySelector('#filtStatus').value = filters.status;
  if (filters.oblast) host.querySelector('#filtOblast').value = filters.oblast;
  if (filters.vrsta) host.querySelector('#filtVrsta').value = filters.vrsta;

  /* Pre-load projekti za modal select. */
  cachedProjekti = await loadProjektiLite();

  await renderTeme(host, { canEdit });
}

export function teardownPmTemeTab() {
  abortFlag = true;
}

async function renderTeme(host, { canEdit }) {
  const body = host.querySelector('#temeBody');
  body.innerHTML = '<div class="sast-loading">Učitavam teme…</div>';

  cachedTeme = await loadPmTeme({
    status: filters.status || null,
    limit: 500,
  });

  if (abortFlag) return;

  /* Client-side filteri za oblast/vrsta. */
  let rows = cachedTeme;
  if (filters.oblast) rows = rows.filter(t => t.oblast === filters.oblast);
  if (filters.vrsta) rows = rows.filter(t => t.vrsta === filters.vrsta);

  if (!rows.length) {
    body.innerHTML = '<div class="sast-empty">Nema tema sa zadatim filterima.</div>';
    return;
  }

  body.innerHTML = `
    <table class="sast-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Naslov</th>
          <th>Vrsta / Oblast</th>
          <th>Predložio</th>
          <th>Pri.</th>
          <th>Datum</th>
          <th class="sast-th-actions">Akcije</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(t => renderTemaRow(t, canEdit)).join('')}
      </tbody>
    </table>
  `;

  body.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const tema = cachedTeme.find(t => t.id === id);
      if (!tema) return;
      handleTemaAction(host, action, tema, { canEdit });
    });
  });
}

function renderTemaRow(t, canEdit) {
  const color = TEMA_STATUS_BOJE[t.status] || '#666';
  const priIcon = t.prioritet === 1 ? '🔴' : (t.prioritet === 2 ? '🟡' : '🟢');
  const actions = [];
  if (canEdit && t.status === 'predlog') {
    actions.push(`<button class="btn-icon btn-success" data-action="approve" data-id="${t.id}" title="Odobri (postaje 'usvojeno')">✓</button>`);
    actions.push(`<button class="btn-icon btn-danger" data-action="reject" data-id="${t.id}" title="Odbij">✕</button>`);
  }
  if (canEdit && t.status === 'usvojeno' && !t.sastanakId) {
    actions.push(`<button class="btn-icon btn-primary" data-action="assign" data-id="${t.id}" title="Dodeli sastanku">📅</button>`);
  }
  if (canEdit) {
    actions.push(`<button class="btn-icon" data-action="edit" data-id="${t.id}" title="Izmeni">✎</button>`);
    actions.push(`<button class="btn-icon btn-danger" data-action="delete" data-id="${t.id}" title="Obriši">🗑</button>`);
  }
  return `
    <tr>
      <td><span class="sast-status-pill" style="background:${color}">${escHtml(TEMA_STATUSI[t.status] || t.status)}</span></td>
      <td>
        <div><strong>${escHtml(t.naslov)}</strong></div>
        ${t.opis ? `<div class="sast-row-sub">${escHtml(t.opis.slice(0, 150))}${t.opis.length > 150 ? '…' : ''}</div>` : ''}
      </td>
      <td>${escHtml(TEMA_VRSTE[t.vrsta] || t.vrsta)} <br><small>${escHtml(TEMA_OBLASTI[t.oblast] || t.oblast)}</small></td>
      <td>${escHtml(t.predlozioLabel || t.predlozioEmail)}</td>
      <td title="${PRIORITETI[t.prioritet]}">${priIcon}</td>
      <td>${escHtml(formatDate(t.predlozioAt))}</td>
      <td class="sast-td-actions">${actions.join(' ')}</td>
    </tr>
  `;
}

async function handleTemaAction(host, action, tema, { canEdit }) {
  if (action === 'edit') {
    openTemaModal(host, { canEdit, mode: 'edit', tema });
    return;
  }
  if (action === 'delete') {
    if (!confirm(`Obriši temu "${tema.naslov}"?`)) return;
    const ok = await deleteTema(tema.id);
    if (ok) { showToast('🗑 Tema obrisana'); await renderTeme(host, { canEdit }); }
    else showToast('⚠ Greška pri brisanju');
    return;
  }
  if (action === 'reject') {
    const napomena = prompt('Razlog odbijanja (opciono):', '');
    if (napomena === null) return;
    const r = await odbijTemu(tema.id, napomena);
    if (r) { showToast('✕ Tema odbijena'); await renderTeme(host, { canEdit }); }
    return;
  }
  if (action === 'approve') {
    const r = await saveTema({ ...tema, status: 'usvojeno' });
    if (r) { showToast('✓ Tema usvojena'); await renderTeme(host, { canEdit }); }
    return;
  }
  if (action === 'assign') {
    /* Otvori mini dialog sa listom planiranih sedmičnih sastanaka. */
    const sastanci = await loadSastanci({
      tip: 'sedmicni', status: 'planiran',
      fromDate: new Date().toISOString().slice(0, 10),
      limit: 20,
    });
    if (!sastanci.length) {
      showToast('ℹ Nema planiranih sedmičnih sastanaka. Kreiraj jedan u "Sastanci" tabu.');
      return;
    }
    const choices = sastanci.map((s, i) => `${i + 1}. ${formatDate(s.datum)} - ${s.naslov}`).join('\n');
    const sel = prompt(`Izaberi sastanak (1-${sastanci.length}):\n${choices}`);
    const idx = Number(sel) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= sastanci.length) return;
    const r = await dodeliTemuSastanku(tema.id, sastanci[idx].id);
    if (r) { showToast('📅 Tema dodeljena sastanku'); await renderTeme(host, { canEdit }); }
  }
}

/* ── Tema modal (kreiranje / izmena) ── */

function openTemaModal(host, { canEdit, mode = 'create', tema = null }) {
  const isEdit = mode === 'edit' && tema;
  const cu = getCurrentUser();
  const overlay = document.createElement('div');
  overlay.className = 'sast-modal-overlay';
  overlay.innerHTML = `
    <div class="sast-modal">
      <header class="sast-modal-header">
        <h3>${isEdit ? '✎ Izmeni temu' : '+ Nova tema'}</h3>
        <button class="sast-modal-close" aria-label="Zatvori">✕</button>
      </header>
      <div class="sast-modal-body">
        <form id="temaForm" class="sast-form">
          <label class="sast-form-row">
            <span>Naslov *</span>
            <input type="text" name="naslov" required maxlength="200" value="${escHtml(tema?.naslov || '')}">
          </label>
          <div class="sast-form-grid">
            <label class="sast-form-row">
              <span>Vrsta</span>
              <select name="vrsta">
                ${Object.entries(TEMA_VRSTE).map(([k, v]) => `<option value="${k}"${tema?.vrsta === k ? ' selected' : ''}>${escHtml(v)}</option>`).join('')}
              </select>
            </label>
            <label class="sast-form-row">
              <span>Oblast</span>
              <select name="oblast">
                ${Object.entries(TEMA_OBLASTI).map(([k, v]) => `<option value="${k}"${tema?.oblast === k ? ' selected' : ''}>${escHtml(v)}</option>`).join('')}
              </select>
            </label>
            <label class="sast-form-row">
              <span>Prioritet</span>
              <select name="prioritet">
                ${Object.entries(PRIORITETI).map(([k, v]) => `<option value="${k}"${String(tema?.prioritet || 2) === k ? ' selected' : ''}>${escHtml(v)}</option>`).join('')}
              </select>
            </label>
          </div>
          <label class="sast-form-row">
            <span>Projekat (opciono)</span>
            <select name="projekatId">
              <option value="">— bez projekta —</option>
              ${cachedProjekti.map(p => `<option value="${p.id}"${tema?.projekatId === p.id ? ' selected' : ''}>${escHtml(p.label)}</option>`).join('')}
            </select>
          </label>
          <label class="sast-form-row">
            <span>Opis</span>
            <textarea name="opis" rows="5" maxlength="2000">${escHtml(tema?.opis || '')}</textarea>
          </label>
          ${isEdit ? `
            <label class="sast-form-row">
              <span>Status</span>
              <select name="status">
                ${Object.entries(TEMA_STATUSI).map(([k, v]) => `<option value="${k}"${tema.status === k ? ' selected' : ''}>${escHtml(v)}</option>`).join('')}
              </select>
            </label>
          ` : ''}
        </form>
      </div>
      <footer class="sast-modal-footer">
        <button class="btn" data-action="cancel">Otkaži</button>
        <button class="btn btn-primary" data-action="save">${isEdit ? 'Sačuvaj izmene' : 'Sačuvaj temu'}</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.sast-modal-close').addEventListener('click', close);
  overlay.querySelector('[data-action=cancel]').addEventListener('click', close);
  overlay.querySelector('[data-action=save]').addEventListener('click', async () => {
    const form = overlay.querySelector('#temaForm');
    const fd = new FormData(form);
    const naslov = String(fd.get('naslov') || '').trim();
    if (!naslov) { showToast('⚠ Naslov je obavezan'); return; }

    const payload = {
      ...(isEdit ? tema : {}),
      naslov,
      vrsta: fd.get('vrsta'),
      oblast: fd.get('oblast'),
      prioritet: Number(fd.get('prioritet')) || 2,
      projekatId: fd.get('projekatId') || null,
      opis: fd.get('opis'),
    };
    if (isEdit) payload.status = fd.get('status') || tema.status;
    if (!isEdit) {
      payload.predlozioEmail = cu?.email || '';
      payload.predlozioLabel = cu?.email || '';
    }
    const r = await saveTema(payload);
    if (r) {
      showToast(isEdit ? '✎ Tema izmenjena' : '+ Tema kreirana');
      close();
      await renderTeme(host, { canEdit });
    } else {
      showToast('⚠ Greška pri snimanju');
    }
  });
}
