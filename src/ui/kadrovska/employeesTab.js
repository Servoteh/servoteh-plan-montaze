/**
 * Kadrovska — TAB Zaposleni.
 *
 * Bit-paritetan port iz legacy/index.html (renderKadrovska + openEmployeeModal +
 * submitEmployeeForm + confirmDeleteEmployee). Razlike u ponašanju nema —
 * samo razdvojeno na ES module + addEventListener umesto inline onclick.
 *
 * Public API:
 *   renderEmployeesTab() → HTML stringa za telo panela (mount-uje root)
 *   wireEmployeesTab(panelEl, { onChange }) → veže event listener-e
 *   refreshEmployeesTab() → ponovni render trenutno mount-ovanog panela
 *
 * Modal-i: kreiraju se on-demand (nije globalan u DOM-u) — clean teardown.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import { canEdit, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../lib/constants.js';
import {
  kadrovskaState,
  saveEmployeesCache,
} from '../../state/kadrovska.js';
import {
  saveEmployeeToDb,
  deleteEmployeeFromDb,
  mapDbEmployee,
} from '../../services/employees.js';
import {
  ensureEmployeesLoaded,
  uniqueDepartments,
} from '../../services/kadrovska.js';
import { renderSummaryChips } from './shared.js';

let panelRef = null;
let onChangeCb = null;

/* ── HTML šabloni ── */

export function renderEmployeesTab() {
  return `
    <div class="kadr-summary-strip" id="empSummary"></div>
    <div class="kadrovska-toolbar">
      <input type="text" class="kadrovska-search" id="kadrovskaSearch" placeholder="Pretraga po imenu, poziciji, email-u…">
      <select class="kadrovska-filter" id="kadrovskaDeptFilter">
        <option value="">Sva odeljenja</option>
      </select>
      <select class="kadrovska-filter" id="kadrovskaStatusFilter">
        <option value="">Svi statusi</option>
        <option value="active">Aktivni</option>
        <option value="inactive">Neaktivni</option>
      </select>
      <div class="kadrovska-toolbar-spacer"></div>
      <span class="kadrovska-count" id="kadrovskaCount">0 zaposlenih</span>
      <button class="btn btn-primary" id="kadrovskaAddBtn">+ Novi zaposleni</button>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table" id="kadrovskaTable">
        <thead>
          <tr>
            <th>Ime i prezime</th>
            <th>Pozicija</th>
            <th class="col-hide-sm">Odeljenje</th>
            <th class="col-hide-sm">Telefon</th>
            <th class="col-hide-sm">Email</th>
            <th class="col-hide-sm">Zaposlen od</th>
            <th>Status</th>
            <th class="col-actions">Akcije</th>
          </tr>
        </thead>
        <tbody id="kadrovskaTbody"></tbody>
      </table>
      <div class="kadrovska-empty" id="kadrovskaEmpty" style="display:none;margin-top:16px;">
        <div class="kadrovska-empty-title">Nema zaposlenih</div>
        <div>Dodaj prvog zaposlenog preko dugmeta <strong>+ Novi zaposleni</strong>.</div>
      </div>
    </main>`;
}

/* ── Wire događaji + prvo renderovanje ── */

export async function wireEmployeesTab(panelEl, { onChange } = {}) {
  panelRef = panelEl;
  onChangeCb = onChange || null;

  /* Filteri / search → re-render */
  panelEl.querySelector('#kadrovskaSearch').addEventListener('input', refreshEmployeesTab);
  panelEl.querySelector('#kadrovskaDeptFilter').addEventListener('change', refreshEmployeesTab);
  panelEl.querySelector('#kadrovskaStatusFilter').addEventListener('change', refreshEmployeesTab);
  panelEl.querySelector('#kadrovskaAddBtn').addEventListener('click', () => openEmployeeModal(null));

  /* Učitaj iz Supabase + prikaži */
  await ensureEmployeesLoaded(true);
  refreshEmployeesTab();
}

