/**
 * CMMS zalihe i dobavljači.
 */

import { rowsToCsv, CSV_BOM } from '../../lib/csv.js';
import { escHtml, showToast } from '../../lib/dom.js';
import { isAdminOrMenadzment } from '../../state/auth.js';
import {
  fetchMaintParts,
  fetchMaintPartStockMovements,
  fetchMaintSuppliers,
  insertMaintPart,
  insertMaintPartStockMovement,
  insertMaintSupplier,
  patchMaintPart,
} from '../../services/maintenance.js';

function canManageInventory(prof) {
  const role = String(prof?.role || '').toLowerCase();
  return isAdminOrMenadzment() || role === 'chief' || role === 'admin';
}

function canMoveStock(prof) {
  const role = String(prof?.role || '').toLowerCase();
  return canManageInventory(prof) || role === 'technician';
}

function num(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function fmt(v) {
  return new Intl.NumberFormat('sr-Latn-RS', { maximumFractionDigits: 4 }).format(num(v));
}

function money(v) {
  return new Intl.NumberFormat('sr-Latn-RS', { maximumFractionDigits: 2 }).format(num(v));
}

function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function supplierName(part) {
  return part.maint_suppliers?.name || '—';
}

function partDisplay(part) {
  return `${part.part_code || ''} — ${part.name || ''}`;
}

function formNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readPartForm(wrap) {
  return {
    part_code: wrap.querySelector('[name="part_code"]')?.value?.trim() || '',
    name: wrap.querySelector('[name="name"]')?.value?.trim() || '',
    description: wrap.querySelector('[name="description"]')?.value?.trim() || null,
    unit: wrap.querySelector('[name="unit"]')?.value?.trim() || 'kom',
    supplier_id: wrap.querySelector('[name="supplier_id"]')?.value || null,
    manufacturer: wrap.querySelector('[name="manufacturer"]')?.value?.trim() || null,
    model: wrap.querySelector('[name="model"]')?.value?.trim() || null,
    min_stock: formNum(wrap.querySelector('[name="min_stock"]')?.value, 0),
    current_stock: formNum(wrap.querySelector('[name="current_stock"]')?.value, 0),
    unit_cost: wrap.querySelector('[name="unit_cost"]')?.value ? formNum(wrap.querySelector('[name="unit_cost"]')?.value, 0) : null,
    active: !!wrap.querySelector('[name="active"]')?.checked,
  };
}

function openPartModal({ row, suppliers, onSaved }) {
  const existing = row || null;
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  const supplierOpts = suppliers.map(s => `<option value="${escHtml(s.supplier_id)}"${existing?.supplier_id === s.supplier_id ? ' selected' : ''}>${escHtml(s.name)}</option>`).join('');
  wrap.innerHTML = `<div class="kadr-modal" style="max-width:720px">
    <div class="kadr-modal-title">${existing ? 'Izmeni deo' : 'Novi deo'}</div>
    <div class="kadr-modal-err" id="mntPartErr"></div>
    <form id="mntPartForm">
      <div class="mnt-inventory-form-grid">
        <label class="form-label">Šifra *
          <input class="form-input" name="part_code" required maxlength="80" value="${escHtml(existing?.part_code || '')}">
        </label>
        <label class="form-label">Naziv *
          <input class="form-input" name="name" required maxlength="200" value="${escHtml(existing?.name || '')}">
        </label>
        <label class="form-label">Jedinica
          <input class="form-input" name="unit" maxlength="20" value="${escHtml(existing?.unit || 'kom')}">
        </label>
        <label class="form-label">Dobavljač
          <select class="form-input" name="supplier_id"><option value="">—</option>${supplierOpts}</select>
        </label>
        <label class="form-label">Minimalna zaliha
          <input class="form-input" name="min_stock" type="number" step="0.0001" min="0" value="${escHtml(String(existing?.min_stock ?? 0))}">
        </label>
        <label class="form-label">Trenutna zaliha
          <input class="form-input" name="current_stock" type="number" step="0.0001" value="${escHtml(String(existing?.current_stock ?? 0))}" ${existing ? 'disabled' : ''}>
        </label>
        <label class="form-label">Jedinična cena
          <input class="form-input" name="unit_cost" type="number" step="0.01" min="0" value="${escHtml(existing?.unit_cost ?? '')}">
        </label>
        <label class="form-label">Proizvođač
          <input class="form-input" name="manufacturer" maxlength="160" value="${escHtml(existing?.manufacturer || '')}">
        </label>
        <label class="form-label">Model
          <input class="form-input" name="model" maxlength="160" value="${escHtml(existing?.model || '')}">
        </label>
        <label class="form-label" style="display:flex;gap:8px;align-items:center;margin-top:26px">
          <input type="checkbox" name="active" ${existing?.active === false ? '' : 'checked'}> Aktivan
        </label>
        <label class="form-label mnt-inventory-form-full">Opis
          <textarea class="form-input" name="description" rows="2">${escHtml(existing?.description || '')}</textarea>
        </label>
      </div>
      <div class="kadr-modal-actions" style="margin-top:14px">
        <button type="button" class="btn" id="mntPartCancel" style="background:var(--surface3)">Otkaži</button>
        <button type="submit" class="btn">${existing ? 'Sačuvaj' : 'Dodaj'}</button>
      </div>
    </form>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#mntPartCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntPartForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const err = wrap.querySelector('#mntPartErr');
    if (err) err.textContent = '';
    const payload = readPartForm(wrap);
    if (!payload.part_code || !payload.name) {
      if (err) err.textContent = 'Šifra i naziv su obavezni.';
      return;
    }
    const ok = existing?.part_id
      ? await patchMaintPart(existing.part_id, payload)
      : !!(await insertMaintPart(payload));
    if (!ok) {
      if (err) err.textContent = 'Snimanje nije uspelo (RLS ili duplikat šifre).';
      return;
    }
    showToast(existing ? '✅ Deo ažuriran' : '✅ Deo dodat');
    close();
    onSaved?.();
  });
}

function openSupplierModal({ onSaved }) {
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `<div class="kadr-modal" style="max-width:520px">
    <div class="kadr-modal-title">Novi dobavljač</div>
    <div class="kadr-modal-err" id="mntSupplierErr"></div>
    <form id="mntSupplierForm">
      <label class="form-label">Naziv *</label>
      <input class="form-input" name="name" required maxlength="200">
      <label class="form-label">Kontakt</label>
      <input class="form-input" name="contact" maxlength="160">
      <label class="form-label">Email</label>
      <input class="form-input" name="email" type="email" maxlength="200">
      <label class="form-label">Telefon</label>
      <input class="form-input" name="phone" maxlength="80">
      <label class="form-label">Napomena</label>
      <textarea class="form-input" name="notes" rows="2"></textarea>
      <div class="kadr-modal-actions" style="margin-top:14px">
        <button type="button" class="btn" id="mntSupplierCancel" style="background:var(--surface3)">Otkaži</button>
        <button type="submit" class="btn">Dodaj</button>
      </div>
    </form>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#mntSupplierCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntSupplierForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const row = await insertMaintSupplier({
      name: String(fd.get('name') || '').trim(),
      contact: String(fd.get('contact') || '').trim() || null,
      email: String(fd.get('email') || '').trim() || null,
      phone: String(fd.get('phone') || '').trim() || null,
      notes: String(fd.get('notes') || '').trim() || null,
    });
    if (!row) {
      const err = wrap.querySelector('#mntSupplierErr');
      if (err) err.textContent = 'Dodavanje nije uspelo (RLS ili duplikat naziva).';
      return;
    }
    showToast('✅ Dobavljač dodat');
    close();
    onSaved?.();
  });
}

