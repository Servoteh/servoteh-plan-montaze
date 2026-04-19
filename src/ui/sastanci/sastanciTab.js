/**
 * Sastanci tab — lista svih sastanaka (sedmični + projektni).
 *
 * Filteri: tip, status, period (od-do), projekat.
 * Klik na red otvara `sastanakModal` koji vodi (ili pregleda) sastanak.
 * Dugme "+ Novi sastanak" otvara izbor tipa pa kreiranje.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadSastanci, deleteSastanak,
  SASTANAK_TIPOVI, SASTANAK_STATUSI, SASTANAK_STATUS_BOJE,
} from '../../services/sastanci.js';
import { loadProjektiLite } from '../../services/projekti.js';
import { openSastanakModal } from './sastanakModal.js';
import { openCreateSastanakModal } from './createSastanakModal.js';

let abortFlag = false;
let cachedSastanci = [];
let cachedProjekti = [];
let filters = { tip: '', status: '', projekatId: '', fromDate: '', toDate: '' };

export async function renderSastanciTab(host, { canEdit }) {
  abortFlag = false;
  cachedProjekti = await loadProjektiLite();

  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-toolbar">
        <div class="sast-filters">
          <select id="ssFiltTip" class="sast-input">
            <option value="">Svi tipovi</option>
            ${Object.entries(SASTANAK_TIPOVI).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}
          </select>
          <select id="ssFiltStatus" class="sast-input">
            <option value="">Svi statusi</option>
            ${Object.entries(SASTANAK_STATUSI).map(([k, v]) => `<option value="${k}">${escHtml(v)}</option>`).join('')}
          </select>
          <select id="ssFiltProjekat" class="sast-input">
            <option value="">Svi projekti</option>
            ${cachedProjekti.map(p => `<option value="${p.id}">${escHtml(p.label)}</option>`).join('')}
          </select>
          <input type="date" id="ssFiltFrom" class="sast-input" title="Od datuma" value="${filters.fromDate}">
          <input type="date" id="ssFiltTo" class="sast-input" title="Do datuma" value="${filters.toDate}">
        </div>
        <div class="sast-toolbar-actions">
          ${canEdit ? '<button class="btn btn-primary" id="newSastanakBtn">+ Novi sastanak</button>' : ''}
        </div>
      </div>
      <div id="ssBody" class="sast-table-wrap"></div>
    </div>
  `;

  if (canEdit) {
    host.querySelector('#newSastanakBtn').addEventListener('click', () => {
      openCreateSastanakModal({
        projekti: cachedProjekti,
        onCreated: (sast) => {
          openSastanakModal({
            sastanakId: sast.id,
            canEdit,
            onClose: () => renderRows(host, { canEdit }),
          });
        },
      });
    });
  }

  /* Restore filtere u UI. */
  host.querySelector('#ssFiltTip').value = filters.tip;
  host.querySelector('#ssFiltStatus').value = filters.status;
  host.querySelector('#ssFiltProjekat').value = filters.projekatId;

  ['ssFiltTip', 'ssFiltStatus', 'ssFiltProjekat', 'ssFiltFrom', 'ssFiltTo'].forEach(id => {
    host.querySelector('#' + id).addEventListener('change', (e) => {
      const key = id.replace('ssFilt', '').toLowerCase();
      const map = { tip: 'tip', status: 'status', projekat: 'projekatId', from: 'fromDate', to: 'toDate' };
      filters[map[key]] = e.target.value;
      renderRows(host, { canEdit });
    });
  });

  await renderRows(host, { canEdit });
}

export function teardownSastanciTab() {
  abortFlag = true;
}

async function renderRows(host, { canEdit }) {
  const body = host.querySelector('#ssBody');
  body.innerHTML = '<div class="sast-loading">Učitavam sastanke…</div>';

  cachedSastanci = await loadSastanci({
    tip: filters.tip || null,
    status: filters.status || null,
    projekatId: filters.projekatId || null,
    fromDate: filters.fromDate || null,
    toDate: filters.toDate || null,
    limit: 500,
  });

  if (abortFlag) return;

  if (!cachedSastanci.length) {
    body.innerHTML = '<div class="sast-empty">Nema sastanaka sa zadatim filterima.</div>';
    return;
  }

  body.innerHTML = `
    <table class="sast-table sast-table-clickable">
      <thead>
        <tr>
          <th>Datum</th>
          <th>Tip</th>
          <th>Naslov</th>
          <th>Vodio</th>
          <th>Projekat</th>
          <th>Status</th>
          <th class="sast-th-actions">Akcije</th>
        </tr>
      </thead>
      <tbody>
        ${cachedSastanci.map(s => renderSastanakRow(s, canEdit)).join('')}
      </tbody>
    </table>
  `;

  /* Klik na red → otvori sastanak. */
  body.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      openSastanakModal({
        sastanakId: tr.dataset.id,
        canEdit,
        onClose: () => renderRows(host, { canEdit }),
      });
    });
  });

  body.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      const sast = cachedSastanci.find(s => s.id === id);
      if (!sast) return;
      if (action === 'open') {
        openSastanakModal({ sastanakId: id, canEdit, onClose: () => renderRows(host, { canEdit }) });
      }
      if (action === 'delete') {
        if (sast.status === 'zakljucan') {
          showToast('🔒 Zaključani sastanci se ne mogu brisati');
          return;
        }
        if (!confirm(`Obriši sastanak "${sast.naslov}"?`)) return;
        const ok = await deleteSastanak(id);
        if (ok) { showToast('🗑 Sastanak obrisan'); await renderRows(host, { canEdit }); }
      }
    });
  });
}

function renderSastanakRow(s, canEdit) {
  const tipLabel = SASTANAK_TIPOVI[s.tip] || s.tip;
  const statusLabel = SASTANAK_STATUSI[s.status] || s.status;
  const statusColor = SASTANAK_STATUS_BOJE[s.status] || '#666';
  const projekat = cachedProjekti.find(p => p.id === s.projekatId);
  const projLabel = projekat ? escHtml(projekat.code || projekat.name) : '';

  const actions = [
    `<button class="btn-icon btn-primary" data-action="open" data-id="${s.id}" title="Otvori">↗</button>`,
  ];
  if (canEdit && s.status !== 'zakljucan') {
    actions.push(`<button class="btn-icon btn-danger" data-action="delete" data-id="${s.id}" title="Obriši">🗑</button>`);
  }

  return `
    <tr data-id="${s.id}">
      <td>
        <strong>${escHtml(formatDate(s.datum))}</strong>
        ${s.vreme ? `<br><small>${escHtml(s.vreme.slice(0, 5))}</small>` : ''}
      </td>
      <td><span class="sast-tip-badge sast-tip-${escHtml(s.tip)}">${escHtml(tipLabel)}</span></td>
      <td><strong>${escHtml(s.naslov)}</strong></td>
      <td>${escHtml(s.vodioLabel || s.vodioEmail || '—')}</td>
      <td>${projLabel}</td>
      <td><span class="sast-status-pill" style="background:${statusColor}">${escHtml(statusLabel)}</span></td>
      <td class="sast-td-actions">${actions.join(' ')}</td>
    </tr>
  `;
}
