/**
 * Kadrovska — TAB Sati (pojedinačno).
 *
 * Bit-paritetan port iz legacy/index.html (renderWorkHours + openWorkHourModal +
 * submitWorkHourForm + confirmDeleteWorkHour).
 *
 * NAPOMENA: Mesečni grid (Excel-like) je posebna implementacija (F4.2). Ovaj tab
 * koristi tradicionalni "row-per-entry" pristup za retroaktivne ručne unose.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate, formatYMD } from '../../lib/date.js';
import { canEdit, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../lib/constants.js';
import {
  kadrovskaState,
  kadrWorkHoursState,
  saveWorkHoursCache,
} from '../../state/kadrovska.js';
import {
  saveWorkHourToDb,
  updateWorkHourInDb,
  deleteWorkHourFromDb,
  mapDbWorkHour,
} from '../../services/workHours.js';
import {
  ensureWorkHoursLoaded,
  ensureEmployeesLoaded,
  employeeNameById,
} from '../../services/kadrovska.js';
import { renderSummaryChips, employeeOptionsHtml } from './shared.js';

let panelRef = null;

export function renderWorkHoursTab() {
  return `
    <div class="kadr-summary-strip" id="whSummary"></div>
    <div class="kadrovska-toolbar">
      <select class="kadrovska-filter" id="whEmpFilter">
        <option value="">Svi zaposleni</option>
      </select>
      <input type="month" class="kadrovska-filter" id="whMonthFilter" title="Mesec">
      <div class="kadrovska-toolbar-spacer"></div>
      <span class="kadrovska-count" id="whCount">0 unosa</span>
      <button class="btn btn-primary" id="whAddBtn">+ Unesi sate</button>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table" id="whTable">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Zaposleni</th>
            <th>Sati</th>
            <th class="col-hide-sm">Prekovremeni</th>
            <th class="col-hide-sm">Projekat / Napomena</th>
            <th class="col-actions">Akcije</th>
          </tr>
        </thead>
        <tbody id="whTbody"></tbody>
      </table>
      <div class="kadr-totals" id="whTotals" style="display:none;">
        <div class="kadr-total-item">
          <span class="kadr-total-label">Redovni</span>
          <span class="kadr-total-value" id="whTotalRegular">0</span>
        </div>
        <div class="kadr-total-item overtime">
          <span class="kadr-total-label">Prekovremeni</span>
          <span class="kadr-total-value" id="whTotalOvertime">0</span>
        </div>
        <div class="kadr-total-item accent">
          <span class="kadr-total-label">Ukupno</span>
          <span class="kadr-total-value" id="whTotalAll">0</span>
        </div>
        <div class="kadr-total-item">
          <span class="kadr-total-label">Dana</span>
          <span class="kadr-total-value" id="whTotalDays">0</span>
        </div>
      </div>
      <div class="kadrovska-empty" id="whEmpty" style="display:none;margin-top:16px;">
        <div class="kadrovska-empty-title">Nema unetih sati</div>
        <div>Unesi prvi zapis preko dugmeta <strong>+ Unesi sate</strong>.</div>
      </div>
    </main>`;
}

export async function wireWorkHoursTab(panelEl) {
  panelRef = panelEl;
  panelEl.querySelector('#whEmpFilter').addEventListener('change', refreshWorkHoursTab);
  panelEl.querySelector('#whMonthFilter').addEventListener('change', refreshWorkHoursTab);
  panelEl.querySelector('#whAddBtn').addEventListener('click', () => openWorkHourModal(null));

  await ensureEmployeesLoaded();
  await ensureWorkHoursLoaded(true);
  refreshWorkHoursTab();
}

function applyFilters(list) {
  if (!panelRef) return list;
  const empF = panelRef.querySelector('#whEmpFilter')?.value || '';
  const monthF = panelRef.querySelector('#whMonthFilter')?.value || '';
  return list.filter(w => {
    if (empF && w.employeeId !== empF) return false;
    if (monthF && (!w.workDate || w.workDate.slice(0, 7) !== monthF)) return false;
    return true;
  });
}

function populateEmpFilter() {
  const sel = panelRef?.querySelector('#whEmpFilter');
  if (!sel) return;
  const curr = sel.value;
  sel.innerHTML = '<option value="">Svi zaposleni</option>'
    + employeeOptionsHtml({ includeBlank: false, selectedId: curr });
  if (curr && Array.from(sel.options).some(o => o.value === curr)) sel.value = curr;
}

export function refreshWorkHoursTab() {
  if (!panelRef) return;
  const tbody = panelRef.querySelector('#whTbody');
  const emptyBox = panelRef.querySelector('#whEmpty');
  const countEl = panelRef.querySelector('#whCount');
  const totalsBox = panelRef.querySelector('#whTotals');
  const addBtn = panelRef.querySelector('#whAddBtn');

  if (addBtn) {
    const edit = canEdit();
    addBtn.disabled = !edit;
    addBtn.style.opacity = edit ? '1' : '0.55';
    addBtn.style.cursor = edit ? 'pointer' : 'not-allowed';
  }

  populateEmpFilter();
  const filtered = applyFilters(kadrWorkHoursState.items);

  const badge = document.getElementById('kadrTabCountHours');
  if (badge) badge.textContent = String(kadrWorkHoursState.items.length);

  const total = kadrWorkHoursState.items.length;
  if (countEl) {
    countEl.textContent = filtered.length === total
      ? `${total} ${total === 1 ? 'unos' : 'unosa'}`
      : `${filtered.length} / ${total} unosa`;
  }

  /* Summary — tekući mesec */
  const _now = new Date();
  const _curMonth = String(_now.getFullYear()) + '-' + String(_now.getMonth() + 1).padStart(2, '0');
  let curH = 0, curOt = 0;
  const curEmpSet = new Set();
  kadrWorkHoursState.items.forEach(w => {
    if (!w.workDate || w.workDate.slice(0, 7) !== _curMonth) return;
    curH += Number(w.hours || 0);
    curOt += Number(w.overtimeHours || 0);
    if (w.employeeId) curEmpSet.add(w.employeeId);
  });
  renderSummaryChips('whSummary', [
    { label: 'Ukupno unosa', value: total, tone: 'accent' },
    { label: 'Redovnih sati (mesec)', value: curH.toFixed(2), tone: 'accent' },
    { label: 'Prekovremenih (mesec)', value: curOt.toFixed(2), tone: curOt > 0 ? 'warn' : 'muted' },
    { label: 'Zaposlenih (mesec)', value: curEmpSet.size, tone: 'muted' },
  ]);

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (totalsBox) totalsBox.style.display = 'none';
    if (emptyBox) {
      emptyBox.style.display = 'block';
      emptyBox.querySelector('.kadrovska-empty-title').textContent =
        total === 0 ? 'Nema unetih sati' : 'Nijedan rezultat ne odgovara filterima';
    }
    return;
  }
  if (emptyBox) emptyBox.style.display = 'none';

  let totReg = 0, totOt = 0;
  const uniqDays = new Set();
  const edit = canEdit();
  tbody.innerHTML = filtered.map(w => {
    totReg += Number(w.hours || 0);
    totOt += Number(w.overtimeHours || 0);
    if (w.workDate && w.employeeId) uniqDays.add(w.employeeId + '|' + w.workDate);
    const id = escHtml(w.id || '');
    const sub = [w.projectRef, w.note].filter(x => x).join(' · ');
    return `<tr data-id="${id}">
      <td><strong>${w.workDate ? formatDate(w.workDate) : '—'}</strong></td>
      <td><div class="emp-name">${escHtml(employeeNameById(w.employeeId))}</div></td>
      <td><span style="font-family:var(--mono);font-weight:600;">${Number(w.hours || 0).toFixed(2)}</span></td>
      <td class="col-hide-sm">${Number(w.overtimeHours || 0) > 0 ? `<span style="color:#F2994A;font-family:var(--mono);font-weight:600;">+${Number(w.overtimeHours).toFixed(2)}</span>` : '—'}</td>
      <td class="col-hide-sm">${escHtml(sub || '—')}</td>
      <td class="col-actions">
        <button class="btn-row-act" data-action="edit" data-id="${id}" ${edit ? '' : 'disabled'}>Izmeni</button>
        <button class="btn-row-act danger" data-action="delete" data-id="${id}" ${edit ? '' : 'disabled'}>Obriši</button>
      </td>
    </tr>`;
  }).join('');

  if (totalsBox) {
    totalsBox.style.display = 'flex';
    panelRef.querySelector('#whTotalRegular').textContent = totReg.toFixed(2);
    panelRef.querySelector('#whTotalOvertime').textContent = totOt.toFixed(2);
    panelRef.querySelector('#whTotalAll').textContent = (totReg + totOt).toFixed(2);
    panelRef.querySelector('#whTotalDays').textContent = String(uniqDays.size);
  }

  tbody.querySelectorAll('button[data-action="edit"]').forEach(b => {
    b.addEventListener('click', () => openWorkHourModal(b.dataset.id));
  });
  tbody.querySelectorAll('button[data-action="delete"]').forEach(b => {
    b.addEventListener('click', () => confirmDeleteWorkHour(b.dataset.id));
  });
}