function openStockModal({ part, onSaved }) {
  const wrap = document.createElement('div');
  wrap.className = 'kadr-modal-overlay';
  wrap.innerHTML = `<div class="kadr-modal" style="max-width:520px">
    <div class="kadr-modal-title">Promena zalihe</div>
    <div class="kadr-modal-subtitle">${escHtml(part.part_code)} · ${escHtml(part.name)}</div>
    <div class="kadr-modal-err" id="mntStockErr"></div>
    <form id="mntStockForm">
      <label class="form-label">Tip promene</label>
      <select class="form-input" name="movement_type">
        <option value="in">Ulaz</option>
        <option value="out">Izlaz</option>
        <option value="return">Povrat</option>
        <option value="adjustment">Korekcija (+/-)</option>
      </select>
      <label class="form-label">Količina *</label>
      <input class="form-input" name="quantity" type="number" step="0.0001" required>
      <label class="form-label">Jedinična cena</label>
      <input class="form-input" name="unit_cost" type="number" step="0.01" min="0" value="${escHtml(part.unit_cost ?? '')}">
      <label class="form-label">Napomena</label>
      <textarea class="form-input" name="note" rows="2"></textarea>
      <div class="kadr-modal-actions" style="margin-top:14px">
        <button type="button" class="btn" id="mntStockCancel" style="background:var(--surface3)">Otkaži</button>
        <button type="submit" class="btn">Upiši promenu</button>
      </div>
    </form>
  </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#mntStockCancel')?.addEventListener('click', close);
  wrap.querySelector('#mntStockForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const movementType = String(fd.get('movement_type') || 'adjustment');
    const quantity = Number(fd.get('quantity'));
    const row = await insertMaintPartStockMovement({
      part_id: part.part_id,
      movement_type: movementType,
      quantity,
      unit_cost: fd.get('unit_cost') ? Number(fd.get('unit_cost')) : null,
      note: String(fd.get('note') || '').trim() || null,
    });
    if (!row) {
      const err = wrap.querySelector('#mntStockErr');
      if (err) err.textContent = 'Upis nije uspeo (RLS ili nevalidna količina).';
      return;
    }
    showToast('✅ Zaliha ažurirana');
    close();
    onSaved?.();
  });
}

function movementLabel(t) {
  return { in: 'Ulaz', out: 'Izlaz', adjustment: 'Korekcija', return: 'Povrat' }[t] || t || '—';
}

/**
 * @param {HTMLElement} host
 * @param {{ prof: object|null }} opts
 */
export async function renderMaintInventoryPanel(host, opts) {
  const state = { q: '', lowOnly: false };
  const canEdit = canManageInventory(opts.prof);
  const canMove = canMoveStock(opts.prof);
  let suppliers = [];
  let movements = [];

  const load = async () => {
    host.innerHTML = `<div class="mnt-panel"><p class="mnt-muted">Učitavam zalihe…</p></div>`;
    const [partsRows, suppliersRows, movementRows] = await Promise.all([
      fetchMaintParts({ limit: 1000 }),
      fetchMaintSuppliers({ limit: 500 }),
      fetchMaintPartStockMovements({ limit: 12 }),
    ]);
    suppliers = suppliersRows;
    movements = movementRows;
    render(partsRows);
  };

  const render = partsRows => {
    const q = state.q.trim().toLowerCase();
    const rows = partsRows.filter(p => {
      if (state.lowOnly && !(num(p.current_stock) <= num(p.min_stock))) return false;
      if (!q) return true;
      return `${p.part_code} ${p.name} ${p.manufacturer || ''} ${p.model || ''} ${supplierName(p)}`.toLowerCase().includes(q);
    });
    const low = partsRows.filter(p => num(p.current_stock) <= num(p.min_stock));
    const value = partsRows.reduce((sum, p) => sum + num(p.current_stock) * num(p.unit_cost), 0);
    const tableRows = rows.map(p => {
      const lowCls = num(p.current_stock) <= num(p.min_stock) ? 'mnt-badge mnt-badge--degraded' : 'mnt-badge mnt-badge--running';
      return `<tr data-mnt-part-id="${escHtml(p.part_id)}">
        <td><strong>${escHtml(p.part_code)}</strong><div class="mnt-muted">${escHtml(p.name)}</div></td>
        <td>${escHtml(supplierName(p))}</td>
        <td>${escHtml(p.manufacturer || '—')} ${p.model ? `· ${escHtml(p.model)}` : ''}</td>
        <td><span class="${lowCls}">${escHtml(fmt(p.current_stock))} ${escHtml(p.unit || '')}</span><div class="mnt-muted">min ${escHtml(fmt(p.min_stock))}</div></td>
        <td>${escHtml(money(p.unit_cost))}</td>
        <td>${canMove ? `<button type="button" class="btn btn-xs" data-mnt-stock="${escHtml(p.part_id)}">Zaliha</button>` : ''} ${canEdit ? `<button type="button" class="btn btn-xs" data-mnt-part-edit="${escHtml(p.part_id)}">Izmeni</button>` : ''}</td>
      </tr>`;
    }).join('');
    const movementHtml = movements.map(m => `<li class="mnt-dash-mini-row">
      <span>${escHtml(m.maint_parts?.part_code || '')} · ${escHtml(m.maint_parts?.name || '')}</span>
      <span>${escHtml(movementLabel(m.movement_type))} ${escHtml(fmt(m.quantity))}</span>
      <span class="mnt-muted">${escHtml(String(m.created_at || '').replace('T', ' ').slice(0, 16))}</span>
    </li>`).join('');

    host.innerHTML = `
      <div class="mnt-assets-head">
        <div>
          <h3 style="font-size:16px;margin:0 0 4px">Zalihe i dobavljači</h3>
          <p class="mnt-muted" style="margin:0">Katalog delova, minimalne zalihe, dobavljači i kretanja zaliha.</p>
        </div>
        <div class="mnt-report-actions">
          ${canEdit ? '<button type="button" class="btn btn-xs" id="mntSupplierAdd">+ Dobavljač</button><button type="button" class="btn btn-xs" id="mntPartAdd">+ Deo</button>' : ''}
          <button type="button" class="btn btn-xs" id="mntPartsCsv">Export CSV</button>
        </div>
      </div>
      <div class="mnt-kpi-row">
        <button type="button" class="mnt-kpi ${low.length ? 'mnt-kpi--late' : 'mnt-kpi--zero'}" id="mntLowOnlyKpi"><span class="mnt-kpi-label">Ispod minimuma</span><span class="mnt-kpi-val">${escHtml(String(low.length))}</span></button>
        <div class="mnt-kpi"><span class="mnt-kpi-label">Ukupno delova</span><span class="mnt-kpi-val">${escHtml(String(partsRows.length))}</span></div>
        <div class="mnt-kpi"><span class="mnt-kpi-label">Vrednost zaliha</span><span class="mnt-kpi-val">${escHtml(money(value))}</span></div>
        <div class="mnt-kpi"><span class="mnt-kpi-label">Dobavljači</span><span class="mnt-kpi-val">${escHtml(String(suppliers.length))}</span></div>
      </div>
      <div class="mnt-asset-toolbar">
        <input class="form-input" id="mntPartSearch" placeholder="Pretraga dela, šifre, dobavljača…" value="${escHtml(state.q)}">
        <label class="mnt-wo-check"><input type="checkbox" id="mntLowOnly" ${state.lowOnly ? 'checked' : ''}> Samo ispod minimuma</label>
        <span class="mnt-muted">${rows.length} od ${partsRows.length}</span>
      </div>
      <div class="mnt-doc-layout">
        <section>
          <div class="mnt-table-wrap">
            <table class="mnt-table">
              <thead><tr><th>Deo</th><th>Dobavljač</th><th>Model</th><th>Zaliha</th><th>Cena</th><th>Akcije</th></tr></thead>
              <tbody>${tableRows || '<tr><td colspan="6" class="mnt-muted">Nema delova za prikaz.</td></tr>'}</tbody>
            </table>
          </div>
        </section>
        <aside class="mnt-dash-card">
          <div class="mnt-att-head"><h3>Poslednja kretanja</h3><span class="mnt-muted">${movements.length}</span></div>
          <ul class="mnt-dash-mini-list">${movementHtml || '<li class="mnt-muted">Nema kretanja.</li>'}</ul>
        </aside>
      </div>`;

    host.querySelector('#mntPartSearch')?.addEventListener('input', e => {
      state.q = e.target.value || '';
      render(partsRows);
    });
    host.querySelector('#mntLowOnly')?.addEventListener('change', e => {
      state.lowOnly = !!e.target.checked;
      render(partsRows);
    });
    host.querySelector('#mntLowOnlyKpi')?.addEventListener('click', () => {
      state.lowOnly = !state.lowOnly;
      render(partsRows);
    });
    host.querySelector('#mntPartAdd')?.addEventListener('click', () => openPartModal({ suppliers, onSaved: load }));
    host.querySelector('#mntSupplierAdd')?.addEventListener('click', () => openSupplierModal({ onSaved: load }));
    host.querySelectorAll('[data-mnt-part-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const part = partsRows.find(p => p.part_id === btn.getAttribute('data-mnt-part-edit'));
        if (part) openPartModal({ row: part, suppliers, onSaved: load });
      });
    });
    host.querySelectorAll('[data-mnt-stock]').forEach(btn => {
      btn.addEventListener('click', () => {
        const part = partsRows.find(p => p.part_id === btn.getAttribute('data-mnt-stock'));
        if (part) openStockModal({ part, onSaved: load });
      });
    });
    host.querySelector('#mntPartsCsv')?.addEventListener('click', () => {
      const headers = ['part_code', 'name', 'supplier', 'unit', 'current_stock', 'min_stock', 'unit_cost', 'manufacturer', 'model'];
      const data = rows.map(p => [p.part_code, p.name, supplierName(p), p.unit, p.current_stock, p.min_stock, p.unit_cost, p.manufacturer, p.model]);
      downloadCsv(CSV_BOM + rowsToCsv(headers, data), `odrzavanje_zalihe_${new Date().toISOString().slice(0, 10)}.csv`);
      showToast('✅ CSV izvezen');
    });
  };

  await load();
}
