/**
 * Tabela predmeta + filter + toggle.
 */

import { escHtml, showToast } from '../../../lib/dom.js';
import { setPredmetAktivacija } from '../../../services/predmetAktivacija.js';
import { openNapomenaModal } from './napomenaModal.js';

let _rows = [];
let _filter = 'all'; /* 'all' | 'active' | 'inactive' */
let _search = '';

function formatAt(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return escHtml(String(iso));
    return escHtml(d.toLocaleString('sr-Latn-RS', { dateStyle: 'short', timeStyle: 'short' }));
  } catch {
    return '—';
  }
}

function filterRows() {
  const q = _search.trim().toLowerCase();
  return _rows.filter(r => {
    if (_filter === 'active' && !r.je_aktivan) return false;
    if (_filter === 'inactive' && r.je_aktivan) return false;
    if (!q) return true;
    const sif = String(r.broj_predmeta || '').toLowerCase();
    const naz = String(r.naziv_predmeta || '').toLowerCase();
    return sif.includes(q) || naz.includes(q);
  });
}

export function setPredmetAktivacijaRows(rows) {
  _rows = Array.isArray(rows) ? rows : [];
}

export function renderPredmetiTable() {
  const list = filterRows();
  const n = list.length;
  return `
    <div class="kadr-summary-strip" style="margin-bottom:10px">
      <span class="kadr-count">${n} prikazano / ${_rows.length} ukupno</span>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
      <label class="form-label" style="margin:0">Pretraga</label>
      <input type="search" class="form-input" id="predAktSearch" style="max-width:240px"
        placeholder="Šifra ili naziv…" value="${escHtml(_search)}">
      <label class="form-label" style="margin:0">Prikaz</label>
      <select class="form-input" id="predAktFilter" style="max-width:160px">
        <option value="all" ${_filter === 'all' ? 'selected' : ''}>Svi</option>
        <option value="active" ${_filter === 'active' ? 'selected' : ''}>Aktivni</option>
        <option value="inactive" ${_filter === 'inactive' ? 'selected' : ''}>Neaktivni</option>
      </select>
    </div>
    <div class="mnt-table-wrap" style="overflow:auto;max-height:70vh">
      <table class="mnt-table" style="font-size:13px;min-width:720px">
        <thead>
          <tr>
            <th>Šifra</th>
            <th>Naziv</th>
            <th>Komitent</th>
            <th>Aktivan</th>
            <th>Poslednja izmena</th>
            <th>Napomena</th>
          </tr>
        </thead>
        <tbody>
          ${list.length ? list.map(r => rowHtml(r)).join('') : `<tr><td colspan="6" class="mnt-muted">Nema redova za filter.</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function rowHtml(r) {
  const id = Number(r.item_id);
  const chk = r.je_aktivan ? 'checked' : '';
  const who = r.azurirao_email ? escHtml(r.azurirao_email) : '—';
  const when = formatAt(r.azurirano_at);
  const nap = r.napomena != null && String(r.napomena).trim() !== '' ? escHtml(String(r.napomena)) : '—';
  return `<tr data-pred-akt-id="${id}">
    <td><code>${escHtml(String(r.broj_predmeta || ''))}</code></td>
    <td>${escHtml(String(r.naziv_predmeta || ''))}</td>
    <td>${escHtml(String(r.customer_name || ''))}</td>
    <td><label class="mnt-toggle"><input type="checkbox" data-pred-akt-toggle="${id}" ${chk} aria-label="Aktivan"></label></td>
    <td style="white-space:nowrap;font-size:12px">${who}<br><span class="mnt-muted">${when}</span></td>
    <td><button type="button" class="kadr-action-btn" data-pred-akt-nap="${id}" title="Izmeni napomenu">${nap}</button></td>
  </tr>`;
}

/**
 * @param {HTMLElement} root
 * @param {{ onChanged?: () => void }} [opts]
 */
export function wirePredmetiTable(root, opts = {}) {
  const onChanged = opts.onChanged || null;

  const findRow = id =>
    _rows.find(x => Number(x.item_id) === Number(id));

  root.querySelector('#predAktSearch')?.addEventListener('input', e => {
    _search = e.target?.value || '';
    onChanged?.();
  });
  root.querySelector('#predAktFilter')?.addEventListener('change', e => {
    _filter = e.target?.value || 'all';
    onChanged?.();
  });

  root.querySelectorAll('[data-pred-akt-toggle]').forEach(el => {
    el.addEventListener('change', async ev => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement) || input.type !== 'checkbox') return;
      const id = Number(input.getAttribute('data-pred-akt-toggle'));
      const next = input.checked;
      const prev = findRow(id);
      const oldAkt = !!prev?.je_aktivan;
      /* Vrati čekboks dok korisnik ne potvrdi (change je već promenio stanje). */
      input.checked = oldAkt;
      const sif = prev ? String(prev.broj_predmeta || '').trim() : '';
      const naz = prev ? String(prev.naziv_predmeta || '').trim() : '';
      const opis = [sif || `#${id}`, naz].filter(Boolean).join(' — ');
      const akcija = next ? 'aktivirate' : 'deaktivirate';
      const upozorenje = next
        ? 'Predmet će ući u Plan proizvodnje i u listu u Praćenju proizvodnje (uz ostala podešavanja).'
        : 'Predmet će biti uklonjen iz Plana proizvodnje i iz liste u Praćenju proizvodnje, bez brisanja podataka u bazi.';
      const potvrdi = window.confirm(
        `Da li ste sigurni da želite da ${akcija} predmet?\n\n${opis}\n\n${upozorenje}\n\nNastaviti?`
      );
      if (!potvrdi) return;
      input.checked = next;
      if (prev) prev.je_aktivan = next;
      const ok = await setPredmetAktivacija(id, next, null);
      if (ok == null) {
        if (prev) prev.je_aktivan = oldAkt;
        input.checked = oldAkt;
        showToast('Snimanje nije uspelo (proveri dozvolu ili mrežu).');
        return;
      }
      showToast('Sačuvano');
      onChanged?.();
    });
  });

  root.querySelectorAll('[data-pred-akt-nap]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.getAttribute('data-pred-akt-nap'));
      const row = findRow(id);
      openNapomenaModal({
        title: 'Napomena za predmet',
        initial: row?.napomena || '',
        onConfirm: async text => {
          const nextAkt = !!row?.je_aktivan;
          const ok = await setPredmetAktivacija(id, nextAkt, text);
          if (ok == null) {
            showToast('Snimanje napomene nije uspelo.');
            return;
          }
          if (row) row.napomena = text;
          showToast('Sačuvano');
          onChanged?.();
        },
      });
    });
  });
}