/* ── Modal ── */

function buildWorkHourModalHtml(w) {
  const isEdit = !!w;
  /* 0-based mesec za formatYMD (interno radi +1). */
  const t = new Date();
  const todayStr = formatYMD(t.getFullYear(), t.getMonth(), t.getDate());
  const prefilledEmp = w?.employeeId
    || (panelRef?.querySelector('#whEmpFilter')?.value || '');
  return `
    <div class="kadr-modal-overlay" id="whModal" role="dialog" aria-labelledby="whModalTitle" aria-modal="true">
      <div class="kadr-modal">
        <div class="kadr-modal-title" id="whModalTitle">${isEdit ? 'Izmeni unos sati' : 'Novi unos sati'}</div>
        <div class="kadr-modal-subtitle">Ručni unos. Za masovne unose koristi <strong>Mesečni grid</strong>.</div>
        <div class="kadr-modal-err" id="whModalErr"></div>
        <form id="whForm">
          <input type="hidden" id="whId" value="${escHtml(w?.id || '')}">
          <div class="emp-form-grid">
            <div class="emp-field col-full">
              <label for="whEmpId">Zaposleni *</label>
              <select id="whEmpId" required>
                ${employeeOptionsHtml({ includeBlank: true, blankLabel: '— izaberi —', selectedId: prefilledEmp, activeOnly: !isEdit })}
              </select>
            </div>
            <div class="emp-field">
              <label for="whDate">Datum *</label>
              <input type="date" id="whDate" required value="${escHtml(w?.workDate || todayStr)}">
            </div>
            <div class="emp-field">
              <label for="whHours">Sati *</label>
              <input type="number" id="whHours" min="0" max="24" step="0.25" value="${w?.hours != null ? w.hours : 8}" required>
            </div>
            <div class="emp-field">
              <label for="whOvertime">Prekovremeni</label>
              <input type="number" id="whOvertime" min="0" max="24" step="0.25" value="${w?.overtimeHours != null ? w.overtimeHours : 0}">
            </div>
            <div class="emp-field">
              <label for="whProject">Projekat / ref.</label>
              <input type="text" id="whProject" maxlength="120" placeholder="npr. INA-2025-03 ili opština Novi Sad" value="${escHtml(w?.projectRef || '')}">
            </div>
            <div class="emp-field col-full">
              <label for="whNote">Napomena</label>
              <textarea id="whNote" maxlength="300" placeholder="Opcioni komentar…">${escHtml(w?.note || '')}</textarea>
            </div>
          </div>
          <div class="kadr-modal-actions">
            <button type="button" class="btn" id="whCancelBtn">Otkaži</button>
            <button type="submit" class="btn btn-primary" id="whSubmitBtn">Sačuvaj</button>
          </div>
        </form>
      </div>
    </div>`;
}

