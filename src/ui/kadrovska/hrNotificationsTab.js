/**
 * Kadrovska — TAB „Notifikacije" (Faza K4, HR/admin).
 *
 * Tri panela:
 *   - ⏳ U redu (queued)
 *   - ✅ Poslate (sent)
 *   - ❌ Neuspele (failed) + canceled
 *
 * Akcije:
 *   - Ručno „🔔 Skeniraj sada" → poziva RPC `kadr_trigger_schedule_hr_reminders`.
 *   - Po redu: Otkaži / Retry / Obriši.
 *   - Gumb ⚙️ — otvara settings modal (prag dana, WhatsApp brojevi, email lista,
 *     toggle birthday/anniversary).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import { isHrOrAdmin, getIsOnline } from '../../state/auth.js';
import { hasSupabaseConfig } from '../../lib/constants.js';
import {
  loadHrNotifConfig,
  updateHrNotifConfig,
  loadHrNotifLog,
  cancelHrNotif,
  retryHrNotif,
  deleteHrNotif,
  triggerScheduleHrReminders,
} from '../../services/hrNotifications.js';

let panelRoot = null;
let currentFilter = 'queued';
let cachedRows = [];
let cachedConfig = null;

const TYPE_LABELS = {
  medical_expiring: 'Lekarski ističe',
  contract_expiring: 'Ugovor ističe',
  birthday: 'Rođendan',
  work_anniversary: 'Godišnjica rada',
};
const STATUS_LABELS = {
  queued: '⏳ U redu',
  sent: '✅ Poslato',
  failed: '❌ Neuspelo',
  canceled: '🚫 Otkazano',
};
const CHANNEL_ICON = {
  whatsapp: '💬', email: '✉', sms: '📱',
};

/* ── RENDER ──────────────────────────────────────────────────────── */

export function renderHrNotificationsTab() {
  if (!isHrOrAdmin()) {
    return `
      <section class="kadr-panel-inner" aria-label="Notifikacije">
        <div class="kadr-empty" style="margin:40px 24px">
          <div class="kadrovska-empty-title">🔒 Pristup zabranjen</div>
          <div>Notifikacijama pristupa isključivo HR ili administrator.</div>
        </div>
      </section>`;
  }
  return `
    <div class="kadr-summary-strip" id="hrnSummary"></div>
    <div class="kadrovska-toolbar">
      <select class="kadrovska-filter" id="hrnFilter">
        <option value="queued" selected>⏳ U redu</option>
        <option value="sent">✅ Poslate</option>
        <option value="failed">❌ Neuspele</option>
        <option value="canceled">🚫 Otkazane</option>
        <option value="all">Sve</option>
      </select>
      <input type="text" class="kadrovska-search" id="hrnSearch" placeholder="Pretraga po primaocu / naslovu…">
      <div class="kadrovska-toolbar-spacer"></div>
      <button class="btn btn-ghost" id="hrnSettingsBtn">⚙️ Podešavanja</button>
      <button class="btn btn-primary" id="hrnScanBtn">🔔 Skeniraj sada</button>
    </div>
    <main class="kadrovska-main">
      <table class="kadrovska-table">
        <thead>
          <tr>
            <th>Zakazano</th>
            <th>Tip</th>
            <th class="col-hide-sm">Kanal</th>
            <th>Primalac</th>
            <th>Poruka</th>
            <th class="col-hide-sm">Pokušaji</th>
            <th>Status</th>
            <th class="col-actions">Akcije</th>
          </tr>
        </thead>
        <tbody id="hrnTbody"></tbody>
      </table>
      <div class="kadrovska-empty" id="hrnEmpty" style="display:none;margin-top:16px;">
        <div class="kadrovska-empty-title">Nema zapisa</div>
        <div>Klikni <strong>🔔 Skeniraj sada</strong> da generišeš predstojeća upozorenja.</div>
      </div>
    </main>`;
}

