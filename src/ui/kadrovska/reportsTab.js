/**
 * Kadrovska / Izveštaji.
 *
 * Trenutno samo "Bolovanja" pod-tab (legacy paritet). Struktura ostavljena
 * tako da se kasnije lako dodaju ostali izveštaji (godišnji, prekovr., teren).
 *
 * Bolovanja izveštaj:
 *   - Filteri: zaposleni, odeljenje (firma), period (manual From/To,
 *     month picker, year picker, ili "sva vremena").
 *   - Per-employee aggregati: count evidencija, ukupno dana u periodu,
 *     prosek po evidenciji, datum poslednjeg bolovanja, "trenutno na
 *     bolovanju" pill.
 *   - Summary chips + footer UKUPNO red u tabeli.
 *   - XLSX export (lazy CDN load): 2 sheet-a — "sažetak" i "detalji".
 *
 * Bez framework-a / inline handler-a.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { daysInclusive } from '../../lib/date.js';
import { isHrOrAdmin } from '../../state/auth.js';
import { KADR_EDU_LEVEL_LABELS } from '../../lib/constants.js';
import {
  kadrovskaState,
  kadrAbsencesState,
  kadrVacationState,
  kadrChildrenState,
} from '../../state/kadrovska.js';
import {
  ensureEmployeesLoaded,
  ensureAbsencesLoaded,
  ensureVacationLoaded,
} from '../../services/kadrovska.js';
import { loadChildrenForEmployee } from '../../services/employeeChildren.js';
import { renderSummaryChips } from './shared.js';
import { loadXlsx } from '../../lib/xlsx.js';

let panelRoot = null;

/* ─── HELPERS ──────────────────────────────────────────────────────────── */

