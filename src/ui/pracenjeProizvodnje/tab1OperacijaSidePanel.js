import { escHtml } from '../../lib/dom.js';
import { fetchPrijaveZaOperaciju } from '../../services/pracenjeProizvodnje.js';
import { statusBadgeHtml } from './statusBadge.js';

let panel = null;

export function openOperacijaSidePanel({ position, operation }) {
  if (!panel) {
    panel = document.createElement('aside');
    panel.className = 'modal-panel';
    panel.style.cssText = 'position:fixed;right:18px;top:84px;bottom:18px;width:min(560px,calc(100vw - 36px));z-index:80;overflow:auto;box-shadow:0 18px 50px rgba(0,0,0,.35)';
    document.body.appendChild(panel);
  }
  renderLoading(position, operation);
  load(position, operation);
}

export function closeOperacijaSidePanel() {
  panel?.remove();
  panel = null;
}

function renderLoading(position, operation) {
  panel.innerHTML = shellHtml(position, operation, '<div class="pp-state"><div class="pp-state-title">Učitavanje prijava…</div></div>');
}

async function load(position, operation) {
  try {
    const rows = await fetchPrijaveZaOperaciju(position.id, operation.tp_operacija_id);
    panel.innerHTML = shellHtml(position, operation, prijaveHtml(rows, position));
  } catch (e) {
    panel.innerHTML = shellHtml(position, operation, `<div class="pp-error">${escHtml(e?.message || e)}</div>`);
  }
  panel.querySelector('#opPanelClose')?.addEventListener('click', closeOperacijaSidePanel);
}

function shellHtml(position, operation, body) {
  return `
    <div class="modal-header">
      <h3>${escHtml(operation.naziv || 'Operacija')} · ${escHtml(operation.work_center || '')}</h3>
      <button type="button" class="modal-close" id="opPanelClose" aria-label="Zatvori">×</button>
    </div>
    <div class="modal-body">
      <div class="form-hint">${escHtml(position.sifra_pozicije || '')} ${escHtml(position.naziv || '')}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
        <span class="pp-counter">Planirano: <strong>${escHtml(operation.planirano_komada ?? '—')}</strong></span>
        <span class="pp-counter">Prijavljeno: <strong>${escHtml(operation.prijavljeno_komada ?? 0)}</strong></span>
        ${statusBadgeHtml(operation.status, { button: false })}
      </div>
      <nav class="kadrovska-tabs" style="margin-bottom:10px">
        <button class="kadrovska-tab is-active" type="button">Prijave rada</button>
        <button class="kadrovska-tab" type="button" disabled title="Dokumentacija dolazi u kasnijoj fazi">Dokumentacija</button>
        <button class="kadrovska-tab" type="button" disabled title="Crteži dolaze kroz PDM link u kasnijoj fazi">Crteži</button>
      </nav>
      ${body}
    </div>
  `;
}

function prijaveHtml(rows) {
  if (!rows.length) return '<div class="pp-state"><div class="pp-state-title">Nema prijava za ovu operaciju</div></div>';
  return `
    <div class="pp-table-wrap">
      <table class="pp-table">
        <thead><tr><th>Datum</th><th>Radnik</th><th class="pp-cell-num">Količina</th><th>Smena</th><th>Napomena</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escHtml(formatDate(r.datum))}</td>
              <td>${escHtml(r.radnik || '—')}</td>
              <td class="pp-cell-num">${escHtml(r.kolicina ?? '')}</td>
              <td>${escHtml(r.smena || '—')}</td>
              <td>${escHtml(r.napomena || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('sr-RS');
}
