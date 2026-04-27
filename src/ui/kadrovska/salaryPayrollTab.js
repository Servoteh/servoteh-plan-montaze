/**
 * Kadrovska — SUB-TAB „Mesečni obračun" (Faza K3.2, samo admin).
 *
 * Ciklus isplate:
 *   ▸ PRVI DEO (akontacija)  — unos do ~5. u mesecu.
 *   ▸ DRUGI DEO (konačno)    — unos od 15. do 20., obračunat po formuli:
 *     BAZA       = satničari: hourly_rate × hours_worked
 *                  fiksni:   fixed_salary
 *     UKUPNO_RSD = BAZA + transport_rsd + per_diem_rsd × domestic_days
 *     DRUGI_DEO  = UKUPNO_RSD − advance_amount
 *     UKUPNO_EUR = per_diem_eur × foreign_days   (zasebna isplata)
 *
 * UX:
 *   - Gore: month-picker, chips, dugmad „Pripremi mesec", „Excel", „Osveži".
 *   - Sredina: veliki grid (tabela) sa inline edit poljima.
 *   - Svaka izmena polja trigeruje LIVE preview totals u istom redu
 *     (bez DB poziva); klikom na „Sačuvaj" taj red se PATCH-uje u bazi.
 *   - „Pripremi mesec" poziva RPC kadr_payroll_init_month(y, m) koji
 *     kreira draft red po aktivnom zaposlenom sa snapshot-om uslova.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  compareEmployeesByLastFirst,
  employeeDisplayName,
} from '../../lib/employeeNames.js';
import { canAccessSalary, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../lib/constants.js';
import { kadrPayrollState, kadrovskaState } from '../../state/kadrovska.js';
import { ensureEmployeesLoaded } from '../../services/kadrovska.js';
import {
  loadPayrollByMonth,
  upsertPayroll,
  deletePayroll,
  initPayrollMonth,
  computeTotals,
} from '../../services/salaryPayroll.js';
import { renderSummaryChips } from './shared.js';
import { loadXlsx } from '../../lib/xlsx.js';

const MONTH_NAMES = [
  'Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun',
  'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar',
];

let rootEl = null;

function payrollEmployee(row) {
  return kadrovskaState.employees.find(e => e.id === row.employeeId) || null;
}

function payrollEmployeeName(row) {
  return employeeDisplayName(payrollEmployee(row)) || employeeDisplayName(row) || row.employeeName || '';
}

function comparePayrollRows(a, b) {
  const ea = payrollEmployee(a);
  const eb = payrollEmployee(b);
  if (ea && eb) return compareEmployeesByLastFirst(ea, eb);
  return compareEmployeesByLastFirst(ea || a, eb || b);
}

/* ── Public API ─────────────────────────────────────────────── */

