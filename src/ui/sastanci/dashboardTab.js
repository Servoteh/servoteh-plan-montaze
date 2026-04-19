/**
 * Dashboard tab — startna stranica modula Sastanci.
 *
 * Sadrži:
 *   - 5 stat kartica (planirani, u toku, akcije otvorene, akcije kasne, PM teme)
 *   - "Nadolazeći sastanci" lista (sledećih 14 dana)
 *   - "Akcije koje kasne" lista (top 5)
 *   - "PM teme čekaju odobrenje" lista (top 5)
 *
 * Kartice imaju click handler koji skače na odgovarajući tab.
 */

import { escHtml } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import { loadDashboardStats, loadSastanci } from '../../services/sastanci.js';
import { loadAkcije, AKCIJA_STATUS_BOJE } from '../../services/akcioniPlan.js';
import { loadPmTeme, TEMA_STATUS_BOJE } from '../../services/pmTeme.js';

let abortFlag = false;

export async function renderDashboardTab(host, { canEdit, onJumpToTab }) {
  abortFlag = false;
  host.innerHTML = `
    <div class="sast-dashboard">
      <div class="sast-stats" id="sastStats">
        <div class="sast-loading">Učitavam statistike…</div>
      </div>

      <div class="sast-dash-grid">
        <section class="sast-dash-card" id="sastUpcomingCard">
          <header><h3>📅 Nadolazeći sastanci</h3><a href="#" data-jump="sastanci" class="sast-link">Svi →</a></header>
          <div class="sast-dash-body" id="sastUpcoming">Učitavam…</div>
        </section>

        <section class="sast-dash-card" id="sastLateCard">
          <header><h3>⚠ Akcije koje kasne</h3><a href="#" data-jump="akcioni-plan" class="sast-link">Sve →</a></header>
          <div class="sast-dash-body" id="sastLate">Učitavam…</div>
        </section>

        <section class="sast-dash-card" id="sastTopicsCard">
          <header><h3>💡 PM teme — na čekanju</h3><a href="#" data-jump="pm-teme" class="sast-link">Sve →</a></header>
          <div class="sast-dash-body" id="sastTopics">Učitavam…</div>
        </section>
      </div>
    </div>
  `;

  /* Wire jump linkove. */
  host.querySelectorAll('[data-jump]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      onJumpToTab?.(a.dataset.jump);
    });
  });

  /* Učitaj sve paralelno. */
  const today = new Date().toISOString().slice(0, 10);
  const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

  const [stats, upcoming, late, topics] = await Promise.all([
    loadDashboardStats(),
    loadSastanci({ status: 'planiran', fromDate: today, toDate: in14, limit: 10 }),
    loadAkcije({ effectiveStatus: 'kasni', limit: 8 }),
    loadPmTeme({ status: 'predlog', limit: 8 }),
  ]);

  if (abortFlag) return;

  renderStats(host.querySelector('#sastStats'), stats, onJumpToTab);
  renderUpcoming(host.querySelector('#sastUpcoming'), upcoming);
  renderLate(host.querySelector('#sastLate'), late);
  renderTopics(host.querySelector('#sastTopics'), topics);
}

export function teardownDashboardTab() {
  abortFlag = true;
}

