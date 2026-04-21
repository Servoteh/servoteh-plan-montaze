/**
 * Kadrovska / Mesečni grid — Excel-like batch unos sati.
 *
 * Funkcionalnost (paritetno sa legacy/index.html renderGrid):
 *   - Mesečni grid: 1 kolona po danu, 4 reda po radniku (Redovni / Prekov. /
 *     Teren / 2 maš.) + 4 footer reda (UKUPNO).
 *   - Vikend i današnji dan vizuelno markirani; ćelije sa neisaved izmenama
 *     dobijaju "cell-dirty" klasu.
 *   - Svi unosi prihvataju brojeve 0..24 (sa zarezom ili tačkom). Reg ćelija
 *     dodatno prima šifre odsustva: go / bo / sp / np / sl / pr (case-insens.)
 *   - Teren ima D/I dugme za prebacivanje između domaćeg i inostranstva.
 *     Default je "domestic" pri prvom unosu.
 *   - 2 maš. ćelija ima narandžasti tint kad je > 0.
 *   - Live re-summing na blur, batch upsert u Supabase preko
 *     `work_hours?on_conflict=employee_id,work_date`.
 *   - Export u .xlsx (lazy CDN load).
 *
 * Bez framework-a / inline handler-a — sve preko `addEventListener`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { canEditKadrovskaGrid, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../services/supabase.js';
import { kadrovskaState } from '../../state/kadrovska.js';
import { ensureEmployeesLoaded } from '../../services/kadrovska.js';
import { loadGridMonth, batchUpsertGrid } from '../../services/grid.js';
import { renderSummaryChips } from './shared.js';
import { loadXlsx } from '../../lib/xlsx.js';

/* ─── KONSTANTE ───────────────────────────────────────────────────────── */

const GRID_ABS_CODES = ['go', 'bo', 'sp', 'np', 'sl', 'pr'];
/** Dani u nedelji — index 0 = Sunday. */
const GRID_DAY_LETTERS = ['N', 'P', 'U', 'S', 'Č', 'P', 'S'];
const GRID_FIELD_SUBTYPE_DEFAULT = 'domestic';

/** State je modulom-lokalan — reset se radi u `wireGridTab` pri prvom mountu. */
const gridState = {
  monthKey: '',
  loaded: false,
  rowsByEmpDate: new Map(), // Map<empId, Map<ymd, mappedRow>>
  dirty: new Map(),         // Map<'empId|ymd', { hours, overtime_hours, field_hours, field_subtype, two_machine_hours, absence_code }>
  saving: false,
};

let panelRoot = null;

/* ─── HELPERS ──────────────────────────────────────────────────────────── */

