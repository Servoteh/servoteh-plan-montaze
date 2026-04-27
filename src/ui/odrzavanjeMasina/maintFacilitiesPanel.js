/**
 * CMMS objekti — specijalizovan prikaz za `maint_assets.asset_type = facility`
 * + dodatna tabela `maint_facility_details`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  fetchMaintAssets,
  fetchMaintFacilityDetails,
  patchMaintAsset,
  upsertMaintFacilityDetails,
} from '../../services/maintenance.js';
import { canManageMaintCatalog } from './maintCatalogTab.js';

const STATUS_LABELS = {
  running: 'Radi',
  degraded: 'Smetnje',
  down: 'Zastoj',
  maintenance: 'Održavanje',
};

const CRITICALITY_LABELS = {
  low: 'Niska',
  medium: 'Srednja',
  high: 'Visoka',
  critical: 'Kritična',
};

function statusLabel(s) {
  return STATUS_LABELS[s] || s || '—';
}

function criticalityLabel(s) {
  return CRITICALITY_LABELS[s] || s || '—';
}

function statusBadgeClass(s) {
  if (s === 'running') return 'mnt-badge mnt-badge--running';
  if (s === 'degraded') return 'mnt-badge mnt-badge--degraded';
  if (s === 'down') return 'mnt-badge mnt-badge--down';
  if (s === 'maintenance') return 'mnt-badge mnt-badge--maintenance';
  return 'mnt-badge';
}

function criticalityBadgeClass(s) {
  if (s === 'critical') return 'mnt-badge mnt-badge--down';
  if (s === 'high') return 'mnt-badge mnt-badge--degraded';
  if (s === 'medium') return 'mnt-badge mnt-badge--maintenance';
  if (s === 'low') return 'mnt-badge mnt-badge--running';
  return 'mnt-badge';
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v).slice(0, 10) + 'T00:00:00');
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

function needsAttention(row) {
  const d = row.details || {};
  const inspectionDays = daysUntil(d.inspection_due_at);
  const fireDays = daysUntil(d.fire_safety_due_at);
  return (inspectionDays !== null && inspectionDays <= 30)
    || (fireDays !== null && fireDays <= 30)
    || ['high', 'critical'].includes(d.criticality || '');
}

function numOrNull(raw) {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readFacilityForm(wrap) {
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
      facility_type: wrap.querySelector('[name="facility_type"]')?.value?.trim() || null,
      floor_area_m2: numOrNull(wrap.querySelector('[name="floor_area_m2"]')?.value),
      floor_or_zone: wrap.querySelector('[name="floor_or_zone"]')?.value?.trim() || null,
      criticality: wrap.querySelector('[name="criticality"]')?.value || null,
      inspection_due_at: wrap.querySelector('[name="inspection_due_at"]')?.value || null,
      fire_safety_due_at: wrap.querySelector('[name="fire_safety_due_at"]')?.value || null,
      service_contract: wrap.querySelector('[name="service_contract"]')?.value?.trim() || null,
      service_provider: wrap.querySelector('[name="service_provider"]')?.value?.trim() || null,
      last_inspection_at: wrap.querySelector('[name="last_inspection_at"]')?.value || null,
      notes: wrap.querySelector('[name="facility_notes"]')?.value?.trim() || null,
    },
  };
}

function openFacilityModal({ row, prof, onSaved }) {
  const canEdit = canManageMaintCatalog(prof);
  if (!canEdit) {
    showToast('Nemaš ovlašćenje za izmenu objekata');
    return;
  }
  const d = row.details || {};
  const statusOpts = Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${escHtml(k)}"${row.status === k ? ' selected' : ''}>${escHtml(v)}</option>`).join('');
  const criticalityOpts = [
    '<option value="">—</option>',
    ...Object.entries(CRITICALITY_LABELS).map(([k, v]) => `<option value="${escHtml(k)}"${d.criticality === k ? ' selected' : ''}>${escHtml(v)}</option>`),
  ].join('');
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `<div class="kadr-modal" style="max-width:860px">
    <div class="kadr-modal-title">Detalji objekta</div>
    <div class="kadr-modal-subtitle"><code>${escHtml(row.asset_code || '')}</code> · ${escHtml(row.name || '')}</div>
    <div class="kadr-modal-err" id="mntFacilityErr"></div>
    <form id="mntFacilityForm">
      <div class="mnt-facility-form-grid">
        <label class="form-label">Naziv *
          <input class="form-input" name="name" required value="${escHtml(row.name || '')}">
        </label>
        <label class="form-label">Status
          <select class="form-input" name="status">${statusOpts}</select>
        </label>
        <label class="form-label">Tip objekta
          <input class="form-input" name="facility_type" value="${escHtml(d.facility_type || '')}" placeholder="hala, instalacija, HVAC, elektro orman…">
        </label>
        <label class="form-label">Zona / sprat
          <input class="form-input" name="floor_or_zone" value="${escHtml(d.floor_or_zone || '')}">
        </label>
        <label class="form-label">Površina m²
          <input class="form-input" name="floor_area_m2" type="number" min="0" step="0.01" value="${escHtml(d.floor_area_m2 ?? '')}">
        </label>
        <label class="form-label">Kritičnost
          <select class="form-input" name="criticality">${criticalityOpts}</select>
        </label>
        <label class="form-label">Proizvođač / sistem
          <input class="form-input" name="manufacturer" value="${escHtml(row.manufacturer || '')}">
        </label>
        <label class="form-label">Model
          <input class="form-input" name="model" value="${escHtml(row.model || '')}">
        </label>
        <label class="form-label">Serijski / inventarski broj
          <input class="form-input" name="serial_number" value="${escHtml(row.serial_number || '')}">
        </label>
        <label class="form-label">Dobavljač
          <input class="form-input" name="supplier" value="${escHtml(row.supplier || '')}">
        </label>
        <label class="form-label">Inspekcija rok
          <input class="form-input" name="inspection_due_at" type="date" value="${escHtml(d.inspection_due_at || '')}">
        </label>
        <label class="form-label">PP zaštita rok
          <input class="form-input" name="fire_safety_due_at" type="date" value="${escHtml(d.fire_safety_due_at || '')}">
        </label>
        <label class="form-label">Poslednja inspekcija
          <input class="form-input" name="last_inspection_at" type="date" value="${escHtml(d.last_inspection_at || '')}">
        </label>
        <label class="form-label">Serviser / ugovarač
          <input class="form-input" name="service_provider" value="${escHtml(d.service_provider || '')}">
        </label>
        <label class="form-label mnt-facility-form-full">Ugovor / servisni aranžman
          <input class="form-input" name="service_contract" value="${escHtml(d.service_contract || '')}">
        </label>
        <label class="form-label mnt-facility-form-full">Napomene objekta
          <textarea class="form-input" name="facility_notes" rows="2">${escHtml(d.notes || '')}</textarea>
        </label>
        <label class="form-label mnt-facility-form-full">Napomene sredstva
          <textarea class="form-input" name="asset_notes" rows="2">${escHtml(row.notes || '')}</textarea>
        </label>
      </div>
      <div class="kadr-modal-actions" style="margin-top:16px">
        <button type="button" class="btn" id="mntFacilityCancel" style="background:var(--surface3)">Otkaži</button>
        <button type="submit" class="btn">Sačuvaj</button>
      </div>
    </form>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#mntFacilityCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntFacilityForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const err = wrap.querySelector('#mntFacilityErr');
    if (err) err.textContent = '';
    const payload = readFacilityForm(wrap);
    if (!payload.asset.name) {
      if (err) err.textContent = 'Naziv je obavezan.';
      return;
    }
    const okAsset = await patchMaintAsset(row.asset_id, payload.asset);
    const detail = okAsset ? await upsertMaintFacilityDetails(row.asset_id, payload.details) : null;
    if (!okAsset || !detail) {
      if (err) err.textContent = 'Snimanje nije uspelo (RLS ili nevalidni podaci).';
      return;
    }
    showToast('Objekat sačuvan');
    close();
    onSaved?.();
  });
}

function mergeFacilities(assets, details) {
  const byAsset = new Map(details.map(d => [d.asset_id, d]));
  return assets.map(a => ({ ...a, details: byAsset.get(a.asset_id) || null }));
}

/**
 * @param {HTMLElement} host
 * @param {{ prof: object|null }} opts
 */
