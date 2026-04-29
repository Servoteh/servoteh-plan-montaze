/**
 * Kadrovska / Mesečni grid — Excel-like batch unos sati.
 *
 * Funkcionalnost (paritetno sa legacy/index.html renderGrid):
 *   - Mesečni grid: 1 kolona po danu, 4 reda po radniku (Redovni / Prekov. /
 *     Teren / 2 maš.) + 4 footer reda (UKUPNO). Jedna lista radnika — rastuće
 *     po prezimenu (A–Z); ispod imena dva sitna reda: „odeljenje — pododeljenje“, pozicija.
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
 *   - Šifre odsustva (go/bo/sp/…) idu u work_hours; izveštaji i saldo GO čitaju
 *     isključivo odatle (nema duplog unosa u tabu Odsustva).
 *
 * Bez framework-a / inline handler-a — sve preko `addEventListener`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  compareEmployeesByLastFirst,
  employeeDisplayName,
} from '../../lib/employeeNames.js';
import { canEditKadrovskaGrid, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../services/supabase.js';
import { kadrovskaState, orgStructureState } from '../../state/kadrovska.js';
import { ensureEmployeesLoaded, ensureOrgStructureLoaded } from '../../services/kadrovska.js';
import { loadGridMonth, batchUpsertGrid } from '../../services/grid.js';
import { renderSummaryChips } from './shared.js';
import { loadXlsx } from '../../lib/xlsx.js';
import { SESSION_KEYS } from '../../lib/constants.js';
import { ssGet, ssSet } from '../../lib/storage.js';
import { loadHolidaysForRange, holidayDateSet } from '../../services/holidays.js';
import { parseDateLocal } from '../../lib/date.js';
import { gridRedovniUnitsOneDay } from '../../services/payrollCalc.js';

/* ─── KONSTANTE ───────────────────────────────────────────────────────── */

const GRID_ABS_CODES = ['go', 'bo', 'sp', 'np', 'sl', 'pr'];
/* Faza K3.3 — bolovanje subtype kodovi za grid:
   'bo'  → obicno (65%)
   'bop' → povreda na radu (100%)
   'bot' → održavanje trudnoće (100%) */
const GRID_BO_SUBTYPE_MAP = {
  bo:  'obicno',
  bop: 'povreda_na_radu',
  bot: 'odrzavanje_trudnoce',
};
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
  /** Sinhronizovano sa #gridSearch + sessionStorage (SESSION_KEYS.KADR_GRID_SEARCH) */
  searchQuery: '',
  /** YMD državnih neradnih dana (keš posle loadHolidaysForRange) */
  holidayYmdSet: new Set(),
};

let panelRoot = null;
/** Sticky toolbar (mesec/odeljenje/pretraga/dugmad) u #kadrGridToolbarSlot. */
let gridToolbarHost = null;

function _gridQ(sel) {
  if (!sel || typeof sel !== 'string') return null;
  if (gridToolbarHost) {
    const x = gridToolbarHost.querySelector(sel);
    if (x) return x;
  }
  return panelRoot?.querySelector(sel) || null;
}

/** @type {ReturnType<typeof setTimeout> | null} */
let _gridSearchDebounce = null;

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
    const dt = parseDateLocal(ymd);
    const dow = dt ? dt.getDay() : new Date(y, m - 1, d).getDay();
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

function _gridDayClasses(day, holidayYmdSet, extra = []) {
  const cls = ['col-day'];
  if (day?.isWeekend) cls.push('cell-weekend');
  if (day?.dow === 6) cls.push('cell-weekend-sat');
  if (day?.dow === 0) cls.push('cell-weekend-sun');
  if (holidayYmdSet?.has?.(day?.ymd)) cls.push('cell-holiday');
  if (extra?.length) cls.push(...extra.filter(Boolean));
  return cls;
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
      absence_subtype: 'absence_subtype' in d ? d.absence_subtype : (db?.absenceSubtype || null),
    };
  }
  return {
    hours: db?.hours || 0,
    overtime_hours: db?.overtimeHours || 0,
    field_hours: db?.fieldHours || 0,
    field_subtype: db?.fieldSubtype || null,
    two_machine_hours: db?.twoMachineHours || 0,
    absence_code: db?.absenceCode || null,
    absence_subtype: db?.absenceSubtype || null,
  };
}

/**
 * Parsiraj sirov tekst ćelije.
 * @returns {{kind:'num',value:number} | {kind:'abs',code:string} | {kind:'empty'} | {kind:'err'}}
 */
