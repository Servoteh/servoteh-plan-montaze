/**
 * Employee children — CRUD (Faza K2).
 * Tabela `employee_children` je RLS-gated: SELECT/INSERT/UPDATE/DELETE
 * samo za `admin` (migracija `restrict_employee_pii_admin_only.sql`).
 *
 * Na FE strani — UI poziva ove funkcije samo kada `canViewEmployeePii()` vraća true.
 */

import { sbReq } from './supabase.js';
import { canViewEmployeePii, getIsOnline } from '../state/auth.js';

export function mapDbChild(d) {
  return {
    id: d.id,
    employeeId: d.employee_id,
    firstName: d.first_name || '',
    birthDate: d.birth_date || '',
    note: d.note || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

function buildPayload(c) {
  const p = {
    employee_id: c.employeeId,
    first_name: (c.firstName || '').trim(),
    birth_date: c.birthDate || null,
    note: c.note || '',
    updated_at: new Date().toISOString(),
  };
  if (c.id) p.id = c.id;
  return p;
}

/** Vrati svu decu jednog zaposlenog (ili svu decu ako ne prosledimo empId). */
export async function loadChildrenForEmployee(employeeId) {
  if (!getIsOnline() || !canViewEmployeePii()) return null;
  const q = employeeId
    ? `employee_children?employee_id=eq.${encodeURIComponent(employeeId)}&select=*&order=birth_date.asc.nullslast`
    : `employee_children?select=*&order=employee_id,birth_date.asc.nullslast`;
  const data = await sbReq(q);
  if (!data) return null;
  return data.map(mapDbChild);
}

export async function saveChildToDb(c) {
  if (!getIsOnline() || !canViewEmployeePii()) return null;
  return await sbReq('employee_children', 'POST', buildPayload(c));
}

export async function updateChildInDb(c) {
  if (!getIsOnline() || !canViewEmployeePii() || !c.id) return null;
  const { id, ...rest } = buildPayload(c);
  return await sbReq(
    `employee_children?id=eq.${encodeURIComponent(c.id)}`,
    'PATCH',
    rest,
  );
}

export async function deleteChildFromDb(id) {
  if (!getIsOnline() || !canViewEmployeePii() || !id) return false;
  return (await sbReq(
    `employee_children?id=eq.${encodeURIComponent(id)}`,
    'DELETE',
  )) !== null;
}
