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

/* ── Mapping ──────────────────────────────────────────────────── */

export function mapDbPayroll(d) {
  return {
    id: d.id,
    employeeId: d.employee_id,
    employeeName: d.employee_name || '',     // iz view-a
    employeePosition: d.employee_position || '',
    employeeDepartment: d.employee_department || '',
    employeeActive: d.employee_active != null ? !!d.employee_active : true,
    periodYear: d.period_year,
    periodMonth: d.period_month,
    salaryType: d.salary_type || 'ugovor',
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
  if (r.id) p.id = r.id;
  return p;
}

/**
 * Ogledalo DB trigger-a — računa totals u FE-u za live preview.
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

/* ── READ ──────────────────────────────────────────────────── */

/** Lista obračuna za dati mesec (JOIN preko view-a). */
export async function loadPayrollByMonth(year, month) {
  if (!getIsOnline() || !isAdmin()) return null;
  const params = [
    'select=*',
    `period_year=eq.${int(year)}`,
    `period_month=eq.${int(month)}`,
    'order=employee_name.asc',
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
