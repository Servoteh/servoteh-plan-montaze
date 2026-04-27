/**
 * CMMS registar sredstava (maint_assets).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { fetchMaintAssets, insertMaintAsset, patchMaintAsset } from '../../services/maintenance.js';
import { canManageMaintCatalog } from './maintCatalogTab.js';

const ASSET_TYPES = ['machine', 'vehicle', 'it', 'facility'];
const ASSET_STATUSES = ['running', 'degraded', 'down', 'maintenance'];

function assetTypeLabel(t) {
  const m = {
    machine: 'Mašina',
    vehicle: 'Vozilo',
    it: 'IT oprema',
    facility: 'Objekat',
  };
  return m[t] || t || 'Sredstvo';
}

function statusLabel(s) {
  const m = {
    running: 'Radi',
    degraded: 'Smetnje',
    down: 'Zastoj',
    maintenance: 'Održavanje',
  };
  return m[s] || s || '—';
}

function statusBadgeClass(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'running') return 'mnt-badge mnt-badge--running';
  if (v === 'degraded') return 'mnt-badge mnt-badge--degraded';
  if (v === 'down') return 'mnt-badge mnt-badge--down';
  if (v === 'maintenance') return 'mnt-badge mnt-badge--maintenance';
  return 'mnt-badge';
}

function readForm(wrap) {
  return {
    asset_code: wrap.querySelector('[name="asset_code"]')?.value?.trim() || '',
    asset_type: wrap.querySelector('[name="asset_type"]')?.value || '',
    name: wrap.querySelector('[name="name"]')?.value?.trim() || '',
    status: wrap.querySelector('[name="status"]')?.value || 'running',
    manufacturer: wrap.querySelector('[name="manufacturer"]')?.value?.trim() || null,
    model: wrap.querySelector('[name="model"]')?.value?.trim() || null,
    serial_number: wrap.querySelector('[name="serial_number"]')?.value?.trim() || null,
    supplier: wrap.querySelector('[name="supplier"]')?.value?.trim() || null,
    notes: wrap.querySelector('[name="notes"]')?.value?.trim() || null,
  };
}

/**
 * @param {{ row?: object|null, prof: object|null, onSaved?: () => void, forcedType?: string }} opts
 */