function renderStats(host, stats, onJumpToTab) {
  if (!stats) {
    host.innerHTML = '<div class="sast-empty">Nije moguće učitati statistike.</div>';
    return;
  }
  const cards = [
    { id: 'sastanci', icon: '📅', value: stats.sastancUpcoming, label: 'Sastanaka u 14 dana', color: '#3b82f6' },
    { id: 'sastanci', icon: '🔴', value: stats.sastancUToku, label: 'U toku', color: '#10b981' },
    { id: 'akcioni-plan', icon: '✅', value: stats.akcijeOtvoreno, label: 'Otvorenih akcija', color: '#f59e0b' },
    { id: 'akcioni-plan', icon: '⚠', value: stats.akcijeKasni, label: 'Kasne', color: '#ef4444' },
    { id: 'pm-teme', icon: '💡', value: stats.pmTemeNaCekanju, label: 'PM teme na čekanju', color: '#a855f7' },
  ];
  host.innerHTML = cards.map(c => `
    <button type="button" class="sast-stat-card" data-jump="${c.id}" style="--accent:${c.color}">
      <div class="sast-stat-icon">${c.icon}</div>
      <div class="sast-stat-value">${c.value}</div>
      <div class="sast-stat-label">${escHtml(c.label)}</div>
    </button>
  `).join('');
  host.querySelectorAll('[data-jump]').forEach(b => {
    b.addEventListener('click', () => onJumpToTab?.(b.dataset.jump));
  });
}

function renderUpcoming(host, sastanci) {
  if (!sastanci || !sastanci.length) {
    host.innerHTML = '<div class="sast-empty">Nema zakazanih sastanaka u sledećih 14 dana.</div>';
    return;
  }
  host.innerHTML = `
    <ul class="sast-list">
      ${sastanci.map(s => `
        <li class="sast-list-item">
          <div class="sast-list-date">
            <div class="sast-list-day">${formatDate(s.datum)}</div>
            ${s.vreme ? `<div class="sast-list-time">${escHtml(s.vreme.slice(0, 5))}</div>` : ''}
          </div>
          <div class="sast-list-main">
            <div class="sast-list-title">
              <span class="sast-tip-badge sast-tip-${escHtml(s.tip)}">${s.tip === 'projektni' ? 'Projektni' : 'Sedmični'}</span>
              ${escHtml(s.naslov)}
            </div>
            <div class="sast-list-meta">${s.vodioLabel ? '👤 ' + escHtml(s.vodioLabel) : ''} ${s.mesto ? ' · 📍 ' + escHtml(s.mesto) : ''}</div>
          </div>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderLate(host, akcije) {
  if (!akcije || !akcije.length) {
    host.innerHTML = '<div class="sast-empty">🎉 Nema akcija koje kasne.</div>';
    return;
  }
  host.innerHTML = `
    <ul class="sast-list">
      ${akcije.map(a => `
        <li class="sast-list-item">
          <div class="sast-list-status" style="background:${AKCIJA_STATUS_BOJE.kasni}">⚠</div>
          <div class="sast-list-main">
            <div class="sast-list-title">${escHtml(a.naslov)}</div>
            <div class="sast-list-meta">
              ${a.odgovoranLabel || a.odgovoranText || a.odgovoranEmail ? '👤 ' + escHtml(a.odgovoranLabel || a.odgovoranText || a.odgovoranEmail) : ''}
              ${a.rok ? ' · 📅 Rok: ' + escHtml(formatDate(a.rok)) + (a.danaDoRoka != null ? ` (${a.danaDoRoka < 0 ? 'kasni ' + Math.abs(a.danaDoRoka) + 'd' : ''})` : '') : ''}
            </div>
          </div>
        </li>
      `).join('')}
    </ul>
  `;
}

function renderTopics(host, teme) {
  if (!teme || !teme.length) {
    host.innerHTML = '<div class="sast-empty">Nema tema na čekanju.</div>';
    return;
  }
  host.innerHTML = `
    <ul class="sast-list">
      ${teme.map(t => `
        <li class="sast-list-item">
          <div class="sast-list-status" style="background:${TEMA_STATUS_BOJE[t.status] || '#666'}">${t.prioritet === 1 ? '!' : ''}</div>
          <div class="sast-list-main">
            <div class="sast-list-title">${escHtml(t.naslov)}</div>
            <div class="sast-list-meta">${escHtml(t.predlozioLabel || t.predlozioEmail || '—')} · ${escHtml(t.oblast)}</div>
          </div>
        </li>
      `).join('')}
    </ul>
  `;
}
