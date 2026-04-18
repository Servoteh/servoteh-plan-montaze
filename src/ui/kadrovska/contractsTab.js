/**
 * Kadrovska — TAB Ugovori.
 *
 * Bit-paritetan port iz legacy/index.html (renderContracts + openContractModal +
 * submitContractForm + confirmDeleteContract + _kadrContractStatus).
 *
 * Dodatne funkcionalnosti:
 *  - Status kalkulacija: active / expiring (<30d) / expired / inactive
 *  - Vizuelna oznaka isteka (row-expiring / row-expired)
 *  - Filter po statusu (active default — vidiš ono što je relevantno)
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate, formatYMD, daysInclusive } from '../../lib/date.js';
import { canEdit, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig, KADR_CON_TYPE_LABELS } from '../../lib/constants.js';
import {
  kadrovskaState,
  kadrContractsState,
  saveContractsCache,
} from '../../state/kadrovska.js';
import {
  saveContractToDb,
  updateContractInDb,
  deleteContractFromDb,
  mapDbContract,
} from '../../services/contracts.js';
import {
  ensureContractsLoaded,
  ensureEmployeesLoaded,
  employeeNameById,
} from '../../services/kadrovska.js';
import { renderSummaryChips, employeeOptionsHtml } from './shared.js';

let panelRef = null;

const CON_TYPE_OPTS = [
  { v: 'neodredjeno', l: 'Neodređeno vreme' },
  { v: 'odredjeno', l: 'Određeno vreme' },
  { v: 'privremeno', l: 'Privremeni' },
  { v: 'delo', l: 'Ugovor o delu' },
  { v: 'student', l: 'Student' },
  { v: 'praksa', l: 'Praksa' },
  { v: 'ostalo', l: 'Ostalo' },
];

/** Vrati { key, label, cls, days? } na osnovu trenutnog datuma. */
function contractStatus(c) {
  const now = new Date();
  const todayStr = formatYMD(now.getFullYear(), now.getMonth(), now.getDate());
  if (!c.isActive) return { key: 'inactive', label: 'Neaktivan', cls: 'inactive' };
  if (c.dateTo) {
    if (c.dateTo < todayStr) return { key: 'expired', label: 'Istekao', cls: 'expired' };
    const diff = daysInclusive(todayStr, c.dateTo) - 1;
    if (diff <= 30) return { key: 'expiring', label: `Ističe za ${diff} d`, cls: 'expiring', days: diff };
  }
  return { key: 'active', label: 'Aktivan', cls: 'active' };
}

export function renderContractsTab() {
  return `
    <div class="kadr-summary-strip" id="conSummary"></div>
    <div class="kadrovska-toolbar">
      <select class="kadrovska-filter" id="conEmpFilter">
        <option value="">Svi zaposleni</option>
      </select>
      <select class="kadrovska-filter" id="conTypeFilter">
        <option value="">Svi tipovi</option>
        ${CON_TYPE_OPTS.map(o => `<option value="${o.v}">${escHtml(o.l)}</option>`).join('')}
      </select>
      <select class="kadrovska-filter" id="conStatusFilter">
        <option value="active" selected>Aktivni</option>
        <option value="all">Svi</option>
        <option value="inactive">Neaktivni</option>
        <option value="expiring">Ističu &lt; 30 dana</option>
        <option value="expired">Istekli</option>
      </select>
      <div class="kadrovska-toolbar-spacer"></div>
      <span class="kadrovska-count" id="conCount">0 ugovora</span>
      <button class="btn btn-primary" id="conAddBtn">+ Novi ugovor</button>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table" id="conTable">
        <thead>
          <tr>
            <th>Zaposleni</th>
            <th>Tip</th>
            <th class="col-hide-sm">Br. ugovora</th>
            <th class="col-hide-sm">Pozicija</th>
            <th>Od</th>
            <th>Do</th>
            <th>Status</th>
            <th class="col-actions">Akcije</th>
          </tr>
        </thead>
        <tbody id="conTbody"></tbody>
      </table>
      <div class="kadrovska-empty" id="conEmpty" style="display:none;margin-top:16px;">
        <div class="kadrovska-empty-title">Nema ugovora</div>
        <div>Dodaj prvi ugovor preko dugmeta <strong>+ Novi ugovor</strong>.</div>
      </div>
    </main>`;
}