function closeWorkHourModal() {
  document.getElementById('whModal')?.remove();
}

function openWorkHourModal(id) {
  if (!canEdit()) {
    showToast('⚠ Samo PM/LeadPM može da dodaje/menja');
    return;
  }
  if (kadrovskaState.employees.length === 0) {
    showToast('⚠ Prvo dodaj zaposlenog u tab "Zaposleni"');
    return;
  }
  closeWorkHourModal();
  let w = null;
  if (id) {
    w = kadrWorkHoursState.items.find(x => x.id === id);
    if (!w) { showToast('⚠ Zapis nije pronađen'); return; }
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = buildWorkHourModalHtml(w);
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById('whModal');
  const form = modal.querySelector('#whForm');
  modal.querySelector('#whCancelBtn').addEventListener('click', closeWorkHourModal);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); submitWorkHourForm(); });
  modal.addEventListener('click', (ev) => { if (ev.target === modal) closeWorkHourModal(); });
  setTimeout(() => modal.querySelector('#whEmpId')?.focus(), 50);
}

async function submitWorkHourForm() {
  const errEl = document.getElementById('whModalErr');
  const btn = document.getElementById('whSubmitBtn');
  errEl.textContent = ''; errEl.classList.remove('visible');

  const empId = document.getElementById('whEmpId').value;
  const workDate = document.getElementById('whDate').value;
  const hours = parseFloat(document.getElementById('whHours').value || '0');
  const ot = parseFloat(document.getElementById('whOvertime').value || '0');
  const projectRef = document.getElementById('whProject').value.trim();
  const note = document.getElementById('whNote').value.trim();
  const id = document.getElementById('whId').value || null;

  if (!empId) { errEl.textContent = 'Izaberi zaposlenog.'; errEl.classList.add('visible'); return; }
  if (!workDate) { errEl.textContent = 'Datum je obavezan.'; errEl.classList.add('visible'); return; }
  if (isNaN(hours) || hours < 0 || hours > 24) { errEl.textContent = 'Sati moraju biti 0–24.'; errEl.classList.add('visible'); return; }
  if (isNaN(ot) || ot < 0 || ot > 24) { errEl.textContent = 'Prekovremeni moraju biti 0–24.'; errEl.classList.add('visible'); return; }

  const payload = { id, employeeId: empId, workDate, hours, overtimeHours: ot, projectRef, note };
  btn.disabled = true; btn.textContent = 'Čuvanje…';
  try {
    if (getIsOnline() && hasSupabaseConfig()) {
      let res;
      if (id && !String(id).startsWith('local_')) res = await updateWorkHourInDb(payload);
      else res = await saveWorkHourToDb(payload);
      if (!res || !res.length) {
        errEl.textContent = 'Supabase čuvanje nije uspelo. Primeni migraciju add_kadrovska_phase1.sql.';
        errEl.classList.add('visible');
        return;
      }
      const saved = mapDbWorkHour(res[0]);
      const idx = kadrWorkHoursState.items.findIndex(x => x.id === saved.id);
      if (idx >= 0) kadrWorkHoursState.items[idx] = saved;
      else kadrWorkHoursState.items.unshift(saved);
    } else {
      if (!payload.id) payload.id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const idx = kadrWorkHoursState.items.findIndex(x => x.id === payload.id);
      if (idx >= 0) kadrWorkHoursState.items[idx] = payload;
      else kadrWorkHoursState.items.unshift(payload);
    }
    kadrWorkHoursState.items.sort((a, b) => String(b.workDate || '').localeCompare(String(a.workDate || '')));
    saveWorkHoursCache(kadrWorkHoursState.items);
    closeWorkHourModal();
    refreshWorkHoursTab();
    showToast(id ? '✏️ Unos izmenjen' : '✅ Sati uneti');
  } catch (e) {
    console.error('[wh] submit', e);
    errEl.textContent = 'Greška pri čuvanju.';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false; btn.textContent = 'Sačuvaj';
  }
}

async function confirmDeleteWorkHour(id) {
  if (!canEdit()) return;
  if (!confirm('Obrisati unos sati?')) return;
  try {
    if (getIsOnline() && hasSupabaseConfig() && !String(id).startsWith('local_')) {
      const ok = await deleteWorkHourFromDb(id);
      if (!ok) { showToast('⚠ Supabase brisanje nije uspelo'); return; }
    }
    kadrWorkHoursState.items = kadrWorkHoursState.items.filter(x => x.id !== id);
    saveWorkHoursCache(kadrWorkHoursState.items);
    refreshWorkHoursTab();
    showToast('🗑 Unos obrisan');
  } catch (e) {
    console.error(e);
    showToast('⚠ Greška');
  }
}
