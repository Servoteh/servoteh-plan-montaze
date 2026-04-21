/**
 * Salary (zarade) — CRUD nad salary_terms + current salary view.
 * STRIKTNO samo admin po RLS-u; FE takođe kapira sve preko `isAdmin()`.
 *
 * Shape FE (camelCase):
 *   { id, employeeId, salaryType, effectiveFrom, effectiveTo, amount,
 *     amountType, currency, hourlyRate, contractRef, note, createdBy,
 *     createdAt, updatedAt }
 *
 * Dve glavne operacije:
 *   - `loadTermsForEmployee(empId)` → cela istorija ugovornih uslova
 *   - `loadCurrentSalariesFromDb()`  → view `v_employee_current_salary`
 */

import { sbReq } from './supabase.js';
import { isAdmin, getIsOnline } from '../state/auth.js';

export function mapDbTerm(d) {
  return {
    id: d.id,
    employeeId: d.employee_id,
    salaryType: d.salary_type || 'ugovor',
    effectiveFrom: d.effective_from || '',
    effectiveTo: d.effective_to || '',
    amount: d.amount == null ? 0 : Number(d.amount),
    amountType: d.amount_type || 'neto',
    currency: d.currency || 'RSD',
    hourlyRate: d.hourly_rate == null ? null : Number(d.hourly_rate),
    /* Faza K3.2 — mesečni dodaci (snapshot u salary_terms): */
    transportAllowanceRsd: d.transport_allowance_rsd == null ? 0 : Number(d.transport_allowance_rsd),
    perDiemRsd: d.per_diem_rsd == null ? 0 : Number(d.per_diem_rsd),
    perDiemEur: d.per_diem_eur == null ? 0 : Number(d.per_diem_eur),
    contractRef: d.contract_ref || '',
    note: d.note || '',
    createdBy: d.created_by || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function buildTermPayload(t) {
  const p = {
    employee_id: t.employeeId,
    salary_type: t.salaryType || 'ugovor',
    effective_from: t.effectiveFrom,
    effective_to: t.effectiveTo || null,
    amount: Number(t.amount || 0),
    amount_type: t.amountType || 'neto',
    currency: t.currency || 'RSD',
    hourly_rate: t.salaryType === 'satnica' ? Number(t.amount || 0) : (t.hourlyRate == null ? null : Number(t.hourlyRate)),
    transport_allowance_rsd: Number(t.transportAllowanceRsd || 0),
    per_diem_rsd: Number(t.perDiemRsd || 0),
    per_diem_eur: Number(t.perDiemEur || 0),
    contract_ref: t.contractRef || null,
    note: t.note || '',
    updated_at: new Date().toISOString(),
  };
  if (t.id) p.id = t.id;
  return p;
}

/* ── SELECT ──────────────────────────────────────────────────── */

/** Učitaj SVE zapise (za admin listu). Može biti veliki skup — ograniči UI paginacijom. */
export async function loadAllTermsFromDb() {
  if (!getIsOnline() || !isAdmin()) return null;
  const data = await sbReq('salary_terms?select=*&order=employee_id,effective_from.desc');
  if (!data) return null;
  return data.map(mapDbTerm);
}

/** Istorija zarada jednog zaposlenog. */
export async function loadTermsForEmployee(employeeId) {
  if (!getIsOnline() || !isAdmin() || !employeeId) return null;
  const data = await sbReq(
    `salary_terms?employee_id=eq.${encodeURIComponent(employeeId)}&select=*&order=effective_from.desc`
  );
  if (!data) return null;
  return data.map(mapDbTerm);
}

/** Aktuelna zarada po zaposlenom (preko view-a). */
export async function loadCurrentSalariesFromDb() {
  if (!getIsOnline() || !isAdmin()) return null;
  const data = await sbReq('v_employee_current_salary?select=*');
  if (!data) return null;
  return data.map(d => ({
    employeeId: d.employee_id,
    salaryTermId: d.salary_term_id,
    salaryType: d.salary_type,
    effectiveFrom: d.effective_from || '',
    effectiveTo: d.effective_to || '',
    amount: d.amount == null ? 0 : Number(d.amount),
    amountType: d.amount_type,
    currency: d.currency,
    hourlyRate: d.hourly_rate == null ? null : Number(d.hourly_rate),
    transportAllowanceRsd: d.transport_allowance_rsd == null ? 0 : Number(d.transport_allowance_rsd),
    perDiemRsd: d.per_diem_rsd == null ? 0 : Number(d.per_diem_rsd),
    perDiemEur: d.per_diem_eur == null ? 0 : Number(d.per_diem_eur),
    contractRef: d.contract_ref || '',
    note: d.note || '',
    updatedAt: d.updated_at,
  }));
}

/* ── WRITE ──────────────────────────────────────────────────── */

export async function saveTermToDb(t) {
  if (!getIsOnline() || !isAdmin()) return null;
  const res = await sbReq('salary_terms', 'POST', buildTermPayload(t));
  if (res === null) {
    console.warn('[salary] save failed — run add_kadr_salary_terms.sql');
  }
  return res;
}

export async function updateTermInDb(t) {
  if (!getIsOnline() || !isAdmin() || !t.id) return null;
  const { id, ...rest } = buildTermPayload(t);
  return await sbReq(
    `salary_terms?id=eq.${encodeURIComponent(t.id)}`,
    'PATCH',
    rest,
  );
}

export async function deleteTermFromDb(id) {
  if (!getIsOnline() || !isAdmin() || !id) return false;
  return (await sbReq(
    `salary_terms?id=eq.${encodeURIComponent(id)}`,
    'DELETE',
  )) !== null;
}
