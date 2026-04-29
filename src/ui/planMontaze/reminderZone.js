/**
 * Plan Montaže — Reminder zone (kompaktna traka).
 *
 * Ista logika filtriranja faza kao ranije; prikaz je jedan red + dismiss (session).
 */

import { escHtml } from '../../lib/dom.js';
import { dayDiffFromToday, formatDate } from '../../lib/date.js';
import { calcReadiness } from '../../lib/phase.js';
import { getActiveProject } from '../../state/planMontaze.js';
import { canEdit } from '../../state/auth.js';
import { openReminderDialog } from './reminderModal.js';

function _dismissStorageKey(projectId) {
  return `pm_rz_dismiss_${projectId}`;
}

/** @returns {string} HTML — kompaktna traka ili prazan div. */
export function reminderZoneHtml() {
  const p = getActiveProject();
  if (!p) return '<div class="reminder-zone" id="reminderZone"></div>';
  try {
    if (sessionStorage.getItem(_dismissStorageKey(p.id)) === '1') {
      return '<div class="reminder-zone reminder-zone--dismissed" id="reminderZone"></div>';
    }
  } catch (_) { /* ignore */ }

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
    ? `<button type="button" class="btn btn-primary rz-send-btn" id="rzSendBtn">📧 Pošalji</button>`
    : '';

  const inline = cards.map(c => {
    const dot = c.urg ? '🔴' : '🟡';
    const line = `${escHtml(c.title)} — Za ${c.days}d`;
    return `<span class="rs-item${c.urg ? ' rs-item--urg' : ' rs-item--warn'}" title="${escHtml(c.projectCode)} / ${escHtml(c.wpName)} · ${escHtml(formatDate(c.start))} · ${escHtml(c.reasons.slice(0, 3).join(', '))}">${dot} ${line}</span>`;
  }).join('<span class="rs-sep" aria-hidden="true">·</span>');

  return `
    <div class="reminder-strip reminder-zone" id="reminderZone" role="region" aria-label="Podsetnici">
      <span class="rs-warn-icon" aria-hidden="true">⚠</span>
      <span class="rs-label">PODSETNICI (${cards.length}):</span>
      <div class="rs-inline">${inline}</div>
      <div class="rs-actions">
        ${sendBtn}
        <button type="button" class="rs-dismiss" id="rzDismissBtn" title="Sakrij traku do sledeće navigacije" aria-label="Zatvori podsetnike">×</button>
      </div>
    </div>
  `;
}

/** Wire-uje dugmad u reminder zoni. */
export function wireReminderZone(root) {
  const send = root?.querySelector('#rzSendBtn');
  if (send && !send.dataset.wired) {
    send.dataset.wired = '1';
    send.addEventListener('click', () => openReminderDialog());
  }
  const dismiss = root?.querySelector('#rzDismissBtn');
  if (dismiss && !dismiss.dataset.wired) {
    dismiss.dataset.wired = '1';
    dismiss.addEventListener('click', () => {
      const p = getActiveProject();
      if (p?.id) {
        try { sessionStorage.setItem(_dismissStorageKey(p.id), '1'); } catch (_) { /* ignore */ }
      }
      const z = root.querySelector('#reminderZone');
      if (z) z.remove();
    });
  }
}