export async function wireHrNotificationsTab(panelEl) {
  panelRoot = panelEl;
  if (!isHrOrAdmin()) return;

  panelEl.querySelector('#hrnFilter').addEventListener('change', (e) => {
    currentFilter = e.target.value;
    reload();
  });
  panelEl.querySelector('#hrnSearch').addEventListener('input', () => applyFilter());
  panelEl.querySelector('#hrnScanBtn').addEventListener('click', runScan);
  panelEl.querySelector('#hrnSettingsBtn').addEventListener('click', openSettingsModal);

  if (!getIsOnline() || !hasSupabaseConfig()) {
    panelEl.querySelector('#hrnTbody').innerHTML =
      '<tr><td colspan="8" class="emp-sub" style="padding:20px;text-align:center">Online konekcija je obavezna.</td></tr>';
    return;
  }
  await reload();
}

async function reload() {
  if (!panelRoot) return;
  const rows = await loadHrNotifLog({ status: currentFilter, limit: 300 });
  if (rows === null) {
    panelRoot.querySelector('#hrnTbody').innerHTML =
      '<tr><td colspan="8" class="emp-sub" style="padding:20px;text-align:center">⚠ Migracija `add_kadr_notifications.sql` nije primenjena.</td></tr>';
    return;
  }
  cachedRows = rows;
  applyFilter();
}