function _gridParseCellText(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return { kind: 'empty' };
  /* Faza K3.3 — bolovanje subtype kodovi: bo / bop / bot. */
  if (Object.prototype.hasOwnProperty.call(GRID_BO_SUBTYPE_MAP, v)) {
    return { kind: 'abs', code: 'bo', subtype: GRID_BO_SUBTYPE_MAP[v] };
  }
  if (GRID_ABS_CODES.includes(v)) return { kind: 'abs', code: v, subtype: null };
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
    absence_subtype: eff.absence_subtype,
  };
  if (kind === 'reg') {
    if (parsed.kind === 'abs') {
      next.absence_code = parsed.code;
      /* subtype validan samo uz 'bo'. */
      next.absence_subtype = parsed.code === 'bo' ? (parsed.subtype || 'obicno') : null;
      next.hours = 0;
    } else if (parsed.kind === 'num') {
      next.absence_code = null;
      next.absence_subtype = null;
      next.hours = parsed.value;
    } else if (parsed.kind === 'empty') {
      next.absence_code = null;
      next.absence_subtype = null;
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
  const el = _gridQ('#gridDirtyCount');
  const btn = _gridQ('#gridSaveAll');
  const n = _gridDirtyCount();
  if (el) {
    el.textContent = String(n);
    el.title = n === 1 ? '1 izmena za snimanje' : n + ' izmena za snimanje';
  }
  if (btn) {
    btn.disabled = !canEditKadrovskaGrid() || n === 0 || gridState.saving;
    btn.style.opacity = btn.disabled ? '0.55' : '1';
  }
}

/** Rastuće po prezimenu A–Z (sr), zatim po punom imenu za stabilan redosled. */
/** Drugi red ime-ćelije: „Odeljenje — pododeljenje“ (ili jedno ako drugo nedostaje). */
function _gridEmpDeptSubLine(emp) {
  const dept = String(emp?.department || '').trim();
  const sub = String(emp?.subDepartmentName || '').trim();
  if (dept && sub) return `${dept} — ${sub}`;
  return dept || sub || '—';
}

function _gridEmpPositionLine(emp) {
  const pos = String(emp?.position || emp?.positionName || '').trim();
  return pos || '—';
}

function _gridCompareBySurnameAsc(a, b) {
  return compareEmployeesByLastFirst(a, b);
}

/** Aktivni + firma (filter) + sort; bez pretrage — za čip, badge, XLSX. */
function _gridEmployeesCompanyOnly() {
  const company = _gridQ('#gridCompanyFilter')?.value || '';
  return kadrovskaState.employees
    .filter(e => e.isActive)
    .filter(e => {
      if (!company) return true;
      const deptId = parseInt(company, 10);
      if (orgStructureState.departments.length && !isNaN(deptId)) {
        return e.departmentId === deptId;
      }
      return e.department === company;
    })
    .sort(_gridCompareBySurnameAsc);
}

function _gridCurrentSearchQuery() {
  const fromInput = _gridQ('#gridSearch')?.value;
  if (fromInput != null) return String(fromInput).trim();
  return String(gridState.searchQuery || '').trim();
}

/** Company filter AND pretraga po imenu (case-insensitive), klijent-side. */
function _gridFilteredEmployees() {
  const base = _gridEmployeesCompanyOnly();
  const q = _gridCurrentSearchQuery().toLowerCase();
  if (!q) return base;
  return base.filter(e => {
    const name = employeeDisplayName(e).toLowerCase();
    return name.includes(q);
  });
}

function _syncGridSearchMeta(companyCount, visibleCount) {
  const el = _gridQ('#gridSearchMeta');
  const clearBtn = _gridQ('#gridSearchClear');
  if (clearBtn) {
    const q = _gridCurrentSearchQuery();
    clearBtn.style.visibility = q ? 'visible' : 'hidden';
  }
  if (!el) return;
  const q = _gridCurrentSearchQuery();
  if (!q) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  el.style.display = 'inline';
  el.textContent = `Prikazano ${visibleCount} od ${companyCount}`;
}

/* ─── COMPANY FILTER OPTIONS (referentne tabele; fallback na tekst) ─── */

function _gridCompanyOptions(selected) {
  let html = `<option value=""${!selected ? ' selected' : ''}>Sva odeljenja</option>`;
  if (orgStructureState.departments.length) {
    const list = [...orgStructureState.departments].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'sr'));
    for (const d of list) {
      const val = String(d.id);
      const sel = val === selected ? ' selected' : '';
      html += `<option value="${val}"${sel}>${escHtml(d.name)}</option>`;
    }
  } else {
    const set = new Set();
    kadrovskaState.employees.forEach(e => {
      if (e.isActive && e.department) set.add(e.department);
    });
    const list = Array.from(set).sort((a, b) => a.localeCompare(b, 'sr'));
    for (const d of list) {
      const sel = d === selected ? ' selected' : '';
      html += `<option value="${escHtml(d)}"${sel}>${escHtml(d)}</option>`;
    }
  }
  return html;
}

