/**
 * Salary Payroll (mesečni obračun, Faza K3.2) — CRUD nad `salary_payroll`.
 * RLS: samo admin.
 *
 * Ciklus:
 *   1) `initMonth(year, month)` — kreira draft red po aktivnom zaposlenom
 *      sa snapshot-om trenutnih salary_terms (prevoz, dinarska, devizna).
 *   2) `loadByMonth(year, month)` — lista svih redova za mesec (JOIN na employees).
 *   3) `upsertPayroll(row)` — POST ako nema id, PATCH ako ima. Totals se
 *      racuna u bazi kroz trigger, ali i FE radi mirror za live preview.
 *
 * FE compute helper — ogledalo trigger-a (za live preview pre save-a):
 *   computeTotals(row): { totalRsd, totalEur, secondPartRsd }
 */

import { sbReq } from './supabase.js';
import { isAdmin, getIsOnline } from '../state/auth.js';
import { employeeDisplayName } from '../lib/employeeNames.js';
import { mapDbWorkHour } from './workHours.js';
import { loadHolidaysForRange, holidayDateSet } from './holidays.js';
import {
  computeEarnings,
  aggregateWorkHoursForMonth,
  deriveCompensationModel,
  computeMonthlyFond,
} from './payrollCalc.js';

/* ── Mapping ──────────────────────────────────────────────────── */