function openAssetModal(opts) {
  const { row = null, prof, onSaved, forcedType = '' } = opts;
  const canManage = canManageMaintCatalog(prof);
  if (!canManage) {
    showToast('⚠ Nemaš ovlašćenje za izmenu sredstava');
    return;
  }
  const isEdit = !!row?.asset_id;
  const isMachine = row?.asset_type === 'machine';
  if (isMachine) {
    showToast('ℹ Mašine se uređuju kroz Katalog mašina');
    return;
  }

  const typeOpts = ASSET_TYPES.filter(t => t !== 'machine').map(t => {
    const selected = String(row?.asset_type || forcedType || 'vehicle') === t ? ' selected' : '';
    return `<option value="${escHtml(t)}"${selected}>${escHtml(assetTypeLabel(t))}</option>`;
  }).join('');
  const statusOpts = ASSET_STATUSES.map(s => {
    const selected = String(row?.status || 'running') === s ? ' selected' : '';
    return `<option value="${escHtml(s)}"${selected}>${escHtml(statusLabel(s))}</option>`;
  }).join('');

  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `
    <div class="kadr-modal" style="max-width:560px">
      <div class="kadr-modal-title">${isEdit ? 'Izmeni sredstvo' : 'Novo sredstvo'}</div>
      <div class="kadr-modal-subtitle">Vozila, IT i objekti kroz <code>maint_assets</code>. Mašine se vode u katalogu mašina.</div>
      <div class="kadr-modal-err" id="mntAssetErr"></div>
      <form id="mntAssetForm">
        <div class="mnt-asset-form-grid">
          <label class="form-label">Tip
            <select class="form-input" name="asset_type" ${isEdit ? 'disabled' : ''}>${typeOpts}</select>
          </label>
          <label class="form-label">Status
            <select class="form-input" name="status">${statusOpts}</select>
          </label>
          <label class="form-label">Šifra *
            <input class="form-input" name="asset_code" value="${escHtml(row?.asset_code || '')}" ${isEdit ? 'readonly' : ''} required maxlength="120">
          </label>
          <label class="form-label">Naziv *
            <input class="form-input" name="name" value="${escHtml(row?.name || '')}" required maxlength="200">
          </label>
          <label class="form-label">Proizvođač
            <input class="form-input" name="manufacturer" value="${escHtml(row?.manufacturer || '')}" maxlength="120">
          </label>
          <label class="form-label">Model
            <input class="form-input" name="model" value="${escHtml(row?.model || '')}" maxlength="120">
          </label>
          <label class="form-label">Serijski broj
            <input class="form-input" name="serial_number" value="${escHtml(row?.serial_number || '')}" maxlength="120">
          </label>
          <label class="form-label">Dobavljač
            <input class="form-input" name="supplier" value="${escHtml(row?.supplier || '')}" maxlength="200">
          </label>
          <label class="form-label mnt-asset-form-full">Napomene
            <textarea class="form-input" name="notes" rows="3">${escHtml(row?.notes || '')}</textarea>
          </label>
        </div>
        <div class="kadr-modal-actions" style="margin-top:16px">
          <button type="button" class="btn btn-secondary" id="mntAssetCancel">Otkaži</button>
          <button type="submit" class="btn">${isEdit ? 'Sačuvaj' : 'Dodaj sredstvo'}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('#mntAssetCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntAssetForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const err = wrap.querySelector('#mntAssetErr');
    if (err) err.textContent = '';
    const data = readForm(wrap);
    if (isEdit) data.asset_type = row.asset_type;
    if (!data.asset_code || !data.name || !data.asset_type) {
      if (err) err.textContent = 'Šifra, naziv i tip su obavezni.';
      return;
    }
    const ok = isEdit
      ? await patchMaintAsset(row.asset_id, data)
      : await insertMaintAsset(data);
    if (!ok) {
      if (err) err.textContent = 'Snimanje nije uspelo (RLS ili duplirana šifra).';
      showToast('⚠ Sredstvo nije sačuvano');
      return;
    }
    showToast('✅ Sredstvo sačuvano');
    close();
    onSaved?.();
  });
}

/**
 * @param {HTMLElement} host
 * @param {{ prof: object|null, onNavigateToPath?: (p:string)=>void, forcedType?: string }} opts
 */
export async function renderMaintAssetsPanel(host, opts) {
  const { prof, onNavigateToPath, forcedType = 'all' } = opts;
  const canManage = canManageMaintCatalog(prof);
  const state = {
    type: forcedType || 'all',
    q: new URLSearchParams(window.location.search).get('q') || '',
  };
  host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Učitavam sredstva…</p></div>`;
  const rows = await fetchMaintAssets({ type: state.type, q: state.q, includeArchived: false });
  if (!Array.isArray(rows)) {
    host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam sredstva. Proveri RLS ili migracije.</p></div>`;
    return;
  }

  const counts = ASSET_TYPES.reduce((acc, t) => {
    acc[t] = rows.filter(r => r.asset_type === t).length;
    return acc;
  }, {});
  const typeOpts = ['all', ...ASSET_TYPES].map(t => {
    const label = t === 'all' ? 'Sva sredstva' : `${assetTypeLabel(t)} (${counts[t] || 0})`;
    return `<option value="${escHtml(t)}"${state.type === t ? ' selected' : ''}>${escHtml(label)}</option>`;
  }).join('');
  const tableRows = rows.map(r => {
    const isMachine = r.asset_type === 'machine';
    const openPath = isMachine ? `/maintenance/machine/${encodeURIComponent(r.asset_code)}` : '';
    return `<tr data-mnt-asset-id="${escHtml(r.asset_id)}">
      <td><code>${escHtml(r.asset_code || '')}</code></td>
      <td>${escHtml(r.name || '')}</td>
      <td>${escHtml(assetTypeLabel(r.asset_type))}</td>
      <td><span class="${statusBadgeClass(r.status)}">${escHtml(statusLabel(r.status))}</span></td>
      <td class="mnt-muted">${escHtml([r.manufacturer, r.model].filter(Boolean).join(' ') || '—')}</td>
      <td class="mnt-muted">${escHtml(r.serial_number || '—')}</td>
      <td style="white-space:nowrap">
        ${isMachine ? `<button type="button" class="btn btn-xs" data-mnt-nav="${escHtml(openPath)}">Otvori</button>` : ''}
        ${canManage && !isMachine ? '<button type="button" class="btn btn-xs" data-mnt-asset-edit>Izmeni</button>' : ''}
      </td>
    </tr>`;
  }).join('');

  host.innerHTML = `
    <div class="mnt-assets-head">
      <div>
        <h3 style="font-size:16px;margin:0 0 4px">Sredstva</h3>
        <p class="mnt-muted" style="margin:0">Jedinstven CMMS registar. Mašine su povezane sa katalogom mašina; vozila, IT i objekti se vode direktno ovde.</p>
      </div>
      ${canManage ? '<button type="button" class="btn" id="mntAssetAdd">+ Novo sredstvo</button>' : ''}
    </div>
    <div class="mnt-asset-toolbar">
      <input class="form-input" id="mntAssetSearch" type="search" placeholder="Pretraga šifre, naziva, proizvođača…" value="${escHtml(state.q)}">
      <select class="form-input" id="mntAssetType"${forcedType !== 'all' ? ' disabled' : ''}>${typeOpts}</select>
      <span class="mnt-muted">${rows.length} prikazano</span>
    </div>
    <div class="mnt-table-wrap">
      <table class="mnt-table">
        <thead><tr><th>Šifra</th><th>Naziv</th><th>Tip</th><th>Status</th><th>Model</th><th>Serijski</th><th></th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="7" class="mnt-muted">Nema sredstava za prikaz.</td></tr>'}</tbody>
      </table>
    </div>`;

  const rerender = () => {
    const q = host.querySelector('#mntAssetSearch')?.value || '';
    const type = host.querySelector('#mntAssetType')?.value || state.type;
    if (forcedType === 'all' && type !== 'all') {
      onNavigateToPath?.(`/maintenance/assets/${type === 'machine' ? 'machines' : type === 'facility' ? 'facilities' : type}`);
      return;
    }
    const url = new URL(window.location.href);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    window.history.replaceState({}, '', url.pathname + url.search);
    void renderMaintAssetsPanel(host, opts);
  };
  let timer = 0;
  host.querySelector('#mntAssetSearch')?.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(rerender, 250);
  });
  host.querySelector('#mntAssetType')?.addEventListener('change', rerender);
  host.querySelector('#mntAssetAdd')?.addEventListener('click', () => {
    openAssetModal({
      prof,
      forcedType: forcedType !== 'all' && forcedType !== 'machine' ? forcedType : 'vehicle',
      onSaved: () => renderMaintAssetsPanel(host, opts),
    });
  });
  host.querySelectorAll('[data-mnt-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.getAttribute('data-mnt-nav');
      if (p) onNavigateToPath?.(p);
    });
  });
  host.querySelectorAll('[data-mnt-asset-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('[data-mnt-asset-id]')?.getAttribute('data-mnt-asset-id');
      const row = rows.find(r => String(r.asset_id) === String(id));
      if (row) openAssetModal({ row, prof, onSaved: () => renderMaintAssetsPanel(host, opts) });
    });
  });
}
