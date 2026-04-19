/**
 * PM Teme tab — predlog → odobravanje → dodela sastanku.
 *
 * Pod-tabovi:
 *   - Sve teme        — sve aktivne teme (sortirano po admin_rang/hitno/prioritet)
 *   - Moje teme       — samo teme koje je predložio trenutni korisnik
 *   - Hitno           — samo hitno=true (crveni okvir)
 *   - Za razmatranje  — samo za_razmatranje=true (admin označio)
 *
 * Akcije po roli:
 *   - Svi (canEdit):    + Nova tema, edit/delete SAMO svojih, toggle Hitno na svojima
 *   - Admin:            može sve gore + toggle ZaRazmatranje, set AdminRang,
 *                       odobri/odbij/dodeli sastanku, edit/delete BILO ČIJU temu
 *   - Read-only role:   samo pregled
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadPmTeme, saveTema, deleteTema, dodeliTemuSastanku, odbijTemu,
  setHitno, setZaRazmatranje, setAdminRang,
  TEMA_VRSTE, TEMA_OBLASTI, TEMA_STATUSI, TEMA_STATUS_BOJE, PRIORITETI,
} from '../../services/pmTeme.js';
import { loadSastanci } from '../../services/sastanci.js';
import { loadProjektiLite } from '../../services/projekti.js';
import { getCurrentUser, canPrioritizeTeme, isTemaOwner } from '../../state/auth.js';

let abortFlag = false;
let cachedTeme = [];
let cachedProjekti = [];
let filters = { status: '', oblast: '', vrsta: '', subTab: 'sve' };

const SUB_TABS = [
  { id: 'sve',          label: 'Sve teme' },
  { id: 'moje',         label: 'Moje teme' },
  { id: 'hitno',        label: 'Hitno', cls: 'is-hitno-tab' },
  { id: 'razmatranje',  label: 'Za razmatranje' },
];

export async function renderPmTemeTab(host, { canEdit }) {
  abortFlag = false;
  const isAdmin = canPrioritizeTeme();
  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-subtabs" role="tablist">
        ${SUB_TABS.map(t => `
          <button type="button" class="sast-subtab${filters.subTab === t.id ? ' is-active' : ''}${t.cls ? ' ' + t.cls : ''}"
                  data-subtab="${t.id}" role="tab">${escHtml(t.label)}</button>
        `).join('')}
      </div>

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
      openTemaModal(host, { canEdit, isAdmin, mode: 'create' });
    });
  }

  host.querySelectorAll('.sast-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      filters.subTab = btn.dataset.subtab;
      host.querySelectorAll('.sast-subtab').forEach(b => b.classList.toggle('is-active', b === btn));
      renderTeme(host, { canEdit, isAdmin });
    });
  });

  ['filtStatus', 'filtOblast', 'filtVrsta'].forEach(id => {
    const el = host.querySelector('#' + id);
    el?.addEventListener('change', () => {
      filters[id.replace('filt', '').toLowerCase()] = el.value;
      renderTeme(host, { canEdit, isAdmin });
    });
  });
  if (filters.status) host.querySelector('#filtStatus').value = filters.status;
  if (filters.oblast) host.querySelector('#filtOblast').value = filters.oblast;
  if (filters.vrsta) host.querySelector('#filtVrsta').value = filters.vrsta;

  cachedProjekti = await loadProjektiLite();

  await renderTeme(host, { canEdit, isAdmin });
}

export function teardownPmTemeTab() {
  abortFlag = true;
}

async function renderTeme(host, { canEdit, isAdmin }) {
  const body = host.querySelector('#temeBody');
  body.innerHTML = '<div class="sast-loading">Učitavam teme…</div>';

  const cu = getCurrentUser();
  const loadFilters = {
    status: filters.status || null,
    limit: 500,
  };
  if (filters.subTab === 'moje' && cu?.email) {
    loadFilters.predlozioEmail = cu.email;
  }
  if (filters.subTab === 'hitno') loadFilters.hitnoOnly = true;
  if (filters.subTab === 'razmatranje') loadFilters.razmatranjeOnly = true;

  cachedTeme = await loadPmTeme(loadFilters);

  if (abortFlag) return;

  let rows = cachedTeme;
  if (filters.oblast) rows = rows.filter(t => t.oblast === filters.oblast);
  if (filters.vrsta) rows = rows.filter(t => t.vrsta === filters.vrsta);

  if (!rows.length) {
    body.innerHTML = `<div class="sast-empty">${escHtml(emptyMsg(filters.subTab))}</div>`;
    return;
  }

  body.innerHTML = `
    <table class="sast-table sast-teme-table">
      <thead>
        <tr>
          <th class="th-rang" title="Master prioritet (admin)">#</th>
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
        ${rows.map(t => renderTemaRow(t, { canEdit, isAdmin })).join('')}
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
      handleTemaAction(host, action, tema, { canEdit, isAdmin });
    });
  });

  /* Admin može da menja rang inline (input number). */
  body.querySelectorAll('.rang-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const id = inp.dataset.id;
      const val = inp.value === '' ? null : Number(inp.value);
      const r = await setAdminRang(id, val);
      if (r) {
        showToast('# Master rang ažuriran');
        await renderTeme(host, { canEdit, isAdmin });
      } else {
        showToast('⚠ Greška pri snimanju ranga');
      }
    });
  });
}

