/**
 * Kadrovska — TAB Zaposleni (Faza K2 — prošireni profili).
 *
 * Prikaz liste zadržava minimum kolona (ime, pozicija, odeljenje, telefon, email,
 * status) a ceo prošireni profil (JMBG, adresa, banka, pol, datum rođenja, slava,
 * obrazovanje, lekarski pregled, deca) živi u detaljnom modalu sa sekcijama.
 *
 * Osetljiva polja (JMBG, adresa, banka, privatni telefon, kontakt osoba, deca)
 * vide i menjaju samo admin. Za ostale korisnike modal prikazuje „•••“ u tim
 * sekcijama i disable-uje ih.
 *
 * Public API:
 *   renderEmployeesTab()
 *   wireEmployeesTab(panelEl)
 *   refreshEmployeesTab()
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  compareEmployeesByLastFirst,
  employeeDisplayName,
} from '../../lib/employeeNames.js';
import { canEditKadrovska, canViewEmployeePii, getIsOnline, isAdmin } from '../../state/auth.js';
import {
  hasSupabaseConfig,
  KADR_EDU_LEVEL_LABELS,
} from '../../lib/constants.js';
import {
  kadrovskaState,
  kadrChildrenState,
  saveEmployeesCache,
} from '../../state/kadrovska.js';
import {
  saveEmployeeToDb,
  updateEmployeeInDb,
  deleteEmployeeFromDb,
  mapDbEmployee,
} from '../../services/employees.js';
import {
  saveChildToDb,
  updateChildInDb,
  deleteChildFromDb,
  mapDbChild,
} from '../../services/employeeChildren.js';
import {
  ensureEmployeesLoaded,
  ensureChildrenLoaded,
  ensureOrgStructureLoaded,
  uniqueDepartments,
} from '../../services/kadrovska.js';
import { orgStructureState } from '../../state/kadrovska.js';
import { renderSummaryChips } from './shared.js';
import { openEmployeesBulkModal } from './employeesBulkModal.js';

let panelRef = null;
let onChangeCb = null;

/* ─── HELPERS ────────────────────────────────────────────────────────── */

/** Izračunaj datum rođenja i pol iz JMBG-a (13 cifara). Vrati {birthDate, gender} ili null. */
function parseJmbg(jmbg) {
  if (!jmbg || !/^\d{13}$/.test(jmbg)) return null;
  const dd = parseInt(jmbg.slice(0, 2), 10);
  const mm = parseInt(jmbg.slice(2, 4), 10);
  const yyy = parseInt(jmbg.slice(4, 7), 10);
  const rrr = parseInt(jmbg.slice(9, 12), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  /* Godišnji okvir: yyy je poslednje 3 cifre; 000-899 → 2000-2899 (modern), 900-999 → 1900-1999. */
  const year = yyy >= 900 ? 1000 + yyy : 2000 + yyy;
  const iso = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const gender = rrr >= 500 ? 'Z' : 'M';
  return { birthDate: iso, gender };
}

/** Maskiraj JMBG/broj računa za prikaz ne-HR korisnicima: prikaži prvih 2 + ••• + poslednjih 3. */
function maskSensitive(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 5) return '•'.repeat(s.length);
  return s.slice(0, 2) + '•••••' + s.slice(-3);
}

/* ─── LIST RENDER ────────────────────────────────────────────────────── */

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
      <button class="btn btn-ghost" id="kadrovskaBulkBtn" title="Brzi unos više zaposlenih ili uvoz iz Excel/CSV">⚡ Brzi unos</button>
      <button class="btn btn-primary" id="kadrovskaAddBtn">+ Novi zaposleni</button>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table" id="kadrovskaTable">
        <thead>
          <tr>
            <th>Ime i prezime</th>
            <th>Pozicija</th>
            <th class="col-hide-sm">Odeljenje</th>
            <th class="col-hide-sm">Pododeljenje</th>
            <th class="col-hide-sm">Telefon</th>
            <th class="col-hide-sm">Email</th>
            <th class="col-hide-sm">Lekarski ističe</th>
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

