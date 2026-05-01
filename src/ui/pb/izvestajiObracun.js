/**
 * Čisti helpers za obračun izveštaja (Vitest + Izveštaji tab).
 */

/**
 * @param {object[]} reports
 * @param {string} dateFrom YYYY-MM-DD
 * @param {string} dateTo YYYY-MM-DD
 * @param {string|null|undefined} employeeId
 */
export function filterWorkReportsByPeriod(reports, dateFrom, dateTo, employeeId) {
  const df = dateFrom ? String(dateFrom).slice(0, 10) : '';
  const dt = dateTo ? String(dateTo).slice(0, 10) : '';
  let list = Array.isArray(reports) ? reports.slice() : [];
  if (df) list = list.filter(r => String(r.datum || '').slice(0, 10) >= df);
  if (dt) list = list.filter(r => String(r.datum || '').slice(0, 10) <= dt);
  if (employeeId && employeeId !== 'all') {
    list = list.filter(r => r.employee_id === employeeId);
  }
  return list;
}

/** @param {object[]} reports */
export function sumHours(reports) {
  const s = (Array.isArray(reports) ? reports : []).reduce(
    (acc, r) => acc + (Number(r.sati) || 0),
    0,
  );
  return Math.round(s * 10) / 10;
}

/**
 * @param {object[]} reports
 * @returns {Record<string, { name: string, count: number, hours: number }>}
 */
export function groupByEmployee(reports) {
  const out = {};
  for (const r of Array.isArray(reports) ? reports : []) {
    const id = r.employee_id || 'unknown';
    if (!out[id]) {
      out[id] = {
        name: r.engineer_name || '—',
        count: 0,
        hours: 0,
      };
    }
    out[id].count += 1;
    out[id].hours += Number(r.sati) || 0;
  }
  for (const k of Object.keys(out)) {
    out[k].hours = Math.round(out[k].hours * 10) / 10;
  }
  return out;
}