function _gridDefaultMonthKey() {
  const t = new Date();
  return String(t.getFullYear()) + '-' + String(t.getMonth() + 1).padStart(2, '0');
}

/* ─── RENDER (HTML SHELL) — toolbar u sticky slotu, telo u panelu ───────── */

export function renderKadrovskaGridToolbarHtml() {
  const monthKey = gridState.monthKey || _gridDefaultMonthKey();
  return `
    <div class="kadr-toolbar kadr-mesecni-grid-toolbar" aria-label="Mesečni grid alatke">
      <div class="kadr-grid-toolbar-row">
        <div class="kadr-grid-toolbar-left">
          <label class="kadr-field kadr-field--toolbar">
            <span>Mesec</span>
            <input type="month" id="gridMonth" value="${escHtml(monthKey)}">
          </label>
          <label class="kadr-field kadr-field--toolbar">
            <span>Odeljenje</span>
            <select id="gridCompanyFilter">${_gridCompanyOptions('')}</select>
          </label>
          <div class="kadr-grid-search-field kadr-grid-search-field--toolbar" role="search">
            <span class="kadr-grid-search-icon" aria-hidden="true">🔎</span>
            <input type="search" class="kadr-grid-search-input" id="gridSearch" name="kadrGridSearch" inputmode="search" enterkeyhint="search" autocomplete="off" placeholder="Pretraga po imenu i prezimenu" spellcheck="false" aria-label="Pretraga po imenu i prezimenu">
            <button type="button" class="kadr-grid-search-clear" id="gridSearchClear" title="Obriši pretragu" aria-label="Obriši pretragu" style="visibility:hidden">✕</button>
          </div>
          <span class="kadr-grid-search-meta" id="gridSearchMeta" style="display:none" aria-live="polite"></span>
        </div>
        <div class="kadr-grid-toolbar-right">
          <button type="button" class="btn btn-ghost" id="gridReload" title="Osveži iz baze">↻ Osveži</button>
          <span class="kadr-dirty-count-badge" id="gridDirtyCount" title="Nesačuvanih izmena">0</span>
          <button type="button" class="btn btn-primary" id="gridSaveAll" disabled>Sačuvaj izmene</button>
          <button type="button" class="btn btn-excel-outline" id="gridExport" title="Izvoz u Excel">Excel</button>
        </div>
      </div>
    </div>`;
}

export function renderGridPanelBody() {
  return `
    <section class="kadr-panel-inner kadr-grid-panel" aria-label="Mesečni grid">
      <div class="kadr-summary-strip" id="gridSummary"></div>
      <div class="grid-legend-collapsible">
        <button type="button" class="grid-legend-toggle" id="gridLegendToggle" aria-expanded="false" aria-controls="gridLegendBody">
          Legenda <span class="grid-legend-chev" aria-hidden="true">▶</span>
        </button>
        <div class="grid-legend-body" id="gridLegendBody" hidden>
          <div class="grid-legend" aria-label="Legenda">
            <span class="grid-legend-pill abs-go">go = god. odmor</span>
            <span class="grid-legend-pill abs-bo">bo = bolovanje 65%</span>
            <span class="grid-legend-pill abs-bo">bop = povreda na radu 100%</span>
            <span class="grid-legend-pill abs-bo">bot = održavanje trudnoće 100%</span>
            <span class="grid-legend-pill abs-sp">sp = plaćeni praznik</span>
            <span class="grid-legend-pill abs-np">np = neopravdano</span>
            <span class="grid-legend-pill abs-sl">sl = slobodan dan</span>
            <span class="grid-legend-pill abs-pr">pr = prazan dan</span>
          </div>
        </div>
      </div>
      <div id="gridWrap" class="grid-wrap"></div>
      <div id="gridEmpty" class="kadr-empty" style="display:none">Nema aktivnih radnika za izabrane filtere.</div>
    </section>
  `;
}