function applyFilter() {
  if (!panelRoot) return;
  const q = (panelRoot.querySelector('#hrnSearch').value || '').trim().toLowerCase();
  const list = q
    ? cachedRows.filter(r => {
        const hay = [r.recipient, r.subject, r.body, TYPE_LABELS[r.notificationType] || r.notificationType]
          .join(' ').toLowerCase();
        return hay.includes(q);
      })
    : cachedRows;

  const tbody = panelRoot.querySelector('#hrnTbody');
  const empty = panelRoot.querySelector('#hrnEmpty');

  /* Summary */
  const counts = { queued: 0, sent: 0, failed: 0, canceled: 0 };
  cachedRows.forEach(r => { if (counts[r.status] != null) counts[r.status]++; });
  renderSummary(counts);

  if (!list.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = list.map(r => {
    const when = r.scheduledAt ? fmtDateTime(r.scheduledAt) : '—';
    const typeLabel = TYPE_LABELS[r.notificationType] || r.notificationType;
    const chIcon = CHANNEL_ICON[r.channel] || '•';
    const msg = escHtml((r.subject || r.body || '').slice(0, 80));
    const statusHtml = statusBadge(r.status);
    const errHtml = r.status === 'failed' && r.error
      ? `<div class="hrn-err" title="${escHtml(r.error)}">❗ ${escHtml(r.error.slice(0, 60))}${r.error.length > 60 ? '…' : ''}</div>`
      : '';
    return `<tr data-id="${escHtml(r.id)}">
      <td>${escHtml(when)}</td>
      <td><span class="kadr-type-badge t-hrn-${escHtml(r.notificationType.replace(/_/g, '-'))}">${escHtml(typeLabel)}</span></td>
      <td class="col-hide-sm">${chIcon} ${escHtml(r.channel)}</td>
      <td>${escHtml(r.recipient)}</td>
      <td>${msg}${errHtml}</td>
      <td class="col-hide-sm">${escHtml(String(r.attempts))}</td>
      <td>${statusHtml}</td>
      <td class="col-actions">
        ${r.status === 'failed' ? `<button class="btn-row-act" data-act="retry" data-id="${escHtml(r.id)}">♻ Retry</button>` : ''}
        ${(r.status === 'queued' || r.status === 'failed') ? `<button class="btn-row-act" data-act="cancel" data-id="${escHtml(r.id)}">Otkaži</button>` : ''}
        <button class="btn-row-act danger" data-act="del" data-id="${escHtml(r.id)}">Obriši</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'retry') {
        const ok = await retryHrNotif(id);
        showToast(ok ? '♻ Vraćeno u queue' : '⚠ Neuspeh');
      } else if (act === 'cancel') {
        if (!confirm('Otkazati ovo upozorenje?')) return;
        const ok = await cancelHrNotif(id);
        showToast(ok ? '🚫 Otkazano' : '⚠ Neuspeh');
      } else if (act === 'del') {
        if (!confirm('Obrisati zapis? Akcija je trajna.')) return;
        const ok = await deleteHrNotif(id);
        showToast(ok ? '🗑 Obrisano' : '⚠ Neuspeh');
      }
      await reload();
    });
  });
}

function statusBadge(status) {
  const cls = {
    queued: 't-hrn-q', sent: 't-hrn-sent', failed: 't-hrn-failed', canceled: 't-hrn-cx',
  }[status] || 't-ostalo';
  return `<span class="kadr-type-badge ${cls}">${escHtml(STATUS_LABELS[status] || status)}</span>`;
}

function renderSummary(counts) {
  const box = panelRoot?.querySelector('#hrnSummary');
  if (!box) return;
  box.innerHTML = `
    <div class="kadr-chip"><span class="kadr-chip-label">⏳ U redu</span><span class="kadr-chip-value">${counts.queued}</span></div>
    <div class="kadr-chip"><span class="kadr-chip-label">✅ Poslate</span><span class="kadr-chip-value">${counts.sent}</span></div>
    <div class="kadr-chip ${counts.failed ? 'kadr-chip-warn' : ''}"><span class="kadr-chip-label">❌ Neuspele</span><span class="kadr-chip-value">${counts.failed}</span></div>
    <div class="kadr-chip"><span class="kadr-chip-label">🚫 Otkazane</span><span class="kadr-chip-value">${counts.canceled}</span></div>
  `;
}

function fmtDateTime(iso) {
  try {
    const d = new Date(iso);
    return `${formatDate(iso)} ${d.toLocaleTimeString('sr-RS', { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return iso; }
}

/* ── SCAN ──────────────────────────────────────────────────────── */

async function runScan() {
  const btn = panelRoot.querySelector('#hrnScanBtn');
  btn.disabled = true; btn.textContent = 'Skeniranje…';
  try {
    const r = await triggerScheduleHrReminders();
    if (!r) {
      showToast('⚠ Skeniranje nije uspelo (migracija ili RLS?)');
      return;
    }
    if (r.configMissing) {
      showToast('ℹ Konfiguracija nedostaje — otvori ⚙️ Podešavanja');
    } else {
      showToast(`🔔 Zakazano ${r.scheduledCount} novih upozorenja`);
    }
    await reload();
  } finally {
    btn.disabled = false; btn.textContent = '🔔 Skeniraj sada';
  }
}

/* ── SETTINGS MODAL ────────────────────────────────────────────── */

async function openSettingsModal() {
  if (!isHrOrAdmin()) return;
  closeModal();
  if (!cachedConfig) {
    cachedConfig = await loadHrNotifConfig();
  }
  const cfg = cachedConfig || {
    enabled: true, medicalLeadDays: 30, contractLeadDays: 30,
    birthdayEnabled: false, workAnniversaryEnabled: false,
    whatsappRecipients: [], emailRecipients: [],
  };

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="emp-modal-overlay" id="hrnModal" role="dialog" aria-modal="true">
      <div class="emp-modal">
        <div class="emp-modal-title">⚙️ Podešavanja notifikacija</div>
        <div class="emp-modal-subtitle">HR upozorenja se skeniraju jednom dnevno (07:00). Ovde biraš pragove i primaoce.</div>
        <div class="emp-modal-err" id="hrnErr"></div>
        <form id="hrnForm">
          <div class="emp-form-grid">
            <div class="emp-field col-full">
              <label><input type="checkbox" id="cfgEnabled" ${cfg.enabled ? 'checked' : ''}> Notifikacije uključene (master switch)</label>
            </div>
            <div class="emp-field">
              <label for="cfgMed">Lekarski — koliko dana pre?</label>
              <input type="number" id="cfgMed" min="1" max="180" value="${cfg.medicalLeadDays}">
            </div>
            <div class="emp-field">
              <label for="cfgCon">Ugovor — koliko dana pre?</label>
              <input type="number" id="cfgCon" min="1" max="365" value="${cfg.contractLeadDays}">
            </div>
            <div class="emp-field col-full">
              <label><input type="checkbox" id="cfgBday" ${cfg.birthdayEnabled ? 'checked' : ''}> Šalji poruke za rođendane</label>
            </div>
            <div class="emp-field col-full">
              <label><input type="checkbox" id="cfgAnn" ${cfg.workAnniversaryEnabled ? 'checked' : ''}> Šalji poruke za godišnjice rada</label>
            </div>
            <div class="emp-field col-full">
              <label for="cfgWa">WhatsApp primaoci (brojevi u E.164, npr. 381601234567 — jedan po redu)</label>
              <textarea id="cfgWa" rows="3" placeholder="381601234567&#10;381609876543">${escHtml(cfg.whatsappRecipients.join('\n'))}</textarea>
            </div>
            <div class="emp-field col-full">
              <label for="cfgEm">Email primaoci (jedan po redu)</label>
              <textarea id="cfgEm" rows="3" placeholder="hr@firma.rs&#10;direktor@firma.rs">${escHtml(cfg.emailRecipients.join('\n'))}</textarea>
            </div>
          </div>
          <div class="hrn-hint">
            💡 Da bi WhatsApp slanje radilo, u Supabase → Edge Functions → <code>hr-notify-dispatch</code> postavi secrets
            <code>WA_ACCESS_TOKEN</code>, <code>WA_PHONE_NUMBER_ID</code> i <code>WA_TEMPLATE_NAME</code>. Bez njih, poruke idu u DRY-RUN log.
          </div>
          <div class="emp-modal-actions">
            <button type="button" class="btn" id="hrnCancel">Otkaži</button>
            <button type="submit" class="btn btn-primary" id="hrnSubmit">Sačuvaj</button>
          </div>
        </form>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const m = document.getElementById('hrnModal');
  m.querySelector('#hrnCancel').addEventListener('click', closeModal);
  m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
  m.querySelector('#hrnForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitConfig();
  });
}

function closeModal() {
  document.getElementById('hrnModal')?.remove();
}

async function submitConfig() {
  const err = document.getElementById('hrnErr');
  err.textContent = ''; err.classList.remove('visible');
  const cfg = {
    enabled: document.getElementById('cfgEnabled').checked,
    medicalLeadDays: parseInt(document.getElementById('cfgMed').value, 10) || 30,
    contractLeadDays: parseInt(document.getElementById('cfgCon').value, 10) || 30,
    birthdayEnabled: document.getElementById('cfgBday').checked,
    workAnniversaryEnabled: document.getElementById('cfgAnn').checked,
    whatsappRecipients: splitLines(document.getElementById('cfgWa').value)
      .filter(s => /^\+?\d{6,20}$/.test(s.replace(/\s+/g, ''))),
    emailRecipients: splitLines(document.getElementById('cfgEm').value)
      .filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)),
  };

  if (cfg.medicalLeadDays < 1 || cfg.contractLeadDays < 1) {
    err.textContent = 'Pragovi dana moraju biti ≥ 1.';
    err.classList.add('visible');
    return;
  }

  const btn = document.getElementById('hrnSubmit');
  btn.disabled = true; btn.textContent = 'Čuvanje…';
  try {
    const saved = await updateHrNotifConfig(cfg);
    if (!saved) {
      err.textContent = 'Čuvanje nije uspelo. Da li je migracija primenjena i imaš HR/admin prava?';
      err.classList.add('visible');
      return;
    }
    cachedConfig = saved;
    closeModal();
    showToast('💾 Podešavanja sačuvana');
  } finally {
    btn.disabled = false; btn.textContent = 'Sačuvaj';
  }
}

function splitLines(s) {
  return String(s || '').split(/[\r\n,;]+/).map(x => x.trim()).filter(Boolean);
}