function _isoToday() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function _ymd(y, m1, d) {
  return `${y}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function _fmtSrDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = String(ymd).split('-');
  if (!y || !m || !d) return ymd;
  return `${parseInt(d, 10)}.${parseInt(m, 10)}.${y}`;
}

function _periodLabel(from, to) {
  if (!from && !to) return 'Sva vremena';
  if (from && to) return _fmtSrDate(from) + ' – ' + _fmtSrDate(to);
  if (from) return 'od ' + _fmtSrDate(from);
  return 'do ' + _fmtSrDate(to);
}

/**
 * Effective period: explicit From/To → month picker → year picker → all-time.
 */
function _readPeriod() {
  const fromEl = panelRoot?.querySelector('#repSickFrom')?.value || '';
  const toEl = panelRoot?.querySelector('#repSickTo')?.value || '';
  if (fromEl || toEl) return { from: fromEl || '', to: toEl || '' };
  const monthEl = panelRoot?.querySelector('#repSickMonth')?.value || '';
  if (monthEl) {
    const [y, m] = monthEl.split('-').map(n => parseInt(n, 10));
    if (y && m) {
      const last = new Date(y, m, 0).getDate();
      return { from: _ymd(y, m, 1), to: _ymd(y, m, last) };
    }
  }
  const yEl = panelRoot?.querySelector('#repSickYear')?.value || '';
  if (yEl) {
    const y = parseInt(yEl, 10);
    if (y >= 2000 && y <= 2100) return { from: _ymd(y, 1, 1), to: _ymd(y, 12, 31) };
  }
  return { from: '', to: '' };
}

function _intersectingDays(absFrom, absTo, periodFrom, periodTo) {
  if (!absFrom || !absTo) return 0;
  const f = periodFrom ? (absFrom < periodFrom ? periodFrom : absFrom) : absFrom;
  const t = periodTo ? (absTo > periodTo ? periodTo : absTo) : absTo;
  if (f > t) return 0;
  return daysInclusive(f, t);
}

/* ─── RENDER ───────────────────────────────────────────────────────────── */

export function renderReportsTab() {
  const curYear = String(new Date().getFullYear());
  const showChildren = isHrOrAdmin();
  return `
    <section class="kadr-panel-inner kadr-reports-panel" aria-label="Izveštaji">
      <div class="kadr-toolbar reports-toolbar">
        <div class="kadr-toolbar-row" role="tablist" aria-label="Izveštaj — vrsta">
          <button type="button" class="report-tab active" data-report-tab="sick" role="tab" aria-selected="true">🩺 Bolovanja</button>
          <button type="button" class="report-tab" data-report-tab="demo" role="tab" aria-selected="false">📈 Demografija</button>
          <button type="button" class="report-tab" data-report-tab="vacation" role="tab" aria-selected="false">🏖 Saldo GO</button>
          ${showChildren ? '<button type="button" class="report-tab" data-report-tab="children" role="tab" aria-selected="false">👶 Deca</button>' : ''}
        </div>
      </div>

      <div class="report-panel active" id="reportPanel-sick" role="tabpanel">
        <div class="kadr-toolbar">
          <div class="kadr-toolbar-row">
            <label class="kadr-field">
              <span>Zaposleni</span>
              <select id="repSickEmpFilter"><option value="">Svi zaposleni</option></select>
            </label>
            <label class="kadr-field">
              <span>Odeljenje / firma</span>
              <select id="repSickDeptFilter"><option value="">Sva odeljenja / firme</option></select>
            </label>
            <label class="kadr-field">
              <span>Mesec</span>
              <input type="month" id="repSickMonth">
            </label>
            <label class="kadr-field">
              <span>Godina</span>
              <input type="number" id="repSickYear" min="2000" max="2100" value="${curYear}" style="max-width:90px">
            </label>
            <label class="kadr-field">
              <span>Od</span>
              <input type="date" id="repSickFrom">
            </label>
            <label class="kadr-field">
              <span>Do</span>
              <input type="date" id="repSickTo">
            </label>
            <button type="button" class="btn btn-ghost" id="repSickReset">Resetuj filtere</button>
            <button type="button" class="btn btn-ghost" id="repSickExport" title="Izvoz u Excel">📊 Excel</button>
            <span class="kadr-count" id="repSickCount">0 evidencija</span>
          </div>
        </div>
        <div class="kadr-summary-strip" id="repSickSummary"></div>
        <div class="kadr-table-wrap">
          <table class="kadr-table report-sick-table">
            <thead>
              <tr>
                <th>Zaposleni</th>
                <th class="col-hide-sm">Odeljenje</th>
                <th>Br. evid.</th>
                <th>Σ dana (period)</th>
                <th class="col-hide-sm">Prosek (d)</th>
                <th class="col-hide-sm">Poslednje</th>
                <th>Trenutno?</th>
              </tr>
            </thead>
            <tbody id="repSickTbody"></tbody>
            <tfoot id="repSickTfoot"></tfoot>
          </table>
        </div>
        <div id="repSickEmpty" class="kadr-empty" style="display:none">Nema bolovanja u izabranom periodu.</div>
      </div>

      <div class="report-panel" id="reportPanel-demo" role="tabpanel" hidden>
        <div class="kadr-toolbar">
          <div class="kadr-toolbar-row">
            <label class="kadr-field">
              <span>Status</span>
              <select id="repDemoStatus">
                <option value="active" selected>Samo aktivni</option>
                <option value="all">Svi</option>
              </select>
            </label>
            <button type="button" class="btn btn-ghost" id="repDemoExport" title="Izvoz u Excel">📊 Excel</button>
          </div>
        </div>
        <div class="kadr-summary-strip" id="repDemoSummary"></div>
        <div class="kadr-demo-grid" id="repDemoGrid"></div>
      </div>

      <div class="report-panel" id="reportPanel-vacation" role="tabpanel" hidden>
        <div class="kadr-toolbar">
          <div class="kadr-toolbar-row">
            <label class="kadr-field">
              <span>Godina</span>
              <input type="number" id="repVacYear" min="2000" max="2100" value="${curYear}" style="max-width:90px">
            </label>
            <label class="kadr-field">
              <span>Status</span>
              <select id="repVacStatus">
                <option value="active" selected>Samo aktivni</option>
                <option value="all">Svi</option>
              </select>
            </label>
            <button type="button" class="btn btn-ghost" id="repVacExport" title="Izvoz u Excel">📊 Excel</button>
            <span class="kadr-count" id="repVacCount">0 zaposlenih</span>
          </div>
        </div>
        <div class="kadr-summary-strip" id="repVacSummary"></div>
        <div class="kadr-table-wrap">
          <table class="kadr-table">
            <thead>
              <tr>
                <th>Zaposleni</th>
                <th class="col-hide-sm">Odeljenje</th>
                <th>Dana pravo</th>
                <th>Preneto</th>
                <th>Iskorišćeno</th>
                <th>Preostalo</th>
              </tr>
            </thead>
            <tbody id="repVacTbody"></tbody>
          </table>
        </div>
        <div id="repVacEmpty" class="kadr-empty" style="display:none">Nema podataka o GO za izabranu godinu.</div>
      </div>

      ${showChildren ? `
      <div class="report-panel" id="reportPanel-children" role="tabpanel" hidden>
        <div class="kadr-toolbar">
          <div class="kadr-toolbar-row">
            <button type="button" class="btn btn-ghost" id="repChildrenExport" title="Izvoz u Excel">📊 Excel</button>
            <span class="kadr-count" id="repChildrenCount">0 dece</span>
          </div>
        </div>
        <div class="kadr-summary-strip" id="repChildrenSummary"></div>
        <div class="kadr-table-wrap">
          <table class="kadr-table">
            <thead>
              <tr>
                <th>Zaposleni</th>
                <th>Dete — ime</th>
                <th>Datum rođenja</th>
                <th>Starost (god.)</th>
              </tr>
            </thead>
            <tbody id="repChildrenTbody"></tbody>
          </table>
        </div>
        <div id="repChildrenEmpty" class="kadr-empty" style="display:none">Nema upisane dece.</div>
      </div>
      ` : ''}
    </section>
  `;
}

/* ─── FILTERS POPULATE ────────────────────────────────────────────────── */

function _populateFilters() {
  const sel = panelRoot?.querySelector('#repSickEmpFilter');
  if (sel) {
    const prev = sel.value;
    const sortedEmp = kadrovskaState.employees.slice()
      .sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'sr'));
    sel.innerHTML = '<option value="">Svi zaposleni</option>'
      + sortedEmp.map(e => `<option value="${escHtml(e.id)}">${escHtml(e.fullName || '—')}${e.isActive ? '' : ' (neaktivan)'}</option>`).join('');
    if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
  }
  const dsel = panelRoot?.querySelector('#repSickDeptFilter');
  if (dsel) {
    const prev = dsel.value;
    const set = new Set();
    kadrovskaState.employees.forEach(e => {
      if (e.department) set.add(String(e.department).trim());
    });
    const opts = Array.from(set).sort((a, b) => a.localeCompare(b, 'sr'));
    dsel.innerHTML = '<option value="">Sva odeljenja / firme</option>'
      + opts.map(d => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join('');
    if (prev && Array.from(dsel.options).some(o => o.value === prev)) dsel.value = prev;
  }
}

/* ─── REPORT RENDER ───────────────────────────────────────────────────── */

function _aggregate() {
  const empFilter = panelRoot?.querySelector('#repSickEmpFilter')?.value || '';
  const deptFilter = panelRoot?.querySelector('#repSickDeptFilter')?.value || '';
  const { from: pFrom, to: pTo } = _readPeriod();

  const allSick = (kadrAbsencesState.items || []).filter(a => a.type === 'bolovanje');
  const empById = new Map(kadrovskaState.employees.map(e => [e.id, e]));
  const today = _isoToday();

  const perEmp = new Map();
  let kept = 0;
  allSick.forEach(a => {
    if (!a.employeeId) return;
    if (empFilter && a.employeeId !== empFilter) return;
    const emp = empById.get(a.employeeId);
    if (deptFilter && (!emp || emp.department !== deptFilter)) return;
    const days = _intersectingDays(a.dateFrom, a.dateTo, pFrom, pTo);
    if (days <= 0) return;
    kept++;
    if (!perEmp.has(a.employeeId)) {
      perEmp.set(a.employeeId, {
        emp: emp || null,
        id: a.employeeId,
        name: emp?.fullName || '(obrisan)',
        dept: emp?.department || '',
        count: 0,
        totalDays: 0,
        lastTo: '',
        currentlyActive: false,
        durations: [],
      });
    }
    const r = perEmp.get(a.employeeId);
    r.count++;
    r.totalDays += days;
    if (a.dateFrom && a.dateTo && a.dateFrom <= today && a.dateTo >= today) r.currentlyActive = true;
    if (a.dateTo && (!r.lastTo || a.dateTo > r.lastTo)) r.lastTo = a.dateTo;
    r.durations.push(daysInclusive(a.dateFrom, a.dateTo));
  });

  return { perEmp, kept, pFrom, pTo, empFilter, deptFilter, empById, today, allSick };
}

function _renderSickReport() {
  const tbody = panelRoot?.querySelector('#repSickTbody');
  const tfoot = panelRoot?.querySelector('#repSickTfoot');
  const empty = panelRoot?.querySelector('#repSickEmpty');
  const countEl = panelRoot?.querySelector('#repSickCount');
  const badge = document.getElementById('kadrTabCountReports');
  if (!tbody) return;

  const { perEmp, kept, pFrom, pTo } = _aggregate();
  const empCount = perEmp.size;
  let sumDays = 0, currentNow = 0;
  perEmp.forEach(r => {
    sumDays += r.totalDays;
    if (r.currentlyActive) currentNow++;
  });
  const avgPerEmp = empCount ? Math.round((sumDays / empCount) * 10) / 10 : 0;

  if (badge) badge.textContent = String(empCount);
  if (countEl) countEl.textContent = `${kept} ${kept === 1 ? 'evidencija' : 'evidencija'} · ${empCount} ${empCount === 1 ? 'zaposleni' : 'zaposlenih'}`;

  renderSummaryChips('repSickSummary', [
    { label: 'Period', value: _periodLabel(pFrom, pTo), tone: 'muted' },
    { label: 'Zaposlenih sa bolovanjem', value: empCount, tone: empCount > 0 ? 'accent' : 'muted' },
    { label: 'Σ Dana', value: sumDays, tone: sumDays > 0 ? 'warn' : 'muted' },
    { label: 'Prosek dana / radnik', value: avgPerEmp, tone: 'muted' },
    { label: 'Trenutno na bolovanju', value: currentNow, tone: currentNow > 0 ? 'warn' : 'muted' },
  ]);

  if (empCount === 0) {
    tbody.innerHTML = '';
    if (tfoot) tfoot.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  const rows = Array.from(perEmp.values()).sort((a, b) => {
    if (b.totalDays !== a.totalDays) return b.totalDays - a.totalDays;
    return String(a.name).localeCompare(String(b.name), 'sr');
  });

  tbody.innerHTML = rows.map(r => {
    const avg = r.durations.length
      ? Math.round((r.durations.reduce((a, b) => a + b, 0) / r.durations.length) * 10) / 10
      : 0;
    const last = r.lastTo ? _fmtSrDate(r.lastTo) : '—';
    const cur = r.currentlyActive
      ? '<span class="kadr-pill warn">DA</span>'
      : '<span class="kadr-pill muted">ne</span>';
    return `<tr>
      <td><strong>${escHtml(r.name)}</strong></td>
      <td class="col-hide-sm">${escHtml(r.dept || '—')}</td>
      <td>${r.count}</td>
      <td><strong>${r.totalDays}</strong></td>
      <td class="col-hide-sm">${avg}</td>
      <td class="col-hide-sm">${escHtml(last)}</td>
      <td>${cur}</td>
    </tr>`;
  }).join('');

  if (tfoot) {
    tfoot.innerHTML = `<tr class="row-totals">
      <td colspan="2" style="text-align:right;font-weight:700">UKUPNO</td>
      <td>${rows.reduce((s, r) => s + r.count, 0)}</td>
      <td><strong>${sumDays}</strong></td>
      <td colspan="3"></td>
    </tr>`;
  }
}

/* ═════════════════════════════════════════════════════════════════════
   DEMOGRAFIJA (rod / starost / obrazovanje / staž)
   ═════════════════════════════════════════════════════════════════════ */

function _ageYears(birthDate) {
  if (!birthDate) return null;
  const d = new Date(birthDate);
  if (isNaN(d)) return null;
  const t = new Date();
  let y = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) y--;
  return y;
}

function _tenureYears(hireDate) {
  if (!hireDate) return null;
  const d = new Date(hireDate);
  if (isNaN(d)) return null;
  return _ageYears(hireDate);
}

const AGE_BUCKETS = [
  { k: '<25',    min: 0,  max: 24 },
  { k: '25–34',  min: 25, max: 34 },
  { k: '35–44',  min: 35, max: 44 },
  { k: '45–54',  min: 45, max: 54 },
  { k: '55+',    min: 55, max: 200 },
];
const TENURE_BUCKETS = [
  { k: '<1 god', min: 0,  max: 0 },
  { k: '1–2',    min: 1,  max: 2 },
  { k: '3–5',    min: 3,  max: 5 },
  { k: '6–10',   min: 6,  max: 10 },
  { k: '11–20',  min: 11, max: 20 },
  { k: '20+',    min: 21, max: 200 },
];

function _bucketize(val, buckets) {
  if (val == null) return '(nepoznato)';
  for (const b of buckets) {
    if (val >= b.min && val <= b.max) return b.k;
  }
  return '(nepoznato)';
}

function _aggregateDemo() {
  const status = panelRoot?.querySelector('#repDemoStatus')?.value || 'active';
  const emps = kadrovskaState.employees.filter(e => status === 'all' || e.isActive);

  const gender = new Map([['M', 0], ['Z', 0], ['(nepoznato)', 0]]);
  const ageDist = new Map(AGE_BUCKETS.map(b => [b.k, 0]).concat([['(nepoznato)', 0]]));
  const tenDist = new Map(TENURE_BUCKETS.map(b => [b.k, 0]).concat([['(nepoznato)', 0]]));
  const eduDist = new Map();
  const deptDist = new Map();

  emps.forEach(e => {
    gender.set(e.gender || '(nepoznato)', (gender.get(e.gender || '(nepoznato)') || 0) + 1);
    const age = _ageYears(e.birthDate);
    ageDist.set(_bucketize(age, AGE_BUCKETS), (ageDist.get(_bucketize(age, AGE_BUCKETS)) || 0) + 1);
    const ten = _tenureYears(e.hireDate);
    tenDist.set(_bucketize(ten, TENURE_BUCKETS), (tenDist.get(_bucketize(ten, TENURE_BUCKETS)) || 0) + 1);
    const eduLbl = e.educationLevel
      ? (KADR_EDU_LEVEL_LABELS[e.educationLevel] || e.educationLevel)
      : '(nepopunjeno)';
    eduDist.set(eduLbl, (eduDist.get(eduLbl) || 0) + 1);
    const dept = e.department || '(nedodeljeno)';
    deptDist.set(dept, (deptDist.get(dept) || 0) + 1);
  });

  return { total: emps.length, gender, ageDist, tenDist, eduDist, deptDist };
}

function _miniCardHtml(title, dist, { order = null, sortDesc = true } = {}) {
  let entries = Array.from(dist.entries()).filter(([, n]) => n > 0);
  if (order) {
    const idx = new Map(order.map((k, i) => [k, i]));
    entries.sort((a, b) => (idx.get(a[0]) ?? 999) - (idx.get(b[0]) ?? 999));
  } else if (sortDesc) {
    entries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'sr'));
  }
  const total = entries.reduce((s, [, n]) => s + n, 0) || 1;
  const rows = entries.map(([k, n]) => {
    const pct = Math.round((n / total) * 100);
    return `<div class="demo-row">
      <span class="demo-k">${escHtml(k)}</span>
      <span class="demo-bar"><span style="width:${pct}%"></span></span>
      <span class="demo-v">${n} <small>(${pct}%)</small></span>
    </div>`;
  }).join('');
  return `<div class="demo-card">
    <h4>${escHtml(title)}</h4>
    ${rows || '<div class="emp-sub">Nema podataka.</div>'}
  </div>`;
}

function _renderDemo() {
  if (!panelRoot) return;
  const host = panelRoot.querySelector('#repDemoGrid');
  if (!host) return;
  const a = _aggregateDemo();
  renderSummaryChips('repDemoSummary', [
    { label: 'Ukupno', value: a.total, tone: 'accent' },
    { label: 'Muški', value: a.gender.get('M') || 0, tone: 'muted' },
    { label: 'Ženski', value: a.gender.get('Z') || 0, tone: 'muted' },
    { label: 'Bez podataka (pol)', value: a.gender.get('(nepoznato)') || 0, tone: 'muted' },
  ]);
  const genderLabeled = new Map([
    ['Muški',     a.gender.get('M') || 0],
    ['Ženski',    a.gender.get('Z') || 0],
    ['(nepoznato)', a.gender.get('(nepoznato)') || 0],
  ]);
  host.innerHTML = [
    _miniCardHtml('Rodna struktura', genderLabeled, { order: ['Muški', 'Ženski', '(nepoznato)'] }),
    _miniCardHtml('Starosna struktura', a.ageDist, { order: AGE_BUCKETS.map(b => b.k).concat(['(nepoznato)']) }),
    _miniCardHtml('Staž', a.tenDist, { order: TENURE_BUCKETS.map(b => b.k).concat(['(nepoznato)']) }),
    _miniCardHtml('Stručna sprema', a.eduDist),
    _miniCardHtml('Po odeljenjima', a.deptDist),
  ].join('');
}

async function _exportDemoXlsx() {
  let XLSX;
  try { XLSX = await loadXlsx(); } catch { showToast('⚠ XLSX nedostupan'); return; }
  const a = _aggregateDemo();
  const sheets = [
    ['Rod', [
      ['Pol', 'Broj'],
      ['Muški', a.gender.get('M') || 0],
      ['Ženski', a.gender.get('Z') || 0],
      ['(nepoznato)', a.gender.get('(nepoznato)') || 0],
    ]],
    ['Starost', [
      ['Raspon', 'Broj'],
      ...AGE_BUCKETS.map(b => [b.k, a.ageDist.get(b.k) || 0]),
      ['(nepoznato)', a.ageDist.get('(nepoznato)') || 0],
    ]],
    ['Staž', [
      ['Raspon', 'Broj'],
      ...TENURE_BUCKETS.map(b => [b.k, a.tenDist.get(b.k) || 0]),
      ['(nepoznato)', a.tenDist.get('(nepoznato)') || 0],
    ]],
    ['Stručna sprema', [
      ['Stepen', 'Broj'],
      ...Array.from(a.eduDist.entries()).sort((x, y) => y[1] - x[1]),
    ]],
    ['Odeljenja', [
      ['Odeljenje', 'Broj'],
      ...Array.from(a.deptDist.entries()).sort((x, y) => y[1] - x[1]),
    ]],
  ];
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 24 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  XLSX.writeFile(wb, `Demografija_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast('📊 Izvezeno');
}