export { renderGridPanelBody as renderGridTab };

/* ─── RENDER (TABELA) ─────────────────────────────────────────────────── */

function _renderGridBody() {
  const wrap = _gridQ('#gridWrap');
  const empty = _gridQ('#gridEmpty');
  if (!wrap) return;

  const monthEl = _gridQ('#gridMonth');
  if (monthEl && !monthEl.value) monthEl.value = _gridDefaultMonthKey();
  const yyyymm = monthEl?.value || _gridDefaultMonthKey();
  gridState.monthKey = yyyymm;
  const days = _gridDaysInMonth(yyyymm);

  const companyEmps = _gridEmployeesCompanyOnly();
  const emps = _gridFilteredEmployees();
  const badge = document.getElementById('kadrTabCountGrid');
  if (badge) badge.textContent = String(companyEmps.length);
  _syncGridSearchMeta(companyEmps.length, emps.length);

  if (companyEmps.length === 0) {
    wrap.innerHTML = '';
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'Nema aktivnih radnika za izbrane filtere.';
    }
    _renderSummary(emps, days, null, companyEmps.length);
    _gridUpdateDirtyBadge();
    return;
  }
  if (emps.length === 0) {
    wrap.innerHTML = '';
    if (empty) {
      empty.style.display = 'block';
      empty.textContent = 'Nema radnika koji odgovaraju pretrazi.';
    }
    /* Čip + Σ za celu firmu; pretraga samo suzi grid. */
    _renderSummary(companyEmps, days, null, companyEmps.length);
    _gridUpdateDirtyBadge();
    return;
  }
  if (empty) {
    empty.style.display = 'none';
    empty.textContent = 'Nema aktivnih radnika za izbrane filtere.';
  }

  const sortedEmps = [...emps].sort(_gridCompareBySurnameAsc);
  const today = _gridIsoToday();
  const editable = canEditKadrovskaGrid();
  const holSet = gridState.holidayYmdSet instanceof Set ? gridState.holidayYmdSet : new Set();

  let html = '<table class="grid-table"><thead>';
  html += '<tr>';
  html += '<th class="col-num" rowspan="2">#</th>';
  html += '<th class="col-name" rowspan="2">Ime i prezime</th>';
  html += '<th class="col-kind" rowspan="2">Tip</th>';
  days.forEach(d => {
    const cls = _gridDayClasses(d, holSet, d.ymd === today ? ['cell-today'] : []);
    html += `<th class="${cls.join(' ')}">${d.day}</th>`;
  });
  html += '<th class="col-sum" rowspan="2">Σ</th>';
  html += '</tr><tr class="row-day-letter">';
  days.forEach(d => {
    const cls = _gridDayClasses(d, holSet);
    html += `<th class="${cls.join(' ')}">${d.letter}</th>`;
  });
  html += '</tr></thead><tbody>';

  let serialNo = 0;
  const colTotals = days.map(() => ({ reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, tm: 0 }));
  const grandTot = { reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tm: 0, tmDays: 0 };

  sortedEmps.forEach(emp => {
      serialNo++;
      const empId = escHtml(emp.id || '');
      let sReg = 0, sOt = 0, sField = 0, sFdom = 0, sFfor = 0, sTm = 0;
      const cellsReg = [], cellsOt = [], cellsField = [], cellsTm = [];
      days.forEach((d, di) => {
        const eff = _gridEffective(emp.id, d.ymd);
        const fH = Number(eff.field_hours || 0);
        const tmH = Number(eff.two_machine_hours || 0);
        sReg += gridRedovniUnitsOneDay(d.ymd, {
          hours: eff.hours,
          absence_code: eff.absence_code,
          absence_subtype: eff.absence_subtype,
        }, holSet);
        sOt += Number(eff.overtime_hours || 0);
        sField += fH;
        sTm += tmH;
        if (fH > 0) {
          if (eff.field_subtype === 'foreign') { sFfor += fH; grandTot.fforDays++; }
          else { sFdom += fH; grandTot.fdomDays++; }
        }
        if (tmH > 0) grandTot.tmDays++;
        colTotals[di].reg += gridRedovniUnitsOneDay(d.ymd, {
          hours: eff.hours,
          absence_code: eff.absence_code,
          absence_subtype: eff.absence_subtype,
        }, holSet);
        colTotals[di].ot += Number(eff.overtime_hours || 0);
        colTotals[di].field += fH;
        if (fH > 0) {
          if (eff.field_subtype === 'foreign') colTotals[di].ffor += fH;
          else colTotals[di].fdom += fH;
        }
        colTotals[di].tm += tmH;

        const dk = _gridDirtyKey(emp.id, d.ymd);
        const isDirty = gridState.dirty.has(dk);
        const extraDayCls = [];
        if (d.ymd === today) extraDayCls.push('cell-today');
        const dayBase = _gridDayClasses(d, holSet, extraDayCls);
        if (isDirty) dayBase.push('cell-dirty');

        let regVal, regCls = ['grid-cell'];
        if (eff.absence_code) {
          /* Faza K3.3 — prikaži bo subtype kao bo/bop/bot. */
          if (eff.absence_code === 'bo') {
            const subToCode = { obicno: 'bo', povreda_na_radu: 'bop', odrzavanje_trudnoce: 'bot' };
            regVal = subToCode[eff.absence_subtype] || 'bo';
          } else {
            regVal = eff.absence_code;
          }
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

      const deptSubLine = `<span class="grid-emp-meta">${escHtml(_gridEmpDeptSubLine(emp))}</span>`;
      const posLine = `<span class="grid-emp-meta">${escHtml(_gridEmpPositionLine(emp))}</span>`;
      const nameCell = `<span class="grid-emp-name">${escHtml(employeeDisplayName(emp) || '—')}</span>${deptSubLine}${posLine}`;
      html += `<tr class="row-emp-1"><td class="col-num" rowspan="4">${serialNo}.</td><td class="col-name" rowspan="4">${nameCell}</td><td class="col-kind">Redovni</td>${cellsReg.join('')}<td class="col-sum">${_gridFormatSum(sReg)}</td></tr>`;
      html += `<tr class="row-emp-2"><td class="col-kind">Prekov.</td>${cellsOt.join('')}<td class="col-sum">${_gridFormatSum(sOt)}</td></tr>`;
      html += `<tr class="row-emp-3"><td class="col-kind" title="Teren — domaći (D) / inostrani (I)">Teren</td>${cellsField.join('')}<td class="col-sum" title="Domaći ${_gridFormatSum(sFdom)}h / Inostrani ${_gridFormatSum(sFfor)}h">${_gridFormatSum(sField)}</td></tr>`;
      html += `<tr class="row-emp-4"><td class="col-kind" title="Rad na dve mašine — dodatno se plaća">2 maš.</td>${cellsTm.join('')}<td class="col-sum">${_gridFormatSum(sTm)}</td></tr>`;
  });

  /* Footer totals */
  const ftReg = colTotals.map((c, i) => {
    const cls = _gridDayClasses(days[i], holSet);
    return `<td class="${cls.join(' ')}">${_gridFormatSum(c.reg)}</td>`;
  }).join('');
  const ftOt = colTotals.map((c, i) => {
    const cls = _gridDayClasses(days[i], holSet);
    return `<td class="${cls.join(' ')}">${_gridFormatSum(c.ot)}</td>`;
  }).join('');
  const ftField = colTotals.map((c, i) => {
    const cls = _gridDayClasses(days[i], holSet);
    return `<td class="${cls.join(' ')}" title="DOM ${_gridFormatSum(c.fdom)} / INO ${_gridFormatSum(c.ffor)}">${_gridFormatSum(c.field)}</td>`;
  }).join('');
  const ftTm = colTotals.map((c, i) => {
    const cls = _gridDayClasses(days[i], holSet);
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
  _renderSummary(emps, days, grandTot, companyEmps.length);
}

function _renderSummary(emps, days, gt, companyCount) {
  const nCompany = companyCount != null ? companyCount : emps.length;
  let g = gt;
  if (!g || g.fdom === undefined) {
    g = { reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tm: 0, tmDays: 0 };
    const holSet = gridState.holidayYmdSet instanceof Set ? gridState.holidayYmdSet : new Set();
    emps.forEach(e => {
      days.forEach(d => {
        const eff = _gridEffective(e.id, d.ymd);
        const fH = Number(eff.field_hours || 0);
        const tmH = Number(eff.two_machine_hours || 0);
        g.reg += gridRedovniUnitsOneDay(d.ymd, {
          hours: eff.hours,
          absence_code: eff.absence_code,
          absence_subtype: eff.absence_subtype,
        }, holSet);
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
    { label: 'Aktivnih radnika', value: nCompany, tone: 'accent' },
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
      e.target.title = 'Nevažeća vrednost: broj 0–24 ili oznaka ' + GRID_ABS_CODES.join('/') + ' (bo/bop/bot za bolovanje)';
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
  if (parsed.kind === 'num') {
    e.target.value = _gridFormatNum(parsed.value);
  } else if (parsed.kind === 'abs') {
    /* Sačuvaj subtype šifru za 'bo' u displej-u (bo/bop/bot). */
    if (parsed.code === 'bo') {
      const subToCode = { obicno: 'bo', povreda_na_radu: 'bop', odrzavanje_trudnoce: 'bot' };
      e.target.value = subToCode[parsed.subtype] || 'bo';
    } else {
      e.target.value = parsed.code;
    }
  } else {
    e.target.value = '';
  }
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
  const wrap = _gridQ('#gridWrap');
  if (!wrap) return;
  const days = _gridDaysInMonth(gridState.monthKey);
  const holSet = gridState.holidayYmdSet instanceof Set ? gridState.holidayYmdSet : new Set();
  let sReg = 0, sOt = 0, sField = 0, sFdom = 0, sFfor = 0, sTm = 0;
  days.forEach(d => {
    const eff = _gridEffective(empId, d.ymd);
    sReg += gridRedovniUnitsOneDay(d.ymd, {
      hours: eff.hours,
      absence_code: eff.absence_code,
      absence_subtype: eff.absence_subtype,
    }, holSet);
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
  const wrap = _gridQ('#gridWrap');
  if (wrap?.querySelector('td.cell-error')) {
    showToast('⚠ Postoje nevažeće ćelije (crveno) — popravi pre snimanja');
    return;
  }
  gridState.saving = true;
  const btn = _gridQ('#gridSaveAll');
  if (btn) { btn.disabled = true; btn.textContent = 'Snimanje…'; }

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
    if (btn) { btn.disabled = false; btn.textContent = 'Sačuvaj izmene'; }
    _gridUpdateDirtyBadge();
  }
}

async function _onMonthChange() {
  const monthEl = _gridQ('#gridMonth');
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
  const wrap = _gridQ('#gridWrap');
  if (wrap) {
    wrap.innerHTML = `<div style="padding:30px;color:var(--text3);font-size:12px;text-align:center">Učitavanje ${escHtml(yyyymm)}…</div>`;
  }
  const days = _gridDaysInMonth(yyyymm);
  if (getIsOnline() && hasSupabaseConfig()) {
    try {
      await loadHolidaysForRange(days[0].ymd, days[days.length - 1].ymd);
      gridState.holidayYmdSet = holidayDateSet();
      gridState.rowsByEmpDate = await loadGridMonth(days);
    } catch (err) {
      console.error('[grid] load month failed', err);
      gridState.rowsByEmpDate = new Map();
      gridState.holidayYmdSet = new Set();
    }
  } else {
    gridState.rowsByEmpDate = new Map();
    await loadHolidaysForRange(days[0].ymd, days[days.length - 1].ymd);
    gridState.holidayYmdSet = holidayDateSet();
  }
  gridState.monthKey = yyyymm;
  gridState.loaded = true;
  _renderGridBody();
}

/* ─── EXCEL EXPORT ──────────────────────────────────────────────────────
 * Isti obrazac kao `planMontaze/exportModal.js`: `import { loadXlsx } from '../../lib/xlsx.js'`
 * + `const XLSX = await loadXlsx()`. Izvoz: svi aktivni po firma-filteru, bez pretrage.
 */

async function _exportToXlsx() {
  const yyyymm = gridState.monthKey || _gridQ('#gridMonth')?.value;
  if (!yyyymm) {
    showToast('⚠ Nema izabranog meseca');
    return;
  }
  const emps = _gridEmployeesCompanyOnly();
  if (emps.length === 0) {
    showToast('Nema podataka za izvoz u odabranom mesecu.');
    return;
  }

  showToast('⏳ Učitavam XLSX...');
  let XLSX;
  try {
    XLSX = await loadXlsx();
  } catch (err) {
    console.error('[kadr-grid-xlsx]', err);
    showToast('Neuspešno učitavanje modula za Excel. Osveži stranicu (Ctrl+F5) i pokušaj ponovo. Ako se ponovi, očisti keš PWA/Service Worker-a.');
    return;
  }

  try {
    const days = _gridDaysInMonth(yyyymm);
    await loadHolidaysForRange(days[0].ymd, days[days.length - 1].ymd);
    const holSet = holidayDateSet();
    const sortedEmps = [...emps].sort(_gridCompareBySurnameAsc);
    const monthLabel = (() => {
      const [y, m] = yyyymm.split('-');
      const names = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun', 'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar'];
      return (names[parseInt(m, 10) - 1] || m).toUpperCase() + ' ' + y;
    })();

    const aoa = [];
    aoa.push([monthLabel].concat(new Array(days.length + 6).fill('')));
    aoa.push([]);
    aoa.push(['#', 'Ime i prezime', 'Odeljenje — pododeljenje', 'Pozicija', 'Tip'].concat(days.map(d => d.day)).concat(['Σ']));
    aoa.push(['', '', '', '', ''].concat(days.map(d => d.letter)).concat(['']));

    let serialNo = 0;
    const grand = { reg: 0, ot: 0, field: 0, fdom: 0, ffor: 0, fdomDays: 0, fforDays: 0, tm: 0, tmDays: 0 };
    const colTotals = days.map(() => ({ reg: 0, ot: 0, field: 0, tm: 0 }));

    sortedEmps.forEach(emp => {
        serialNo++;
        let sR = 0, sO = 0, sF = 0, sFd = 0, sFf = 0, sTm = 0;
        const deptSub = _gridEmpDeptSubLine(emp);
        const pos = _gridEmpPositionLine(emp);
        const rowR = [serialNo + '.', employeeDisplayName(emp) || '—', deptSub, pos, 'Redovni'];
        const rowO = ['', '', '', '', 'Prekov.'];
        const rowF = ['', '', '', '', 'Teren'];
        const rowTm = ['', '', '', '', '2 maš.'];
        days.forEach((d, i) => {
          const eff = _gridEffective(emp.id, d.ymd);
          const fH = Number(eff.field_hours || 0);
          const tmH = Number(eff.two_machine_hours || 0);
          if (eff.absence_code) {
            if (eff.absence_code === 'bo') {
              const subToCode = { obicno: 'BO', povreda_na_radu: 'BOP', odrzavanje_trudnoce: 'BOT' };
              rowR.push(subToCode[eff.absence_subtype] || 'BO');
            } else {
              rowR.push(eff.absence_code.toUpperCase());
            }
          } else rowR.push(eff.hours || '');
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
          const ru = gridRedovniUnitsOneDay(d.ymd, {
            hours: eff.hours,
            absence_code: eff.absence_code,
            absence_subtype: eff.absence_subtype,
          }, holSet);
          sR += ru;
          sO += Number(eff.overtime_hours || 0);
          sF += fH;
          sTm += tmH;
          colTotals[i].reg += ru;
          colTotals[i].ot += Number(eff.overtime_hours || 0);
          colTotals[i].field += fH;
          colTotals[i].tm += tmH;
        });
        grand.reg += sR; grand.ot += sO; grand.field += sF;
        grand.fdom += sFd; grand.ffor += sFf; grand.tm += sTm;
        rowR.push(sR || 0); rowO.push(sO || 0); rowF.push(sF || 0); rowTm.push(sTm || 0);
        aoa.push(rowR); aoa.push(rowO); aoa.push(rowF); aoa.push(rowTm);
    });
    aoa.push([]);
    aoa.push(['', 'UKUPNO', '', '', 'Redovni'].concat(colTotals.map(c => c.reg || 0)).concat([grand.reg || 0]));
    aoa.push(['', '', '', '', 'Prekov.'].concat(colTotals.map(c => c.ot || 0)).concat([grand.ot || 0]));
    aoa.push(['', '', '', '', 'Teren'].concat(colTotals.map(c => c.field || 0)).concat([grand.field || 0]));
    aoa.push(['', '', '', '', '2 maš.'].concat(colTotals.map(c => c.tm || 0)).concat([grand.tm || 0]));
    aoa.push([]);
    aoa.push(['', 'TEREN BREAKDOWN', 'Domaći (h)', grand.fdom || 0, '', '', 'Domaći (dani)', grand.fdomDays || 0]);
    aoa.push(['', '', 'Inostrani (h)', grand.ffor || 0, '', '', 'Inostrani (dani)', grand.fforDays || 0]);
    aoa.push(['', 'RAD NA 2 MAŠINE', 'Sati', grand.tm || 0, '', '', 'Dani', grand.tmDays || 0]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 5 }, { wch: 26 }, { wch: 28 }, { wch: 22 }, { wch: 9 }].concat(days.map(() => ({ wch: 4 }))).concat([{ wch: 7 }]);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: days.length + 6 } }];

    const wb = XLSX.utils.book_new();
    const sheetName = monthLabel.length > 31 ? monthLabel.slice(0, 31) : monthLabel;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const fname = 'Sati_' + yyyymm + '.xlsx';
    XLSX.writeFile(wb, fname);
    showToast('📊 Izvezeno: ' + fname);
  } catch (err) {
    console.error('[kadr-grid-xlsx]', err);
    showToast('Greška pri izvozu: ' + (err && err.message ? err.message : String(err)));
  }
}

/* ─── PUBLIC: WIRE ────────────────────────────────────────────────────── */

export async function wireGridTab(panel, toolbarHost = null) {
  panelRoot = panel;
  gridToolbarHost = toolbarHost;

  _gridQ('#gridMonth')?.addEventListener('change', _onMonthChange);
  _gridQ('#gridCompanyFilter')?.addEventListener('change', () => {
    _renderGridBody();
  });
  _gridQ('#gridReload')?.addEventListener('click', async () => {
    if (_gridDirtyCount() > 0) {
      if (!confirm('Imaš nesačuvanih izmena. Reload će ih odbaciti. Nastaviti?')) return;
      gridState.dirty.clear();
    }
    const yyyymm = _gridQ('#gridMonth')?.value || _gridDefaultMonthKey();
    await ensureEmployeesLoaded(true);
    const firmSel = _gridQ('#gridCompanyFilter');
    if (firmSel) firmSel.innerHTML = _gridCompanyOptions(firmSel.value || '');
    await _loadAndRender(yyyymm);
  });
  _gridQ('#gridSaveAll')?.addEventListener('click', _saveAllGrid);
  _gridQ('#gridExport')?.addEventListener('click', () => {
    void _exportToXlsx().catch(err => {
      console.error('[kadr-grid-xlsx]', err);
      showToast('Greška pri izvozu: ' + (err && err.message ? err.message : String(err)));
    });
  });

  const savedSearch = ssGet(SESSION_KEYS.KADR_GRID_SEARCH, '') || '';
  gridState.searchQuery = savedSearch;
  const searchInp = _gridQ('#gridSearch');
  if (searchInp) searchInp.value = savedSearch;
  searchInp?.addEventListener('input', () => {
    clearTimeout(_gridSearchDebounce);
    _gridSearchDebounce = setTimeout(() => {
      const v = _gridQ('#gridSearch')?.value ?? '';
      gridState.searchQuery = String(v);
      ssSet(SESSION_KEYS.KADR_GRID_SEARCH, String(v));
      _renderGridBody();
    }, 150);
  });
  _gridQ('#gridSearchClear')?.addEventListener('click', () => {
    const inp = _gridQ('#gridSearch');
    if (inp) inp.value = '';
    gridState.searchQuery = '';
    ssSet(SESSION_KEYS.KADR_GRID_SEARCH, '');
    clearTimeout(_gridSearchDebounce);
    _renderGridBody();
  });

  panel.querySelector('#gridLegendToggle')?.addEventListener('click', () => {
    const body = panel.querySelector('#gridLegendBody');
    const btn = panel.querySelector('#gridLegendToggle');
    const chev = btn?.querySelector('.grid-legend-chev');
    const isHidden = body?.hasAttribute('hidden');
    if (isHidden) {
      body?.removeAttribute('hidden');
      btn?.setAttribute('aria-expanded', 'true');
      if (chev) chev.textContent = '▼';
    } else {
      body?.setAttribute('hidden', '');
      btn?.setAttribute('aria-expanded', 'false');
      if (chev) chev.textContent = '▶';
    }
  });

  try {
    await Promise.all([
      ensureEmployeesLoaded(true),
      ensureOrgStructureLoaded(),
    ]);
  } catch (err) {
    console.warn('[grid] load failed', err);
  }

  const compSel = _gridQ('#gridCompanyFilter');
  if (compSel) {
    const cur = compSel.value;
    compSel.innerHTML = _gridCompanyOptions(cur);
  }

  const monthEl = _gridQ('#gridMonth');
  const wantMonth = monthEl?.value || _gridDefaultMonthKey();
  if (gridState.loaded && gridState.monthKey === wantMonth) {
    _renderGridBody();
  } else {
    await _loadAndRender(wantMonth);
  }
}