function emptyMsg(subTab) {
  switch (subTab) {
    case 'moje':         return 'Nemaš još nijednu predloženu temu. Klikni "+ Nova tema" da dodaš.';
    case 'hitno':        return 'Nema hitnih tema. Označi temu kao hitnu da se pojavi ovde.';
    case 'razmatranje':  return 'Nema tema označenih "za razmatranje". Admin označava ovaj flag.';
    default:             return 'Nema tema sa zadatim filterima.';
  }
}

function renderTemaRow(t, { canEdit, isAdmin }) {
  const color = TEMA_STATUS_BOJE[t.status] || '#666';
  const priIcon = t.prioritet === 1 ? '🔴' : (t.prioritet === 2 ? '🟡' : '🟢');
  const owner = isTemaOwner(t.predlozioEmail);
  const canEditThis = canEdit && (owner || isAdmin);
  const rowCls = [
    t.hitno ? 'is-hitno' : '',
    t.zaRazmatranje ? 'is-razmatra' : '',
    owner ? 'is-mine' : '',
  ].filter(Boolean).join(' ');

  const flags = [];
  if (t.hitno) flags.push('<span class="sast-flag flag-hitno" title="Hitno">🔥 HITNO</span>');
  if (t.zaRazmatranje) flags.push('<span class="sast-flag flag-razmatra" title="Za razmatranje na sledećem sastanku menadžmenta">🎯 Za razmatranje</span>');

  const actions = [];
  /* Hitno toggle — vlasnik ili admin. */
  if (canEditThis) {
    actions.push(`<button class="btn-icon ${t.hitno ? 'btn-danger active' : 'btn-ghost'}" data-action="toggleHitno" data-id="${t.id}" title="${t.hitno ? 'Skini Hitno' : 'Označi kao Hitno'}">🔥</button>`);
  }
  /* Za razmatranje — samo admin. */
  if (isAdmin) {
    actions.push(`<button class="btn-icon ${t.zaRazmatranje ? 'btn-warn active' : 'btn-ghost'}" data-action="toggleRazmatra" data-id="${t.id}" title="${t.zaRazmatranje ? 'Skini "za razmatranje"' : 'Označi za razmatranje (samo admin)'}">🎯</button>`);
  }
  /* Status approval — samo admin (workflow odobravanja). */
  if (isAdmin && t.status === 'predlog') {
    actions.push(`<button class="btn-icon btn-success" data-action="approve" data-id="${t.id}" title="Odobri (postaje 'usvojeno')">✓</button>`);
    actions.push(`<button class="btn-icon btn-danger" data-action="reject" data-id="${t.id}" title="Odbij">✕</button>`);
  }
  if (isAdmin && t.status === 'usvojeno' && !t.sastanakId) {
    actions.push(`<button class="btn-icon btn-primary" data-action="assign" data-id="${t.id}" title="Dodeli sastanku">📅</button>`);
  }
  if (canEditThis) {
    actions.push(`<button class="btn-icon" data-action="edit" data-id="${t.id}" title="Izmeni">✎</button>`);
    actions.push(`<button class="btn-icon btn-danger" data-action="delete" data-id="${t.id}" title="Obriši">🗑</button>`);
  }

  /* Master rang ćeliju — admin može inline da menja. */
  const rangCell = isAdmin
    ? `<input type="number" class="rang-input" data-id="${t.id}" value="${t.adminRang ?? ''}" min="1" max="999" placeholder="—" title="Master prioritet (manji = veći)">`
    : `<span class="rang-display">${t.adminRang ?? '—'}</span>`;

  return `
    <tr class="${rowCls}">
      <td class="td-rang">${rangCell}</td>
      <td><span class="sast-status-pill" style="background:${color}">${escHtml(TEMA_STATUSI[t.status] || t.status)}</span></td>
      <td>
        <div class="tema-naslov-line">
          <strong>${escHtml(t.naslov)}</strong>
          ${flags.join(' ')}
        </div>
        ${t.opis ? `<div class="sast-row-sub">${escHtml(t.opis.slice(0, 200))}${t.opis.length > 200 ? '…' : ''}</div>` : ''}
      </td>
      <td>${escHtml(TEMA_VRSTE[t.vrsta] || t.vrsta)} <br><small>${escHtml(TEMA_OBLASTI[t.oblast] || t.oblast)}</small></td>
      <td>${escHtml(t.predlozioLabel || t.predlozioEmail)}${owner ? ' <small class="sast-mine">(ja)</small>' : ''}</td>
      <td title="${PRIORITETI[t.prioritet]}">${priIcon}</td>
      <td>${escHtml(formatDate(t.predlozioAt))}</td>
      <td class="sast-td-actions">${actions.join(' ')}</td>
    </tr>
  `;
}

