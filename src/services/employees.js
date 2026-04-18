/**
 * Employees CRUD — Supabase REST + offline-safe wrappers.
 * Bit-paritet sa legacy/index.html `loadEmployeesFromDb` / `saveEmployeeToDb`
 * / `deleteEmployeeFromDb` + mapDbEmployee + buildEmployeePayload.
 */

import { sbReq } from './supabase.js';
import { canEdit, getIsOnline } from '../state/auth.js';

export function mapDbEmployee(d) {
  return {
    id: d.id,
    fullName: d.full_name || '',
    position: d.position || '',
    department: d.department || '',
    phone: d.phone || '',
    email: d.email || '',
    hireDate: d.hire_date || '',
    isActive: d.is_active !== false,
    note: d.note || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function buildEmployeePayload(emp) {
  const p = {
    full_name: emp.fullName || '',
    position: emp.position || '',
    department: emp.department || '',
    phone: emp.phone || '',
    email: emp.email || '',
    hire_date: emp.hireDate || null,
    is_active: emp.isActive !== false,
    note: emp.note || '',
    updated_at: new Date().toISOString(),
  };
  if (emp.id) p.id = emp.id;
  return p;
}

export async function loadEmployeesFromDb() {
  if (!getIsOnline()) return null;
  const data = await sbReq('employees?select=*&order=full_name.asc');
  if (!data) return null;
  return data.map(mapDbEmployee);
}

export async function saveEmployeeToDb(emp) {
  if (!getIsOnline() || !canEdit()) return null;
  const res = await sbReq('employees', 'POST', buildEmployeePayload(emp));
  if (res === null) {
    console.warn('[kadrovska] Save failed. Is sql/migrations/add_kadrovska_module.sql applied?');
  }
  return res;
}

export async function deleteEmployeeFromDb(id) {
  if (!getIsOnline() || !canEdit() || !id) return false;
  const res = await sbReq(`employees?id=eq.${encodeURIComponent(id)}`, 'DELETE');
  return res !== null;
}