/* ═════════════════════════════════════════════════════════════════════
   SALDO GO (po godini)
   ═════════════════════════════════════════════════════════════════════ */

function _renderVacReport() {
  if (!panelRoot) return;
  const tbody = panelRoot.querySelector('#repVacTbody');
  const empty = panelRoot.querySelector('#repVacEmpty');
  const countEl = panelRoot.querySelector('#repVacCount');
  if (!tbody) return;

  const year = Number(panelRoot.querySelector('#repVacYear').value || new Date().getFullYear());
  const status = panelRoot.querySelector('#repVacStatus').value || 'active';
  const balByEmp = new Map();
  for (const b of kadrVacationState.balances) if (b.year === year) balByEmp.set(b.employeeId, b);
  const entByEmp = new Map();
  for (const e of kadrVacationState.entitlements) if (e.year === year) entByEmp.set(e.employeeId, e);

  const emps = kadrovskaState.employees.filter(e => status === 'all' || e.isActive);
  const rows = emps.map(emp => {
    const ent = entByEmp.get(emp.id);
    const bal = balByEmp.get(emp.id);
    const daysTotal = ent?.daysTotal ?? 20;
    const daysCarried = ent?.daysCarriedOver ?? 0;
    let daysUsed = bal?.daysUsed ?? 0;
    if (!bal) {
      daysUsed = 0;
      kadrAbsencesState.items.forEach(a => {
        if (a.type === 'godisnji' && a.employeeId === emp.id && a.dateFrom?.startsWith(String(year))) {
          daysUsed += a.daysCount != null
            ? Number(a.daysCount)
            : (a.dateFrom && a.dateTo ? daysInclusive(a.dateFrom, a.dateTo) : 0);
        }
      });
    }
    return { emp, daysTotal, daysCarried, daysUsed, remaining: daysTotal + daysCarried - daysUsed };
  });

  if (countEl) countEl.textContent = `${rows.length} ${rows.length === 1 ? 'zaposleni' : 'zaposlenih'}`;

  const totalTot = rows.reduce((s, r) => s + r.daysTotal + r.daysCarried, 0);
  const totalUsed = rows.reduce((s, r) => s + r.daysUsed, 0);
  const totalRem = rows.reduce((s, r) => s + r.remaining, 0);
  renderSummaryChips('repVacSummary', [
    { label: 'Godina', value: year, tone: 'accent' },
    { label: 'Ukupno dana', value: totalTot, tone: 'accent' },
    { label: 'Iskorišćeno', value: totalUsed, tone: 'warn' },
    { label: 'Preostalo', value: totalRem, tone: totalRem > 0 ? 'ok' : 'muted' },
  ]);

  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = rows.sort((a, b) => String(a.emp.fullName || '').localeCompare(String(b.emp.fullName || ''), 'sr')).map(r => {
    const remCls = r.remaining < 0 ? 'warn' : (r.remaining < 3 ? 'accent' : 'ok');
    return `<tr>
      <td><strong>${escHtml(r.emp.fullName || '—')}</strong></td>
      <td class="col-hide-sm">${escHtml(r.emp.department || '—')}</td>
      <td>${r.daysTotal}</td>
      <td>${r.daysCarried}</td>
      <td><strong>${r.daysUsed}</strong></td>
      <td><span class="kadr-type-badge t-${remCls}" style="font-family:var(--mono);font-weight:700;">${r.remaining}</span></td>
    </tr>`;
  }).join('');
}