export function renderPayrollSubtab() {
  if (!canAccessSalary()) {
    return `<div class="kadr-empty" style="margin:40px 24px">🔒 Samo administrator.</div>`;
  }
  const y = kadrPayrollState.selectedYear;
  const m = kadrPayrollState.selectedMonth;

  const years = [];
  const yNow = new Date().getFullYear();
  for (let yy = yNow - 3; yy <= yNow + 1; yy++) years.push(yy);

  return `
    <section class="kadr-panel-inner" aria-label="Mesečni obračun">
      <div class="kadr-summary-strip" id="payrSummary"></div>
      <div class="kadrovska-toolbar payroll-toolbar">
        <button class="btn btn-ghost" id="payrPrevMonth" title="Prethodni mesec">‹</button>
        <select id="payrMonth" class="kadrovska-filter" aria-label="Mesec">
          ${MONTH_NAMES.map((name, i) => `<option value="${i + 1}"${(i + 1) === m ? ' selected' : ''}>${name}</option>`).join('')}
        </select>
        <select id="payrYear" class="kadrovska-filter" aria-label="Godina">
          ${years.map(yy => `<option value="${yy}"${yy === y ? ' selected' : ''}>${yy}</option>`).join('')}
        </select>
        <button class="btn btn-ghost" id="payrNextMonth" title="Sledeći mesec">›</button>
        <input type="text" class="kadrovska-search" id="payrSearch" placeholder="Pretraga zaposlenih…">
        <div class="kadrovska-toolbar-spacer"></div>
        <button class="btn btn-ghost" id="payrReload">🔄 Osveži</button>
        <button class="btn btn-ghost" id="payrExport">📊 Excel</button>
        <button class="btn btn-primary" id="payrInit" title="Kreiraj draft redove za sve aktivne zaposlene za izabrani mesec">+ Pripremi mesec</button>
      </div>
      <div class="payroll-hint">
        <strong>Prvi deo</strong> = akontacija (do 5. u mesecu). <strong>Drugi deo</strong> = ukupno − prvi deo (15–20. u mesecu).
        Satničari: sati × satnica. Fiksni (ugovor/dogovor): fiksna plata.
      </div>
      <main class="kadrovska-main payroll-main">
        <div class="payroll-grid-wrap">
          <table class="kadrovska-table payroll-grid" id="payrTable">
            <thead>
              <tr>
                <th class="sticky-col">Zaposleni</th>
                <th>Tip</th>
                <th title="Akontacija (prvi deo)">I deo</th>
                <th title="Datum isplate I dela">I deo – datum</th>
                <th title="Satnica × sati ili fiksna plata">Sati / Fixno</th>
                <th>Prevoz</th>
                <th title="Broj domaćih terena × dinarska dnevnica">Dom. tereni</th>
                <th title="Broj ino terena × devizna dnevnica">Ino tereni</th>
                <th title="Ukupno RSD = baza + prevoz + dinarske dnevnice">Ukupno RSD</th>
                <th title="Devizne dnevnice zasebno">Ukupno EUR</th>
                <th title="II deo = UKUPNO RSD − I deo">II deo</th>
                <th>II deo – datum</th>
                <th>Status</th>
                <th class="col-actions">Akcije</th>
              </tr>
            </thead>
            <tbody id="payrTbody"></tbody>
          </table>
        </div>
        <div class="kadrovska-empty" id="payrEmpty" style="display:none;margin-top:16px;">
          <div class="kadrovska-empty-title">Nema obračuna za ${MONTH_NAMES[m - 1]} ${y}.</div>
          <div>Klikni <strong>+ Pripremi mesec</strong> da se kreiraju draft redovi za sve aktivne zaposlene.</div>
        </div>
      </main>
    </section>`;
}

export async function wirePayrollSubtab(panelEl) {
  if (!canAccessSalary()) return;
  rootEl = panelEl;

  panelEl.querySelector('#payrPrevMonth').addEventListener('click', () => shiftMonth(-1));
  panelEl.querySelector('#payrNextMonth').addEventListener('click', () => shiftMonth(+1));
  panelEl.querySelector('#payrMonth').addEventListener('change', (e) => setMonth(+e.target.value));
  panelEl.querySelector('#payrYear').addEventListener('change', (e) => setYear(+e.target.value));
  panelEl.querySelector('#payrSearch').addEventListener('input', debounce(refreshRows, 120));
  panelEl.querySelector('#payrReload').addEventListener('click', () => reloadPeriod(true));
  panelEl.querySelector('#payrInit').addEventListener('click', initCurrentMonth);
  panelEl.querySelector('#payrExport').addEventListener('click', exportXlsx);

  await ensureEmployeesLoaded();
  await reloadPeriod(true);
}

/* ── State / period helpers ─────────────────────────────────── */

function periodKey(y, m) { return `${y}-${String(m).padStart(2, '0')}`; }
function currentKey() { return periodKey(kadrPayrollState.selectedYear, kadrPayrollState.selectedMonth); }

