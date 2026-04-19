/**
 * Arhiva tab — lista zaključanih sastanaka sa zapisnicima.
 *
 * Klik na red:
 *   - "Otvori sastanak" → otvara `sastanakModal` u read-only modu
 *   - "Štampaj zapisnik" → poziva `printZapisnik(snapshot)`
 *
 * Filter: pretraga po naslovu / pretraga u sadržaj_text (DB JSONB lookup).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import { loadSveArhive, printZapisnik } from '../../services/sastanakArhiva.js';
import { openSastanakModal } from './sastanakModal.js';

let abortFlag = false;
let cachedArhive = [];
let searchQ = '';

export async function renderArhivaTab(host, { canEdit }) {
  abortFlag = false;
  host.innerHTML = `
    <div class="sast-section">
      <div class="sast-toolbar">
        <div class="sast-filters">
          <input type="search" id="arhSearch" class="sast-input" placeholder="Pretraži zapisnike (naslov)" value="${escHtml(searchQ)}" style="min-width:300px">
        </div>
      </div>
      <div id="arhBody" class="sast-table-wrap"></div>
    </div>
  `;

  host.querySelector('#arhSearch').addEventListener('input', (e) => {
    searchQ = e.target.value;
    renderRows(host, { canEdit });
  });

  cachedArhive = await loadSveArhive({ limit: 200 });
  if (abortFlag) return;
  renderRows(host, { canEdit });
}

export function teardownArhivaTab() {
  abortFlag = true;
}

function renderRows(host, { canEdit }) {
  const body = host.querySelector('#arhBody');
  let rows = cachedArhive;
  if (searchQ) {
    const q = searchQ.toLowerCase();
    rows = rows.filter(a => {
      const s = a.snapshot?.sastanak;
      if (!s) return false;
      return String(s.naslov || '').toLowerCase().includes(q)
        || String(a.snapshot?.aktivnosti?.map(x => x.sadrzajText || '').join(' ') || '').toLowerCase().includes(q);
    });
  }
  if (!rows.length) {
    body.innerHTML = '<div class="sast-empty">Nema arhiviranih zapisnika.</div>';
    return;
  }
  body.innerHTML = `
    <table class="sast-table sast-table-clickable">
      <thead><tr>
        <th>Datum sastanka</th>
        <th>Tip</th>
        <th>Naslov</th>
        <th>Vodio</th>
        <th>Učesnika</th>
        <th>Slika</th>
        <th>Arhivirano</th>
        <th class="sast-th-actions">Akcije</th>
      </tr></thead>
      <tbody>
        ${rows.map(a => {
          const s = a.snapshot?.sastanak || {};
          const tip = s.tip || '?';
          const ucCount = (a.snapshot?.ucesnici || []).length;
          const slCount = (a.snapshot?.slike || []).length;
          return `
            <tr data-sid="${escHtml(s.id || '')}" data-aid="${escHtml(a.id || '')}">
              <td><strong>${escHtml(formatDate(s.datum))}</strong></td>
              <td><span class="sast-tip-badge sast-tip-${escHtml(tip)}">${tip === 'projektni' ? 'Projektni' : 'Sedmični'}</span></td>
              <td>${escHtml(s.naslov || '—')}</td>
              <td>${escHtml(s.vodioLabel || s.vodioEmail || '—')}</td>
              <td>${ucCount}</td>
              <td>${slCount}</td>
              <td>${escHtml(formatDate(a.arhiviranoAt))}<br><small>${escHtml(a.arhiviraoLabel || a.arhiviraoEmail || '')}</small></td>
              <td class="sast-td-actions">
                <button class="btn-icon btn-primary" data-action="open" title="Otvori">↗</button>
                <button class="btn-icon" data-action="print" title="Štampaj zapisnik">🖨</button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  body.querySelectorAll('tr[data-sid]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      openSastanakModal({ sastanakId: tr.dataset.sid, canEdit, onClose: () => {} });
    });
  });

  body.querySelectorAll('[data-action]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const tr = b.closest('tr');
      const sid = tr.dataset.sid;
      const aid = tr.dataset.aid;
      const arh = cachedArhive.find(x => x.id === aid);
      if (!arh) return;
      if (b.dataset.action === 'open') {
        openSastanakModal({ sastanakId: sid, canEdit, onClose: () => {} });
      }
      if (b.dataset.action === 'print') {
        if (arh.snapshot) printZapisnik(arh.snapshot);
        else showToast('⚠ Snapshot prazan');
      }
    });
  });
}
