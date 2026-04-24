/**
 * Holidays service — kadr_holidays (državni praznici RS).
 *
 * SELECT je dostupan svim authenticated korisnicima (RLS).
 * INSERT/UPDATE/DELETE radi samo admin (server-side enforcement).
 *
 * Cache:
 *   `kadrHolidaysState.byDate` — Map<'YYYY-MM-DD', holidayRow>
 *   `kadrHolidaysState.loadedYears` — Set<number>
 *
 * `loadHolidaysForRange(from, to)` lazy-učitava godine koje još nisu
 * u cache-u. Dovoljno granularno za svaki view koji nas interesuje
 * (mesečni grid, mesečni obračun).
 */

import { sbReq } from './supabase.js';
import { getIsOnline } from '../state/auth.js';
import { kadrHolidaysState } from '../state/kadrovska.js';

export function mapDbHoliday(d) {
  return {
    id: d.id,
    holidayDate: d.holiday_date || '',
    name: d.name || '',
    isWorkday: !!d.is_workday,
    note: d.note || '',
    createdAt: d.created_at || null,
    updatedAt: d.updated_at || null,
  };
}

export function buildHolidayPayload(h) {
  const p = {
    holiday_date: h.holidayDate,
    name: h.name || '',
    is_workday: !!h.isWorkday,
    note: h.note || '',
    updated_at: new Date().toISOString(),
  };
  if (h.id) p.id = h.id;
  return p;
}

/**
 * Lazy load svih praznika za godine koje pokrivaju [from, to].
 * @param {string} from  'YYYY-MM-DD'
 * @param {string} to    'YYYY-MM-DD'
 */
export async function loadHolidaysForRange(from, to) {
  if (!from || !to) return;
  const yearFrom = parseInt(from.slice(0, 4), 10);
  const yearTo   = parseInt(to.slice(0, 4), 10);
  const need = [];
  for (let y = yearFrom; y <= yearTo; y++) {
    if (!kadrHolidaysState.loadedYears.has(y)) need.push(y);
  }
  if (need.length === 0) return;
  if (!getIsOnline()) {
    /* offline — nema šta da uradimo, FE će raditi bez praznika (warn već stoji) */
    need.forEach(y => kadrHolidaysState.loadedYears.add(y));
    return;
  }

  const minStart = `${need[0]}-01-01`;
  const maxEnd   = `${need[need.length - 1]}-12-31`;
  const data = await sbReq(
    `kadr_holidays?holiday_date=gte.${minStart}&holiday_date=lte.${maxEnd}`
    + '&select=*&order=holiday_date.asc'
  );
  if (Array.isArray(data)) {
    data.forEach(d => {
      const m = mapDbHoliday(d);
      if (m.holidayDate) kadrHolidaysState.byDate.set(m.holidayDate, m);
    });
  }
  need.forEach(y => kadrHolidaysState.loadedYears.add(y));
}

/** Sinhroni helper — vraća true ako ymd jeste praznik (po cache-u). */
export function isHolidayDate(ymd) {
  if (!ymd) return false;
  const h = kadrHolidaysState.byDate.get(ymd);
  return !!h && !h.isWorkday;
}

/** Vraća listu praznika u zadanom mesecu (iz cache-a). */
export function holidaysInMonth(year, month) {
  const out = [];
  const m = String(month).padStart(2, '0');
  const prefix = `${year}-${m}-`;
  kadrHolidaysState.byDate.forEach((h, ymd) => {
    if (ymd.startsWith(prefix) && !h.isWorkday) out.push(h);
  });
  out.sort((a, b) => a.holidayDate.localeCompare(b.holidayDate));
  return out;
}

/** Set svih ymd-ova koji su praznici (za payrollCalc.computeMonthlyFond). */
export function holidayDateSet() {
  const s = new Set();
  kadrHolidaysState.byDate.forEach((h, ymd) => {
    if (!h.isWorkday) s.add(ymd);
  });
  return s;
}

/* ── Admin CRUD ─────────────────────────────────────────────────── */

export async function loadAllHolidaysFromDb() {
  if (!getIsOnline()) return null;
  const data = await sbReq('kadr_holidays?select=*&order=holiday_date.asc');
  if (!data) return null;
  return data.map(mapDbHoliday);
}

export async function saveHolidayToDb(h) {
  if (!getIsOnline()) return null;
  const res = await sbReq('kadr_holidays', 'POST', buildHolidayPayload(h));
  if (res === null) {
    console.warn('[kadrovska] holidays save failed — run sql/migrations/add_kadr_holidays.sql');
  }
  return res;
}

export async function updateHolidayInDb(h) {
  if (!getIsOnline() || !h.id) return null;
  const { id, ...rest } = buildHolidayPayload(h);
  return await sbReq(`kadr_holidays?id=eq.${encodeURIComponent(h.id)}`, 'PATCH', rest);
}

export async function deleteHolidayFromDb(id) {
  if (!getIsOnline() || !id) return false;
  return (await sbReq(`kadr_holidays?id=eq.${encodeURIComponent(id)}`, 'DELETE')) !== null;
}
