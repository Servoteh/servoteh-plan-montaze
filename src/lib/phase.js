/**
 * Phase helpers — bit-paritetno sa legacy/index.html.
 *
 *   - calcReadiness(row): {ready, reasons[], done}
 *   - calcRisk(row): {level: 'none'|'low'|'med'|'high', reasons[]}
 *   - applyBusinessRules(row): mutira row da satisfy: status↔pct sync, end>=start
 *   - statusClass(s): 'st-0'..'st-3'
 *   - normalizePhaseType(t): 'mechanical' | 'electrical'
 */

import { CHECK_LABELS, NUM_CHECKS } from './constants.js';
import { calcDuration, dayDiffFromToday, parseDateLocal } from './date.js';

export function statusClass(s) {
  return ['st-0', 'st-1', 'st-2', 'st-3'][s] || 'st-0';
}

export function normalizePhaseType(t) {
  const v = String(t || '').toLowerCase();
  return v === 'electrical' || v === 'elektro' || v === 'e' ? 'electrical' : 'mechanical';
}

/**
 * @returns {{ready: boolean, reasons: string[], done: boolean}}
 */
export function calcReadiness(row) {
  const reasons = [];
  if (row.status === 2) return { ready: false, reasons: ['Završeno'], done: true };
  for (let ci = 0; ci < NUM_CHECKS; ci++) {
    if (!row.checks[ci]) reasons.push(CHECK_LABELS[ci] + ': NE');
  }
  if (!row.person) reasons.push('Nema vođe');
  if (!row.start) reasons.push('Nema datuma početka');
  return { ready: reasons.length === 0, reasons, done: false };
}

/**
 * @returns {{level: 'none'|'low'|'med'|'high', reasons: string[]}}
 */
export function calcRisk(row) {
  const reasons = [];
  const dur = calcDuration(row.start, row.end);
  if (dur === -1) reasons.push('🔴 Kraj pre početka');
  if (row.status === 2 && !row.checks.every(c => c)) reasons.push('🔴 Završeno ali nepotpuno');
  if (row.start && row.status !== 2) {
    const d = dayDiffFromToday(row.start);
    if (d !== null && d >= 0 && d <= 7 && !calcReadiness(row).ready) {
      reasons.push('🟠 Počinje uskoro, nije spremno');
    }
  }
  if (!row.person && row.status !== 2) reasons.push('🟡 Nema vođe');
  if ((!row.start || !row.end) && row.status !== 2) reasons.push('⚪ Nedostaju datumi');
  if (row.status === 3 && !row.blocker?.trim()) reasons.push('🟠 Na čekanju bez blokatora');

  let level = 'none';
  if (reasons.some(r => r.startsWith('🔴'))) level = 'high';
  else if (reasons.some(r => r.startsWith('🟠'))) level = 'med';
  else if (reasons.some(r => r.startsWith('🟡') || r.startsWith('⚪'))) level = 'low';
  return { level, reasons };
}

/**
 * Mutira row tako da poštuje pravila:
 *  - status=2 → pct=100; status=0 → pct=0
 *  - pct>0 i status=0 → status=1
 *  - pct=100 i status≠2 → status=2
 *  - end<start → end=start
 */
export function applyBusinessRules(row) {
  if (row.status === 2) row.pct = 100;
  if (row.status === 0) row.pct = 0;
  if (row.pct > 0 && row.status === 0) row.status = 1;
  if (row.pct === 100 && row.status !== 2) row.status = 2;
  if (row.start && row.end) {
    const _s = parseDateLocal(row.start);
    const _e = parseDateLocal(row.end);
    if (_s && _e && _e < _s) row.end = row.start;
  }
}