export function mapDbPayroll(d) {
  const employeeFirstName = d.employee_first_name || '';
  const employeeLastName = d.employee_last_name || '';
  return {
    id: d.id,
    employeeId: d.employee_id,
    employeeName: employeeDisplayName({
      employeeName: d.employee_name,
      employeeFirstName,
      employeeLastName,
    }),
    employeeFirstName,
    employeeLastName,
    employeePosition: d.employee_position || '',
    employeeDepartment: d.employee_department || '',
    employeeActive: d.employee_active != null ? !!d.employee_active : true,
    employeeWorkType: d.employee_work_type || 'ugovor',
    periodYear: d.period_year,
    periodMonth: d.period_month,
    salaryType: d.salary_type || 'ugovor',
    compensationModel: d.compensation_model || null,
    /* Prvi deo */
    advanceAmount: num(d.advance_amount),
    advancePaidOn: d.advance_paid_on || '',
    advanceNote: d.advance_note || '',
    /* Baza */
    fixedSalary: num(d.fixed_salary),
    hoursWorked: num(d.hours_worked),
    hourlyRate: num(d.hourly_rate),
    /* Dodaci */
    transportRsd: num(d.transport_rsd),
    domesticDays: int(d.domestic_days),
    perDiemRsd: num(d.per_diem_rsd),
    foreignDays: int(d.foreign_days),
    perDiemEur: num(d.per_diem_eur),
    /* Izračunato (u bazi preko trigger-a) */
    totalRsd: num(d.total_rsd),
    totalEur: num(d.total_eur),
    secondPartRsd: num(d.second_part_rsd),
    /* K3.3 (opciono) */
    fondSatiMeseca: num(d.fond_sati_meseca),
    redovanRadSati: num(d.redovan_rad_sati),
    prekovremeniSati: num(d.prekovremeni_sati),
    praznikPlaceniSati: num(d.praznik_placeni_sati),
    praznikRadSati: num(d.praznik_rad_sati),
    godisnjiSati: num(d.godisnji_sati),
    slobodniDaniSati: num(d.slobodni_dani_sati),
    bolovanje65Sati: num(d.bolovanje_65_sati),
    bolovanje100Sati: num(d.bolovanje_100_sati),
    dveMasineSati: num(d.dve_masine_sati),
    payableHours: num(d.payable_hours),
    ukupnaZarada: num(d.ukupna_zarada),
    preostaloZaIsplatu: num(d.preostalo_za_isplatu),
    prviDeoAmount: num(d.prvi_deo),
    payrollWarnings: Array.isArray(d.warnings) ? d.warnings : [],
    /* Finalizacija */
    finalPaidOn: d.final_paid_on || '',
    status: d.status || 'draft',
    note: d.note || '',
    createdBy: d.created_by || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

function num(v) { return v == null || v === '' ? 0 : Number(v); }
function int(v) { return v == null || v === '' ? 0 : parseInt(v, 10) || 0; }

export function buildPayrollPayload(r) {
  const p = {
    employee_id: r.employeeId,
    period_year: int(r.periodYear),
    period_month: int(r.periodMonth),
    salary_type: r.salaryType || 'ugovor',
    advance_amount: num(r.advanceAmount),
    advance_paid_on: r.advancePaidOn || null,
    advance_note: r.advanceNote || '',
    fixed_salary: num(r.fixedSalary),
    hours_worked: num(r.hoursWorked),
    hourly_rate: num(r.hourlyRate),
    transport_rsd: num(r.transportRsd),
    domestic_days: int(r.domesticDays),
    per_diem_rsd: num(r.perDiemRsd),
    foreign_days: int(r.foreignDays),
    per_diem_eur: num(r.perDiemEur),
    final_paid_on: r.finalPaidOn || null,
    status: r.status || 'draft',
    note: r.note || '',
    updated_at: new Date().toISOString(),
  };
  if (r.compensationModel) p.compensation_model = r.compensationModel;
  if (r.fondSatiMeseca != null && r.fondSatiMeseca !== '') p.fond_sati_meseca = num(r.fondSatiMeseca);
  if (r.redovanRadSati != null && r.redovanRadSati !== '') p.redovan_rad_sati = num(r.redovanRadSati);
  if (r.prekovremeniSati != null && r.prekovremeniSati !== '') p.prekovremeni_sati = num(r.prekovremeniSati);
  if (r.praznikPlaceniSati != null && r.praznikPlaceniSati !== '') p.praznik_placeni_sati = num(r.praznikPlaceniSati);
  if (r.praznikRadSati != null && r.praznikRadSati !== '') p.praznik_rad_sati = num(r.praznikRadSati);
  if (r.godisnjiSati != null && r.godisnjiSati !== '') p.godisnji_sati = num(r.godisnjiSati);
  if (r.slobodniDaniSati != null && r.slobodniDaniSati !== '') p.slobodni_dani_sati = num(r.slobodniDaniSati);
  if (r.bolovanje65Sati != null && r.bolovanje65Sati !== '') p.bolovanje_65_sati = num(r.bolovanje65Sati);
  if (r.bolovanje100Sati != null && r.bolovanje100Sati !== '') p.bolovanje_100_sati = num(r.bolovanje100Sati);
  if (r.dveMasineSati != null && r.dveMasineSati !== '') p.dve_masine_sati = num(r.dveMasineSati);
  if (r.terenUZemljiCount != null && r.terenUZemljiCount !== '') p.teren_u_zemlji_count = int(r.terenUZemljiCount);
  if (r.terenUInostranstvuCount != null && r.terenUInostranstvuCount !== '') p.teren_u_inostranstvu_count = int(r.terenUInostranstvuCount);
  if (r.payableHours != null && r.payableHours !== '') p.payable_hours = num(r.payableHours);
  if (r.ukupnaZarada != null && r.ukupnaZarada !== '' && r.ukupnaZarada > 0) p.ukupna_zarada = num(r.ukupnaZarada);
  if (r.preostaloZaIsplatu != null && r.preostaloZaIsplatu !== '') p.preostalo_za_isplatu = num(r.preostaloZaIsplatu);
  if (r.prviDeoAmount != null && r.prviDeoAmount !== '') p.prvi_deo = num(r.prviDeoAmount);
  if (Array.isArray(r.payrollWarnings)) p.warnings = r.payrollWarnings;
  if (r.id) p.id = r.id;
  return p;
}

/** Shape za payrollCalc.computeEarnings iz reda v_employee_current_salary. */
export function termsForPayrollCalc(s) {
  if (!s) return null;
  const hourly = s.salaryType === 'satnica' ? num(s.amount) : num(s.hourlyRate ?? 0);
  const model = s.compensationModel || deriveCompensationModel({ salaryType: s.salaryType });
  if (!model) return null;
  return {
    compensationModel: model,
    salaryType: s.salaryType,
    fixedAmount: num(s.fixedAmount),
    fixedTransportComponent: num(s.fixedTransportComponent),
    fixedExtraHourRate: num(s.fixedExtraHourRate),
    firstPartAmount: num(s.firstPartAmount),
    splitHourRate: num(s.splitHourRate),
    splitTransportAmount: num(s.splitTransportAmount),
    hourlyRate: hourly,
    hourlyTransportAmount: num(s.hourlyTransportAmount),
    terrainDomesticRate: num(s.terrainDomesticRate),
    terrainForeignRate: num(s.terrainForeignRate),
  };
}

let payrollComputationCtx = {
  year: 0,
  month: 0,
  holidaySet: new Set(),
  workHoursByEmp: new Map(),
  currentSalaries: [],
};

export async function refreshPayrollComputationContext(year, month, currentSalaries) {
  const y = int(year);
  const m = int(month);
  const mi = String(m).padStart(2, '0');
  const from = `${y}-${mi}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${mi}-${String(last).padStart(2, '0')}`;
  await loadHolidaysForRange(from, to);
  const holidaySet = holidayDateSet();
  const workHoursByEmp = await loadWorkHoursMapsForPayrollMonth(y, m);
  payrollComputationCtx = {
    year: y,
    month: m,
    holidaySet,
    workHoursByEmp,
    currentSalaries: currentSalaries || [],
  };
}

export async function loadWorkHoursMapsForPayrollMonth(year, month) {
  const y = int(year);
  const m = int(month);
  const mi = String(m).padStart(2, '0');
  const from = `${y}-${mi}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${mi}-${String(last).padStart(2, '0')}`;
  const byEmp = new Map();
  if (!getIsOnline() || !isAdmin()) return byEmp;
  const data = await sbReq(
    `work_hours?work_date=gte.${from}&work_date=lte.${to}&select=*`,
  );
  if (!Array.isArray(data)) return byEmp;
  data.forEach(raw => {
    const row = mapDbWorkHour(raw);
    if (!row.employeeId || !row.workDate) return;
    if (!byEmp.has(row.employeeId)) byEmp.set(row.employeeId, new Map());
    byEmp.get(row.employeeId).set(row.workDate, row);
  });
  return byEmp;
}

/**
 * Ogledalo DB trigger-a — računa totals u FE-u za live preview (legacy).
 * Vraća novi objekat sa total_rsd, total_eur, second_part_rsd.
 */
export function computeTotals(r) {
  const base = r.salaryType === 'satnica'
    ? num(r.hoursWorked) * num(r.hourlyRate)
    : num(r.fixedSalary);
  const totalRsd = base + num(r.transportRsd) + num(r.perDiemRsd) * int(r.domesticDays);
  const totalEur = num(r.perDiemEur) * int(r.foreignDays);
  const secondPartRsd = totalRsd - num(r.advanceAmount);
  return {
    baseRsd: base,
    totalRsd: round2(totalRsd),
    totalEur: round2(totalEur),
    secondPartRsd: round2(secondPartRsd),
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Live preview / persist: obračun iz mesečnog grida (work_hours) + praznika + K3.3 formula.
 * Ako nema aktivnog uslova zarade ili konteksta meseca — fallback na computeTotals().
 */
export function computeDisplayTotals(row) {
  const base = computeTotals(row);
  const ctx = payrollComputationCtx;
  if (!row?.periodYear || !row?.periodMonth) return { ...base, payrollK33: false };
  if (ctx.year !== int(row.periodYear) || ctx.month !== int(row.periodMonth)) return { ...base, payrollK33: false };

  const cur = ctx.currentSalaries.find(s => s.employeeId === row.employeeId);
  const terms = termsForPayrollCalc(cur);
  if (!terms || !deriveCompensationModel(terms)) return { ...base, payrollK33: false };

  const ymdMap = ctx.workHoursByEmp.get(row.employeeId) || new Map();
  const agg = aggregateWorkHoursForMonth(int(row.periodYear), int(row.periodMonth), ymdMap, ctx.holidaySet);
  const workType = row.employeeWorkType || 'ugovor';
  const earned = computeEarnings({
    workType,
    terms,
    hours: agg,
    terrain: { domestic: int(row.domesticDays), foreign: int(row.foreignDays) },
    advanceAmount: num(row.advanceAmount),
  });

  const totalRsd = round2(
    earned.breakdown.baseEarnings
    + earned.breakdown.extraEarnings
    + num(row.transportRsd)
    + num(row.perDiemRsd) * int(row.domesticDays),
  );
  const totalEur = round2(num(row.perDiemEur) * int(row.foreignDays));
  const secondPartRsd = round2(totalRsd - earned.prviDeo);
  const fond = computeMonthlyFond(int(row.periodYear), int(row.periodMonth), ctx.holidaySet);

  return {
    baseRsd: round2(earned.breakdown.baseEarnings + earned.breakdown.extraEarnings),
    totalRsd,
    totalEur,
    secondPartRsd,
    payrollK33: true,
    payableHours: earned.payableHours,
    ukupnaZarada: totalRsd,
    prviDeoAmount: earned.prviDeo,
    preostaloZaIsplatu: secondPartRsd,
    compensationModel: earned.compensationModel,
    fondSatiMeseca: fond.fondSati,
    redovanRadSati: agg.redovanRadSati,
    prekovremeniSati: agg.prekovremeniSati,
    praznikPlaceniSati: agg.praznikPlaceniSati,
    praznikRadSati: agg.praznikRadSati,
    godisnjiSati: agg.godisnjiSati,
    slobodniDaniSati: agg.slobodniDaniSati,
    bolovanje65Sati: agg.bolovanje65Sati,
    bolovanje100Sati: agg.bolovanje100Sati,
    dveMasineSati: agg.dveMasineSati,
    payrollWarnings: earned.warnings,
  };
}

/* ── READ ──────────────────────────────────────────────────── */

/** Lista obračuna za dati mesec (JOIN preko view-a). */
export async function loadPayrollByMonth(year, month) {
  if (!getIsOnline() || !isAdmin()) return null;
  const params = [
    'select=*',
    `period_year=eq.${int(year)}`,
    `period_month=eq.${int(month)}`,
    'order=employee_last_name.asc,employee_first_name.asc,employee_name.asc',
  ];
  const data = await sbReq(`v_salary_payroll_month?${params.join('&')}`);
  if (!data) return null;
  return data.map(mapDbPayroll);
}

/** Lista svih obračuna jednog zaposlenog (istorija). */
export async function loadPayrollForEmployee(employeeId) {
  if (!getIsOnline() || !isAdmin() || !employeeId) return null;
  const data = await sbReq(
    `v_salary_payroll_month?employee_id=eq.${encodeURIComponent(employeeId)}`
    + '&select=*&order=period_year.desc,period_month.desc',
  );
  if (!data) return null;
  return data.map(mapDbPayroll);
}

/* ── WRITE ──────────────────────────────────────────────────── */

/** Upsert — ako row.id postoji, PATCH, inače POST. */
export async function upsertPayroll(row) {
  if (!getIsOnline() || !isAdmin()) return null;
  const payload = buildPayrollPayload(row);
  if (row.id) {
    const { id, ...rest } = payload;
    const res = await sbReq(
      `salary_payroll?id=eq.${encodeURIComponent(row.id)}`,
      'PATCH',
      rest,
    );
    if (!res || !res.length) return null;
    return mapDbPayroll(res[0]);
  }
  const res = await sbReq('salary_payroll', 'POST', payload);
  if (!res || !res.length) return null;
  return mapDbPayroll(res[0]);
}

export async function deletePayroll(id) {
  if (!getIsOnline() || !isAdmin() || !id) return false;
  return (await sbReq(
    `salary_payroll?id=eq.${encodeURIComponent(id)}`,
    'DELETE',
  )) !== null;
}

/**
 * Kreira draft redove za sve aktivne zaposlene za dati mesec.
 * Vraća broj novih redova (postojeci se ne diraju).
 */
export async function initPayrollMonth(year, month) {
  if (!getIsOnline() || !isAdmin()) return null;
  const data = await sbReq('rpc/kadr_payroll_init_month', 'POST', {
    p_year: int(year),
    p_month: int(month),
  });
  if (data == null) return null;
  /* PostgREST za SCALAR RPC vraća jednostavnu vrednost (number) */
  return typeof data === 'number' ? data : (Array.isArray(data) ? (data[0] || 0) : 0);
}
