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
import { kadrovskaState, kadrAbsencesState } from '../../state/kadrovska.js';
import {
  ensureEmployeesLoaded,
  ensureAbsencesLoaded,
} from '../../services/kadrovska.js';
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
  return `
    <section class="kadr-panel-inner kadr-reports-panel" aria-label="Izveštaji">
      <div class="kadr-toolbar reports-toolbar">
        <div class="kadr-toolbar-row" role="tablist" aria-label="Izveštaj — vrsta">
          <button type="button" class="report-tab active" data-report-tab="sick" role="tab" aria-selected="true">🩺 Bolovanja</button>
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
