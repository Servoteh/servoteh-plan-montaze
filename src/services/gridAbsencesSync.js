/**
 * Posle snimanja mesečnog grida: work_hours (šifre go/bo/sp/…) je izvor istine.
 * Briše odsustva u tom kalendarskom mesecu koja se poklapaju sa tipovima iz grida
 * i ponovo ih gradi iz `rowsByEmpDate` (kontinuirane serije iste šifre).
 */

import { daysInclusive, ymdAddDays } from '../lib/date.js';
import { canEditKadrovska, getIsOnline } from '../state/auth.js';
import { sbReq } from './supabase.js';
import { saveAbsenceToDb } from './absences.js';

/** Šifra u work_hours → absences.type (REST / šema). */
export const GRID_CODE_TO_ABSENCE_TYPE = {
  go: 'godisnji',
  bo: 'bolovanje',
  sp: 'placeno',
  np: 'neplaceno',
  sl: 'slobodan',
  pr: 'ostalo',
};

const GRID_MANAGED_ABSENCE_TYPES = Object.values(GRID_CODE_TO_ABSENCE_TYPE);

export function monthBoundsYmd(yyyymm) {
  const [y, m] = yyyymm.split('-').map(n => parseInt(n, 10));
  if (!y || !m) return { first: '', last: '' };
  const last = new Date(y, m, 0).getDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { first: `${y}-${pad(m)}-01`, last: `${y}-${pad(m)}-${pad(last)}` };
}

/**
 * Nakon merge-a u gridState.rowsByEmpDate: segmenti odsustva za jednog radnika u mesecu.
 * @param {string} empId
 * @param {string} yyyymm
 * @param {Map<string, Map<string, object>>} rowsByEmpDate
 */
export function buildWorkHourAbsenceSegmentsForMonth(empId, yyyymm, rowsByEmpDate) {
  const [y, mo] = yyyymm.split('-').map(n => parseInt(n, 10));
  if (!y || !mo || !empId) return [];
  const lastDay = new Date(y, mo, 0).getDate();
  const empMap = rowsByEmpDate.get(empId);
  const out = [];
  let cur = null;

  for (let d = 1; d <= lastDay; d++) {
    const mm = String(mo).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const ymd = `${y}-${mm}-${dd}`;
    const row = empMap?.get(ymd);
    const codeRaw = row?.absenceCode;
    const code = codeRaw != null && String(codeRaw).trim() !== ''
      ? String(codeRaw).trim().toLowerCase()
      : null;
    const type = code ? GRID_CODE_TO_ABSENCE_TYPE[code] : null;
    const sub = row?.absenceSubtype != null ? String(row.absenceSubtype).trim().toLowerCase() : '';
    const noteExtra = code === 'bo' && sub ? `bolovanje: ${sub}` : (code === 'pr' ? 'prazan dan' : '');

    if (!type) {
      if (cur) {
        out.push(finishSeg(cur));
        cur = null;
      }
      continue;
    }

    const nextDay = cur ? ymdAddDays(cur.to, 1) : null;
    const sameRun = cur
      && cur.type === type
      && (cur.noteExtra || '') === noteExtra
      && nextDay === ymd;

    if (sameRun) {
      cur.to = ymd;
    } else {
      if (cur) out.push(finishSeg(cur));
      cur = { type, from: ymd, to: ymd, noteExtra };
    }
  }
  if (cur) out.push(finishSeg(cur));
  return out;
}

function finishSeg(cur) {
  const note = ['Mesečni grid', cur.noteExtra].filter(Boolean).join(' · ');
  return {
    type: cur.type,
    dateFrom: cur.from,
    dateTo: cur.to,
    daysCount: daysInclusive(cur.from, cur.to),
    note,
  };
}

/**
 * Briše absences redove tipova koje grid upravlja, koji se preklapaju sa [first, last].
 */
export async function deleteGridManagedAbsencesOverlappingMonth(employeeId, yyyymm) {
  if (!getIsOnline() || !canEditKadrovska() || !employeeId || !yyyymm) return false;
  const { first, last } = monthBoundsYmd(yyyymm);
  if (!first || !last) return false;
  const typeIn = GRID_MANAGED_ABSENCE_TYPES.join(',');
  const path = 'absences'
    + `?employee_id=eq.${encodeURIComponent(employeeId)}`
    + `&date_from=lte.${encodeURIComponent(last)}`
    + `&date_to=gte.${encodeURIComponent(first)}`
    + `&type=in.(${typeIn})`;
  const ok = await sbReq(path, 'DELETE');
  return ok !== null;
}

/**
 * Za sve dirnute radnike: obriši grid-tipove u mesecu, upiši segmente iz work_hours.
 */
export async function syncAbsencesFromGridMonth(employeeIds, yyyymm, rowsByEmpDate) {
  const ids = [...new Set(employeeIds)].filter(Boolean);
  if (!ids.length || !yyyymm || !rowsByEmpDate) return { ok: true, errors: [] };
  const errors = [];

  for (const empId of ids) {
    const delOk = await deleteGridManagedAbsencesOverlappingMonth(empId, yyyymm);
    if (!delOk) {
      errors.push({ empId, step: 'delete' });
      continue;
    }
    const segs = buildWorkHourAbsenceSegmentsForMonth(empId, yyyymm, rowsByEmpDate);
    for (const s of segs) {
      const res = await saveAbsenceToDb({
        employeeId: empId,
        type: s.type,
        dateFrom: s.dateFrom,
        dateTo: s.dateTo,
        daysCount: s.daysCount,
        note: s.note,
      });
      if (!res) errors.push({ empId, step: 'insert', segment: s });
    }
  }

  return { ok: errors.length === 0, errors };
}
