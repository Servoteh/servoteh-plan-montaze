/**
 * CMMS vozila — specijalizovan prikaz za `maint_assets.asset_type = vehicle`
 * + dodatna tabela `maint_vehicle_details`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  fetchMaintAssets,
  fetchMaintVehicleDetails,
  patchMaintAsset,
  upsertMaintVehicleDetails,
} from '../../services/maintenance.js';
import { canManageMaintCatalog } from './maintCatalogTab.js';

const STATUS_LABELS = {
  running: 'Radi',
  degraded: 'Smetnje',
  down: 'Zastoj',
  maintenance: 'Održavanje',
};

function statusLabel(s) {
  return STATUS_LABELS[s] || s || '—';
}

function statusBadgeClass(s) {
  if (s === 'running') return 'mnt-badge mnt-badge--running';
  if (s === 'degraded') return 'mnt-badge mnt-badge--degraded';
  if (s === 'down') return 'mnt-badge mnt-badge--down';
  if (s === 'maintenance') return 'mnt-badge mnt-badge--maintenance';
  return 'mnt-badge';
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function daysUntil(v) {
  const d = parseDate(v);
  if (!d) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

function dueLabel(v) {
  const days = daysUntil(v);
  if (days === null) return '—';
  if (days < 0) return `kasni ${Math.abs(days)} d`;
  if (days === 0) return 'danas';
  if (days === 1) return 'sutra';
  return `za ${days} d`;
}

function dueBadgeClass(v) {
  const days = daysUntil(v);
  if (days === null) return 'mnt-badge';
  if (days < 0) return 'mnt-badge mnt-badge--down';
  if (days <= 30) return 'mnt-badge mnt-badge--degraded';
  return 'mnt-badge mnt-badge--running';
}

function vehicleDueSoon(row) {
  const dates = [
    row.details?.registration_expires_at,
    row.details?.insurance_expires_at,
    row.details?.service_due_at,
  ];
  return dates.some(d => {
    const days = daysUntil(d);
    return days !== null && days <= 30;
  });
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readDetailsForm(wrap) {
  const intOrNull = name => {
    const raw = wrap.querySelector(`[name="${name}"]`)?.value;
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : null;
  };
  return {
    asset: {
      name: wrap.querySelector('[name="name"]')?.value?.trim() || '',
      status: wrap.querySelector('[name="status"]')?.value || 'running',
      manufacturer: wrap.querySelector('[name="manufacturer"]')?.value?.trim() || null,
      model: wrap.querySelector('[name="model"]')?.value?.trim() || null,
      serial_number: wrap.querySelector('[name="serial_number"]')?.value?.trim() || null,
      supplier: wrap.querySelector('[name="supplier"]')?.value?.trim() || null,
      notes: wrap.querySelector('[name="asset_notes"]')?.value?.trim() || null,
    },
    details: {
      registration_plate: wrap.querySelector('[name="registration_plate"]')?.value?.trim() || null,
      vin: wrap.querySelector('[name="vin"]')?.value?.trim() || null,
      odometer_km: intOrNull('odometer_km'),
      fuel_type: wrap.querySelector('[name="fuel_type"]')?.value?.trim() || null,
      registration_expires_at: wrap.querySelector('[name="registration_expires_at"]')?.value || null,
      insurance_expires_at: wrap.querySelector('[name="insurance_expires_at"]')?.value || null,
      service_due_at: wrap.querySelector('[name="service_due_at"]')?.value || null,
      service_interval_km: intOrNull('service_interval_km'),
      next_service_mileage_km: intOrNull('next_service_mileage_km'),
      notes: wrap.querySelector('[name="vehicle_notes"]')?.value?.trim() || null,
    },
  };
}

function openVehicleModal({ row, prof, onSaved }) {
  const canEdit = canManageMaintCatalog(prof);
  if (!canEdit) {
    showToast('⚠ Nemaš ovlašćenje za izmenu vozila');
    return;
  }
  const d = row.details || {};
  const statusOpts = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${escHtml(k)}"${row.status === k ? ' selected' : ''}>${escHtml(v)}</option>`).join('');
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `<div class="kadr-modal" style="max-width:820px">
    <div class="kadr-modal-title">Detalji vozila</div>
    <div class="kadr-modal-subtitle"><code>${escHtml(row.asset_code || '')}</code> · ${escHtml(row.name || '')}</div>
    <div class="kadr-modal-err" id="mntVehicleErr"></div>
    <form id="mntVehicleForm">
      <div class="mnt-vehicle-form-grid">
        <label class="form-label">Naziv *
          <input class="form-input" name="name" required value="${escHtml(row.name || '')}">
        </label>
        <label class="form-label">Status
          <select class="form-input" name="status">${statusOpts}</select>
        </label>
        <label class="form-label">Registracija
          <input class="form-input" name="registration_plate" value="${escHtml(d.registration_plate || '')}">
        </label>
        <label class="form-label">VIN
          <input class="form-input" name="vin" value="${escHtml(d.vin || '')}">
        </label>
        <label class="form-label">Proizvođač
          <input class="form-input" name="manufacturer" value="${escHtml(row.manufacturer || '')}">
        </label>
        <label class="form-label">Model
          <input class="form-input" name="model" value="${escHtml(row.model || '')}">
        </label>
        <label class="form-label">Serijski broj
          <input class="form-input" name="serial_number" value="${escHtml(row.serial_number || '')}">
        </label>
        <label class="form-label">Gorivo
          <input class="form-input" name="fuel_type" value="${escHtml(d.fuel_type || '')}" placeholder="dizel, benzin, elektro…">
        </label>
        <label class="form-label">Kilometraža
          <input class="form-input" name="odometer_km" type="number" min="0" step="1" value="${escHtml(d.odometer_km ?? '')}">
        </label>
        <label class="form-label">Servisni interval km
          <input class="form-input" name="service_interval_km" type="number" min="0" step="1" value="${escHtml(d.service_interval_km ?? '')}">
        </label>
        <label class="form-label">Registracija važi do
          <input class="form-input" name="registration_expires_at" type="date" value="${escHtml(d.registration_expires_at || '')}">
        </label>
        <label class="form-label">Osiguranje važi do
          <input class="form-input" name="insurance_expires_at" type="date" value="${escHtml(d.insurance_expires_at || '')}">
        </label>
        <label class="form-label">Servis rok datum
          <input class="form-input" name="service_due_at" type="date" value="${escHtml(d.service_due_at || '')}">
        </label>
        <label class="form-label">Sledeći servis km
          <input class="form-input" name="next_service_mileage_km" type="number" min="0" step="1" value="${escHtml(d.next_service_mileage_km ?? '')}">
        </label>
        <label class="form-label">Dobavljač / leasing
          <input class="form-input" name="supplier" value="${escHtml(row.supplier || '')}">
        </label>
        <label class="form-label mnt-vehicle-form-full">Napomene vozila
          <textarea class="form-input" name="vehicle_notes" rows="2">${escHtml(d.notes || '')}</textarea>
        </label>
        <label class="form-label mnt-vehicle-form-full">Napomene sredstva
          <textarea class="form-input" name="asset_notes" rows="2">${escHtml(row.notes || '')}</textarea>
        </label>
      </div>
      <div class="kadr-modal-actions" style="margin-top:16px">
        <button type="button" class="btn" id="mntVehicleCancel" style="background:var(--surface3)">Otkaži</button>
        <button type="submit" class="btn">Sačuvaj</button>
      </div>
    </form>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#mntVehicleCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntVehicleForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const err = wrap.querySelector('#mntVehicleErr');
    if (err) err.textContent = '';
    const payload = readDetailsForm(wrap);
    if (!payload.asset.name) {
      if (err) err.textContent = 'Naziv je obavezan.';
      return;
    }
    const okAsset = await patchMaintAsset(row.asset_id, payload.asset);
    const detail = okAsset ? await upsertMaintVehicleDetails(row.asset_id, payload.details) : null;
    if (!okAsset || !detail) {
      if (err) err.textContent = 'Snimanje nije uspelo (RLS, duplikat registracije ili nevalidni podaci).';
      return;
    }
    showToast('✅ Vozilo sačuvano');
    close();
    onSaved?.();
  });
}

function mergeVehicles(assets, details) {
  const byAsset = new Map(details.map(d => [d.asset_id, d]));
  return assets.map(a => ({ ...a, details: byAsset.get(a.asset_id) || null }));
}

/**
 * @param {HTMLElement} host
 * @param {{ prof: object|null }} opts
 */