/** "YYYY-MM-DD" iz (y, m1, d) gde je m1 1-based. */
function ymdOf(y, m1, d) {
  return `${y}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function _gridDaysInMonth(yyyymm) {
  if (!yyyymm) return [];
  const [y, m] = yyyymm.split('-').map(n => parseInt(n, 10));
  if (!y || !m) return [];
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    const ymd = ymdOf(y, m, d);
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();
    out.push({
      day: d,
      ymd,
      dow,
      isWeekend: dow === 0 || dow === 6,
      letter: GRID_DAY_LETTERS[dow],
    });
  }
  return out;
}

function _gridIsoToday() {
  const t = new Date();
  return ymdOf(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

function _gridDirtyKey(empId, ymd) {
  return empId + '|' + ymd;
}

/** Effective vrednost ćelije: dirty override → DB row → defaults. */
function _gridEffective(empId, ymd) {
  const dk = _gridDirtyKey(empId, ymd);
  const db = gridState.rowsByEmpDate.get(empId)?.get(ymd);
  if (gridState.dirty.has(dk)) {
    const d = gridState.dirty.get(dk);
    return {
      hours: d.hours != null ? d.hours : (db?.hours || 0),
      overtime_hours: d.overtime_hours != null ? d.overtime_hours : (db?.overtimeHours || 0),
      field_hours: d.field_hours != null ? d.field_hours : (db?.fieldHours || 0),
      field_subtype: 'field_subtype' in d ? d.field_subtype : (db?.fieldSubtype || null),
      two_machine_hours: d.two_machine_hours != null ? d.two_machine_hours : (db?.twoMachineHours || 0),
      absence_code: 'absence_code' in d ? d.absence_code : (db?.absenceCode || null),
    };
  }
  return {
    hours: db?.hours || 0,
    overtime_hours: db?.overtimeHours || 0,
    field_hours: db?.fieldHours || 0,
    field_subtype: db?.fieldSubtype || null,
    two_machine_hours: db?.twoMachineHours || 0,
    absence_code: db?.absenceCode || null,
  };
}

/**
 * Parsiraj sirov tekst ćelije.
 * @returns {{kind:'num',value:number} | {kind:'abs',code:string} | {kind:'empty'} | {kind:'err'}}
 */
function _gridParseCellText(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return { kind: 'empty' };
  if (GRID_ABS_CODES.includes(v)) return { kind: 'abs', code: v };
  const num = parseFloat(v.replace(',', '.'));
  if (
    isFinite(num) &&
    num >= 0 &&
    num <= 24 &&
    /^[0-9]+([.,][0-9]+)?$/.test(v)
  ) {
    return { kind: 'num', value: Math.round(num * 100) / 100 };
  }
  return { kind: 'err' };
}

function _gridFormatNum(n) {
  if (n == null || n === 0) return '';
  const r = Math.round(Number(n) * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return String(r).replace(/0+$/, '').replace(/\.$/, '');
}

function _gridFormatSum(n) {
  if (!n || n === 0) return '0';
  const r = Math.round(Number(n) * 100) / 100;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/** Updejtuj dirty cache za jednu (empId, ymd, kind) izmenu. kind = 'reg'|'ot'|'field'|'twomach'. */
function _gridApplyEdit(empId, ymd, kind, parsed) {
  const dk = _gridDirtyKey(empId, ymd);
  const eff = _gridEffective(empId, ymd);
  const next = {
    hours: eff.hours,
    overtime_hours: eff.overtime_hours,
    field_hours: eff.field_hours,
    field_subtype: eff.field_subtype,
    two_machine_hours: eff.two_machine_hours,
    absence_code: eff.absence_code,
  };
  if (kind === 'reg') {
    if (parsed.kind === 'abs') {
      next.absence_code = parsed.code;
      next.hours = 0;
    } else if (parsed.kind === 'num') {
      next.absence_code = null;
      next.hours = parsed.value;
    } else if (parsed.kind === 'empty') {
      next.absence_code = null;
      next.hours = 0;
    }
  } else if (kind === 'ot') {
    next.overtime_hours = parsed.kind === 'num' ? parsed.value : 0;
  } else if (kind === 'field') {
    if (parsed.kind === 'field') {
      next.field_hours = parsed.value;
      next.field_subtype = parsed.value > 0 ? parsed.sub : null;
    } else if (parsed.kind === 'num') {
      next.field_hours = parsed.value;
      if (parsed.value > 0) {
        if (!next.field_subtype) next.field_subtype = GRID_FIELD_SUBTYPE_DEFAULT;
      } else {
        next.field_subtype = null;
      }
    } else if (parsed.kind === 'empty') {
      next.field_hours = 0;
      next.field_subtype = null;
    }
  } else if (kind === 'twomach') {
    next.two_machine_hours = parsed.kind === 'num' ? parsed.value : 0;
  }
  gridState.dirty.set(dk, next);
}

function _gridDirtyCount() {
  return gridState.dirty.size;
}

function _gridUpdateDirtyBadge() {
  const el = panelRoot?.querySelector('#gridDirtyCount');
  const btn = panelRoot?.querySelector('#gridSaveAll');
  const n = _gridDirtyCount();
  if (el) el.textContent = n + ' izmena';
  if (btn) {
    btn.disabled = !canEditKadrovskaGrid() || n === 0 || gridState.saving;
    btn.style.opacity = btn.disabled ? '0.55' : '1';
  }
}

function _gridFilteredEmployees() {
  const company = panelRoot?.querySelector('#gridCompanyFilter')?.value || '';
  return kadrovskaState.employees
    .filter(e => e.isActive)
    .filter(e => !company || e.department === company)
    .sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'sr'));
}

function _gridGroupedByDepartment(emps) {
  const order = ['Servoteh', 'HAP Fluid'];
  const groups = new Map();
  emps.forEach(e => {
    const dep = e.department || '(Ostalo)';
    if (!groups.has(dep)) groups.set(dep, []);
    groups.get(dep).push(e);
  });
  return Array.from(groups.entries()).sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    }
    return a[0].localeCompare(b[0], 'sr');
  });
}

/* ─── COMPANY FILTER OPTIONS (samo aktivni → unique department) ──────── */

function _gridCompanyOptions(selected) {
  const set = new Set();
  kadrovskaState.employees.forEach(e => {
    if (e.isActive && e.department) set.add(e.department);
  });
  const list = Array.from(set).sort((a, b) => a.localeCompare(b, 'sr'));
  let html = `<option value=""${!selected ? ' selected' : ''}>Sve firme</option>`;
  for (const d of list) {
    const sel = d === selected ? ' selected' : '';
    html += `<option value="${escHtml(d)}"${sel}>${escHtml(d)}</option>`;
  }
  return html;
}

function _gridDefaultMonthKey() {
  const t = new Date();
  return String(t.getFullYear()) + '-' + String(t.getMonth() + 1).padStart(2, '0');
}

/* ─── RENDER (HTML SHELL) ─────────────────────────────────────────────── */

export function renderGridTab() {
  const monthKey = gridState.monthKey || _gridDefaultMonthKey();
  return `
    <section class="kadr-panel-inner kadr-grid-panel" aria-label="Mesečni grid">
      <div class="kadr-toolbar grid-toolbar">
        <div class="kadr-toolbar-row">
          <label class="kadr-field">
            <span>Mesec</span>
            <input type="month" id="gridMonth" value="${escHtml(monthKey)}">
          </label>
          <label class="kadr-field">
            <span>Firma</span>
            <select id="gridCompanyFilter">${_gridCompanyOptions('')}</select>
          </label>
          <button type="button" class="btn btn-ghost" id="gridReload" title="Osveži iz baze">↻ Osveži</button>
          <span class="grid-dirty-badge" id="gridDirtyCount">0 izmena</span>
          <button type="button" class="btn btn-primary" id="gridSaveAll" disabled>💾 Sačuvaj sve izmene</button>
          <button type="button" class="btn btn-ghost" id="gridExport" title="Izvoz u Excel">📊 Excel</button>
        </div>
        <div class="grid-legend" aria-label="Legenda">
          <span class="grid-legend-pill abs-go">go = god. odmor</span>
          <span class="grid-legend-pill abs-bo">bo = bolovanje</span>
          <span class="grid-legend-pill abs-sp">sp = slobodan prazn.</span>
          <span class="grid-legend-pill abs-np">np = neopravdano</span>
          <span class="grid-legend-pill abs-sl">sl = slobodan</span>
          <span class="grid-legend-pill abs-pr">pr = prazan dan</span>
        </div>
      </div>
      <div class="kadr-summary-strip" id="gridSummary"></div>
      <div id="gridWrap" class="grid-wrap"></div>
      <div id="gridEmpty" class="kadr-empty" style="display:none">Nema aktivnih radnika za izbrane filtere.</div>
    </section>
  `;
}

/* ─── RENDER (TABELA) ─────────────────────────────────────────────────── */

function _renderGridBody() {
  const wrap = panelRoot?.querySelector('#gridWrap');
  const empty = panelRoot?.querySelector('#gridEmpty');
  if (!wrap) return;

  const monthEl = panelRoot?.querySelector('#gridMonth');
  if (monthEl && !monthEl.value) monthEl.value = _gridDefaultMonthKey();
  const yyyymm = monthEl?.value || _gridDefaultMonthKey();
  gridState.monthKey = yyyymm;
  const days = _gridDaysInMonth(yyyymm);

  const emps = _gridFilteredEmployees();
  /* Update tab badge (broj aktivnih) */
  const badge = document.getElementById('kadrTabCountGrid');
  if (badge) badge.textContent = String(emps.length);

  if (emps.length === 0) {
    wrap.innerHTML = '';
    if (empty) empty.style.display = 'block';
    _renderSummary(emps, days);
    _gridUpdateDirtyBadge();
    return;
  }
  if (empty) empty.style.display = 'none';

  const groups = _gridGroupedByDepartment(emps);
  const today = _gridIsoToday();
  const totalCols = 4 + days.length + 1;
  const editable = canEditKadrovskaGrid();

  let html = '<table class="grid-table"><thead>';
  html += '<tr>';
  html += '<th class="col-num" rowspan="2">#</th>';
  html += '<th class="col-name" rowspan="2">Ime i prezime</th>';
  html += '<th class="col-kind" rowspan="2">Tip</th>';
  days.forEach(d => {
    const cls = ['col-day'];
    if (d.isWeekend) cls.push('cell-weekend');
    if (d.ymd === today) cls.push('cell-today');
    html += `<th class="${cls.join(' ')}">${d.day}</th>`;
  });
  html += '<th class="col-sum" rowspan="2">Σ</th>';
  html += '</tr><tr class="row-day-letter">';
  days.forEach(d => {
    const cls = ['col-day'];
    if (d.isWeekend) cls.push('cell-weekend');
    html += `<th class="${cls.join(' ')}">${d.letter}</th>`;
  });
  html += '</tr></thead><tbody>';

  let serialNo = 0;
  const colTotals = days.map(() => ({ reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, tm: 0 }));
  const grandTot = { reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tm: 0, tmDays: 0 };

  groups.forEach(([dep, list]) => {
    html += `<tr class="row-section"><td colspan="${totalCols}">${escHtml(dep)} (${list.length})</td></tr>`;
    list.forEach(emp => {
      serialNo++;
      const empId = escHtml(emp.id || '');
      let sReg = 0, sOt = 0, sField = 0, sFdom = 0, sFfor = 0, sTm = 0;
      const cellsReg = [], cellsOt = [], cellsField = [], cellsTm = [];
      days.forEach((d, di) => {
        const eff = _gridEffective(emp.id, d.ymd);
        const fH = Number(eff.field_hours || 0);
        const tmH = Number(eff.two_machine_hours || 0);
        sReg += Number(eff.hours || 0);
        sOt += Number(eff.overtime_hours || 0);
        sField += fH;
        sTm += tmH;
        if (fH > 0) {
          if (eff.field_subtype === 'foreign') { sFfor += fH; grandTot.fforDays++; }
          else { sFdom += fH; grandTot.fdomDays++; }
        }
        if (tmH > 0) grandTot.tmDays++;
        colTotals[di].reg += Number(eff.hours || 0);
        colTotals[di].ot += Number(eff.overtime_hours || 0);
        colTotals[di].field += fH;
        if (fH > 0) {
          if (eff.field_subtype === 'foreign') colTotals[di].ffor += fH;
          else colTotals[di].fdom += fH;
        }
        colTotals[di].tm += tmH;

        const dk = _gridDirtyKey(emp.id, d.ymd);
        const isDirty = gridState.dirty.has(dk);
        const dayBase = ['col-day'];
        if (d.isWeekend) dayBase.push('cell-weekend');
        if (d.ymd === today) dayBase.push('cell-today');
        if (isDirty) dayBase.push('cell-dirty');

        let regVal, regCls = ['grid-cell'];
        if (eff.absence_code) {
          regVal = eff.absence_code;
          regCls.push('is-absence', 'abs-' + eff.absence_code);
        } else {
          regVal = _gridFormatNum(eff.hours);
        }
        cellsReg.push(`<td class="${dayBase.join(' ')}" data-emp="${empId}" data-ymd="${d.ymd}" data-kind="reg"><input class="${regCls.join(' ')}" type="text" value="${escHtml(regVal)}" maxlength="6" ${editable ? '' : 'disabled'}></td>`);

        cellsOt.push(`<td class="${dayBase.join(' ')}" data-emp="${empId}" data-ymd="${d.ymd}" data-kind="ot"><input class="grid-cell" type="text" value="${escHtml(_gridFormatNum(eff.overtime_hours))}" maxlength="6" ${editable ? '' : 'disabled'}></td>`);

        const fieldInputCls = ['grid-cell', 'grid-cell-field'];
        const isForeign = fH > 0 && eff.field_subtype === 'foreign';
        if (fH > 0) fieldInputCls.push(isForeign ? 'is-field-foreign' : 'is-field-domestic');
        const subBtnCls = ['fsub-btn'];
        subBtnCls.push(isForeign ? 'is-foreign' : 'is-domestic');
        if (fH <= 0) subBtnCls.push('is-hidden');
        const subLabel = isForeign ? 'I' : 'D';
        const subTitle = isForeign
          ? 'Inostrani teren — klikni za prebacivanje na domaći'
          : 'Domaći teren — klikni za prebacivanje na inostrani';
        cellsField.push(`<td class="${dayBase.join(' ')}" data-emp="${empId}" data-ymd="${d.ymd}" data-kind="field" title="Unesi sate (0–24). D/I dugme menja podtip terena."><div class="grid-field-wrap"><input class="${fieldInputCls.join(' ')}" type="text" value="${escHtml(_gridFormatNum(eff.field_hours))}" maxlength="6" ${editable ? '' : 'disabled'}><button type="button" class="${subBtnCls.join(' ')}" data-act="toggle-fsub" title="${subTitle}" ${editable ? '' : 'disabled tabindex="-1"'}>${subLabel}</button></div></td>`);

        const tmCls = ['grid-cell'];
        if (tmH > 0) tmCls.push('is-twomach');
        cellsTm.push(`<td class="${dayBase.join(' ')}" data-emp="${empId}" data-ymd="${d.ymd}" data-kind="twomach" title="Sati rada na dve mašine (dodatno se plaća)"><input class="${tmCls.join(' ')}" type="text" value="${escHtml(_gridFormatNum(eff.two_machine_hours))}" maxlength="6" ${editable ? '' : 'disabled'}></td>`);
      });
      grandTot.reg += sReg; grandTot.ot += sOt; grandTot.field += sField;
      grandTot.fdom += sFdom; grandTot.ffor += sFfor; grandTot.tm += sTm;

      html += `<tr class="row-emp-1"><td class="col-num" rowspan="4">${serialNo}.</td><td class="col-name" rowspan="4">${escHtml(emp.fullName || '—')}</td><td class="col-kind">Redovni</td>${cellsReg.join('')}<td class="col-sum">${_gridFormatSum(sReg)}</td></tr>`;
      html += `<tr class="row-emp-2"><td class="col-kind">Prekov.</td>${cellsOt.join('')}<td class="col-sum">${_gridFormatSum(sOt)}</td></tr>`;
      html += `<tr class="row-emp-3"><td class="col-kind" title="Teren — domaći (D) / inostrani (I)">Teren</td>${cellsField.join('')}<td class="col-sum" title="Domaći ${_gridFormatSum(sFdom)}h / Inostrani ${_gridFormatSum(sFfor)}h">${_gridFormatSum(sField)}</td></tr>`;
      html += `<tr class="row-emp-4"><td class="col-kind" title="Rad na dve mašine — dodatno se plaća">2 maš.</td>${cellsTm.join('')}<td class="col-sum">${_gridFormatSum(sTm)}</td></tr>`;
    });
  });

  /* Footer totals */
  const ftReg = colTotals.map((c, i) => {
    const cls = ['col-day']; if (days[i].isWeekend) cls.push('cell-weekend');
    return `<td class="${cls.join(' ')}">${_gridFormatSum(c.reg)}</td>`;
  }).join('');
  const ftOt = colTotals.map((c, i) => {
    const cls = ['col-day']; if (days[i].isWeekend) cls.push('cell-weekend');
    return `<td class="${cls.join(' ')}">${_gridFormatSum(c.ot)}</td>`;
  }).join('');
  const ftField = colTotals.map((c, i) => {
    const cls = ['col-day']; if (days[i].isWeekend) cls.push('cell-weekend');
    return `<td class="${cls.join(' ')}" title="DOM ${_gridFormatSum(c.fdom)} / INO ${_gridFormatSum(c.ffor)}">${_gridFormatSum(c.field)}</td>`;
  }).join('');
  const ftTm = colTotals.map((c, i) => {
    const cls = ['col-day']; if (days[i].isWeekend) cls.push('cell-weekend');
    return `<td class="${cls.join(' ')}">${_gridFormatSum(c.tm)}</td>`;
  }).join('');
  html += `<tr class="row-totals"><td class="col-num"></td><td class="col-name">UKUPNO</td><td class="col-kind">Redovni</td>${ftReg}<td class="col-sum">${_gridFormatSum(grandTot.reg)}</td></tr>`;
  html += `<tr class="row-totals"><td class="col-num"></td><td class="col-name"></td><td class="col-kind">Prekov.</td>${ftOt}<td class="col-sum">${_gridFormatSum(grandTot.ot)}</td></tr>`;
  html += `<tr class="row-totals"><td class="col-num"></td><td class="col-name"></td><td class="col-kind">Teren</td>${ftField}<td class="col-sum" title="DOM ${_gridFormatSum(grandTot.fdom)}h (${grandTot.fdomDays}d) / INO ${_gridFormatSum(grandTot.ffor)}h (${grandTot.fforDays}d)">${_gridFormatSum(grandTot.field)}</td></tr>`;
  html += `<tr class="row-totals"><td class="col-num"></td><td class="col-name"></td><td class="col-kind">2 maš.</td>${ftTm}<td class="col-sum" title="${grandTot.tmDays} dana evidentirano">${_gridFormatSum(grandTot.tm)}</td></tr>`;

  html += '</tbody></table>';
  wrap.innerHTML = html;

  /* Wire up cell handlers */
  wrap.querySelectorAll('.grid-cell:not(:disabled)').forEach(inp => {
    inp.addEventListener('input', _gridOnCellInput);
    inp.addEventListener('blur', _gridOnCellBlur);
    inp.addEventListener('keydown', _gridOnCellKeydown);
    inp.addEventListener('focus', function () { this.select(); });
  });
  wrap.querySelectorAll('button.fsub-btn:not(:disabled)').forEach(btn => {
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      _gridOnFieldSubToggle(this);
    });
    btn.tabIndex = -1;
  });

  _gridUpdateDirtyBadge();
  _renderSummary(emps, days, grandTot);
}

function _renderSummary(emps, days, gt) {
  const company = panelRoot?.querySelector('#gridCompanyFilter')?.value || '';
  let g = gt;
  if (!g || g.fdom === undefined) {
    g = { reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tm: 0, tmDays: 0 };
    emps.forEach(e => {
      days.forEach(d => {
        const eff = _gridEffective(e.id, d.ymd);
        const fH = Number(eff.field_hours || 0);
        const tmH = Number(eff.two_machine_hours || 0);
        g.reg += Number(eff.hours || 0);
        g.ot += Number(eff.overtime_hours || 0);
        g.field += fH;
        if (fH > 0) {
          if (eff.field_subtype === 'foreign') { g.ffor += fH; g.fforDays++; }
          else { g.fdom += fH; g.fdomDays++; }
        }
        g.tm += tmH;
        if (tmH > 0) g.tmDays++;
      });
    });
  }
  renderSummaryChips('gridSummary', [
    { label: 'Aktivnih radnika', value: emps.length, tone: 'accent' },
    { label: 'Firma (filter)', value: company || 'Sve', tone: 'muted' },
    { label: 'Mesec', value: gridState.monthKey || '—', tone: 'muted' },
    { label: 'Σ Redovni', value: _gridFormatSum(g.reg), tone: 'accent' },
    { label: 'Σ Prekov.', value: _gridFormatSum(g.ot), tone: g.ot > 0 ? 'warn' : 'muted' },
    { label: 'Σ Teren', value: _gridFormatSum(g.field), tone: 'ok' },
    { label: 'Teren DOM', value: _gridFormatSum(g.fdom) + 'h · ' + (g.fdomDays || 0) + 'd', tone: g.fdom > 0 ? 'ok' : 'muted' },
    { label: 'Teren INO', value: _gridFormatSum(g.ffor) + 'h · ' + (g.fforDays || 0) + 'd', tone: g.ffor > 0 ? 'accent' : 'muted' },
    { label: 'Σ 2 mašine', value: _gridFormatSum(g.tm) + 'h · ' + (g.tmDays || 0) + 'd', tone: g.tm > 0 ? 'warn' : 'muted' },
    { label: 'Izmena za snimanje', value: _gridDirtyCount(), tone: _gridDirtyCount() > 0 ? 'warn' : 'muted' },
  ]);
}

/* ─── CELL HANDLERS ───────────────────────────────────────────────────── */

function _gridOnCellInput(e) {
  const td = e.target.closest('td');
  if (!td) return;
  const empId = td.dataset.emp, ymd = td.dataset.ymd, kind = td.dataset.kind;
  if (!empId || !ymd) return;
  const parsed = _gridParseCellText(e.target.value);
  td.classList.remove('cell-error');
  td.classList.add('cell-dirty');
  if (parsed.kind === 'err') {
    td.classList.add('cell-error');
    if (kind === 'reg') {
      e.target.title = 'Nevažeća vrednost: broj 0–24 ili oznaka ' + GRID_ABS_CODES.join('/');
    } else {
      e.target.title = 'Nevažeća vrednost: broj 0–24';
    }
    return;
  }
  e.target.title = '';
  if (kind === 'reg') {
    e.target.classList.remove('is-absence', 'abs-go', 'abs-bo', 'abs-sp', 'abs-np', 'abs-sl', 'abs-pr');
    if (parsed.kind === 'abs') {
      e.target.classList.add('is-absence', 'abs-' + parsed.code);
    }
  }
  if (kind === 'field') {
    const eff = _gridEffective(empId, ymd);
    e.target.classList.remove('is-field-domestic', 'is-field-foreign');
    const btn = td.querySelector('button.fsub-btn');
    if (parsed.kind === 'num' && parsed.value > 0) {
      const sub = eff.field_subtype === 'foreign' ? 'foreign' : 'domestic';
      e.target.classList.add(sub === 'foreign' ? 'is-field-foreign' : 'is-field-domestic');
      if (btn) {
        btn.classList.remove('is-hidden', 'is-domestic', 'is-foreign');
        btn.classList.add(sub === 'foreign' ? 'is-foreign' : 'is-domestic');
        btn.textContent = sub === 'foreign' ? 'I' : 'D';
      }
    } else {
      if (btn) btn.classList.add('is-hidden');
    }
  }
  if (kind === 'twomach') {
    e.target.classList.remove('is-twomach');
    if (parsed.kind === 'num' && parsed.value > 0) e.target.classList.add('is-twomach');
  }
  _gridApplyEdit(empId, ymd, kind, parsed);
  _gridUpdateDirtyBadge();
  _gridRefreshSums(empId);
}

function _gridOnCellBlur(e) {
  const td = e.target.closest('td');
  if (!td) return;
  const parsed = _gridParseCellText(e.target.value);
  if (parsed.kind === 'err') return;
  if (parsed.kind === 'num') e.target.value = _gridFormatNum(parsed.value);
  else if (parsed.kind === 'abs') e.target.value = parsed.code;
  else e.target.value = '';
}

function _gridOnFieldSubToggle(btn) {
  const td = btn.closest('td');
  if (!td || td.dataset.kind !== 'field') return;
  const empId = td.dataset.emp, ymd = td.dataset.ymd;
  if (!empId || !ymd) return;
  const eff = _gridEffective(empId, ymd);
  if (!(Number(eff.field_hours || 0) > 0)) return;
  const nextSub = eff.field_subtype === 'foreign' ? 'domestic' : 'foreign';
  _gridApplyEdit(empId, ymd, 'field', {
    kind: 'field',
    value: Number(eff.field_hours || 0),
    sub: nextSub,
  });
  const inp = td.querySelector('input.grid-cell');
  if (inp) {
    inp.classList.remove('is-field-domestic', 'is-field-foreign');
    inp.classList.add(nextSub === 'foreign' ? 'is-field-foreign' : 'is-field-domestic');
  }
  btn.classList.remove('is-domestic', 'is-foreign');
  btn.classList.add(nextSub === 'foreign' ? 'is-foreign' : 'is-domestic');
  btn.textContent = nextSub === 'foreign' ? 'I' : 'D';
  td.classList.add('cell-dirty');
  _gridUpdateDirtyBadge();
  _gridRefreshSums(empId);
}

function _gridOnCellKeydown(e) {
  const k = e.key;
  if (!['Tab', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) return;
  if (k === 'Tab') return;
  e.preventDefault();
  const td = e.target.closest('td');
  if (!td) return;
  const tr = td.parentElement;
  const cellIdx = Array.prototype.indexOf.call(tr.children, td);
  let target = null;
  if (k === 'ArrowLeft') target = tr.children[cellIdx - 1]?.querySelector?.('input.grid-cell');
  else if (k === 'ArrowRight' || k === 'Enter') target = tr.children[cellIdx + 1]?.querySelector?.('input.grid-cell');
  else if (k === 'ArrowUp' || k === 'ArrowDown') {
    const dir = k === 'ArrowUp' ? -1 : 1;
    let row = tr;
    for (let safety = 0; safety < 200; safety++) {
      row = dir > 0 ? row.nextElementSibling : row.previousElementSibling;
      if (!row) break;
      const cell = row.children[cellIdx];
      const inp = cell?.querySelector?.('input.grid-cell:not(:disabled)');
      if (inp) { target = inp; break; }
    }
  }
  if (target && target.focus) target.focus();
}

/** Live re-sum sums for a single employee bez full re-rendera. */
function _gridRefreshSums(empId) {
  const wrap = panelRoot?.querySelector('#gridWrap');
  if (!wrap) return;
  const days = _gridDaysInMonth(gridState.monthKey);
  let sReg = 0, sOt = 0, sField = 0, sFdom = 0, sFfor = 0, sTm = 0;
  days.forEach(d => {
    const eff = _gridEffective(empId, d.ymd);
    sReg += Number(eff.hours || 0);
    sOt += Number(eff.overtime_hours || 0);
    const fH = Number(eff.field_hours || 0);
    sField += fH;
    if (fH > 0) {
      if (eff.field_subtype === 'foreign') sFfor += fH;
      else sFdom += fH;
    }
    sTm += Number(eff.two_machine_hours || 0);
  });
  const probe = wrap.querySelector(`td[data-emp="${empId}"][data-ymd="${days[0]?.ymd}"][data-kind="reg"]`);
  const trReg = probe?.parentElement;
  if (!trReg) return;
  const trOt = trReg.nextElementSibling;
  const trField = trOt?.nextElementSibling;
  const trTm = trField?.nextElementSibling;
  const sumReg = trReg.querySelector('.col-sum');
  const sumOt = trOt?.querySelector('.col-sum');
  const sumField = trField?.querySelector('.col-sum');
  const sumTm = trTm?.querySelector('.col-sum');
  if (sumReg) sumReg.textContent = _gridFormatSum(sReg);
  if (sumOt) sumOt.textContent = _gridFormatSum(sOt);
  if (sumField) {
    sumField.textContent = _gridFormatSum(sField);
    sumField.title = `Domaći ${_gridFormatSum(sFdom)}h / Inostrani ${_gridFormatSum(sFfor)}h`;
  }
  if (sumTm) sumTm.textContent = _gridFormatSum(sTm);
}

/* ─── BATCH SAVE / LOAD ───────────────────────────────────────────────── */

async function _saveAllGrid() {
  if (!canEditKadrovskaGrid()) { showToast('⚠ Nemaš ovlašćenje za snimanje sati'); return; }
  if (gridState.saving) return;
  if (_gridDirtyCount() === 0) return;
  if (!getIsOnline() || !hasSupabaseConfig()) {
    showToast('⚠ Offline — batch save zahteva Supabase');
    return;
  }
  const wrap = panelRoot?.querySelector('#gridWrap');
  if (wrap?.querySelector('td.cell-error')) {
    showToast('⚠ Postoje nevažeće ćelije (crveno) — popravi pre snimanja');
    return;
  }
  gridState.saving = true;
  const btn = panelRoot?.querySelector('#gridSaveAll');
  if (btn) { btn.disabled = true; btn.textContent = '💾 Snimanje…'; }

  try {
    const saved = await batchUpsertGrid(gridState.dirty);
    if (saved == null) {
      showToast('⚠ Supabase batch upsert nije uspeo — proveri migraciju add_attendance_grid.sql');
      return;
    }
    saved.forEach(m => {
      if (!m.employeeId || !m.workDate) return;
      if (!gridState.rowsByEmpDate.has(m.employeeId)) {
        gridState.rowsByEmpDate.set(m.employeeId, new Map());
      }
      gridState.rowsByEmpDate.get(m.employeeId).set(m.workDate, m);
    });
    const n = gridState.dirty.size;
    gridState.dirty.clear();
    showToast('✅ Sačuvano ' + n + ' izmena');
    _renderGridBody();
  } catch (err) {
    console.error('[grid] batch save error', err);
    showToast('⚠ Greška pri snimanju — vidi konzolu');
  } finally {
    gridState.saving = false;
    if (btn) { btn.textContent = '💾 Sačuvaj sve izmene'; }
    _gridUpdateDirtyBadge();
  }
}

async function _onMonthChange() {
  const monthEl = panelRoot?.querySelector('#gridMonth');
  if (_gridDirtyCount() > 0) {
    if (!confirm('Imaš nesačuvanih izmena. Promena meseca će ih odbaciti. Nastaviti?')) {
      if (monthEl) monthEl.value = gridState.monthKey;
      return;
    }
    gridState.dirty.clear();
  }
  const yyyymm = monthEl?.value || '';
  if (!yyyymm) return;
  await _loadAndRender(yyyymm);
}

async function _loadAndRender(yyyymm) {
  const wrap = panelRoot?.querySelector('#gridWrap');
  if (wrap) {
    wrap.innerHTML = `<div style="padding:30px;color:var(--text3);font-size:12px;text-align:center">Učitavanje ${escHtml(yyyymm)}…</div>`;
  }
  if (getIsOnline() && hasSupabaseConfig()) {
    try {
      const days = _gridDaysInMonth(yyyymm);
      gridState.rowsByEmpDate = await loadGridMonth(days);
    } catch (err) {
      console.error('[grid] load month failed', err);
      gridState.rowsByEmpDate = new Map();
    }
  } else {
    gridState.rowsByEmpDate = new Map();
  }
  gridState.monthKey = yyyymm;
  gridState.loaded = true;
  _renderGridBody();
}

/* ─── EXCEL EXPORT ────────────────────────────────────────────────────── */

async function _exportToXlsx() {
  let XLSX;
  try {
    XLSX = await loadXlsx();
  } catch (err) {
    console.error('[grid] xlsx load failed', err);
    showToast('⚠ XLSX biblioteka nije dostupna');
    return;
  }
  const yyyymm = gridState.monthKey || panelRoot?.querySelector('#gridMonth')?.value;
  if (!yyyymm) { showToast('⚠ Nema izabranog meseca'); return; }
  const days = _gridDaysInMonth(yyyymm);
  const emps = _gridFilteredEmployees();
  if (emps.length === 0) { showToast('⚠ Nema radnika za izvoz'); return; }
  const groups = _gridGroupedByDepartment(emps);
  const monthLabel = (() => {
    const [y, m] = yyyymm.split('-');
    const names = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun', 'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar'];
    return (names[parseInt(m, 10) - 1] || m).toUpperCase() + ' ' + y;
  })();

  const aoa = [];
  aoa.push([monthLabel].concat(new Array(days.length + 3).fill('')));
  aoa.push([]);
  aoa.push(['#', 'Ime i prezime', 'Tip'].concat(days.map(d => d.day)).concat(['Σ']));
  aoa.push(['', '', ''].concat(days.map(d => d.letter)).concat(['']));

  let serialNo = 0;
  const grand = { reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tm: 0, tmDays: 0 };
  const colTotals = days.map(() => ({ reg: 0, ot: 0, field: 0, tm: 0 }));

  groups.forEach(([dep, list]) => {
    aoa.push([`${dep} (${list.length})`].concat(new Array(days.length + 3).fill('')));
    list.forEach(emp => {
      serialNo++;
      let sR = 0, sO = 0, sF = 0, sFd = 0, sFf = 0, sTm = 0;
      const rowR = [serialNo + '.', emp.fullName || '—', 'Redovni'];
      const rowO = ['', '', 'Prekov.'];
      const rowF = ['', '', 'Teren'];
      const rowTm = ['', '', '2 maš.'];
      days.forEach((d, i) => {
        const eff = _gridEffective(emp.id, d.ymd);
        const fH = Number(eff.field_hours || 0);
        const tmH = Number(eff.two_machine_hours || 0);
        if (eff.absence_code) rowR.push(eff.absence_code.toUpperCase());
        else rowR.push(eff.hours || '');
        rowO.push(eff.overtime_hours || '');
        if (fH > 0) {
          rowF.push(eff.field_subtype === 'foreign' ? (_gridFormatNum(fH) + ' I') : _gridFormatNum(fH));
          if (eff.field_subtype === 'foreign') { sFf += fH; grand.fforDays++; }
          else { sFd += fH; grand.fdomDays++; }
        } else {
          rowF.push('');
        }
        rowTm.push(tmH || '');
        if (tmH > 0) grand.tmDays++;
        sR += Number(eff.hours || 0);
        sO += Number(eff.overtime_hours || 0);
        sF += fH;
        sTm += tmH;
        colTotals[i].reg += Number(eff.hours || 0);
        colTotals[i].ot += Number(eff.overtime_hours || 0);
        colTotals[i].field += fH;
        colTotals[i].tm += tmH;
      });
      grand.reg += sR; grand.ot += sO; grand.field += sF;
      grand.fdom += sFd; grand.ffor += sFf; grand.tm += sTm;
      rowR.push(sR || 0); rowO.push(sO || 0); rowF.push(sF || 0); rowTm.push(sTm || 0);
      aoa.push(rowR); aoa.push(rowO); aoa.push(rowF); aoa.push(rowTm);
    });
  });
  aoa.push([]);
  aoa.push(['', 'UKUPNO', 'Redovni'].concat(colTotals.map(c => c.reg || 0)).concat([grand.reg || 0]));
  aoa.push(['', '', 'Prekov.'].concat(colTotals.map(c => c.ot || 0)).concat([grand.ot || 0]));
  aoa.push(['', '', 'Teren'].concat(colTotals.map(c => c.field || 0)).concat([grand.field || 0]));
  aoa.push(['', '', '2 maš.'].concat(colTotals.map(c => c.tm || 0)).concat([grand.tm || 0]));
  aoa.push([]);
  aoa.push(['', 'TEREN BREAKDOWN', 'Domaći (h)', grand.fdom || 0, '', '', 'Domaći (dani)', grand.fdomDays || 0]);
  aoa.push(['', '', 'Inostrani (h)', grand.ffor || 0, '', '', 'Inostrani (dani)', grand.fforDays || 0]);
  aoa.push(['', 'RAD NA 2 MAŠINE', 'Sati', grand.tm || 0, '', '', 'Dani', grand.tmDays || 0]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 5 }, { wch: 26 }, { wch: 9 }].concat(days.map(() => ({ wch: 4 }))).concat([{ wch: 7 }]);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: days.length + 3 } }];

  const wb = XLSX.utils.book_new();
  const sheetName = monthLabel.length > 31 ? monthLabel.slice(0, 31) : monthLabel;
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const fname = 'Sati_' + yyyymm + '.xlsx';
  XLSX.writeFile(wb, fname);
  showToast('📊 Izvezeno: ' + fname);
}

/* ─── PUBLIC: WIRE ────────────────────────────────────────────────────── */

export async function wireGridTab(panel) {
  panelRoot = panel;

  /* Toolbar handlers */
  panel.querySelector('#gridMonth')?.addEventListener('change', _onMonthChange);
  panel.querySelector('#gridCompanyFilter')?.addEventListener('change', () => {
    _renderGridBody();
  });
  panel.querySelector('#gridReload')?.addEventListener('click', async () => {
    if (_gridDirtyCount() > 0) {
      if (!confirm('Imaš nesačuvanih izmena. Reload će ih odbaciti. Nastaviti?')) return;
      gridState.dirty.clear();
    }
    const yyyymm = panel.querySelector('#gridMonth')?.value || _gridDefaultMonthKey();
    await _loadAndRender(yyyymm);
  });
  panel.querySelector('#gridSaveAll')?.addEventListener('click', _saveAllGrid);
  panel.querySelector('#gridExport')?.addEventListener('click', _exportToXlsx);

  /* Učitaj zaposlene (potrebno za firma filter i grupisanje) */
  try {
    await ensureEmployeesLoaded();
  } catch (err) {
    console.warn('[grid] employees load failed', err);
  }

  /* Refresh firma options nakon load-a (možda su novi departments stigli) */
  const compSel = panel.querySelector('#gridCompanyFilter');
  if (compSel) {
    const cur = compSel.value;
    compSel.innerHTML = _gridCompanyOptions(cur);
  }

  /* Učitaj mesec — ako je već loadovan, samo rerender */
  const monthEl = panel.querySelector('#gridMonth');
  const wantMonth = monthEl?.value || _gridDefaultMonthKey();
  if (gridState.loaded && gridState.monthKey === wantMonth) {
    _renderGridBody();
  } else {
    await _loadAndRender(wantMonth);
  }
}
