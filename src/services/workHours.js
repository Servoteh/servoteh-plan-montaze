/**
 * Work Hours CRUD — Supabase REST.
 *
 * Podržava nove kolone iz add_attendance_grid + add_work_extras migracija:
 *  - field_hours      (broj sati na terenu)
 *  - field_subtype    ('domestic' | 'foreign' | null)
 *  - two_machine_hours (rad na dve mašine — dodatno plaćeno)
 *  - absence_code     (go|bo|sp|np|sl|pr — overrides numeric inputs)
 *
 * Backward compatible: ako payload polje nije definisano, preskače se.
 * Mesečni grid (UI u Fazi 4) batch-uje upserte preko `saveWorkHourToDb`.
 */

import { sbReq } from './supabase.js';
import { canEdit, getIsOnline } from '../state/auth.js';

export function mapDbWorkHour(d) {
  return {
    id: d.id,
    employeeId: d.employee_id,
    workDate: d.work_date || '',
    hours: Number(d.hours || 0),
    overtimeHours: Number(d.overtime_hours || 0),
    fieldHours: Number(d.field_hours || 0),
    fieldSubtype: (d.field_subtype === 'domestic' || d.field_subtype === 'foreign') ? d.field_subtype : null,
    twoMachineHours: Number(d.two_machine_hours || 0),
    absenceCode: d.absence_code || null,
    projectRef: d.project_ref || '',
    note: d.note || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function buildWorkHourPayload(w) {
  const p = {
    employee_id: w.employeeId,
    work_date: w.workDate,
    hours: Number(w.hours || 0),
    overtime_hours: Number(w.overtimeHours || 0),
    project_ref: w.projectRef || '',
    note: w.note || '',
    updated_at: new Date().toISOString(),
  };
  /* Nove kolone uključuj samo ako je polje DEFINISANO na ulazu — to čuva
     backward compat sa starim modalom (Sati pojedinačno) pre migracija. */
  if (w.fieldHours !== undefined) p.field_hours = Number(w.fieldHours || 0);
  if (w.absenceCode !== undefined) p.absence_code = w.absenceCode || null;
  if (w.fieldSubtype !== undefined) {
    p.field_subtype = (w.fieldSubtype === 'domestic' || w.fieldSubtype === 'foreign') ? w.fieldSubtype : null;
  }
  if (w.twoMachineHours !== undefined) p.two_machine_hours = Number(w.twoMachineHours || 0);
  if (w.id) p.id = w.id;
  return p;
}

export async function loadWorkHoursFromDb() {
  if (!getIsOnline()) return null;
  const data = await sbReq('work_hours?select=*&order=work_date.desc');
  if (!data) return null;
  return data.map(mapDbWorkHour);
}

export async function saveWorkHourToDb(w) {
  if (!getIsOnline() || !canEdit()) return null;
  const res = await sbReq('work_hours', 'POST', buildWorkHourPayload(w));
  if (res === null) console.warn('[kadrovska] work_hours save failed — run sql/migrations/add_kadrovska_phase1.sql');
  return res;
}

export async function updateWorkHourInDb(w) {
  if (!getIsOnline() || !canEdit() || !w.id) return null;
  const { id, ...rest } = buildWorkHourPayload(w);
  return await sbReq(`work_hours?id=eq.${encodeURIComponent(w.id)}`, 'PATCH', rest);
}

export async function deleteWorkHourFromDb(id) {
  if (!getIsOnline() || !canEdit() || !id) return false;
  return (await sbReq(`work_hours?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}
