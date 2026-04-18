/**
 * Kadrovska — TAB Odsustva.
 *
 * Bit-paritetan port iz legacy/index.html (renderAbsences + openAbsenceModal +
 * submitAbsenceForm + confirmDeleteAbsence). Listener-i preko addEventListener.
 *
 * Public API:
 *   renderAbsencesTab() → HTML stringa za telo panela
 *   wireAbsencesTab(panelEl) → veže event listener-e + load
 *   refreshAbsencesTab() → ponovni render
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate, formatYMD, daysInclusive } from '../../lib/date.js';
import { canEdit, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig, KADR_ABS_TYPE_LABELS } from '../../lib/constants.js';
import {
  kadrovskaState,
  kadrAbsencesState,
  saveAbsencesCache,
} from '../../state/kadrovska.js';
import {
  saveAbsenceToDb,
  updateAbsenceInDb,
  deleteAbsenceFromDb,
  mapDbAbsence,
} from '../../services/absences.js';
import {
  ensureAbsencesLoaded,
  ensureEmployeesLoaded,
  employeeNameById,
} from '../../services/kadrovska.js';
import { renderSummaryChips, employeeOptionsHtml } from './shared.js';

let panelRef = null;

const ABS_TYPE_OPTS = [
  { v: 'godisnji', l: 'Godišnji odmor' },
  { v: 'bolovanje', l: 'Bolovanje' },
  { v: 'slobodan', l: 'Slobodan dan' },
  { v: 'placeno', l: 'Plaćeno odsustvo' },
  { v: 'neplaceno', l: 'Neplaćeno odsustvo' },
  { v: 'sluzbeno', l: 'Službeno putovanje' },
  { v: 'ostalo', l: 'Ostalo' },
];

export function renderAbsencesTab() {
  return `
    <div class="kadr-summary-strip" id="absSummary"></div>
    <div class="kadrovska-toolbar">
      <select class="kadrovska-filter" id="absEmpFilter">
        <option value="">Svi zaposleni</option>
      </select>
      <select class="kadrovska-filter" id="absTypeFilter">
        <option value="">Svi tipovi</option>
        ${ABS_TYPE_OPTS.map(o => `<option value="${o.v}">${escHtml(o.l)}</option>`).join('')}
      </select>
      <input type="date" class="kadrovska-filter" id="absFromFilter" title="Od">
      <input type="date" class="kadrovska-filter" id="absToFilter" title="Do">
      <div class="kadrovska-toolbar-spacer"></div>
      <span class="kadrovska-count" id="absCount">0 odsustava</span>
      <button class="btn btn-primary" id="absAddBtn">+ Novo odsustvo</button>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table" id="absTable">
        <thead>
          <tr>
            <th>Zaposleni</th>
            <th>Tip</th>
            <th class="col-hide-sm">Od</th>
            <th class="col-hide-sm">Do</th>
            <th>Dana</th>
            <th class="col-hide-sm">Napomena</th>
            <th class="col-actions">Akcije</th>
          </tr>
        </thead>
        <tbody id="absTbody"></tbody>
      </table>
      <div class="kadrovska-empty" id="absEmpty" style="display:none;margin-top:16px;">
        <div class="kadrovska-empty-title">Nema odsustava</div>
        <div>Dodaj prvo odsustvo preko dugmeta <strong>+ Novo odsustvo</strong>.</div>
      </div>
    </main>`;
}

export async function wireAbsencesTab(panelEl) {
  panelRef = panelEl;
  panelEl.querySelector('#absEmpFilter').addEventListener('change', refreshAbsencesTab);
  panelEl.querySelector('#absTypeFilter').addEventListener('change', refreshAbsencesTab);
  panelEl.querySelector('#absFromFilter').addEventListener('change', refreshAbsencesTab);
  panelEl.querySelector('#absToFilter').addEventListener('change', refreshAbsencesTab);
  panelEl.querySelector('#absAddBtn').addEventListener('click', () => openAbsenceModal(null));

  /* Zaposleni nam trebaju za prikaz imena i populate-ovanje filtera/modal-a. */
  await ensureEmployeesLoaded();
  await ensureAbsencesLoaded(true);
  refreshAbsencesTab();
}