export async function renderMaintFacilitiesPanel(host, opts) {
  const canEdit = canManageMaintCatalog(opts.prof);
  const state = { q: new URLSearchParams(window.location.search).get('q') || '', attentionOnly: false };

  const load = async () => {
    host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Učitavam objekte…</p></div>`;
    const assets = await fetchMaintAssets({ type: 'facility', q: state.q, includeArchived: false, limit: 1000 });
    if (!Array.isArray(assets)) {
      host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Ne mogu da učitam objekte. Proveri RLS ili migracije.</p></div>`;
      return;
    }
    const details = await fetchMaintFacilityDetails(assets.map(a => a.asset_id));
    render(mergeFacilities(assets, details));
  };

  const render = rowsAll => {
    const rows = state.attentionOnly ? rowsAll.filter(needsAttention) : rowsAll;
    const inspections = rowsAll.filter(r => {
      const days = daysUntil(r.details?.inspection_due_at);
      return days !== null && days <= 30;
    }).length;
    const fireSafety = rowsAll.filter(r => {
      const days = daysUntil(r.details?.fire_safety_due_at);
      return days !== null && days <= 30;
    }).length;
    const critical = rowsAll.filter(r => ['high', 'critical'].includes(r.details?.criticality || '')).length;
    const missing = rowsAll.filter(r => !r.details).length;
    const table = rows.map(r => {
      const d = r.details || {};
      const area = d.floor_area_m2 == null ? '—' : `${Number(d.floor_area_m2).toLocaleString('sr-RS')} m²`;
      return `<tr data-mnt-facility-id="${escHtml(r.asset_id)}">
        <td><code>${escHtml(r.asset_code || '')}</code><div><strong>${escHtml(r.name || '')}</strong></div></td>
        <td>${escHtml(d.facility_type || '—')}<div class="mnt-muted">${escHtml(d.floor_or_zone || '')}</div></td>
        <td>${escHtml(area)}<div class="mnt-muted">${escHtml([r.manufacturer, r.model].filter(Boolean).join(' ') || '')}</div></td>
        <td><span class="${criticalityBadgeClass(d.criticality)}">${escHtml(criticalityLabel(d.criticality))}</span></td>
        <td><span class="${statusBadgeClass(r.status)}">${escHtml(statusLabel(r.status))}</span></td>
        <td><span class="${dueBadgeClass(d.inspection_due_at)}">${escHtml(dueLabel(d.inspection_due_at))}</span><div class="mnt-muted">${escHtml(d.inspection_due_at || '—')}</div></td>
        <td><span class="${dueBadgeClass(d.fire_safety_due_at)}">${escHtml(dueLabel(d.fire_safety_due_at))}</span><div class="mnt-muted">${escHtml(d.fire_safety_due_at || '—')}</div></td>
        <td>${escHtml(d.service_provider || '—')}<div class="mnt-muted">${escHtml(d.service_contract || '')}</div></td>
        <td>${canEdit ? '<button type="button" class="btn btn-xs" data-mnt-facility-edit>Detalji</button>' : ''}</td>
      </tr>`;
    }).join('');

    host.innerHTML = `
      <div class="mnt-assets-head">
        <div>
          <h3 style="font-size:16px;margin:0 0 4px">Objekti</h3>
          <p class="mnt-muted" style="margin:0">Specijalizovan pregled hala, zgrada, instalacija, PP rokova, inspekcija i servisnih ugovora.</p>
        </div>
        <span class="mnt-muted">${rows.length} prikazano</span>
      </div>
      <div class="mnt-kpi-row">
        <button type="button" class="mnt-kpi ${inspections ? 'mnt-kpi--late' : 'mnt-kpi--zero'}" data-mnt-facility-attention><span class="mnt-kpi-label">Inspekcije ≤30d</span><span class="mnt-kpi-val">${inspections}</span></button>
        <button type="button" class="mnt-kpi ${fireSafety ? 'mnt-kpi--late' : 'mnt-kpi--zero'}" data-mnt-facility-attention><span class="mnt-kpi-label">PP rokovi ≤30d</span><span class="mnt-kpi-val">${fireSafety}</span></button>
        <button type="button" class="mnt-kpi ${critical ? 'mnt-kpi--maintenance' : 'mnt-kpi--zero'}" data-mnt-facility-attention><span class="mnt-kpi-label">Visoka kritičnost</span><span class="mnt-kpi-val">${critical}</span></button>
        <div class="mnt-kpi ${missing ? 'mnt-kpi--degraded' : 'mnt-kpi--zero'}"><span class="mnt-kpi-label">Bez detalja</span><span class="mnt-kpi-val">${missing}</span></div>
      </div>
      <div class="mnt-asset-toolbar">
        <input class="form-input" id="mntFacilitySearch" type="search" placeholder="Pretraga objekata…" value="${escHtml(state.q)}">
        <label class="mnt-wo-check"><input type="checkbox" id="mntFacilityAttentionOnly" ${state.attentionOnly ? 'checked' : ''}> Samo pažnja</label>
        <span class="mnt-muted">${rows.length} od ${rowsAll.length}</span>
      </div>
      <div class="mnt-table-wrap">
        <table class="mnt-table">
          <thead><tr><th>Sredstvo</th><th>Tip / zona</th><th>Površina / sistem</th><th>Kritičnost</th><th>Status</th><th>Inspekcija</th><th>PP zaštita</th><th>Serviser</th><th></th></tr></thead>
          <tbody>${table || '<tr><td colspan="9" class="mnt-muted">Nema objekata za prikaz.</td></tr>'}</tbody>
        </table>
      </div>`;

    let timer = 0;
    host.querySelector('#mntFacilitySearch')?.addEventListener('input', e => {
      state.q = e.target.value || '';
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 250);
    });
    host.querySelector('#mntFacilityAttentionOnly')?.addEventListener('change', e => {
      state.attentionOnly = !!e.target.checked;
      render(rowsAll);
    });
    host.querySelectorAll('[data-mnt-facility-attention]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.attentionOnly = true;
        render(rowsAll);
      });
    });
    host.querySelectorAll('[data-mnt-facility-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.closest('[data-mnt-facility-id]')?.getAttribute('data-mnt-facility-id');
        const row = rowsAll.find(r => String(r.asset_id) === String(id));
        if (row) openFacilityModal({ row, prof: opts.prof, onSaved: load });
      });
    });
  };

  await load();
}
