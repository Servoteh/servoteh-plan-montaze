/**
 * Plan Montaže — Reminder zone.
 *
 * Skenira sve faze SVIH WP-ova aktivnog projekta. Prikazuje karticu za svaku
 * fazu koja:
 *   - nije završena (status !== 2)
 *   - ima zakazan start_date
 *   - počinje za 0..7 dana od danas
 *   - nije ready (calcReadiness(row).ready === false)
 *
 * Klasifikacija:
 *   - urgentno (≤3 dana): rc-red
 *   - upozorenje (4..7 dana): rc-yellow
 */

import { escHtml } from '../../lib/dom.js';
import { dayDiffFromToday, formatDate } from '../../lib/date.js';
import { calcReadiness } from '../../lib/phase.js';
import { getActiveProject } from '../../state/planMontaze.js';
import { canEdit } from '../../state/auth.js';
import { openReminderDialog } from './reminderModal.js';

/** @returns {string} HTML — niz reminder cards ili prazan div. */
export function reminderZoneHtml() {
  const p = getActiveProject();
  if (!p) return '<div class="reminder-zone" id="reminderZone"></div>';
  const cards = [];
  (p.workPackages || []).forEach(wp => {
    (wp.phases || []).forEach(row => {
      if (row.status === 2 || !row.start) return;
      const d = dayDiffFromToday(row.start);
      if (d === null || d < 0 || d > 7) return;
      const rd = calcReadiness(row);
      if (rd.ready) return;
      const urg = d <= 3;
      cards.push({
        urg,
        title: row.name,
        wpName: wp.name,
        projectCode: p.code,
        start: row.start,
        days: d,
        reasons: rd.reasons,
      });
    });
  });
  if (!cards.length) return '<div class="reminder-zone" id="reminderZone"></div>';
  const sendBtn = canEdit() && p.reminderEnabled
    ? `<button type="button" class="btn btn-primary rz-send-btn" id="rzSendBtn">📧 Pošalji email podsetnike (${cards.length})</button>`
    : '';
  return `
    <div class="reminder-zone" id="reminderZone">
      <div class="reminder-zone-head">
        <span class="rz-title">⚠ Podsetnici (${cards.length})</span>
        ${sendBtn}
      </div>
      <div class="reminder-zone-body">
        ${cards.map(c => `
          <div class="reminder-card ${c.urg ? 'rc-red' : 'rc-yellow'}">
            <div class="rc-title">${c.urg ? '🔴' : '🟡'} ${escHtml(c.title)}</div>
            <div class="rc-sub">${escHtml(c.projectCode)} / ${escHtml(c.wpName)} · ${escHtml(formatDate(c.start))} · Za ${c.days}d</div>
            <div class="rc-sub">${escHtml(c.reasons.slice(0, 3).join(', '))}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/** Wire-uje "Pošalji" dugme u reminder zone. Idempotentan. */
export function wireReminderZone(root) {
  const btn = root?.querySelector('#rzSendBtn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => openReminderDialog());
}