function applyFilters(list) {
  if (!panelRef) return list;
  const empF = panelRef.querySelector('#absEmpFilter')?.value || '';
  const typeF = panelRef.querySelector('#absTypeFilter')?.value || '';
  const fromF = panelRef.querySelector('#absFromFilter')?.value || '';
  const toF = panelRef.querySelector('#absToFilter')?.value || '';
  return list.filter(a => {
    if (empF && a.employeeId !== empF) return false;
    if (typeF && a.type !== typeF) return false;
    if (fromF && a.dateTo && a.dateTo < fromF) return false;
    if (toF && a.dateFrom && a.dateFrom > toF) return false;
    return true;
  });
}

function populateEmpFilter() {
  const sel = panelRef?.querySelector('#absEmpFilter');
  if (!sel) return;
  const curr = sel.value;
  sel.innerHTML = '<option value="">Svi zaposleni</option>'
    + employeeOptionsHtml({ includeBlank: false, selectedId: curr });
  if (curr && Array.from(sel.options).some(o => o.value === curr)) sel.value = curr;
}

export function refreshAbsencesTab() {
  if (!panelRef) return;
  const tbody = panelRef.querySelector('#absTbody');
  const emptyBox = panelRef.querySelector('#absEmpty');
  const countEl = panelRef.querySelector('#absCount');
  const addBtn = panelRef.querySelector('#absAddBtn');

  if (addBtn) {
    const edit = canEdit();
    addBtn.disabled = !edit;
    addBtn.style.opacity = edit ? '1' : '0.55';
    addBtn.style.cursor = edit ? 'pointer' : 'not-allowed';
  }

  populateEmpFilter();
  const filtered = applyFilters(kadrAbsencesState.items);

  /* Top-tab badge */
  const badge = document.getElementById('kadrTabCountAbsences');
  if (badge) badge.textContent = String(kadrAbsencesState.items.length);

  const total = kadrAbsencesState.items.length;
  if (countEl) {
    countEl.textContent = filtered.length === total
      ? `${total} ${total === 1 ? 'odsustvo' : 'odsustava'}`
      : `${filtered.length} / ${total} odsustava`;
  }

  /* Summary — current month numbers */
  /* formatYMD očekuje 0-based mesec (interno radi m+1 → 1-based string).
     Legacy je ovde imao bug — prosleđivao je getMonth()+1, što je davalo
     mesec unapred. Vite verzija je matematički ispravna. */
  const _now = new Date();
  const _y = _now.getFullYear();
  const _m = _now.getMonth();
  const _mStart = formatYMD(_y, _m, 1);
  const _mEnd = formatYMD(_y, _m, new Date(_y, _m + 1, 0).getDate());
  let mCount = 0, mDays = 0, mSick = 0;
  kadrAbsencesState.items.forEach(a => {
    if (!a.dateFrom || !a.dateTo) return;
    if (a.dateTo < _mStart || a.dateFrom > _mEnd) return;
    mCount++;
    const from = a.dateFrom < _mStart ? _mStart : a.dateFrom;
    const to = a.dateTo > _mEnd ? _mEnd : a.dateTo;
    mDays += daysInclusive(from, to);
    if (a.type === 'bolovanje') mSick++;
  });
  renderSummaryChips('absSummary', [
    { label: 'Ukupno u evidenciji', value: total, tone: 'accent' },
    { label: 'U tekućem mesecu', value: mCount, tone: mCount > 0 ? 'accent' : 'muted' },
    { label: 'Dana u mesecu', value: mDays, tone: 'muted' },
    { label: 'Bolovanja (mesec)', value: mSick, tone: mSick > 0 ? 'warn' : 'muted' },
  ]);

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (emptyBox) {
      emptyBox.style.display = 'block';
      emptyBox.querySelector('.kadrovska-empty-title').textContent =
        total === 0 ? 'Nema odsustava' : 'Nijedan rezultat ne odgovara filterima';
    }
    return;
  }
  if (emptyBox) emptyBox.style.display = 'none';

  const edit = canEdit();
  tbody.innerHTML = filtered.map(a => {
    const days = a.daysCount != null ? a.daysCount : daysInclusive(a.dateFrom, a.dateTo);
    const typeLbl = KADR_ABS_TYPE_LABELS[a.type] || a.type;
    const id = escHtml(a.id || '');
    return `<tr data-id="${id}">
      <td><div class="emp-name">${escHtml(employeeNameById(a.employeeId))}</div></td>
      <td><span class="kadr-type-badge t-${escHtml(a.type)}">${escHtml(typeLbl)}</span></td>
      <td class="col-hide-sm">${a.dateFrom ? formatDate(a.dateFrom) : '—'}</td>
      <td class="col-hide-sm">${a.dateTo ? formatDate(a.dateTo) : '—'}</td>
      <td>${days}</td>
      <td class="col-hide-sm">${escHtml(a.note || '—')}</td>
      <td class="col-actions">
        <button class="btn-row-act" data-action="edit" data-id="${id}" ${edit ? '' : 'disabled'}>Izmeni</button>
        <button class="btn-row-act danger" data-action="delete" data-id="${id}" ${edit ? '' : 'disabled'}>Obriši</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-action="edit"]').forEach(b => {
    b.addEventListener('click', () => openAbsenceModal(b.dataset.id));
  });
  tbody.querySelectorAll('button[data-action="delete"]').forEach(b => {
    b.addEventListener('click', () => confirmDeleteAbsence(b.dataset.id));
  });
}

/* ── Modal ── */

function buildAbsenceModalHtml(a) {
  const isEdit = !!a;
  return `
    <div class="kadr-modal-overlay" id="absModal" role="dialog" aria-labelledby="absModalTitle" aria-modal="true">
      <div class="kadr-modal">
        <div class="kadr-modal-title" id="absModalTitle">${isEdit ? 'Izmeni odsustvo' : 'Novo odsustvo'}</div>
        <div class="kadr-modal-subtitle">Unesi zaposlenog, tip i period odsustva.</div>
        <div class="kadr-modal-err" id="absModalErr"></div>
        <form id="absForm">
          <input type="hidden" id="absId" value="${escHtml(a?.id || '')}">
          <div class="emp-form-grid">
            <div class="emp-field col-full">
              <label for="absEmpId">Zaposleni *</label>
              <select id="absEmpId" required>
                ${employeeOptionsHtml({ includeBlank: true, blankLabel: '— izaberi —', selectedId: a?.employeeId, activeOnly: !isEdit })}
              </select>
            </div>
            <div class="emp-field">
              <label for="absType">Tip odsustva *</label>
              <select id="absType" required>
                ${ABS_TYPE_OPTS.map(o => `<option value="${o.v}"${(a?.type || 'godisnji') === o.v ? ' selected' : ''}>${escHtml(o.l)}</option>`).join('')}
              </select>
            </div>
            <div class="emp-field">
              <label for="absDays">Dana</label>
              <input type="number" id="absDays" min="0" max="365" step="1" placeholder="Auto iz datuma" value="${a?.daysCount != null ? a.daysCount : ''}">
            </div>
            <div class="emp-field">
              <label for="absFrom">Od *</label>
              <input type="date" id="absFrom" required value="${escHtml(a?.dateFrom || '')}">
            </div>
            <div class="emp-field">
              <label for="absTo">Do *</label>
              <input type="date" id="absTo" required value="${escHtml(a?.dateTo || '')}">
            </div>
            <div class="emp-field col-full">
              <label for="absNote">Napomena</label>
              <textarea id="absNote" maxlength="500" placeholder="Opcioni komentar…">${escHtml(a?.note || '')}</textarea>
            </div>
          </div>
          <div class="kadr-modal-actions">
            <button type="button" class="btn" id="absCancelBtn">Otkaži</button>
            <button type="submit" class="btn btn-primary" id="absSubmitBtn">Sačuvaj</button>
          </div>
        </form>
      </div>
    </div>`;
}

function closeAbsenceModal() {
  document.getElementById('absModal')?.remove();
}

function openAbsenceModal(id) {
  if (!canEdit()) {
    showToast('⚠ Samo PM/LeadPM može da dodaje/menja');
    return;
  }
  if (kadrovskaState.employees.length === 0) {
    showToast('⚠ Prvo dodaj zaposlenog u tab "Zaposleni"');
    return;
  }
  closeAbsenceModal();
  let a = null;
  if (id) {
    a = kadrAbsencesState.items.find(x => x.id === id);
    if (!a) { showToast('⚠ Odsustvo nije pronađeno'); return; }
  }
  const wrap = document.createElement('div');
  wrap.innerHTML = buildAbsenceModalHtml(a);
  document.body.appendChild(wrap.firstElementChild);

  const modal = document.getElementById('absModal');
  const form = modal.querySelector('#absForm');
  modal.querySelector('#absCancelBtn').addEventListener('click', closeAbsenceModal);
  form.addEventListener('submit', (ev) => { ev.preventDefault(); submitAbsenceForm(); });
  modal.addEventListener('click', (ev) => { if (ev.target === modal) closeAbsenceModal(); });
  setTimeout(() => modal.querySelector('#absEmpId')?.focus(), 50);
}

async function submitAbsenceForm() {
  const errEl = document.getElementById('absModalErr');
  const btn = document.getElementById('absSubmitBtn');
  errEl.textContent = ''; errEl.classList.remove('visible');

  const empId = document.getElementById('absEmpId').value;
  const type = document.getElementById('absType').value;
  const dateFrom = document.getElementById('absFrom').value;
  const dateTo = document.getElementById('absTo').value;
  let daysCount = document.getElementById('absDays').value;
  const note = document.getElementById('absNote').value.trim();
  const id = document.getElementById('absId').value || null;

  if (!empId) { errEl.textContent = 'Izaberi zaposlenog.'; errEl.classList.add('visible'); return; }
  if (!dateFrom || !dateTo) { errEl.textContent = 'Datumi su obavezni.'; errEl.classList.add('visible'); return; }
  if (dateTo < dateFrom) { errEl.textContent = '"Do" ne može biti pre "Od".'; errEl.classList.add('visible'); return; }
  if (daysCount === '' || daysCount == null) daysCount = daysInclusive(dateFrom, dateTo);
  else daysCount = parseInt(daysCount, 10);

  const payload = { id, employeeId: empId, type, dateFrom, dateTo, daysCount, note };
  btn.disabled = true; btn.textContent = 'Čuvanje…';
  try {
    if (getIsOnline() && hasSupabaseConfig()) {
      let res;
      if (id && !String(id).startsWith('local_')) res = await updateAbsenceInDb(payload);
      else res = await saveAbsenceToDb(payload);
      if (!res || !res.length) {
        errEl.textContent = 'Supabase čuvanje nije uspelo. Primeni migraciju add_kadrovska_phase1.sql.';
        errEl.classList.add('visible');
        return;
      }
      const saved = mapDbAbsence(res[0]);
      const idx = kadrAbsencesState.items.findIndex(x => x.id === saved.id);
      if (idx >= 0) kadrAbsencesState.items[idx] = saved;
      else kadrAbsencesState.items.unshift(saved);
    } else {
      if (!payload.id) payload.id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const idx = kadrAbsencesState.items.findIndex(x => x.id === payload.id);
      if (idx >= 0) kadrAbsencesState.items[idx] = payload;
      else kadrAbsencesState.items.unshift(payload);
    }
    kadrAbsencesState.items.sort((a, b) => String(b.dateFrom || '').localeCompare(String(a.dateFrom || '')));
    saveAbsencesCache(kadrAbsencesState.items);
    closeAbsenceModal();
    refreshAbsencesTab();
    showToast(id ? '✏️ Odsustvo izmenjeno' : '✅ Odsustvo dodato');
  } catch (e) {
    console.error('[abs] submit', e);
    errEl.textContent = 'Greška pri čuvanju.';
    errEl.classList.add('visible');
  } finally {
    btn.disabled = false; btn.textContent = 'Sačuvaj';
  }
}

async function confirmDeleteAbsence(id) {
  if (!canEdit()) return;
  if (!confirm('Obrisati odsustvo?')) return;
  try {
    if (getIsOnline() && hasSupabaseConfig() && !String(id).startsWith('local_')) {
      const ok = await deleteAbsenceFromDb(id);
      if (!ok) { showToast('⚠ Supabase brisanje nije uspelo'); return; }
    }
    kadrAbsencesState.items = kadrAbsencesState.items.filter(x => x.id !== id);
    saveAbsencesCache(kadrAbsencesState.items);
    refreshAbsencesTab();
    showToast('🗑 Odsustvo obrisano');
  } catch (e) {
    console.error(e);
    showToast('⚠ Greška');
  }
}