async function _exportVacXlsx() {
  let XLSX;
  try { XLSX = await loadXlsx(); } catch { showToast('⚠ XLSX nedostupan'); return; }
  const year = Number(panelRoot.querySelector('#repVacYear').value || new Date().getFullYear());
  const status = panelRoot.querySelector('#repVacStatus').value || 'active';
  const balByEmp = new Map();
  for (const b of kadrVacationState.balances) if (b.year === year) balByEmp.set(b.employeeId, b);
  const entByEmp = new Map();
  for (const e of kadrVacationState.entitlements) if (e.year === year) entByEmp.set(e.employeeId, e);

  const aoa = [['Zaposleni', 'Odeljenje', 'Dana pravo', 'Preneto', 'Iskorišćeno', 'Preostalo']];
  kadrovskaState.employees
    .filter(e => status === 'all' || e.isActive)
    .forEach(emp => {
      const ent = entByEmp.get(emp.id);
      const bal = balByEmp.get(emp.id);
      const dt = ent?.daysTotal ?? 20;
      const dc = ent?.daysCarriedOver ?? 0;
      const du = bal?.daysUsed ?? 0;
      aoa.push([emp.fullName || '', emp.department || '', dt, dc, du, dt + dc - du]);
    });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Saldo GO ${year}`);
  XLSX.writeFile(wb, `Saldo_GO_${year}.xlsx`);
  showToast('📊 Izvezeno');
}

/* ═════════════════════════════════════════════════════════════════════
   DECA (samo HR/admin)
   ═════════════════════════════════════════════════════════════════════ */

async function _loadAllChildren() {
  /* Učitaj decu za sve aktivne zaposlene (sequential + cache u state). */
  const emps = kadrovskaState.employees;
  const out = [];
  for (const emp of emps) {
    const arr = kadrChildrenState.byEmp.has(emp.id)
      ? kadrChildrenState.byEmp.get(emp.id)
      : await loadChildrenForEmployee(emp.id);
    if (arr) {
      kadrChildrenState.byEmp.set(emp.id, arr);
      for (const c of arr) out.push({ emp, c });
    }
  }
  return out;
}

async function _renderChildrenReport() {
  if (!panelRoot || !isHrOrAdmin()) return;
  const tbody = panelRoot.querySelector('#repChildrenTbody');
  const empty = panelRoot.querySelector('#repChildrenEmpty');
  const countEl = panelRoot.querySelector('#repChildrenCount');
  if (!tbody) return;

  const rows = await _loadAllChildren();

  if (countEl) countEl.textContent = `${rows.length} ${rows.length === 1 ? 'dete' : 'dece'}`;

  /* Distribucije: ispod 7 god (predškolski), 7–14 (osnovna), 15–18 (srednja), 19+. */
  let preschool = 0, primary = 0, secondary = 0, older = 0;
  rows.forEach(({ c }) => {
    const age = _ageYears(c.birthDate);
    if (age == null) return;
    if (age < 7) preschool++;
    else if (age <= 14) primary++;
    else if (age <= 18) secondary++;
    else older++;
  });
  renderSummaryChips('repChildrenSummary', [
    { label: 'Ukupno dece', value: rows.length, tone: 'accent' },
    { label: '< 7 god', value: preschool, tone: 'muted' },
    { label: '7–14', value: primary, tone: 'muted' },
    { label: '15–18', value: secondary, tone: 'muted' },
    { label: '19+', value: older, tone: 'muted' },
  ]);

  if (!rows.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  rows.sort((a, b) => String(a.emp.fullName || '').localeCompare(String(b.emp.fullName || ''), 'sr')
    || String(a.c.birthDate || '').localeCompare(String(b.c.birthDate || '')));
  tbody.innerHTML = rows.map(({ emp, c }) => {
    const age = _ageYears(c.birthDate);
    return `<tr>
      <td><strong>${escHtml(emp.fullName || '—')}</strong></td>
      <td>${escHtml(c.firstName || '—')}</td>
      <td>${c.birthDate ? _fmtSrDate(c.birthDate) : '—'}</td>
      <td>${age ?? '—'}</td>
    </tr>`;
  }).join('');
}

async function _exportChildrenXlsx() {
  let XLSX;
  try { XLSX = await loadXlsx(); } catch { showToast('⚠ XLSX nedostupan'); return; }
  const rows = await _loadAllChildren();
  if (!rows.length) { showToast('Nema podataka za izvoz'); return; }
  const aoa = [['Zaposleni', 'Odeljenje', 'Ime deteta', 'Datum rođenja', 'Starost']];
  rows
    .sort((a, b) => String(a.emp.fullName || '').localeCompare(String(b.emp.fullName || ''), 'sr'))
    .forEach(({ emp, c }) => {
      aoa.push([emp.fullName || '', emp.department || '', c.firstName || '', c.birthDate || '', _ageYears(c.birthDate) ?? '']);
    });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Deca zaposlenih');
  XLSX.writeFile(wb, `Deca_zaposlenih_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast('📊 Izvezeno');
}