export async function wireEmployeesTab(panelEl, { onChange } = {}) {
  panelRef = panelEl;
  onChangeCb = onChange || null;

  panelEl.querySelector('#kadrovskaSearch').addEventListener('input', refreshEmployeesTab);
  panelEl.querySelector('#kadrovskaDeptFilter').addEventListener('change', refreshEmployeesTab);
  panelEl.querySelector('#kadrovskaStatusFilter').addEventListener('change', refreshEmployeesTab);
  panelEl.querySelector('#kadrovskaAddBtn').addEventListener('click', () => openEmployeeModal(null));
  panelEl.querySelector('#kadrovskaBulkBtn')?.addEventListener('click', () => {
    if (!canEditKadrovska()) {
      showToast('⚠ Samo PM/HR/Admin mogu da dodaju zaposlene');
      return;
    }
    openEmployeesBulkModal({
      onSaved: async () => {
        await ensureEmployeesLoaded(true);
        refreshEmployeesTab();
      },
    });
  });

  panelEl.addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute('data-action');
    const empId  = btn.getAttribute('data-id');
    console.log('[EMP-ACTION]', JSON.stringify(action), JSON.stringify(empId));
    if (action === 'edit')   openEmployeeModal(empId);
    if (action === 'delete') confirmDeleteEmployee(empId);
  });

  await ensureEmployeesLoaded(true);
  try { await ensureOrgStructureLoaded(); } catch (e) { console.warn('[kadrovska] org structure load failed', e); }
  refreshEmployeesTab();
}

