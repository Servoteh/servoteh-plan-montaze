/**
 * Gantt helpers — pure funkcije, bit-paritet sa legacy/index.html.
 */

import { MONTHS_SR } from './constants.js';
import { parseDateLocal, today } from './date.js';

/** Inkluzivan niz Date instanci od startDate do endDate. */
export function buildDayRange(startDate, endDate) {
  const days = [];
  const cur = new Date(startDate);
  cur.setHours(0, 0, 0, 0);
  const lim = new Date(endDate);
  lim.setHours(0, 0, 0, 0);
  while (cur <= lim) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/** Mesečni header: { 'YYYY-M': { label, count } } */
export function buildMonthsHeader(days) {
  const months = {};
  days.forEach(d => {
    const k = d.getFullYear() + '-' + d.getMonth();
    if (!months[k]) months[k] = { label: MONTHS_SR[d.getMonth()] + ' ' + d.getFullYear(), count: 0 };
    months[k].count++;
  });
  return months;
}

/**
 * Računa raspon datuma za prikaz: [today − 3 dana, today + 60 dana ili max(end)+5].
 * Prima niz faza (ili WP-ova ili rows{phase}) i extractor za start/end ISO.
 */
export function inferGanttBounds(rows, getStart, getEnd) {
  let min = new Date(today);
  let max = new Date(today);
  max.setDate(max.getDate() + 60);
  rows.forEach(r => {
    const ds = parseDateLocal(getStart(r));
    const de = parseDateLocal(getEnd(r));
    if (ds && ds < min) min = ds;
    if (de && de > max) max = de;
  });
  min.setDate(min.getDate() - 3);
  max.setDate(max.getDate() + 5);
  return { min, max };
}
