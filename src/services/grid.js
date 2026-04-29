/**
 * Mesečni grid (Excel-like) — Supabase load + batch upsert.
 *
 * Nije CRUD per row kao ostali tabovi — radi se o batch upsertu cele "dirty"
 * mape u jednom POST-u sa Prefer: resolution=merge-duplicates (već default u
 * sbReq POST). Treba da bude UNIQUE(employee_id, work_date) konstreint na
 * tabeli (vidi sql/migrations/add_attendance_grid.sql).
 */

import { sbReq } from './supabase.js';
import { mapDbWorkHour } from './workHours.js';

/**
 * Učitaj sve work_hours redove za dati mesec.
 * @param {string} yyyymm  npr "2026-04"
 * @param {Array<{ymd:string}>} days  iz _gridDaysInMonth
 * @returns {Promise<Map<string, Map<string, object>>>} Map<empId, Map<ymd, mappedRow>>
 */
export async function loadGridMonth(days) {
  const out = new Map();
  if (!days || !days.length) return out;
  const from = days[0].ymd;
  const to = days[days.length - 1].ymd;
  const data = await sbReq(`work_hours?work_date=gte.${from}&work_date=lte.${to}&select=*`);
  if (!Array.isArray(data)) return out;
  data.forEach(r => {
    const m = mapDbWorkHour(r);
    if (!m.employeeId || !m.workDate) return;
    if (!out.has(m.employeeId)) out.set(m.employeeId, new Map());
    out.get(m.employeeId).set(m.workDate, m);
  });
  return out;
}

/**
 * Batch upsert dirty mape. Vraća array novih mapped redova ili null pri grešci.
 * @param {Map<string, object>} dirty  Map<'empId|ymd', { hours, overtime_hours, ...}>
 * @returns {Promise<object[]|null>}
 */
export async function batchUpsertGrid(dirty) {
  if (!dirty || dirty.size === 0) return [];
  const nowIso = new Date().toISOString();
  const payload = [];
  dirty.forEach((d, key) => {
    const [empId, ymd] = key.split('|');
    const fH = Number(d.field_hours || 0);
    const tmH = Number(d.two_machine_hours || 0);
    payload.push({
      employee_id: empId,
      work_date: ymd,
      hours: Number(d.hours || 0),
      overtime_hours: Number(d.overtime_hours || 0),
      field_hours: fH,
      field_subtype: fH > 0 ? (d.field_subtype === 'foreign' ? 'foreign' : 'domestic') : null,
      two_machine_hours: tmH,
      absence_code: d.absence_code || null,
      absence_subtype: d.absence_subtype || null,
      updated_at: nowIso,
    });
  });
  const res = await sbReq('work_hours?on_conflict=employee_id,work_date', 'POST', payload);
  if (!res) return null;
  return Array.isArray(res) ? res.map(r => mapDbWorkHour(r)) : [];
}