/* ─── EXCEL EXPORT ────────────────────────────────────────────────────── */

async function _exportToXlsx() {
  let XLSX;
  try {
    XLSX = await loadXlsx();
  } catch (err) {
    console.error('[reports] xlsx load failed', err);
    showToast('⚠ XLSX biblioteka nije dostupna');
    return;
  }
  const empFilter = panelRoot?.querySelector('#repSickEmpFilter')?.value || '';
  const deptFilter = panelRoot?.querySelector('#repSickDeptFilter')?.value || '';
  const { from: pFrom, to: pTo } = _readPeriod();
  const allSick = (kadrAbsencesState.items || []).filter(a => a.type === 'bolovanje');
  const empById = new Map(kadrovskaState.employees.map(e => [e.id, e]));
  const today = _isoToday();

  const perEmp = new Map();
  const detail = [];
  allSick.forEach(a => {
    if (!a.employeeId) return;
    if (empFilter && a.employeeId !== empFilter) return;
    const emp = empById.get(a.employeeId);
    if (deptFilter && (!emp || emp.department !== deptFilter)) return;
    const days = _intersectingDays(a.dateFrom, a.dateTo, pFrom, pTo);
    if (days <= 0) return;
    const name = emp?.fullName || '(obrisan)';
    const dept = emp?.department || '';
    detail.push([
      name, dept, a.dateFrom || '', a.dateTo || '',
      daysInclusive(a.dateFrom, a.dateTo),
      days,
      a.note || '',
    ]);
    if (!perEmp.has(a.employeeId)) {
      perEmp.set(a.employeeId, {
        emp, name, dept,
        count: 0, totalDays: 0, lastTo: '',
        currentlyActive: false, durations: [],
      });
    }
    const r = perEmp.get(a.employeeId);
    r.count++; r.totalDays += days;
    if (a.dateFrom && a.dateTo && a.dateFrom <= today && a.dateTo >= today) r.currentlyActive = true;
    if (a.dateTo && (!r.lastTo || a.dateTo > r.lastTo)) r.lastTo = a.dateTo;
    r.durations.push(daysInclusive(a.dateFrom, a.dateTo));
  });

  if (perEmp.size === 0) { showToast('⚠ Nema podataka za izvoz'); return; }

  /* Sheet 1: sažetak */
  const summaryAoa = [];
  summaryAoa.push(['IZVEŠTAJ O BOLOVANJIMA']);
  summaryAoa.push(['Period', _periodLabel(pFrom, pTo)]);
  summaryAoa.push(['Filter — zaposleni', empFilter ? (empById.get(empFilter)?.fullName || empFilter) : 'Svi']);
  summaryAoa.push(['Filter — odeljenje', deptFilter || 'Sva']);
  summaryAoa.push([]);
  summaryAoa.push(['Zaposleni', 'Odeljenje', 'Broj evid.', 'Σ dana (u periodu)', 'Prosek (d) po evid.', 'Poslednje bolovanje', 'Trenutno?']);
  Array.from(perEmp.values())
    .sort((a, b) => b.totalDays - a.totalDays || a.name.localeCompare(b.name, 'sr'))
    .forEach(r => {
      const avg = r.durations.length
        ? Math.round((r.durations.reduce((a, b) => a + b, 0) / r.durations.length) * 10) / 10
        : 0;
      summaryAoa.push([r.name, r.dept || '', r.count, r.totalDays, avg, r.lastTo || '', r.currentlyActive ? 'DA' : 'ne']);
    });
  const wsSum = XLSX.utils.aoa_to_sheet(summaryAoa);
  wsSum['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 11 }, { wch: 18 }, { wch: 16 }, { wch: 18 }, { wch: 11 }];
  wsSum['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];

  /* Sheet 2: detalji */
  const detailAoa = [
    ['Zaposleni', 'Odeljenje', 'Od', 'Do', 'Trajanje (d)', 'Dana u periodu', 'Napomena'],
    ...detail.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'sr')),
  ];
  const wsDet = XLSX.utils.aoa_to_sheet(detailAoa);
  wsDet['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 40 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, wsSum, 'Bolovanja - sažetak');
  XLSX.utils.book_append_sheet(wb, wsDet, 'Bolovanja - detalji');
  const periodTag = (pFrom || '') + (pTo ? '_' + pTo : '') || 'all';
  const fname = 'Bolovanja_' + periodTag + '.xlsx';
  XLSX.writeFile(wb, fname);
  showToast('📊 Izvezeno: ' + fname);
}

/* ─── PUBLIC: WIRE ────────────────────────────────────────────────────── */

export async function wireReportsTab(panel) {
  panelRoot = panel;

  /* Wire filter handlers (po pravilu: promena meseca/godine briše manualni
     range; promena range-a briše mesec; promena godine briše mesec+range) */
  panel.querySelector('#repSickEmpFilter')?.addEventListener('change', _renderSickReport);
  panel.querySelector('#repSickDeptFilter')?.addEventListener('change', _renderSickReport);

  panel.querySelector('#repSickMonth')?.addEventListener('change', () => {
    const f = panel.querySelector('#repSickFrom');
    const t = panel.querySelector('#repSickTo');
    if (f) f.value = '';
    if (t) t.value = '';
    _renderSickReport();
  });
  panel.querySelector('#repSickYear')?.addEventListener('change', () => {
    const m = panel.querySelector('#repSickMonth');
    const f = panel.querySelector('#repSickFrom');
    const t = panel.querySelector('#repSickTo');
    if (m) m.value = '';
    if (f) f.value = '';
    if (t) t.value = '';
    _renderSickReport();
  });
  const onRange = () => {
    const m = panel.querySelector('#repSickMonth');
    if (m) m.value = '';
    _renderSickReport();
  };
  panel.querySelector('#repSickFrom')?.addEventListener('change', onRange);
  panel.querySelector('#repSickTo')?.addEventListener('change', onRange);

  panel.querySelector('#repSickReset')?.addEventListener('click', () => {
    ['repSickEmpFilter', 'repSickDeptFilter', 'repSickMonth', 'repSickYear', 'repSickFrom', 'repSickTo']
      .forEach(id => {
        const el = panel.querySelector('#' + id);
        if (el) el.value = '';
      });
    const y = panel.querySelector('#repSickYear');
    if (y) y.value = String(new Date().getFullYear());
    _renderSickReport();
  });

  panel.querySelector('#repSickExport')?.addEventListener('click', _exportToXlsx);

  /* ── Subtab switching ────────────────────────────── */
  const reportTabs = Array.from(panel.querySelectorAll('.report-tab'));
  const reportPanels = Array.from(panel.querySelectorAll('.report-panel'));
  reportTabs.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tab = btn.dataset.reportTab;
      reportTabs.forEach(b => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-selected', String(isActive));
      });
      reportPanels.forEach(p => {
        const isActive = p.id === 'reportPanel-' + tab;
        p.classList.toggle('active', isActive);
        if (isActive) p.removeAttribute('hidden');
        else p.setAttribute('hidden', '');
      });
      if (tab === 'demo') _renderDemo();
      if (tab === 'vacation') {
        const year = Number(panel.querySelector('#repVacYear').value);
        await ensureVacationLoaded(year, true);
        _renderVacReport();
      }
      if (tab === 'children') await _renderChildrenReport();
    });
  });

  /* ── Demografija listeners ────────────────────────── */
  panel.querySelector('#repDemoStatus')?.addEventListener('change', _renderDemo);
  panel.querySelector('#repDemoExport')?.addEventListener('click', _exportDemoXlsx);

  /* ── Saldo GO listeners ──────────────────────────── */
  panel.querySelector('#repVacYear')?.addEventListener('change', async () => {
    const year = Number(panel.querySelector('#repVacYear').value);
    await ensureVacationLoaded(year, true);
    _renderVacReport();
  });
  panel.querySelector('#repVacStatus')?.addEventListener('change', _renderVacReport);
  panel.querySelector('#repVacExport')?.addEventListener('click', _exportVacXlsx);

  /* ── Deca listeners ──────────────────────────────── */
  panel.querySelector('#repChildrenExport')?.addEventListener('click', _exportChildrenXlsx);

  /* Učitaj zaposlene + odsustva (paralelno, kako se ne bi blokiralo) */
  try {
    await Promise.all([
      ensureEmployeesLoaded(),
      ensureAbsencesLoaded(),
    ]);
  } catch (err) {
    console.warn('[reports] data load failed', err);
  }

  _populateFilters();
  _renderSickReport();
}