export async function wireContractsTab(panelEl) {
  panelRef = panelEl;
  panelEl.querySelector('#conEmpFilter').addEventListener('change', refreshContractsTab);
  panelEl.querySelector('#conTypeFilter').addEventListener('change', refreshContractsTab);
  panelEl.querySelector('#conStatusFilter').addEventListener('change', refreshContractsTab);
  panelEl.querySelector('#conAddBtn').addEventListener('click', () => openContractModal(null));

  await ensureEmployeesLoaded();
  await ensureContractsLoaded(true);
  refreshContractsTab();
}

function populateEmpFilter() {
  const sel = panelRef?.querySelector('#conEmpFilter');
  if (!sel) return;
  const curr = sel.value;
  sel.innerHTML = '<option value="">Svi zaposleni</option>'
    + employeeOptionsHtml({ includeBlank: false, selectedId: curr });
  if (curr && Array.from(sel.options).some(o => o.value === curr)) sel.value = curr;
}

export function refreshContractsTab() {
  if (!panelRef) return;
  const tbody = panelRef.querySelector('#conTbody');
  const emptyBox = panelRef.querySelector('#conEmpty');
  const countEl = panelRef.querySelector('#conCount');
  const addBtn = panelRef.querySelector('#conAddBtn');

  if (addBtn) {
    const edit = canEdit();
    addBtn.disabled = !edit;
    addBtn.style.opacity = edit ? '1' : '0.55';
    addBtn.style.cursor = edit ? 'pointer' : 'not-allowed';
  }

  populateEmpFilter();
  const empF = panelRef.querySelector('#conEmpFilter')?.value || '';
  const typeF = panelRef.querySelector('#conTypeFilter')?.value || '';
  const statusF = panelRef.querySelector('#conStatusFilter')?.value || 'active';

  const enriched = kadrContractsState.items.map(c => ({ c, status: contractStatus(c) }));
  const filtered = enriched.filter(({ c, status }) => {
    if (empF && c.employeeId !== empF) return false;
    if (typeF && c.type !== typeF) return false;
    if (statusF === 'active' && status.key !== 'active' && status.key !== 'expiring') return false;
    if (statusF === 'inactive' && status.key !== 'inactive') return false;
    if (statusF === 'expiring' && status.key !== 'expiring') return false;
    if (statusF === 'expired' && status.key !== 'expired') return false;
    return true;
  });

  const badge = document.getElementById('kadrTabCountContracts');
  if (badge) badge.textContent = String(kadrContractsState.items.length);

  const total = kadrContractsState.items.length;
  if (countEl) {
    countEl.textContent = filtered.length === total
      ? `${total} ${total === 1 ? 'ugovor' : 'ugovora'}`
      : `${filtered.length} / ${total} ugovora`;
  }

  /* Summary — status breakdown across all contracts */
  let sActive = 0, sExpiring = 0, sExpired = 0, sInactive = 0;
  enriched.forEach(({ status }) => {
    if (status.key === 'active') sActive++;
    else if (status.key === 'expiring') { sExpiring++; sActive++; }
    else if (status.key === 'expired') sExpired++;
    else if (status.key === 'inactive') sInactive++;
  });
  renderSummaryChips('conSummary', [
    { label: 'Ukupno', value: total, tone: 'accent' },
    { label: 'Aktivni', value: sActive, tone: 'ok' },
    { label: 'Ističu < 30 d', value: sExpiring, tone: sExpiring > 0 ? 'warn' : 'muted' },
    { label: 'Istekli', value: sExpired, tone: sExpired > 0 ? 'danger' : 'muted' },
    { label: 'Neaktivni', value: sInactive, tone: 'muted' },
  ]);

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (emptyBox) {
      emptyBox.style.display = 'block';
      emptyBox.querySelector('.kadrovska-empty-title').textContent =
        total === 0 ? 'Nema ugovora' : 'Nijedan rezultat ne odgovara filterima';
    }
    return;
  }
  if (emptyBox) emptyBox.style.display = 'none';

  const edit = canEdit();
  tbody.innerHTML = filtered.map(({ c, status }) => {
    const typeLbl = KADR_CON_TYPE_LABELS[c.type] || c.type;
    const rowCls = status.key === 'expired' ? 'row-expired' : (status.key === 'expiring' ? 'row-expiring' : '');
    const id = escHtml(c.id || '');
    let expiryHint = '';
    if (status.key === 'expiring') expiryHint = `<div class="kadr-expiry-hint warn">ISTIČE ZA ${status.days} DANA</div>`;
    else if (status.key === 'expired') expiryHint = `<div class="kadr-expiry-hint danger">ISTEKAO</div>`;
    const statusBadgeCls = (status.cls === 'expired' || status.cls === 'expiring') ? 'active' : status.cls;
    return `<tr data-id="${id}" class="${rowCls}">
      <td><div class="emp-name">${escHtml(employeeNameById(c.employeeId))}</div></td>
      <td><span class="kadr-type-badge c-${escHtml(c.type)}">${escHtml(typeLbl)}</span></td>
      <td class="col-hide-sm">${escHtml(c.number || '—')}</td>
      <td class="col-hide-sm">${escHtml(c.position || '—')}</td>
      <td>${c.dateFrom ? formatDate(c.dateFrom) : '—'}</td>
      <td>${c.dateTo ? formatDate(c.dateTo) : '—'}${expiryHint}</td>
      <td><span class="emp-status-badge ${statusBadgeCls}" title="${escHtml(status.label)}">${escHtml(status.label)}</span></td>
      <td class="col-actions">
        <button class="btn-row-act" data-action="edit" data-id="${id}" ${edit ? '' : 'disabled'}>Izmeni</button>
        <button class="btn-row-act danger" data-action="delete" data-id="${id}" ${edit ? '' : 'disabled'}>Obriši</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-action="edit"]').forEach(b => {
    b.addEventListener('click', () => openContractModal(b.dataset.id));
  });
  tbody.querySelectorAll('button[data-action="delete"]').forEach(b => {
    b.addEventListener('click', () => confirmDeleteContract(b.dataset.id));
  });
}

/* ── Modal ── */

function buildContractModalHtml(c) {
  const isEdit = !!c;
  return `
    <div class="kadr-modal-overlay" id="conModal" role="dialog" aria-labelledby="conModalTitle" aria-modal="true">
      <div class="kadr-modal">
        <div class="kadr-modal-title" id="conModalTitle">${isEdit ? 'Izmeni ugovor' : 'Novi ugovor'}</div>
        <div class="kadr-modal-subtitle">Datum početka je obavezan. Datum završetka ostavi prazno za neodređeno trajanje. Platu ne čuvamo u ovoj fazi.</div>
        <div class="kadr-modal-err" id="conModalErr"></div>
        <form id="conForm">
          <input type="hidden" id="conId" value="${escHtml(c?.id || '')}">
          <div class="emp-form-grid">
            <div class="emp-field col-full">
              <label for="conEmpId">Zaposleni *</label>
              <select id="conEmpId" required>
                ${employeeOptionsHtml({ includeBlank: true, blankLabel: '— izaberi —', selectedId: c?.employeeId, activeOnly: !isEdit })}
              </select>
            </div>
            <div class="emp-field">
              <label for="conType">Tip ugovora *</label>
              <select id="conType" required>
                ${CON_TYPE_OPTS.map(o => `<option value="${o.v}"${(c?.type || 'neodredjeno') === o.v ? ' selected' : ''}>${escHtml(o.l)}</option>`).join('')}
              </select>
            </div>
            <div class="emp-field">
              <label for="conNumber">Broj ugovora</label>
              <input type="text" id="conNumber" maxlength="60" placeholder="npr. 2025-0123" value="${escHtml(c?.number || '')}">
            </div>
            <div class="emp-field">
              <label for="conPosition">Pozicija</label>
              <input type="text" id="conPosition" list="empPositionList" maxlength="80" placeholder="npr. Vođa montaže" value="${escHtml(c?.position || '')}">
            </div>
            <div class="emp-field">
              <label for="conFrom">Datum od *</label>
              <input type="date" id="conFrom" required value="${escHtml(c?.dateFrom || '')}">
            </div>
            <div class="emp-field">
              <label for="conTo">Datum do <span style="color:var(--text3);font-size:10px;">(opciono)</span></label>
              <input type="date" id="conTo" value="${escHtml(c?.dateTo || '')}">
            </div>
            <div class="emp-field emp-field-check">
              <input type="checkbox" id="conActive" ${c ? (c.isActive !== false ? 'checked' : '') : 'checked'}>
              <label for="conActive">Aktivan ugovor</label>
            </div>
            <div class="emp-field col-full">
              <label for="conNote">Napomena</label>
              <textarea id="conNote" maxlength="500" placeholder="Opcioni komentar…">${escHtml(c?.note || '')}</textarea>
            </div>
          </div>
          <div class="kadr-modal-actions">
            <button type="button" class="btn" id="conCancelBtn">Otkaži</button>
            <button type="submit" class="btn btn-primary" id="conSubmitBtn">Sačuvaj</button>
          </div>
        </form>
      </div>
    </div>`;
}

function closeContractModal() {
  document.getElementById('conModal')?.remove();
}

function openContractModal(id) {
  if (!canEdit()) {
    showToast('⚠ Samo PM/LeadPM može da dodaje/menja');
    return;
  }
  if (kadrovskaState.employees.length === 0) {
    showToast('⚠ Prvo dodaj zaposlenog u tab "Zaposleni"');
    return;
  }
  closeContractModal();
  let c = null;
  if (id) {
    c = kadrContractsState.items.find(x => x.id === id);
    if (!c) { showToast('⚠ Ugovor nije pronađen'); return; }
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = buildContractModalHtml(c);
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById('conModal');
  const form = modal.querySelector('#conForm');
  modal.querySelector('#conCancelBtn').addEventListener('click', closeContractModal);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); submitContractForm(); });
  modal.addEventListener('click', (ev) => { if (ev.target === modal) closeContractModal(); });
  setTimeout(() => modal.querySelector('#conEmpId')?.focus(), 50);
}

async function submitContractForm() {
  const errEl = document.getElementById('conModalErr');
  const btn = document.getElementById('conSubmitBtn');
  errEl.textContent = ''; errEl.classList.remove('visible');

  const empId = document.getElementById('conEmpId').value;
  const type = document.getElementById('conType').value;
  const number = document.getElementById('conNumber').value.trim();
  const position = document.getElementById('conPosition').value.trim();
  const dateFrom = document.getElementById('conFrom').value || null;
  const dateTo = document.getElementById('conTo').value || null;
  const isActive = document.getElementById('conActive').checked;
  const note = document.getElementById('conNote').value.trim();
  const id = document.getElementById('conId').value || null;

  if (!empId) { errEl.textContent = 'Izaberi zaposlenog.'; errEl.classList.add('visible'); return; }
  if (!dateFrom) { errEl.textContent = 'Datum početka ugovora je obavezan.'; errEl.classList.add('visible'); return; }
  if (dateTo && dateTo < dateFrom) {
    errEl.textContent = 'Datum završetka ne može biti pre datuma početka.';
    errEl.classList.add('visible');
    return;
  }

  const payload = { id, employeeId: empId, type, number, position, dateFrom, dateTo, isActive, note };
  btn.disabled = true; btn.textContent = 'Čuvanje…';
  try {
    if (getIsOnline() && hasSupabaseConfig()) {
      let res;
      if (id && !String(id).startsWith('local_')) res = await updateContractInDb(payload);
      else res = await saveContractToDb(payload);
      if (!res || !res.length) {
        errEl.textContent = 'Supabase čuvanje nije uspelo. Primeni migraciju add_kadrovska_phase1.sql.';
        errEl.classList.add('visible');
        return;
      }
      const saved = mapDbContract(res[0]);
      const idx = kadrContractsState.items.findIndex(x => x.id === saved.id);
      if (idx >= 0) kadrContractsState.items[idx] = saved;
      else kadrContractsState.items.unshift(saved);
    } else {
      if (!payload.id) payload.id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const idx = kadrContractsState.items.findIndex(x => x.id === payload.id);
      if (idx >= 0) kadrContractsState.items[idx] = payload;
      else kadrContractsState.items.unshift(payload);
    }
    kadrContractsState.items.sort((a, b) => String(b.dateFrom || '').localeCompare(String(a.dateFrom || '')));
    saveContractsCache(kadrContractsState.items);
    closeContractModal();
    refreshContractsTab();
    showToast(id ? '✏️ Ugovor izmenjen' : '✅ Ugovor dodat');
  } catch (e) {
    console.error('[con] submit', e);
    errEl.textContent = 'Greška pri čuvanju.';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false; btn.textContent = 'Sačuvaj';
  }
}

async function confirmDeleteContract(id) {
  if (!canEdit()) return;
  if (!confirm('Obrisati ugovor?')) return;
  try {
    if (getIsOnline() && hasSupabaseConfig() && !String(id).startsWith('local_')) {
      const ok = await deleteContractFromDb(id);
      if (!ok) { showToast('⚠ Supabase brisanje nije uspelo'); return; }
    }
    kadrContractsState.items = kadrContractsState.items.filter(x => x.id !== id);
    saveContractsCache(kadrContractsState.items);
    refreshContractsTab();
    showToast('🗑 Ugovor obrisan');
  } catch (e) {
    console.error(e);
    showToast('⚠ Greška');
  }
}