function shiftMonth(delta) {
  let y = kadrPayrollState.selectedYear;
  let m = kadrPayrollState.selectedMonth + delta;
  while (m < 1)  { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  kadrPayrollState.selectedYear = y;
  kadrPayrollState.selectedMonth = m;
  syncPickers();
  reloadPeriod(true);
}
function setMonth(m) { kadrPayrollState.selectedMonth = m; reloadPeriod(true); }
function setYear(y)  { kadrPayrollState.selectedYear  = y; reloadPeriod(true); }

function syncPickers() {
  if (!rootEl) return;
  rootEl.querySelector('#payrMonth').value = String(kadrPayrollState.selectedMonth);
  rootEl.querySelector('#payrYear').value  = String(kadrPayrollState.selectedYear);
}

/* ── Load ───────────────────────────────────────────────────── */

async function reloadPeriod(force = false) {
  if (!canAccessSalary()) return;
  const key = currentKey();
  if (force || !kadrPayrollState.byPeriod.has(key)) {
    if (!getIsOnline() || !hasSupabaseConfig()) {
      kadrPayrollState.byPeriod.set(key, []);
    } else {
      const rows = await loadPayrollByMonth(kadrPayrollState.selectedYear, kadrPayrollState.selectedMonth);
      kadrPayrollState.byPeriod.set(key, rows || []);
    }
  }
  refreshRows();
}

async function initCurrentMonth() {
  if (!canAccessSalary()) return;
  const btn = rootEl.querySelector('#payrInit');
  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = '⏳ Kreiranje…';
  try {
    const n = await initPayrollMonth(kadrPayrollState.selectedYear, kadrPayrollState.selectedMonth);
    if (n == null) {
      showToast('⚠ Nije uspelo — proveri migraciju i da li si admin');
    } else {
      showToast(n > 0 ? `✅ Kreirano ${n} novih redova` : 'ℹ Svi aktivni zaposleni već imaju red za ovaj mesec');
    }
    await reloadPeriod(true);
  } catch (e) {
    console.error('[payroll] init', e);
    showToast('⚠ Greška pri pripremi meseca');
  } finally {
    btn.disabled = false;
    btn.textContent = txt;
  }
}

/* ── Render rows ────────────────────────────────────────────── */

function refreshRows() {
  if (!rootEl || !canAccessSalary()) return;
  const rows = kadrPayrollState.byPeriod.get(currentKey()) || [];
  const q = (rootEl.querySelector('#payrSearch').value || '').trim().toLowerCase();

  const filtered = q
    ? rows.filter(r => {
        const hay = [payrollEmployeeName(r), r.employeeName, r.employeePosition, r.employeeDepartment].join(' ').toLowerCase();
        return hay.includes(q);
      })
    : rows;
  const sorted = filtered.slice().sort(comparePayrollRows);

  const sumRsd = rows.reduce((a, r) => a + (r.totalRsd || 0), 0);
  const sumEur = rows.reduce((a, r) => a + (r.totalEur || 0), 0);
  const sumAdv = rows.reduce((a, r) => a + (r.advanceAmount || 0), 0);
  const sumSec = rows.reduce((a, r) => a + (r.secondPartRsd || 0), 0);
  const countDraft = rows.filter(r => r.status === 'draft').length;
  const countFinal = rows.filter(r => r.status === 'finalized' || r.status === 'paid').length;

  renderSummaryChips('payrSummary', [
    { label: 'Zaposlenih', value: rows.length, tone: 'accent' },
    { label: 'Draft', value: countDraft, tone: countDraft ? 'warn' : 'muted' },
    { label: 'Finalizovano / isplaćeno', value: countFinal, tone: 'ok' },
    { label: 'I deo (akontacija)', value: fmtRsd(sumAdv), tone: 'muted' },
    { label: 'II deo (konačno)', value: fmtRsd(sumSec), tone: 'muted' },
    { label: 'Ukupno RSD', value: fmtRsd(sumRsd), tone: 'accent' },
    { label: 'Ukupno EUR', value: `${fmtNum(sumEur)} EUR`, tone: 'accent' },
  ]);

  const tbody = rootEl.querySelector('#payrTbody');
  const empty = rootEl.querySelector('#payrEmpty');
  if (!sorted.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  tbody.innerHTML = sorted.map(rowHtml).join('');
  wireRowEvents(tbody);
}

function rowHtml(r) {
  const typeBadge = `<span class="kadr-type-badge t-sal-${escHtml(r.salaryType)}">${escHtml(r.salaryType)}</span>`;
  const statusBadge = `<span class="payr-status s-${escHtml(r.status)}">${statusLabel(r.status)}</span>`;
  const isHourly = r.salaryType === 'satnica';
  const locked = r.status === 'paid';
  const dis = locked ? 'disabled' : '';

  const baseCell = isHourly
    ? `<div class="payr-cell-dual">
         <input type="number" class="payr-inp" data-f="hoursWorked" data-emp="${escHtml(r.employeeId)}" min="0" step="0.25" value="${r.hoursWorked || 0}" ${dis}>
         <span class="payr-mul">×</span>
         <input type="number" class="payr-inp w-sm" data-f="hourlyRate"  data-emp="${escHtml(r.employeeId)}" min="0" step="0.01" value="${r.hourlyRate || 0}" ${dis}>
       </div>`
    : `<input type="number" class="payr-inp w-md" data-f="fixedSalary" data-emp="${escHtml(r.employeeId)}" min="0" step="0.01" value="${r.fixedSalary || 0}" ${dis}>`;

  return `
    <tr data-id="${escHtml(r.id)}" data-emp="${escHtml(r.employeeId)}" class="payr-row s-${escHtml(r.status)}">
      <td class="sticky-col">
        <div class="emp-name">${escHtml(payrollEmployeeName(r) || '—')}</div>
        <small class="emp-sub">${escHtml([r.employeePosition, r.employeeDepartment].filter(Boolean).join(' / ') || '')}</small>
      </td>
      <td>${typeBadge}</td>
      <td><input type="number" class="payr-inp w-md" data-f="advanceAmount" data-emp="${escHtml(r.employeeId)}" min="0" step="0.01" value="${r.advanceAmount || 0}" ${dis}></td>
      <td><input type="date" class="payr-inp" data-f="advancePaidOn" data-emp="${escHtml(r.employeeId)}" value="${escHtml(r.advancePaidOn || '')}" ${dis}></td>
      <td>${baseCell}</td>
      <td><input type="number" class="payr-inp w-sm" data-f="transportRsd" data-emp="${escHtml(r.employeeId)}" min="0" step="0.01" value="${r.transportRsd || 0}" ${dis}></td>
      <td>
        <div class="payr-cell-dual">
          <input type="number" class="payr-inp w-xs" data-f="domesticDays" data-emp="${escHtml(r.employeeId)}" min="0" step="1" value="${r.domesticDays || 0}" title="Broj domaćih terena" ${dis}>
          <span class="payr-mul">×</span>
          <input type="number" class="payr-inp w-sm" data-f="perDiemRsd" data-emp="${escHtml(r.employeeId)}" min="0" step="0.01" value="${r.perDiemRsd || 0}" title="Dinarska dnevnica" ${dis}>
        </div>
      </td>
      <td>
        <div class="payr-cell-dual">
          <input type="number" class="payr-inp w-xs" data-f="foreignDays" data-emp="${escHtml(r.employeeId)}" min="0" step="1" value="${r.foreignDays || 0}" title="Broj ino terena" ${dis}>
          <span class="payr-mul">×</span>
          <input type="number" class="payr-inp w-sm" data-f="perDiemEur" data-emp="${escHtml(r.employeeId)}" min="0" step="0.01" value="${r.perDiemEur || 0}" title="Devizna dnevnica EUR" ${dis}>
        </div>
      </td>
      <td class="num"><strong data-out="totalRsd">${fmtRsd(r.totalRsd)}</strong></td>
      <td class="num"><strong data-out="totalEur">${fmtNum(r.totalEur)} EUR</strong></td>
      <td class="num"><strong data-out="secondPartRsd">${fmtRsd(r.secondPartRsd)}</strong></td>
      <td><input type="date" class="payr-inp" data-f="finalPaidOn" data-emp="${escHtml(r.employeeId)}" value="${escHtml(r.finalPaidOn || '')}" ${dis}></td>
      <td>${statusBadge}</td>
      <td class="col-actions">
        <button class="btn-row-act primary" data-act="save" ${locked ? 'disabled' : ''}>💾 Sačuvaj</button>
        <button class="btn-row-act" data-act="status" title="Promeni status">↑ Status</button>
        <button class="btn-row-act danger" data-act="del" title="Obriši red">🗑</button>
      </td>
    </tr>`;
}

function wireRowEvents(tbody) {
  tbody.querySelectorAll('.payr-inp').forEach(inp => {
    inp.addEventListener('input', () => onRowInput(inp));
  });
  tbody.querySelectorAll('button[data-act="save"]').forEach(b => {
    b.addEventListener('click', () => saveRow(b.closest('tr')));
  });
  tbody.querySelectorAll('button[data-act="status"]').forEach(b => {
    b.addEventListener('click', () => cycleStatus(b.closest('tr')));
  });
  tbody.querySelectorAll('button[data-act="del"]').forEach(b => {
    b.addEventListener('click', () => deleteRow(b.closest('tr')));
  });
}

/* ── Live preview (FE mirror trigger) ──────────────────────── */

function collectRowPayload(tr) {
  const out = { id: tr.dataset.id, employeeId: tr.dataset.emp };
  tr.querySelectorAll('.payr-inp').forEach(inp => {
    const f = inp.dataset.f;
    if (!f) return;
    if (inp.type === 'number') out[f] = inp.value === '' ? 0 : Number(inp.value);
    else out[f] = inp.value;
  });
  /* Dohvati tip i trenutni status iz state-a */
  const rows = kadrPayrollState.byPeriod.get(currentKey()) || [];
  const existing = rows.find(r => r.id === tr.dataset.id);
  if (existing) {
    out.salaryType = existing.salaryType;
    out.periodYear = existing.periodYear;
    out.periodMonth = existing.periodMonth;
    out.status = existing.status;
    out.note = existing.note;
  }
  return out;
}

function onRowInput(inp) {
  const tr = inp.closest('tr');
  if (!tr) return;
  const payload = collectRowPayload(tr);
  const t = computeTotals(payload);
  const rsdEl = tr.querySelector('[data-out="totalRsd"]');
  const eurEl = tr.querySelector('[data-out="totalEur"]');
  const secEl = tr.querySelector('[data-out="secondPartRsd"]');
  if (rsdEl) rsdEl.textContent = fmtRsd(t.totalRsd);
  if (eurEl) eurEl.textContent = `${fmtNum(t.totalEur)} EUR`;
  if (secEl) secEl.textContent = fmtRsd(t.secondPartRsd);
  tr.classList.add('dirty');
}

/* ── Save / Status / Delete ──────────────────────────────── */

async function saveRow(tr) {
  if (!tr) return;
  const btn = tr.querySelector('button[data-act="save"]');
  const payload = collectRowPayload(tr);
  btn.disabled = true;
  const txt = btn.textContent;
  btn.textContent = '⏳';
  try {
    const saved = await upsertPayroll(payload);
    if (!saved) {
      showToast('⚠ Čuvanje nije uspelo');
      return;
    }
    /* Update u state-u */
    const key = currentKey();
    const rows = kadrPayrollState.byPeriod.get(key) || [];
    const idx = rows.findIndex(r => r.id === saved.id);
    if (idx >= 0) rows[idx] = { ...rows[idx], ...saved };
    else rows.push(saved);
    kadrPayrollState.byPeriod.set(key, rows);
    tr.classList.remove('dirty');
    refreshRows();
    showToast('💾 Sačuvano');
  } catch (e) {
    console.error('[payroll] save', e);
    showToast('⚠ Greška pri čuvanju');
  } finally {
    btn.disabled = false;
    btn.textContent = txt;
  }
}

async function cycleStatus(tr) {
  if (!tr) return;
  const id = tr.dataset.id;
  const rows = kadrPayrollState.byPeriod.get(currentKey()) || [];
  const r = rows.find(x => x.id === id);
  if (!r) return;
  const next = nextStatus(r.status);
  if (!next) { showToast('ℹ Već je u krajnjem statusu'); return; }
  if (next === 'paid' && !confirm('Obeležiti kao ISPLAĆENO? Nakon toga se red više ne može menjati.')) return;
  const payload = collectRowPayload(tr);
  payload.status = next;
  const saved = await upsertPayroll(payload);
  if (!saved) { showToast('⚠ Nije sačuvano'); return; }
  Object.assign(r, saved);
  refreshRows();
  showToast(`→ ${statusLabel(next)}`);
}

function nextStatus(cur) {
  if (cur === 'draft') return 'advance_paid';
  if (cur === 'advance_paid') return 'finalized';
  if (cur === 'finalized') return 'paid';
  return null;
}
function statusLabel(s) {
  switch (s) {
    case 'draft': return '📝 Draft';
    case 'advance_paid': return '💰 I deo isplaćen';
    case 'finalized': return '✅ Finalizovano';
    case 'paid': return '🔒 Isplaćeno';
    default: return s || '—';
  }
}

async function deleteRow(tr) {
  if (!tr) return;
  if (!confirm('Obrisati ceo obračun za ovog zaposlenog u ovom mesecu?')) return;
  const id = tr.dataset.id;
  const ok = await deletePayroll(id);
  if (!ok) { showToast('⚠ Nije obrisano'); return; }
  const key = currentKey();
  const rows = (kadrPayrollState.byPeriod.get(key) || []).filter(r => r.id !== id);
  kadrPayrollState.byPeriod.set(key, rows);
  refreshRows();
  showToast('🗑 Obrisano');
}

/* ── Excel export ───────────────────────────────────────── */

async function exportXlsx() {
  if (!canAccessSalary()) return;
  const XLSX = await loadXlsx();
  const y = kadrPayrollState.selectedYear;
  const m = kadrPayrollState.selectedMonth;
  const rows = kadrPayrollState.byPeriod.get(currentKey()) || [];

  const aoa = [[
    'Zaposleni', 'Pozicija', 'Odeljenje', 'Tip',
    'I deo (RSD)', 'I deo datum',
    'Sati', 'Satnica', 'Fiksna plata',
    'Prevoz (RSD)', 'Domaći tereni', 'Dinarska dnev.',
    'Ino tereni', 'Devizna dnev. (EUR)',
    'Ukupno RSD', 'Ukupno EUR', 'II deo (RSD)',
    'II deo datum', 'Status', 'Napomena',
  ]];
  rows.slice().sort(comparePayrollRows).forEach(r => aoa.push([
    payrollEmployeeName(r), r.employeePosition, r.employeeDepartment, r.salaryType,
    r.advanceAmount, r.advancePaidOn || '',
    r.hoursWorked, r.hourlyRate, r.fixedSalary,
    r.transportRsd, r.domesticDays, r.perDiemRsd,
    r.foreignDays, r.perDiemEur,
    r.totalRsd, r.totalEur, r.secondPartRsd,
    r.finalPaidOn || '', statusLabel(r.status), r.note || '',
  ]));

  /* Ukupni red */
  const sum = (col) => rows.reduce((a, r) => a + (Number(r[col]) || 0), 0);
  aoa.push([]);
  aoa.push([
    'UKUPNO', '', '', '',
    sum('advanceAmount'), '',
    '', '', '',
    sum('transportRsd'), '', '',
    '', '',
    sum('totalRsd'), sum('totalEur'), sum('secondPartRsd'),
    '', '', '',
  ]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [
    { wch: 28 }, { wch: 20 }, { wch: 16 }, { wch: 10 },
    { wch: 12 }, { wch: 12 },
    { wch: 8 }, { wch: 10 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 14 },
    { wch: 10 }, { wch: 14 },
    { wch: 14 }, { wch: 12 }, { wch: 14 },
    { wch: 12 }, { wch: 18 }, { wch: 24 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `${MONTH_NAMES[m - 1]} ${y}`);
  XLSX.writeFile(wb, `Zarade_obracun_${y}-${String(m).padStart(2, '0')}.xlsx`);
  showToast('📊 Izvezeno');
}

/* ── Utils ──────────────────────────────────────────────── */

function fmtRsd(n) {
  const v = Number(n || 0);
  return `${v.toLocaleString('sr-RS', { maximumFractionDigits: 2 })} RSD`;
}
function fmtNum(n) {
  const v = Number(n || 0);
  return v.toLocaleString('sr-RS', { maximumFractionDigits: 2 });
}

function debounce(fn, ms = 150) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}