function applyFilters(list) {
  if (!panelRef) return list;
  const q = (panelRef.querySelector('#kadrovskaSearch')?.value || '').trim().toLowerCase();
  const deptVal = panelRef.querySelector('#kadrovskaDeptFilter')?.value || '';
  const status = panelRef.querySelector('#kadrovskaStatusFilter')?.value || '';
  return list.filter(e => {
    if (deptVal) {
      const deptId = parseInt(deptVal, 10);
      if (orgStructureState.departments.length && !isNaN(deptId)) {
        if (e.departmentId !== deptId) return false;
      } else {
        if (e.department !== deptVal) return false;
      }
    }
    if (status === 'active' && !e.isActive) return false;
    if (status === 'inactive' && e.isActive) return false;
    if (q) {
      const hay = [employeeDisplayName(e), e.firstName, e.lastName, e.positionName || e.position, e.departmentName || e.department, e.subDepartmentName, e.team, e.email, e.phoneWork, e.note].join(' ').toLowerCase();
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
    const edit = canEditKadrovska();
    addBtn.disabled = !edit;
    addBtn.style.opacity = edit ? '1' : '0.55';
    addBtn.style.cursor = edit ? 'pointer' : 'not-allowed';
    addBtn.title = edit ? '' : 'Samo PM/LeadPM/HR/Admin može da dodaje';
  }
  const bulkBtn = panelRef.querySelector('#kadrovskaBulkBtn');
  if (bulkBtn) {
    const edit = canEditKadrovska();
    bulkBtn.disabled = !edit;
    bulkBtn.style.opacity = edit ? '1' : '0.55';
    bulkBtn.style.cursor = edit ? 'pointer' : 'not-allowed';
    bulkBtn.title = edit ? 'Brzi unos više zaposlenih ili uvoz iz Excel/CSV' : 'Samo PM/LeadPM/HR/Admin može da dodaje';
  }

  const deptSel = panelRef.querySelector('#kadrovskaDeptFilter');
  if (deptSel) {
    const curr = deptSel.value;
    const depts = uniqueDepartments();
    const opts = ['<option value="">Sva odeljenja</option>']
      .concat(depts.map(d => `<option value="${escHtml(String(d.id ?? d.name))}">${escHtml(d.name)}</option>`));
    deptSel.innerHTML = opts.join('');
    if (curr && Array.from(deptSel.options).some(o => o.value === curr)) deptSel.value = curr;
  }

  const filtered = applyFilters(kadrovskaState.employees);

  const tabBadge = document.getElementById('kadrTabCountEmployees');
  if (tabBadge) tabBadge.textContent = String(kadrovskaState.employees.length);

  const totAll = kadrovskaState.employees.length;
  const totActive = kadrovskaState.employees.filter(e => e.isActive).length;
  const totInactive = totAll - totActive;
  /* Podsetnici: lekarski ističe ≤ 30 dana, rođendani u narednih 30 dana */
  const today = new Date();
  const in30 = new Date(today.getTime() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);
  let medExpSoon = 0, bdaySoon = 0;
  kadrovskaState.employees.forEach(e => {
    if (e.isActive && e.medicalExamExpires && e.medicalExamExpires <= in30) medExpSoon++;
    if (e.isActive && e.birthDate) {
      const md = e.birthDate.slice(5); // MM-DD
      const tNow = todayIso.slice(5);
      const tIn30 = in30.slice(5);
      /* Wrap-around (decembar→januar): uporedi kao stringove u jednoj godini */
      const inRange = tNow <= tIn30
        ? (md >= tNow && md <= tIn30)
        : (md >= tNow || md <= tIn30);
      if (inRange) bdaySoon++;
    }
  });
  renderSummaryChips('empSummary', [
    { label: 'Ukupno', value: totAll, tone: 'accent' },
    { label: 'Aktivni', value: totActive, tone: 'ok' },
    { label: 'Neaktivni', value: totInactive, tone: 'muted' },
    { label: 'Lekarski ističe <30d', value: medExpSoon, tone: medExpSoon > 0 ? 'warn' : 'muted' },
    { label: 'Rođendani <30d', value: bdaySoon, tone: bdaySoon > 0 ? 'accent' : 'muted' },
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

  const edit = canEditKadrovska();
  tbody.innerHTML = filtered.map(e => {
    const sub = [e.email, e.phoneWork || e.phone].filter(x => x).join(' · ');
    const deptDisplay = e.departmentName || e.department || '—';
    const subDeptDisplay = e.subDepartmentName || '—';
    const posDisplay = e.positionName || e.position || '—';
    const statusCls = e.isActive ? 'active' : 'inactive';
    const statusTxt = e.isActive ? 'Aktivan' : 'Neaktivan';
    const rowId = escHtml(e.id || '');

    /* Medical badge — „Ističe za X d” ili „Istekao” */
    let medBadge = '—';
    if (e.medicalExamExpires) {
      const d1 = new Date(e.medicalExamExpires);
      const diff = Math.ceil((d1 - today) / (24 * 3600 * 1000));
      if (diff < 0) medBadge = `<span class=”kadr-type-badge t-bolovanje”>Istekao</span>`;
      else if (diff <= 30) medBadge = `<span class=”kadr-type-badge t-placeno”>za ${diff}d</span>`;
      else medBadge = `<span class=”emp-sub”>${formatDate(e.medicalExamExpires)}</span>`;
    }

    return `<tr data-id=”${rowId}”>
      <td>
        <div class=”emp-name”>${escHtml(employeeDisplayName(e) || '—')}</div>
        ${sub ? `<div class=”emp-sub col-hide-sm”>${escHtml(sub)}</div>` : ''}
      </td>
      <td>${escHtml(posDisplay)}</td>
      <td class=”col-hide-sm”>${escHtml(deptDisplay)}</td>
      <td class=”col-hide-sm”>${escHtml(subDeptDisplay)}</td>
      <td class=”col-hide-sm”>${escHtml(e.phoneWork || e.phone || '—')}</td>
      <td class=”col-hide-sm”>${escHtml(e.email || '—')}</td>
      <td class=”col-hide-sm”>${medBadge}</td>
      <td><span class=”emp-status-badge ${statusCls}”>${statusTxt}</span></td>
      <td class=”col-actions”>
        <button class=”btn-row-act” data-action=”edit” data-id=”${rowId}” ${edit ? '' : 'disabled'} title=”${edit ? 'Izmeni' : 'Samo pregled'}”>Izmeni</button>
        <button class=”btn-row-act danger” data-action=”delete” data-id=”${rowId}” ${edit ? '' : 'disabled'} title=”${edit ? 'Obriši' : 'Samo pregled'}”>Obriši</button>
      </td>
    </tr>`;
  }).join('');


  onChangeCb?.();
}

/* ─── KASKADNI SELECT HELPERI ─────────────────────────────────────── */

function _deptOptions(selectedId) {
  const opts = ['<option value="">— izaberi odeljenje —</option>'];
  for (const d of orgStructureState.departments) {
    const sel = d.id === selectedId ? ' selected' : '';
    opts.push(`<option value="${d.id}"${sel}>${escHtml(d.name)}</option>`);
  }
  return opts.join('');
}

function _subDeptOptions(deptId, selectedId) {
  const list = orgStructureState.subDepartments.filter(s => s.department_id === deptId);
  const opts = ['<option value="">— izaberi pododeljenje —</option>'];
  for (const s of list) {
    const sel = s.id === selectedId ? ' selected' : '';
    opts.push(`<option value="${s.id}"${sel}>${escHtml(s.name)}</option>`);
  }
  return opts.join('');
}

function _positionOptions(deptId, subDeptId, selectedId) {
  let list = orgStructureState.jobPositions.filter(p => p.department_id === deptId);
  if (subDeptId) list = list.filter(p => p.sub_department_id === subDeptId);
  const opts = ['<option value="">— izaberi poziciju —</option>'];
  for (const p of list) {
    const sel = p.id === selectedId ? ' selected' : '';
    opts.push(`<option value="${p.id}"${sel}>${escHtml(p.name)}</option>`);
  }
  return opts.join('');
}

/* ═══════════════════════════════════════════════════════════════════════
   EMPLOYEE MODAL — Prošireni profil sa sekcijama
   ═══════════════════════════════════════════════════════════════════════ */

function sectionHtml(title, innerHtml, opts = {}) {
  const locked = opts.locked === true;
  const hint = locked
    ? ' <span class="kadr-section-lock" title="Samo admin">🔒</span>'
    : '';
  return `
    <fieldset class="emp-section${locked ? ' emp-section-locked' : ''}">
      <legend>${escHtml(title)}${hint}</legend>
      <div class="emp-form-grid">
        ${innerHtml}
      </div>
    </fieldset>`;
}

function buildEmployeeModalHtml(emp) {
  const isEdit = !!emp;
  const piiOk = canViewEmployeePii();
  const eduOpts = Object.entries(KADR_EDU_LEVEL_LABELS)
    .map(([v, l]) => `<option value="${v}"${emp?.educationLevel === v ? ' selected' : ''}>${escHtml(l)}</option>`)
    .join('');

  /* Osetljive sekcije — ako nije admin, prikaži read-only (ili maskirano). */
  const sensitiveDisabled = piiOk ? '' : 'disabled';

  return `
    <div class="emp-modal-overlay" id="empModal" role="dialog" aria-labelledby="empModalTitle" aria-modal="true">
      <div class="emp-modal emp-modal-wide">
        <div class="emp-modal-title" id="empModalTitle">${isEdit ? 'Izmeni zaposlenog' : 'Novi zaposleni'}</div>
        <div class="emp-modal-subtitle">Popuni podatke po sekcijama. Samo Ime i Prezime su obavezni.</div>
        <div class="emp-modal-err" id="empModalErr"></div>

        <form id="empForm">
          <input type="hidden" id="empId" value="${escHtml(emp?.id || '')}">

          ${sectionHtml('Osnovno', `
            <div class="emp-field">
              <label for="empFirstName">Ime *</label>
              <input type="text" id="empFirstName" required maxlength="60" value="${escHtml(emp?.firstName || '')}">
            </div>
            <div class="emp-field">
              <label for="empLastName">Prezime *</label>
              <input type="text" id="empLastName" required maxlength="60" value="${escHtml(emp?.lastName || '')}">
            </div>
            <div class="emp-field">
              <label for="empDepartment">Odeljenje ${isAdmin() ? '' : '<span class="kadr-section-lock" title="Samo admin može da menja">🔒</span>'}</label>
              <select id="empDepartment" ${isAdmin() ? '' : 'disabled'}>
                ${_deptOptions(emp?.departmentId || null)}
              </select>
            </div>
            <div class="emp-field">
              <label for="empSubDepartment">Pododeljenje ${isAdmin() ? '' : '<span class="kadr-section-lock" title="Samo admin može da menja">🔒</span>'}</label>
              <select id="empSubDepartment" ${isAdmin() ? '' : 'disabled'}>
                ${_subDeptOptions(emp?.departmentId || null, emp?.subDepartmentId || null)}
              </select>
            </div>
            <div class="emp-field">
              <label for="empPosition">Radno mesto (pozicija)</label>
              <select id="empPosition">
                ${_positionOptions(emp?.departmentId || null, emp?.subDepartmentId || null, emp?.positionId || null)}
              </select>
            </div>
            <div class="emp-field">
              <label for="empTeam">Tim</label>
              <input type="text" id="empTeam" maxlength="80" value="${escHtml(emp?.team || '')}">
            </div>
            <div class="emp-field">
              <label for="empHireDate">Zaposlen od</label>
              <input type="date" id="empHireDate" value="${escHtml(emp?.hireDate || '')}">
            </div>
            <div class="emp-field">
              <label for="empEmail">Email</label>
              <input type="email" id="empEmail" maxlength="120" value="${escHtml(emp?.email || '')}">
            </div>
            <div class="emp-field">
              <label for="empPhoneWork">Telefon (službeni)</label>
              <input type="tel" id="empPhoneWork" maxlength="40" value="${escHtml(emp?.phoneWork || emp?.phone || '')}">
            </div>
            <div class="emp-field emp-field-check">
              <input type="checkbox" id="empIsActive" ${emp ? (emp.isActive !== false ? 'checked' : '') : 'checked'}>
              <label for="empIsActive">Aktivan zaposleni</label>
            </div>
          `)}

          ${sectionHtml('Lični podaci' + (piiOk ? '' : ' (samo admin)'), `
            <div class="emp-field">
              <label for="empPersonalId">JMBG (13 cifara)</label>
              <input type="text" id="empPersonalId" inputmode="numeric" pattern="\\d{13}" maxlength="13"
                     value="${escHtml(piiOk ? (emp?.personalId || '') : maskSensitive(emp?.personalId || ''))}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empBirthDate">Datum rođenja</label>
              <input type="date" id="empBirthDate" value="${escHtml(emp?.birthDate || '')}">
            </div>
            <div class="emp-field">
              <label for="empGender">Pol</label>
              <select id="empGender">
                <option value="">—</option>
                <option value="M"${emp?.gender === 'M' ? ' selected' : ''}>Muški</option>
                <option value="Z"${emp?.gender === 'Z' ? ' selected' : ''}>Ženski</option>
              </select>
            </div>
            <div class="emp-field">
              <label for="empPhonePrivate">Telefon (privatni)</label>
              <input type="tel" id="empPhonePrivate" maxlength="40"
                     value="${escHtml(piiOk ? (emp?.phonePrivate || '') : maskSensitive(emp?.phonePrivate || ''))}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empEmergencyName">Kontakt osoba — ime</label>
              <input type="text" id="empEmergencyName" maxlength="120"
                     value="${escHtml(piiOk ? (emp?.emergencyContactName || '') : '')}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empEmergencyPhone">Kontakt osoba — telefon</label>
              <input type="tel" id="empEmergencyPhone" maxlength="40"
                     value="${escHtml(piiOk ? (emp?.emergencyContactPhone || '') : maskSensitive(emp?.emergencyContactPhone || ''))}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empSlava">Krsna slava</label>
              <input type="text" id="empSlava" maxlength="80" placeholder="npr. Sveti Nikola" value="${escHtml(emp?.slava || '')}">
            </div>
            <div class="emp-field">
              <label for="empSlavaDay">Dan slave (MM-DD)</label>
              <input type="text" id="empSlavaDay" maxlength="5" placeholder="12-19"
                     value="${escHtml(emp?.slavaDay ? emp.slavaDay.slice(0, 2) + '-' + emp.slavaDay.slice(2, 4) : '')}">
            </div>
          `, { locked: !piiOk })}

          ${sectionHtml('Adresa i banka' + (piiOk ? '' : ' (samo admin)'), `
            <div class="emp-field col-full">
              <label for="empAddress">Adresa</label>
              <input type="text" id="empAddress" maxlength="200"
                     value="${escHtml(piiOk ? (emp?.address || '') : '•••')}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empCity">Grad</label>
              <input type="text" id="empCity" maxlength="80"
                     value="${escHtml(piiOk ? (emp?.city || '') : '•••')}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empPostalCode">Poštanski broj</label>
              <input type="text" id="empPostalCode" maxlength="10"
                     value="${escHtml(piiOk ? (emp?.postalCode || '') : '')}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empBankName">Banka</label>
              <input type="text" id="empBankName" maxlength="120"
                     value="${escHtml(piiOk ? (emp?.bankName || '') : '•••')}"
                     ${sensitiveDisabled}>
            </div>
            <div class="emp-field">
              <label for="empBankAccount">Broj računa</label>
              <input type="text" id="empBankAccount" maxlength="40"
                     placeholder="xxx-xxxxxxxxxxxxx-xx"
                     value="${escHtml(piiOk ? (emp?.bankAccount || '') : maskSensitive(emp?.bankAccount || ''))}"
                     ${sensitiveDisabled}>
            </div>
          `, { locked: !piiOk })}

          ${sectionHtml('Obrazovanje i zdravlje', `
            <div class="emp-field">
              <label for="empEduLevel">Stručna sprema — stepen</label>
              <select id="empEduLevel">
                <option value="">—</option>
                ${eduOpts}
              </select>
            </div>
            <div class="emp-field">
              <label for="empEduTitle">Naziv kvalifikacije</label>
              <input type="text" id="empEduTitle" maxlength="120" placeholder="npr. Dipl. maš. inž." value="${escHtml(emp?.educationTitle || '')}">
            </div>
            <div class="emp-field">
              <label for="empMedicalDate">Lekarski pregled — datum</label>
              <input type="date" id="empMedicalDate" value="${escHtml(emp?.medicalExamDate || '')}">
            </div>
            <div class="emp-field">
              <label for="empMedicalExpires">Lekarski pregled — ističe</label>
              <input type="date" id="empMedicalExpires" value="${escHtml(emp?.medicalExamExpires || '')}">
            </div>
          `)}

          ${isEdit && piiOk ? sectionHtml('Deca zaposlenog', `
            <div class="emp-field col-full">
              <div id="empChildrenList" class="emp-children-list"><em>Učitavam…</em></div>
              <div class="emp-children-add">
                <input type="text" id="empChildNewName" placeholder="Ime deteta" maxlength="60">
                <input type="date" id="empChildNewBirth">
                <button type="button" class="btn btn-ghost" id="empChildAddBtn">+ Dodaj dete</button>
              </div>
            </div>
          `, { locked: false }) : ''}

          ${sectionHtml('Napomena', `
            <div class="emp-field col-full">
              <label for="empNote">Slobodna napomena</label>
              <textarea id="empNote" maxlength="1000" placeholder="Opcioni komentar…">${escHtml(emp?.note || '')}</textarea>
            </div>
          `)}

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

async function openEmployeeModal(id) {
  console.log('[MODAL] id=', id, 'canEdit=', canEditKadrovska());
  if (!canEditKadrovska()) {
    showToast('⚠ Nemate prava za izmenu');
    return;
  }
  closeEmployeeModal();

  let emp = null;
  if (id) {
    emp = kadrovskaState.employees.find(x => x.id === id);
    console.log('[MODAL] emp=', emp ? 'found' : 'NOT FOUND, total=' + kadrovskaState.employees.length);
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

  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) closeEmployeeModal();
  });

  /* Kaskadni selekti: Odeljenje → Pododeljenje → Pozicija */
  const deptSel    = modal.querySelector('#empDepartment');
  const subDeptSel = modal.querySelector('#empSubDepartment');
  const posSel     = modal.querySelector('#empPosition');

  deptSel?.addEventListener('change', () => {
    const dId = parseInt(deptSel.value, 10) || null;
    subDeptSel.innerHTML = _subDeptOptions(dId, null);
    posSel.innerHTML     = _positionOptions(dId, null, null);
  });
  subDeptSel?.addEventListener('change', () => {
    const dId  = parseInt(deptSel.value, 10) || null;
    const sdId = parseInt(subDeptSel.value, 10) || null;
    posSel.innerHTML = _positionOptions(dId, sdId, null);
  });

  /* JMBG → auto-fill datum rođenja i pol */
  const jmbgEl = modal.querySelector('#empPersonalId');
  jmbgEl?.addEventListener('input', () => {
    const v = jmbgEl.value.replace(/\D/g, '').slice(0, 13);
    jmbgEl.value = v;
    const parsed = parseJmbg(v);
    if (parsed) {
      const bd = modal.querySelector('#empBirthDate');
      const gd = modal.querySelector('#empGender');
      if (bd && !bd.value) bd.value = parsed.birthDate;
      if (gd && !gd.value) gd.value = parsed.gender;
    }
  });

  /* Deca — lazy load */
  if (id && canViewEmployeePii()) {
    const list = await ensureChildrenLoaded(id);
    renderChildrenList(modal, id, list || []);
    modal.querySelector('#empChildAddBtn')?.addEventListener('click', () => addChildFromForm(modal, id));
  }

  setTimeout(() => modal.querySelector('#empFirstName')?.focus(), 50);
}

function renderChildrenList(modal, employeeId, children) {
  const host = modal.querySelector('#empChildrenList');
  if (!host) return;
  if (!children.length) {
    host.innerHTML = '<em class="emp-sub">Nema dece u evidenciji.</em>';
    return;
  }
  host.innerHTML = `
    <table class="emp-children-table">
      <thead><tr><th>Ime</th><th>Datum rođenja</th><th class="col-actions">Akcije</th></tr></thead>
      <tbody>
        ${children.map(c => `
          <tr data-child-id="${escHtml(c.id)}">
            <td>${escHtml(c.firstName || '—')}</td>
            <td>${c.birthDate ? formatDate(c.birthDate) : '—'}</td>
            <td class="col-actions">
              <button type="button" class="btn-row-act danger" data-act="del-child" data-child-id="${escHtml(c.id)}">Obriši</button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;
  host.querySelectorAll('button[data-act="del-child"]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('Obrisati ovo dete iz evidencije?')) return;
      const ok = await deleteChildFromDb(b.dataset.childId);
      if (!ok) { showToast('⚠ Nije uspelo brisanje'); return; }
      const list = (kadrChildrenState.byEmp.get(employeeId) || []).filter(c => c.id !== b.dataset.childId);
      kadrChildrenState.byEmp.set(employeeId, list);
      renderChildrenList(modal, employeeId, list);
      showToast('🗑 Dete obrisano');
    });
  });
}

async function addChildFromForm(modal, employeeId) {
  const nameEl = modal.querySelector('#empChildNewName');
  const birthEl = modal.querySelector('#empChildNewBirth');
  const name = (nameEl.value || '').trim();
  const birth = birthEl.value || '';
  if (!name) { showToast('⚠ Unesi ime deteta'); return; }
  const res = await saveChildToDb({ employeeId, firstName: name, birthDate: birth });
  if (!res || !res.length) {
    showToast('⚠ Dodavanje nije uspelo. Da li je migracija add_kadr_employee_extended.sql primenjena?');
    return;
  }
  const saved = mapDbChild(res[0]);
  const list = (kadrChildrenState.byEmp.get(employeeId) || []).concat(saved);
  list.sort((a, b) => String(a.birthDate || '').localeCompare(String(b.birthDate || '')));
  kadrChildrenState.byEmp.set(employeeId, list);
  nameEl.value = '';
  birthEl.value = '';
  renderChildrenList(modal, employeeId, list);
  showToast('✅ Dete dodato');
}

async function submitEmployeeForm() {
  const errEl = document.getElementById('empModalErr');
  const btn = document.getElementById('empSubmitBtn');
  errEl.textContent = '';
  errEl.classList.remove('visible');

  const firstName = document.getElementById('empFirstName').value.trim();
  const lastName = document.getElementById('empLastName').value.trim();
  if (!firstName || !lastName) {
    errEl.textContent = 'Ime i Prezime su obavezni.';
    errEl.classList.add('visible');
    return;
  }
  const id = document.getElementById('empId').value || null;
  const piiOk = canViewEmployeePii();

  /* Slava_day u DB je MMDD (bez crtice). */
  const slavaRaw = (document.getElementById('empSlavaDay').value || '').trim();
  const slavaDay = slavaRaw && /^\d{2}-?\d{2}$/.test(slavaRaw)
    ? slavaRaw.replace('-', '')
    : null;

  const departmentId    = parseInt(document.getElementById('empDepartment')?.value, 10) || null;
  const subDepartmentId = parseInt(document.getElementById('empSubDepartment')?.value, 10) || null;
  const positionId      = parseInt(document.getElementById('empPosition')?.value, 10) || null;

  const deptObj    = orgStructureState.departments.find(d => d.id === departmentId);
  const subDeptObj = orgStructureState.subDepartments.find(s => s.id === subDepartmentId);
  const posObj     = orgStructureState.jobPositions.find(p => p.id === positionId);

  const basePayload = {
    id,
    firstName,
    lastName,
    fullName: employeeDisplayName({ firstName, lastName }),
    departmentId,
    departmentName: deptObj?.name || '',
    subDepartmentId,
    subDepartmentName: subDeptObj?.name || '',
    positionId,
    positionName: posObj?.name || '',
    team: document.getElementById('empTeam').value.trim() || null,
    phoneWork: document.getElementById('empPhoneWork').value.trim(),
    email: document.getElementById('empEmail').value.trim().toLowerCase(),
    hireDate: document.getElementById('empHireDate').value || null,
    isActive: document.getElementById('empIsActive').checked,
    birthDate: document.getElementById('empBirthDate').value || null,
    gender: document.getElementById('empGender').value || null,
    slava: document.getElementById('empSlava').value.trim() || null,
    slavaDay,
    educationLevel: document.getElementById('empEduLevel').value || null,
    educationTitle: document.getElementById('empEduTitle').value.trim() || null,
    medicalExamDate: document.getElementById('empMedicalDate').value || null,
    medicalExamExpires: document.getElementById('empMedicalExpires').value || null,
    note: document.getElementById('empNote').value.trim(),
  };

  /* Osetljiva polja idu samo ako je admin — time izbegavamo trigger reject. */
  if (piiOk) {
    basePayload.personalId = document.getElementById('empPersonalId').value.trim() || null;
    basePayload.phonePrivate = document.getElementById('empPhonePrivate').value.trim() || null;
    basePayload.emergencyContactName = document.getElementById('empEmergencyName').value.trim() || null;
    basePayload.emergencyContactPhone = document.getElementById('empEmergencyPhone').value.trim() || null;
    basePayload.address = document.getElementById('empAddress').value.trim() || null;
    basePayload.city = document.getElementById('empCity').value.trim() || null;
    basePayload.postalCode = document.getElementById('empPostalCode').value.trim() || null;
    basePayload.bankName = document.getElementById('empBankName').value.trim() || null;
    basePayload.bankAccount = document.getElementById('empBankAccount').value.trim() || null;

    /* JMBG format check */
    if (basePayload.personalId && !/^\d{13}$/.test(basePayload.personalId)) {
      errEl.textContent = 'JMBG mora imati tačno 13 cifara.';
      errEl.classList.add('visible');
      return;
    }
  }

  /* Duplicate email check (case-insensitive, exclude self). */
  if (basePayload.email) {
    const dup = kadrovskaState.employees.find(e => e.id !== id && e.email && e.email.toLowerCase() === basePayload.email);
    if (dup) {
      errEl.textContent = 'Email već koristi zaposleni: ' + (employeeDisplayName(dup) || dup.email);
      errEl.classList.add('visible');
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Čuvanje…';
  try {
    let saved = null;
    if (getIsOnline() && hasSupabaseConfig()) {
      let res;
      if (id && !String(id).startsWith('local_')) {
        res = await updateEmployeeInDb(basePayload);
      } else {
        res = await saveEmployeeToDb(basePayload);
      }
      if (!res || !res.length) {
        errEl.textContent = 'Supabase nije uspeo da sačuva. Proveri da li je migracija add_kadr_employee_extended.sql primenjena.';
        errEl.classList.add('visible');
        return;
      }
      saved = mapDbEmployee(res[0]);
    } else {
      /* Offline: ručna UUID + ubaci/zameni u state. */
      if (!basePayload.id) {
        basePayload.id = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      }
      saved = { ...basePayload };
    }

    const idx = kadrovskaState.employees.findIndex(e => e.id === saved.id);
    if (idx >= 0) kadrovskaState.employees[idx] = saved;
    else kadrovskaState.employees.push(saved);
    kadrovskaState.employees.sort(compareEmployeesByLastFirst);
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
  if (!canEditKadrovska()) {
    showToast('⚠ Nemate prava za brisanje');
    return;
  }
  const emp = kadrovskaState.employees.find(e => e.id === id);
  if (!emp) return;
  if (!confirm(`Obrisati zaposlenog "${employeeDisplayName(emp)}"?\nOva akcija je trajna.`)) return;
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

/* Updating deprecated imports: saveEmployeeToDb je bio INSERT-only; update ide preko PATCH.
   Ovde koristimo updateEmployeeInDb za postojeće redove da bi izbegli ponavljanje full_name
   konflikta (JMBG unique). */