/** Filtriraj listu po trenutnom search-u + dept + status. */
function applyFilters(list) {
  if (!panelRef) return list;
  const q = (panelRef.querySelector('#kadrovskaSearch')?.value || '').trim().toLowerCase();
  const dept = panelRef.querySelector('#kadrovskaDeptFilter')?.value || '';
  const status = panelRef.querySelector('#kadrovskaStatusFilter')?.value || '';
  return list.filter(e => {
    if (dept && e.department !== dept) return false;
    if (status === 'active' && !e.isActive) return false;
    if (status === 'inactive' && e.isActive) return false;
    if (q) {
      const hay = [e.fullName, e.position, e.department, e.email, e.phone, e.note].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function refreshEmployeesTab() {
  if (!panelRef) return;
  const tbody = panelRef.querySelector('#kadrovskaTbody');
  const emptyBox = panelRef.querySelector('#kadrovskaEmpty');
  const countEl = panelRef.querySelector('#kadrovskaCount');
  const addBtn = panelRef.querySelector('#kadrovskaAddBtn');

  if (addBtn) {
    const edit = canEdit();
    addBtn.disabled = !edit;
    addBtn.style.opacity = edit ? '1' : '0.55';
    addBtn.style.cursor = edit ? 'pointer' : 'not-allowed';
    addBtn.title = edit ? '' : 'Samo PM/LeadPM može da dodaje';
  }

  /* Populate department filter (preserve prev value) */
  const deptSel = panelRef.querySelector('#kadrovskaDeptFilter');
  if (deptSel) {
    const curr = deptSel.value;
    const opts = ['<option value="">Sva odeljenja</option>']
      .concat(uniqueDepartments().map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`));
    deptSel.innerHTML = opts.join('');
    if (curr && Array.from(deptSel.options).some(o => o.value === curr)) deptSel.value = curr;
  }

  const filtered = applyFilters(kadrovskaState.employees);

  /* Top-tab badge sync */
  const tabBadge = document.getElementById('kadrTabCountEmployees');
  if (tabBadge) tabBadge.textContent = String(kadrovskaState.employees.length);

  /* Summary chips */
  const totAll = kadrovskaState.employees.length;
  const totActive = kadrovskaState.employees.filter(e => e.isActive).length;
  const totInactive = totAll - totActive;
  renderSummaryChips('empSummary', [
    { label: 'Ukupno', value: totAll, tone: 'accent' },
    { label: 'Aktivni', value: totActive, tone: 'ok' },
    { label: 'Neaktivni', value: totInactive, tone: 'muted' },
  ]);

  if (countEl) {
    countEl.textContent = filtered.length === totAll
      ? `${totAll} zaposlenih`
      : `${filtered.length} / ${totAll} zaposlenih`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (emptyBox) {
      emptyBox.style.display = 'block';
      emptyBox.querySelector('.kadrovska-empty-title').textContent =
        kadrovskaState.employees.length === 0
          ? 'Nema zaposlenih'
          : 'Nijedan rezultat ne odgovara filterima';
    }
    return;
  }
  if (emptyBox) emptyBox.style.display = 'none';

  const edit = canEdit();
  tbody.innerHTML = filtered.map(e => {
    const sub = [e.email, e.phone].filter(x => x).join(' · ');
    const hireStr = e.hireDate ? formatDate(e.hireDate) : '—';
    const statusCls = e.isActive ? 'active' : 'inactive';
    const statusTxt = e.isActive ? 'Aktivan' : 'Neaktivan';
    const rowId = escHtml(e.id || '');
    return `<tr data-id="${rowId}">
      <td>
        <div class="emp-name">${escHtml(e.fullName || '—')}</div>
        ${sub ? `<div class="emp-sub col-hide-sm">${escHtml(sub)}</div>` : ''}
      </td>
      <td>${escHtml(e.position || '—')}</td>
      <td class="col-hide-sm">${escHtml(e.department || '—')}</td>
      <td class="col-hide-sm">${escHtml(e.phone || '—')}</td>
      <td class="col-hide-sm">${escHtml(e.email || '—')}</td>
      <td class="col-hide-sm">${hireStr}</td>
      <td><span class="emp-status-badge ${statusCls}">${statusTxt}</span></td>
      <td class="col-actions">
        <button class="btn-row-act" data-action="edit" data-id="${rowId}" ${edit ? '' : 'disabled'} title="${edit ? 'Izmeni' : 'Samo pregled'}">Izmeni</button>
        <button class="btn-row-act danger" data-action="delete" data-id="${rowId}" ${edit ? '' : 'disabled'} title="${edit ? 'Obriši' : 'Samo pregled'}">Obriši</button>
      </td>
    </tr>`;
  }).join('');

  /* Wire row akcije (event delegation bi bio elegantniji, ali ova je čistija) */
  tbody.querySelectorAll('button[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => openEmployeeModal(btn.dataset.id));
  });
  tbody.querySelectorAll('button[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => confirmDeleteEmployee(btn.dataset.id));
  });

  onChangeCb?.();
}

/* ═══════════════════════════════════════════════════════════
   EMPLOYEE MODAL
   ═══════════════════════════════════════════════════════════ */

function buildEmployeeModalHtml(emp) {
  const isEdit = !!emp;
  return `
    <div class="emp-modal-overlay" id="empModal" role="dialog" aria-labelledby="empModalTitle" aria-modal="true">
      <div class="emp-modal">
        <div class="emp-modal-title" id="empModalTitle">${isEdit ? 'Izmeni zaposlenog' : 'Novi zaposleni'}</div>
        <div class="emp-modal-subtitle">Popuni osnovne podatke. Samo Ime i prezime je obavezno.</div>
        <div class="emp-modal-err" id="empModalErr"></div>

        <form id="empForm">
          <input type="hidden" id="empId" value="${escHtml(emp?.id || '')}">
          <div class="emp-form-grid">
            <div class="emp-field col-full">
              <label for="empFullName">Ime i prezime *</label>
              <input type="text" id="empFullName" required maxlength="120" placeholder="npr. Dejan Ćirković" value="${escHtml(emp?.fullName || '')}">
            </div>
            <div class="emp-field">
              <label for="empPosition">Pozicija</label>
              <input type="text" id="empPosition" list="empPositionList" maxlength="80" placeholder="npr. Vođa montaže" value="${escHtml(emp?.position || '')}">
              <datalist id="empPositionList">
                <option value="Odg. inženjer"></option>
                <option value="Vođa montaže"></option>
                <option value="Inženjer"></option>
                <option value="Montažer"></option>
                <option value="Zavarivač"></option>
                <option value="Električar"></option>
                <option value="Admin"></option>
              </datalist>
            </div>
            <div class="emp-field">
              <label for="empDepartment">Odeljenje</label>
              <input type="text" id="empDepartment" list="empDepartmentList" maxlength="80" placeholder="npr. Montaža" value="${escHtml(emp?.department || '')}">
              <datalist id="empDepartmentList">
                <option value="Montaža"></option>
                <option value="Elektro"></option>
                <option value="Proizvodnja"></option>
                <option value="Projektovanje"></option>
                <option value="Administracija"></option>
              </datalist>
            </div>
            <div class="emp-field">
              <label for="empPhone">Telefon</label>
              <input type="tel" id="empPhone" maxlength="40" placeholder="npr. 064 123 4567" value="${escHtml(emp?.phone || '')}">
            </div>
            <div class="emp-field">
              <label for="empEmail">Email</label>
              <input type="email" id="empEmail" maxlength="120" placeholder="ime@servoteh.rs" value="${escHtml(emp?.email || '')}">
            </div>
            <div class="emp-field">
              <label for="empHireDate">Zaposlen od</label>
              <input type="date" id="empHireDate" value="${escHtml(emp?.hireDate || '')}">
            </div>
            <div class="emp-field emp-field-check">
              <input type="checkbox" id="empIsActive" ${emp ? (emp.isActive !== false ? 'checked' : '') : 'checked'}>
              <label for="empIsActive">Aktivan zaposleni</label>
            </div>
            <div class="emp-field col-full">
              <label for="empNote">Napomena</label>
              <textarea id="empNote" maxlength="500" placeholder="Opcioni komentar…">${escHtml(emp?.note || '')}</textarea>
            </div>
          </div>
          <div class="emp-modal-actions">
            <button type="button" class="btn" id="empCancelBtn">Otkaži</button>
            <button type="submit" class="btn btn-primary" id="empSubmitBtn">Sačuvaj</button>
          </div>
        </form>
      </div>
    </div>`;
}

function closeEmployeeModal() {
  document.getElementById('empModal')?.remove();
}

function openEmployeeModal(id) {
  if (!canEdit()) {
    showToast('⚠ Samo PM/LeadPM može da dodaje/menja');
    return;
  }
  closeEmployeeModal(); // garantuje samo jedan modal u DOM-u

  let emp = null;
  if (id) {
    emp = kadrovskaState.employees.find(x => x.id === id);
    if (!emp) {
      showToast('⚠ Zaposleni nije pronađen');
      return;
    }
  }

  const wrap = document.createElement('div');
  wrap.innerHTML = buildEmployeeModalHtml(emp);
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById('empModal');
  const form = modal.querySelector('#empForm');
  const cancelBtn = modal.querySelector('#empCancelBtn');

  cancelBtn.addEventListener('click', closeEmployeeModal);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitEmployeeForm();
  });

  /* Klik van modal-a → close (legacy isto ima taj UX) */
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) closeEmployeeModal();
  });

  setTimeout(() => modal.querySelector('#empFullName')?.focus(), 50);
}

async function submitEmployeeForm() {
  const errEl = document.getElementById('empModalErr');
  const btn = document.getElementById('empSubmitBtn');
  errEl.textContent = '';
  errEl.classList.remove('visible');

  const fullName = document.getElementById('empFullName').value.trim();
  if (!fullName) {
    errEl.textContent = 'Ime i prezime je obavezno.';
    errEl.classList.add('visible');
    return;
  }
  const id = document.getElementById('empId').value || null;
  const payload = {
    id,
    fullName,
    position: document.getElementById('empPosition').value.trim(),
    department: document.getElementById('empDepartment').value.trim(),
    phone: document.getElementById('empPhone').value.trim(),
    email: document.getElementById('empEmail').value.trim().toLowerCase(),
    hireDate: document.getElementById('empHireDate').value || null,
    isActive: document.getElementById('empIsActive').checked,
    note: document.getElementById('empNote').value.trim(),
  };

  /* Duplicate email check (case-insensitive, exclude self). */
  if (payload.email) {
    const dup = kadrovskaState.employees.find(e => e.id !== id && e.email && e.email.toLowerCase() === payload.email);
    if (dup) {
      errEl.textContent = 'Email već koristi zaposleni: ' + (dup.fullName || dup.email);
      errEl.classList.add('visible');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Čuvanje…';
  try {
    if (getIsOnline() && hasSupabaseConfig()) {
      const res = await saveEmployeeToDb(payload);
      if (!res || !res.length) {
        errEl.textContent = 'Supabase nije uspeo da sačuva. Proveri da li je migracija primenjena (sql/migrations/add_kadrovska_module.sql).';
        errEl.classList.add('visible');
        return;
      }
      const saved = mapDbEmployee(res[0]);
      const idx = kadrovskaState.employees.findIndex(e => e.id === saved.id);
      if (idx >= 0) kadrovskaState.employees[idx] = saved;
      else kadrovskaState.employees.push(saved);
    } else {
      /* Offline: dodeli local UUID novim zapisima. */
      if (!payload.id) {
        payload.id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      }
      const idx = kadrovskaState.employees.findIndex(e => e.id === payload.id);
      if (idx >= 0) kadrovskaState.employees[idx] = payload;
      else kadrovskaState.employees.push(payload);
    }
    kadrovskaState.employees.sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'sr'));
    saveEmployeesCache(kadrovskaState.employees);
    closeEmployeeModal();
    refreshEmployeesTab();
    showToast(id ? '✏️ Zaposleni izmenjen' : '✅ Zaposleni dodat');
  } catch (e) {
    console.error('[kadrovska] submit error', e);
    errEl.textContent = 'Greška pri čuvanju. Vidi konzolu.';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sačuvaj';
  }
}

async function confirmDeleteEmployee(id) {
  if (!canEdit()) {
    showToast('⚠ Samo PM/LeadPM može da briše');
    return;
  }
  const emp = kadrovskaState.employees.find(e => e.id === id);
  if (!emp) return;
  if (!confirm(`Obrisati zaposlenog "${emp.fullName}"?\nOva akcija je trajna.`)) return;
  try {
    if (getIsOnline() && hasSupabaseConfig() && !String(id).startsWith('local_')) {
      const ok = await deleteEmployeeFromDb(id);
      if (!ok) {
        showToast('⚠ Supabase brisanje nije uspelo');
        return;
      }
    }
    kadrovskaState.employees = kadrovskaState.employees.filter(e => e.id !== id);
    saveEmployeesCache(kadrovskaState.employees);
    refreshEmployeesTab();
    showToast('🗑 Zaposleni obrisan');
  } catch (e) {
    console.error('[kadrovska] delete error', e);
    showToast('⚠ Greška pri brisanju');
  }
}