export async function renderMaintVehiclesPanel(host, opts) {
  const canEdit = canManageMaintCatalog(opts.prof);
  const state = { q: new URLSearchParams(window.location.search).get('q') || '', dueOnly: false };

  const load = async () => {
    host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Učitavam vozila…</p></div>`;
    const assets = await fetchMaintAssets({ type: 'vehicle', q: state.q, includeArchived: false, limit: 1000 });
    if (!Array.isArray(assets)) {
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam vozila. Proveri RLS ili migracije.</p></div>`;
      return;
    }
    const details = await fetchMaintVehicleDetails(assets.map(a => a.asset_id));
    render(mergeVehicles(assets, details));
  };

  const render = rowsAll => {
    const rows = state.dueOnly ? rowsAll.filter(vehicleDueSoon) : rowsAll;
    const dueReg = rowsAll.filter(r => {
      const days = daysUntil(r.details?.registration_expires_at);
      return days !== null && days <= 30;
    }).length;
    const dueIns = rowsAll.filter(r => {
      const days = daysUntil(r.details?.insurance_expires_at);
      return days !== null && days <= 30;
    }).length;
    const dueService = rowsAll.filter(r => {
      const days = daysUntil(r.details?.service_due_at);
      const km = num(r.details?.next_service_mileage_km);
      const odo = num(r.details?.odometer_km);
      return (days !== null && days <= 30) || (km !== null && odo !== null && km - odo <= 1000);
    }).length;
    const missing = rowsAll.filter(r => !r.details).length;
    const table = rows.map(r => {
      const d = r.details || {};
      const serviceKm = num(d.next_service_mileage_km) !== null && num(d.odometer_km) !== null
        ? `${d.next_service_mileage_km - d.odometer_km} km do servisa`
        : '—';
      return `<tr data-mnt-vehicle-id="${escHtml(r.asset_id)}">
        <td><code>${escHtml(r.asset_code || '')}</code><div><strong>${escHtml(r.name || '')}</strong></div></td>
        <td>${escHtml(d.registration_plate || '—')}<div class="mnt-muted">VIN ${escHtml(d.vin || '—')}</div></td>
        <td><span class="${statusBadgeClass(r.status)}">${escHtml(statusLabel(r.status))}</span></td>
        <td>${escHtml([r.manufacturer, r.model].filter(Boolean).join(' ') || '—')}</td>
        <td>${d.odometer_km == null ? '—' : `${escHtml(String(d.odometer_km))} km`}<div class="mnt-muted">${escHtml(d.fuel_type || '')}</div></td>
        <td><span class="${dueBadgeClass(d.registration_expires_at)}">${escHtml(dueLabel(d.registration_expires_at))}</span><div class="mnt-muted">${escHtml(d.registration_expires_at || '—')}</div></td>
        <td><span class="${dueBadgeClass(d.insurance_expires_at)}">${escHtml(dueLabel(d.insurance_expires_at))}</span><div class="mnt-muted">${escHtml(d.insurance_expires_at || '—')}</div></td>
        <td><span class="${dueBadgeClass(d.service_due_at)}">${escHtml(dueLabel(d.service_due_at))}</span><div class="mnt-muted">${escHtml(serviceKm)}</div></td>
        <td>${canEdit ? '<button type="button" class="btn btn-xs" data-mnt-vehicle-edit>Detalji</button>' : ''}</td>
      </tr>`;
    }).join('');

    host.innerHTML = `
      <div class="mnt-assets-head">
        <div>
          <h3 style="font-size:16px;margin:0 0 4px">Vozila</h3>
          <p class="mnt-muted" style="margin:0">Specijalizovan pregled registracije, osiguranja, kilometraže i servisnih rokova.</p>
        </div>
        <span class="mnt-muted">${rows.length} prikazano</span>
      </div>
      <div class="mnt-kpi-row">
        <button type="button" class="mnt-kpi ${dueReg ? 'mnt-kpi--late' : 'mnt-kpi--zero'}" data-mnt-vehicle-due><span class="mnt-kpi-label">Registracija ≤30d</span><span class="mnt-kpi-val">${dueReg}</span></button>
        <button type="button" class="mnt-kpi ${dueIns ? 'mnt-kpi--late' : 'mnt-kpi--zero'}" data-mnt-vehicle-due><span class="mnt-kpi-label">Osiguranje ≤30d</span><span class="mnt-kpi-val">${dueIns}</span></button>
        <button type="button" class="mnt-kpi ${dueService ? 'mnt-kpi--maintenance' : 'mnt-kpi--zero'}" data-mnt-vehicle-due><span class="mnt-kpi-label">Servis uskoro</span><span class="mnt-kpi-val">${dueService}</span></button>
        <div class="mnt-kpi ${missing ? 'mnt-kpi--degraded' : 'mnt-kpi--zero'}"><span class="mnt-kpi-label">Bez detalja</span><span class="mnt-kpi-val">${missing}</span></div>
      </div>
      <div class="mnt-asset-toolbar">
        <input class="form-input" id="mntVehicleSearch" type="search" placeholder="Pretraga vozila…" value="${escHtml(state.q)}">
        <label class="mnt-wo-check"><input type="checkbox" id="mntVehicleDueOnly" ${state.dueOnly ? 'checked' : ''}> Samo rokovi</label>
        <span class="mnt-muted">${rows.length} od ${rowsAll.length}</span>
      </div>
      <div class="mnt-table-wrap">
        <table class="mnt-table">
          <thead><tr><th>Vozilo</th><th>Registracija / VIN</th><th>Status</th><th>Model</th><th>Km</th><th>Registracija</th><th>Osiguranje</th><th>Servis</th><th></th></tr></thead>
          <tbody>${table || '<tr><td colspan="9" class="mnt-muted">Nema vozila za prikaz.</td></tr>'}</tbody>
        </table>
      </div>`;

    let timer = 0;
    host.querySelector('#mntVehicleSearch')?.addEventListener('input', e => {
      state.q = e.target.value || '';
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 250);
    });
    host.querySelector('#mntVehicleDueOnly')?.addEventListener('change', e => {
      state.dueOnly = !!e.target.checked;
      render(rowsAll);
    });
    host.querySelectorAll('[data-mnt-vehicle-due]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.dueOnly = true;
        render(rowsAll);
      });
    });
    host.querySelectorAll('[data-mnt-vehicle-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('[data-mnt-vehicle-id]')?.getAttribute('data-mnt-vehicle-id');
        const row = rowsAll.find(r => String(r.asset_id) === String(id));
        if (row) openVehicleModal({ row, prof: opts.prof, onSaved: load });
      });
    });
  };

  await load();
}
