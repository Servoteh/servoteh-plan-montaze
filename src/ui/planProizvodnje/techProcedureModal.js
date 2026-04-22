/**
 * Plan Proizvodnje — Tehnološki postupak modal (Sprint F.5b).
 *
 * Otvara se klikom na 📋 pored RN-a u "Po mašini" tabu.
 * Prikazuje:
 *   - Header sa osnovnim podacima RN-a (broj, naziv dela, materijal,
 *     dimenzija, komada, rok, kupac, eventualnu napomenu, status)
 *   - Tabelu svih operacija RN-a (po Operacija ASC) iz v_production_operations
 *     sa: br., opis, mašina, plan/real vreme, komada done/total, status, datum
 *     završetka.
 *   - (Opciono) podtabelu/expandable sa svim prijavama (bigtehn_tech_routing_cache).
 *
 * Read-only — modal samo prikazuje podatke iz BigTehn-a, ništa ne piše.
 *
 * Public API:
 *   openTechProcedureModal({ work_order_id, opTitle })
 *   teardownTechProcedureModal()
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadFullTechProcedure,
  formatSecondsHm,
  plannedSeconds,
  rokUrgencyClass,
  getBigtehnDrawingSignedUrl,
} from '../../services/planProizvodnje.js';

let activeModal = null;

/**
 * @param {object} opts
 * @param {number} opts.work_order_id
 * @param {string} [opts.opTitle]   Opis pri otvaranju (npr. "RN 12345")
 * @returns {Promise<void>}         Resolves kada se modal zatvori
 */
export function openTechProcedureModal(opts) {
  if (activeModal) activeModal.close();
  return new Promise((resolve) => {
    const m = createModal(opts, resolve);
    activeModal = m;
    document.body.appendChild(m.root);
    setTimeout(() => m.root.querySelector('.tpm-close')?.focus(), 50);
  });
}

export function teardownTechProcedureModal() {
  if (activeModal) {
    activeModal.close();
    activeModal = null;
  }
}