async function handleTemaAction(host, action, tema, { canEdit, isAdmin }) {
  const owner = isTemaOwner(tema.predlozioEmail);
  const canEditThis = canEdit && (owner || isAdmin);

  if (action === 'edit') {
    if (!canEditThis) { showToast('🔒 Možeš da menjaš samo svoje teme'); return; }
    openTemaModal(host, { canEdit, isAdmin, mode: 'edit', tema });
    return;
  }
  if (action === 'delete') {
    if (!canEditThis) { showToast('🔒 Možeš da brišeš samo svoje teme'); return; }
    if (!confirm(`Obriši temu "${tema.naslov}"?`)) return;
    const ok = await deleteTema(tema.id);
    if (ok) { showToast('🗑 Tema obrisana'); await renderTeme(host, { canEdit, isAdmin }); }
    else showToast('⚠ Greška pri brisanju');
    return;
  }
  if (action === 'toggleHitno') {
    if (!canEditThis) { showToast('🔒 Hitno možeš da menjaš samo na svojim temama'); return; }
    const r = await setHitno(tema.id, !tema.hitno);
    if (r) { showToast(r.hitno ? '🔥 Označeno HITNO' : 'Hitno uklonjeno'); await renderTeme(host, { canEdit, isAdmin }); }
    return;
  }
  if (action === 'toggleRazmatra') {
    if (!isAdmin) { showToast('🔒 Samo admin može da označi temu za razmatranje'); return; }
    const r = await setZaRazmatranje(tema.id, !tema.zaRazmatranje);
    if (r) { showToast(r.zaRazmatranje ? '🎯 Tema ide na razmatranje' : 'Skinut flag "za razmatranje"'); await renderTeme(host, { canEdit, isAdmin }); }
    return;
  }
  if (action === 'reject') {
    if (!isAdmin) { showToast('🔒 Samo admin može da odbije temu'); return; }
    const napomena = prompt('Razlog odbijanja (opciono):', '');
    if (napomena === null) return;
    const r = await odbijTemu(tema.id, napomena);
    if (r) { showToast('✕ Tema odbijena'); await renderTeme(host, { canEdit, isAdmin }); }
    return;
  }
  if (action === 'approve') {
    if (!isAdmin) { showToast('🔒 Samo admin može da odobri temu'); return; }
    const r = await saveTema({ ...tema, status: 'usvojeno' });
    if (r) { showToast('✓ Tema usvojena'); await renderTeme(host, { canEdit, isAdmin }); }
    return;
  }
  if (action === 'assign') {
    if (!isAdmin) { showToast('🔒 Samo admin može da dodeli temu sastanku'); return; }
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
    if (r) { showToast('📅 Tema dodeljena sastanku'); await renderTeme(host, { canEdit, isAdmin }); }
  }
}

/* ── Tema modal (kreiranje / izmena) ── */

function openTemaModal(host, { canEdit, isAdmin, mode = 'create', tema = null }) {
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
              <span>Prioritet (moja procena)</span>
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
          <label class="sast-form-row sast-form-check">
            <input type="checkbox" name="hitno" ${tema?.hitno ? 'checked' : ''}>
            <span><strong>🔥 Hitno</strong> — istakni temu crvenom bojom (za sve da vide da je urgentna)</span>
          </label>
          ${isAdmin ? `
            <label class="sast-form-row sast-form-check">
              <input type="checkbox" name="zaRazmatranje" ${tema?.zaRazmatranje ? 'checked' : ''}>
              <span><strong>🎯 Za razmatranje</strong> <small>(samo admin)</small> — ide na sledeći sastanak menadžmenta</span>
            </label>
            <label class="sast-form-row">
              <span>Master rang <small>(samo admin; manji broj = veći prioritet; prazno = neuređeno)</small></span>
              <input type="number" name="adminRang" min="1" max="999" value="${tema?.adminRang ?? ''}" placeholder="—">
            </label>
          ` : ''}
          ${isEdit && isAdmin ? `
            <label class="sast-form-row">
              <span>Status <small>(samo admin)</small></span>
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
      hitno: fd.get('hitno') === 'on',
    };
    if (isEdit && isAdmin) payload.status = fd.get('status') || tema.status;
    if (!isEdit) {
      payload.predlozioEmail = cu?.email || '';
      payload.predlozioLabel = cu?.email || '';
    }
    const r = await saveTema(payload);
    if (!r) { showToast('⚠ Greška pri snimanju'); return; }

    /* Admin polja se snimaju zasebnim PATCH-evima jer imaju audit snapshot. */
    if (isAdmin) {
      const newRazmatra = fd.get('zaRazmatranje') === 'on';
      const oldRazmatra = !!tema?.zaRazmatranje;
      if (newRazmatra !== oldRazmatra) {
        await setZaRazmatranje(r.id, newRazmatra);
      }
      const newRangRaw = fd.get('adminRang');
      const newRang = newRangRaw === '' || newRangRaw === null ? null : Number(newRangRaw);
      const oldRang = tema?.adminRang ?? null;
      if (newRang !== oldRang) {
        await setAdminRang(r.id, newRang);
      }
    }

    showToast(isEdit ? '✎ Tema izmenjena' : '+ Tema kreirana');
    close();
    await renderTeme(host, { canEdit, isAdmin });
  });
}
