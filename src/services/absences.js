/**
 * Absences CRUD — Supabase REST.
 * Bit-paritet sa legacy/index.html mapDbAbsence + buildAbsencePayload + load/save/update/delete.
 */

import { sbReq } from './supabase.js';
import { canEdit, getIsOnline } from '../state/auth.js';

export function mapDbAbsence(d) {
  return {
    id: d.id,
    employeeId: d.employee_id,
    type: d.type || 'godisnji',
    dateFrom: d.date_from || '',
    dateTo: d.date_to || '',
    daysCount: d.days_count == null ? null : Number(d.days_count),
    note: d.note || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function buildAbsencePayload(a) {
  const p = {
    employee_id: a.employeeId,
    type: a.type || 'godisnji',
    date_from: a.dateFrom,
    date_to: a.dateTo,
    days_count: a.daysCount == null ? null : Number(a.daysCount),
    note: a.note || '',
    updated_at: new Date().toISOString(),
  };
  if (a.id) p.id = a.id;
  return p;
}

export async function loadAbsencesFromDb() {
  if (!getIsOnline()) return null;
  const data = await sbReq('absences?select=*&order=date_from.desc');
  if (!data) return null;
  return data.map(mapDbAbsence);
}

export async function saveAbsenceToDb(a) {
  if (!getIsOnline() || !canEdit()) return null;
  const res = await sbReq('absences', 'POST', buildAbsencePayload(a));
  if (res === null) console.warn('[kadrovska] absences save failed — run sql/migrations/add_kadrovska_phase1.sql');
  return res;
}

export async function updateAbsenceInDb(a) {
  if (!getIsOnline() || !canEdit() || !a.id) return null;
  const { id, ...rest } = buildAbsencePayload(a);
  return await sbReq(`absences?id=eq.${encodeURIComponent(a.id)}`, 'PATCH', rest);
}

export async function deleteAbsenceFromDb(id) {
  if (!getIsOnline() || !canEdit() || !id) return false;
  return (await sbReq(`absences?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}