function createModal(opts, onResolve) {
  const { work_order_id, opTitle } = opts;

  const root = document.createElement('div');
  root.className = 'tpm-overlay';
  root.innerHTML = `
    <div class="tpm-modal" role="dialog" aria-modal="true" aria-label="Tehnološki postupak">
      <header class="tpm-header">
        <div>
          <div class="tpm-title">📋 Tehnološki postupak</div>
          <div class="tpm-subtitle">${escHtml(opTitle || `RN #${work_order_id}`)}</div>
        </div>
        <button type="button" class="tpm-close" aria-label="Zatvori">×</button>
      </header>
      <div class="tpm-body" data-role="body">
        <div class="tpm-loading">Učitavam tehnološki postupak…</div>
      </div>
    </div>
  `;

  function close() {
    if (root.parentNode) root.parentNode.removeChild(root);
    document.removeEventListener('keydown', onKey);
    if (activeModal && activeModal.root === root) activeModal = null;
    onResolve();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  /* Klik na overlay (van modala) zatvara */
  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  root.querySelector('.tpm-close').addEventListener('click', close);

  /* Async učitavanje */
  loadAndRender(root, work_order_id);

  return { root, close };
}

async function loadAndRender(root, workOrderId) {
  const body = root.querySelector('[data-role="body"]');
  try {
    const { operations, logs, header } = await loadFullTechProcedure(workOrderId);
    if (!operations.length) {
      body.innerHTML = `<div class="tpm-empty">Nema operacija za ovaj RN.</div>`;
      return;
    }
    body.innerHTML = renderHeader(header) + renderOperations(operations, logs) + renderPdfSection(header);

    /* Wire klik na PDF crtež dugmad — otvara u novom tab-u (zoom/štampa).
       Ima ih više: jedan u headeru kraj broja crteža + jedan iznad PDF iframe-a. */
    body.querySelectorAll('[data-action="open-bigtehn-drawing"]').forEach((pdfBtn) => {
      pdfBtn.addEventListener('click', async () => {
        const broj = pdfBtn.dataset.broj;
        const tab = window.open('about:blank', '_blank');
        if (!tab) { showToast('Pop-up blokiran.'); return; }
        try {
          const url = await getBigtehnDrawingSignedUrl(broj);
          if (!url) { tab.close(); showToast('PDF nije pronađen.'); return; }
          tab.location.href = url;
        } catch (e) {
          tab.close();
          showToast('Greška pri otvaranju PDF-a.');
          console.error(e);
        }
      });
    });

    /* Inline PDF iframe ispod operacija — lazy load signed URL-a (signed URL
       sprečava direktno embed-ovanje preko storage_path). */
    const pdfFrame = body.querySelector('[data-role="pdf-frame"]');
    const pdfMsg = body.querySelector('[data-role="pdf-msg"]');
    if (pdfFrame && header?.has_bigtehn_drawing && header?.broj_crteza) {
      try {
        const url = await getBigtehnDrawingSignedUrl(header.broj_crteza);
        if (url) {
          pdfFrame.src = url + '#toolbar=1&view=FitH';
          pdfFrame.classList.add('is-loaded');
          if (pdfMsg) pdfMsg.remove();
        } else if (pdfMsg) {
          pdfMsg.textContent = `PDF crtež "${header.broj_crteza}" nije pronađen u Bridge cache-u.`;
          pdfMsg.classList.add('is-error');
        }
      } catch (e) {
        console.error('[tpm pdf inline]', e);
        if (pdfMsg) {
          pdfMsg.textContent = 'Greška pri učitavanju PDF crteža.';
          pdfMsg.classList.add('is-error');
        }
      }
    }

    /* Wire expand/collapse za prijave po operaciji */
    body.querySelectorAll('[data-action="toggle-logs"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const opNum = btn.dataset.op;
        const detail = body.querySelector(`[data-logs-for="${opNum}"]`);
        if (!detail) return;
        const isOpen = detail.classList.toggle('is-open');
        btn.textContent = isOpen ? '▾' : '▸';
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    });
  } catch (err) {
    console.error('[loadFullTechProcedure]', err);
    body.innerHTML = `<div class="tpm-error">Greška pri učitavanju: ${escHtml(err?.message || String(err))}</div>`;
  }
}

function renderHeader(h) {
  if (!h) return '';
  const urgency = rokUrgencyClass(h.rok_izrade);
  const rok = h.rok_izrade ? formatDate(h.rok_izrade) : '—';
  const customer = h.customer_short || h.customer_name || '—';
  const statusBadge = h.rn_zavrsen
    ? `<span class="tpm-badge tpm-badge-done">ZAVRŠEN</span>`
    : h.rn_zakljucano
      ? `<span class="tpm-badge tpm-badge-locked">ZAKLJUČAN</span>`
      : `<span class="tpm-badge tpm-badge-active">U RADU</span>`;

  const drawingBtn = h.has_bigtehn_drawing
    ? `<button type="button"
               class="pp-bigtehn-drawing-btn"
               data-action="open-bigtehn-drawing"
               data-broj="${escHtml(h.broj_crteza)}"
               title="Otvori PDF crtež u novom tab-u">
         📄 ${escHtml(h.broj_crteza || '—')}
       </button>`
    : escHtml(h.broj_crteza || '—');

  return `
    <section class="tpm-rn-header">
      <div class="tpm-rn-grid">
        <div><span class="tpm-key">RN:</span> <strong>${escHtml(h.rn_ident_broj || '—')}</strong> ${statusBadge}</div>
        <div><span class="tpm-key">Crtež:</span> ${drawingBtn}</div>
        <div><span class="tpm-key">Naziv dela:</span> <strong>${escHtml(h.naziv_dela || '—')}</strong></div>
        <div><span class="tpm-key">Kupac:</span> ${escHtml(customer)}</div>
        <div><span class="tpm-key">Materijal:</span> ${escHtml(h.materijal || '—')}</div>
        <div><span class="tpm-key">Dimenzija:</span> ${escHtml(h.dimenzija_materijala || '—')}</div>
        <div><span class="tpm-key">Komada:</span> <strong>${escHtml(String(h.komada_total ?? '—'))}</strong></div>
        <div><span class="tpm-key">Rok:</span>
          <span class="pp-rok urgency-${urgency || 'none'}">${escHtml(rok)}</span>
        </div>
      </div>
      ${h.rn_napomena ? `<div class="tpm-rn-note"><span class="tpm-key">Napomena:</span> ${escHtml(h.rn_napomena)}</div>` : ''}
    </section>
  `;
}

function renderOperations(operations, allLogs) {
  /* Group logs by operacija number */
  const logsByOp = new Map();
  for (const log of allLogs) {
    if (!logsByOp.has(log.operacija)) logsByOp.set(log.operacija, []);
    logsByOp.get(log.operacija).push(log);
  }

  /* Totals */
  let totalPlan = 0;
  let totalReal = 0;
  for (const op of operations) {
    totalPlan += plannedSeconds(op);
    totalReal += op.real_seconds || 0;
  }

  return `
    <section class="tpm-ops">
      <div class="tpm-ops-header">
        <div>Operacije <span class="tpm-muted">(${operations.length})</span></div>
        <div class="tpm-totals">
          <span title="Ukupno tehnološko vreme">⏱ Plan: <strong>${escHtml(formatSecondsHm(totalPlan))}</strong></span>
          <span title="Ukupno stvarno vreme prijavljeno">✅ Real: <strong style="color:#86efac">${escHtml(formatSecondsHm(totalReal))}</strong></span>
        </div>
      </div>
      <table class="tpm-ops-table">
        <thead>
          <tr>
            <th style="width:32px"></th>
            <th title="Broj operacije">Op</th>
            <th>Opis</th>
            <th>Mašina</th>
            <th class="tpm-num">Komada</th>
            <th class="tpm-num">Plan</th>
            <th class="tpm-num">Real</th>
            <th>Status</th>
            <th>Završeno</th>
          </tr>
        </thead>
        <tbody>
          ${operations.map((op) => renderOpRow(op, logsByOp.get(op.operacija) || [])).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function renderPdfSection(h) {
  /* Inline PDF crtež ispod tabele operacija — šef vidi sve na jednom ekranu.
     Ako nema crteža u BigTehn cache-u, sekcija se ne prikazuje. */
  if (!h || !h.has_bigtehn_drawing || !h.broj_crteza) return '';
  const broj = h.broj_crteza;
  return `
    <section class="tpm-pdf-section">
      <div class="tpm-pdf-header">
        <div class="tpm-pdf-title">📄 Crtež <strong>${escHtml(broj)}</strong></div>
        <button type="button" class="tpm-pdf-open-tab" data-action="open-bigtehn-drawing" data-broj="${escHtml(broj)}" title="Otvori u novom tab-u (zoom, štampa)">↗ Novi tab</button>
      </div>
      <div class="tpm-pdf-frame-wrap">
        <iframe class="tpm-pdf-frame" data-role="pdf-frame" title="Crtež ${escHtml(broj)}" referrerpolicy="no-referrer"></iframe>
        <div class="tpm-pdf-msg" data-role="pdf-msg">Učitavam PDF…</div>
      </div>
    </section>
  `;
}

function renderOpRow(op, logs) {
  const planSec = plannedSeconds(op);
  const realSec = op.real_seconds || 0;
  const isDone = op.is_done_in_bigtehn;
  const localStatus = op.local_status;
  const statusBadge = isDone
    ? `<span class="tpm-status s-done">✓ završena</span>`
    : localStatus === 'in_progress'
      ? `<span class="tpm-status s-progress">u radu</span>`
      : localStatus === 'blocked'
        ? `<span class="tpm-status s-blocked">blokirano</span>`
        : `<span class="tpm-status s-waiting">čeka</span>`;

  const machineLabel = op.assigned_machine_code && op.assigned_machine_code !== op.original_machine_code
    ? `<span title="Premešteno iz BigTehn-a">${escHtml(op.assigned_machine_code)} <span class="tpm-muted">(orig: ${escHtml(op.original_machine_code || '—')})</span></span>`
    : escHtml(op.original_machine_code || op.effective_machine_code || '—');

  const lastFinished = op.last_finished_at ? formatDate(op.last_finished_at) : '—';
  const isNonMach = op.is_non_machining ? ' is-non-machining' : '';

  return `
    <tr class="tpm-op-row${isNonMach}" data-op="${op.operacija}">
      <td class="tpm-cell-center">
        ${logs.length
          ? `<button type="button"
                     class="tpm-toggle-logs"
                     data-action="toggle-logs"
                     data-op="${op.operacija}"
                     aria-expanded="false"
                     title="${logs.length} prijav${logs.length === 1 ? 'a' : (logs.length < 5 ? 'e' : 'a')}">▸</button>`
          : ''}
      </td>
      <td class="tpm-cell-strong tpm-num">${escHtml(String(op.operacija))}</td>
      <td title="${escHtml(op.opis_rada || '')}">${escHtml(op.opis_rada || '—')}</td>
      <td>${machineLabel}</td>
      <td class="tpm-num">
        <span class="tpm-cell-strong">${escHtml(String(op.komada_done ?? 0))}</span>
        <span class="tpm-muted"> / ${escHtml(String(op.komada_total ?? 0))}</span>
      </td>
      <td class="tpm-num tpm-muted">${escHtml(formatSecondsHm(planSec))}</td>
      <td class="tpm-num" style="color:#86efac">${escHtml(formatSecondsHm(realSec))}</td>
      <td>${statusBadge}</td>
      <td class="tpm-muted">${escHtml(lastFinished)}</td>
    </tr>
    ${logs.length ? renderLogsRow(op.operacija, logs) : ''}
  `;
}

function renderLogsRow(opNum, logs) {
  return `
    <tr class="tpm-logs-row" data-logs-for="${opNum}">
      <td colspan="9">
        <div class="tpm-logs-wrap">
          <div class="tpm-logs-title">Prijave za operaciju ${escHtml(String(opNum))} (${logs.length})</div>
          <table class="tpm-logs-table">
            <thead>
              <tr>
                <th>Početak</th>
                <th>Završeno</th>
                <th>Mašina</th>
                <th>Radnik</th>
                <th class="tpm-num">Komada</th>
                <th class="tpm-num">Trajanje</th>
                <th>Završen?</th>
                <th>Napomena</th>
              </tr>
            </thead>
            <tbody>
              ${logs.map(renderLogRow).join('')}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  `;
}

function renderLogRow(log) {
  const startedAt = log.started_at ? formatDate(log.started_at) : '—';
  const finishedAt = log.finished_at ? formatDate(log.finished_at) : '—';
  const dur = log.prn_timer_seconds ? formatSecondsHm(log.prn_timer_seconds) : '—';
  const worker = log.potpis || (log.worker_id ? `#${log.worker_id}` : '—');
  const isDone = log.is_completed
    ? `<span class="tpm-tag-done">DA</span>`
    : `<span class="tpm-muted">ne</span>`;
  const napomena = log.napomena ? escHtml(String(log.napomena).trim()) : '';
  return `
    <tr>
      <td class="tpm-muted">${escHtml(startedAt)}</td>
      <td class="tpm-muted">${escHtml(finishedAt)}</td>
      <td>${escHtml(log.machine_code || '—')}</td>
      <td>${escHtml(worker)}</td>
      <td class="tpm-num">${escHtml(String(log.komada ?? 0))}</td>
      <td class="tpm-num">${escHtml(dur)}</td>
      <td class="tpm-cell-center">${isDone}</td>
      <td title="${napomena}">${napomena.length > 60 ? napomena.slice(0, 60) + '…' : napomena}</td>
    </tr>
  `;
}
