/**
 * Lokacije — Lookup modali za BigTehn entitete.
 *
 * Read-only pregled poslednjeg sinhronizovanog snimka iz Supabase
 * cache tabela koje BRIDGE puni iz MSSQL-a (svakih ~15 min):
 *   - `bigtehn_work_orders_cache` — pretraga po crtežu / RN-u / nazivu dela
 *   - `bigtehn_items_cache` — pretraga po broju predmeta / nazivu / ugovoru
 *
 * Klik na red u RN listi otvara postojeći Plan Proizvodnje
 * `openTechProcedureModal({ work_order_id })` (operacije + prijave iz
 * `bigtehn_tech_routing_cache`). Ovaj modul nikad ne piše u bazu.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  searchBigtehnWorkOrders,
  searchBigtehnItems,
} from '../../services/lokacije.js';
import { openTechProcedureModal } from '../planProizvodnje/techProcedureModal.js';

let activeOverlay = null;

function closeOverlay() {
  if (!activeOverlay) return;
  activeOverlay.remove();
  activeOverlay = null;
}

function buildOverlay(title, contentHtml) {
  closeOverlay();
  const root = document.createElement('div');
  root.className = 'tpm-overlay';
  root.innerHTML = `
    <div class="tpm-modal" role="dialog" aria-modal="true" aria-label="${escHtml(title)}">
      <header class="tpm-head">
        <h2 class="tpm-title">${escHtml(title)}</h2>
        <button type="button" class="tpm-close" aria-label="Zatvori">×</button>
      </header>
      <div class="tpm-body">${contentHtml}</div>
    </div>`;
  root.addEventListener('click', e => {
    if (e.target === root) closeOverlay();
  });
  root.querySelector('.tpm-close')?.addEventListener('click', closeOverlay);
  document.addEventListener(
    'keydown',
    function onKey(ev) {
      if (ev.key === 'Escape') {
        closeOverlay();
        document.removeEventListener('keydown', onKey);
      }
    },
    { once: false },
  );
  document.body.appendChild(root);
  activeOverlay = root;
  return root;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function renderRnRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<tr><td colspan="7" class="loc-muted">Nema rezultata.</td></tr>';
  }
  return rows
    .map(r => {
      const rok = r.rok_izrade ? formatDate(r.rok_izrade) : '—';
      const status = r.status_rn === true ? 'Zatvoren' : r.status_rn === false ? 'Otvoren' : '—';
      const tezina = r.tezina_obr != null && r.tezina_obr > 0 ? Number(r.tezina_obr).toFixed(2) : '';
      return `<tr class="loc-row-click" data-wo-id="${escHtml(String(r.id))}" title="Otvori tehnološki postupak">
        <td><strong>${escHtml(r.ident_broj || '')}</strong></td>
        <td>${escHtml(r.broj_crteza || '')}${r.revizija ? ` <span class="loc-muted">(rev. ${escHtml(r.revizija)})</span>` : ''}</td>
        <td>${escHtml(r.naziv_dela || '')}</td>
        <td>${escHtml(r.materijal || '')} <span class="loc-muted">${escHtml(r.dimenzija_materijala || '')}</span></td>
        <td class="loc-qty-cell">${escHtml(String(r.komada ?? ''))}${tezina ? ` <span class="loc-muted">(${tezina} kg)</span>` : ''}</td>
        <td>${escHtml(rok)}</td>
        <td>${escHtml(status)}</td>
      </tr>`;
    })
    .join('');
}

function renderItemRows(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<tr><td colspan="6" class="loc-muted">Nema rezultata.</td></tr>';
  }
  return rows
    .map(r => {
      const rok = r.rok_zavrsetka ? formatDate(r.rok_zavrsetka) : '—';
      return `<tr>
        <td><strong>${escHtml(r.broj_predmeta || '')}</strong></td>
        <td>${escHtml(r.naziv_predmeta || '')}</td>
        <td>${escHtml(r.opis || '')}</td>
        <td>${escHtml(r.broj_ugovora || '')}${r.broj_narudzbenice ? ` <span class="loc-muted">/ ${escHtml(r.broj_narudzbenice)}</span>` : ''}</td>
        <td>${escHtml(rok)}</td>
        <td>${escHtml(r.status || '')}</td>
      </tr>`;
    })
    .join('');
}

/**
 * Lookup po radnim nalozima iz `bigtehn_work_orders_cache`.
 * Modal ima jedan input (debounced 300ms) i listu rezultata; klik na red
 * otvara `openTechProcedureModal({ work_order_id })`.
 *
 * @param {{ initialQuery?: string }} [opts]
 */
export function openWorkOrderLookupModal(opts = {}) {
  const initial = String(opts.initialQuery || '').trim();
  const html = `
    <div class="loc-search loc-items-search" style="margin-bottom:12px">
      <input type="search" id="wolQuery" class="loc-search-input"
        placeholder="Broj crteža · ident_broj (npr. 9400/1) · naziv dela…"
        value="${escHtml(initial)}" autocomplete="off" autofocus />
      <span class="loc-muted loc-filter-hint">Pretraga ide po <code>broj_crteza</code>, <code>ident_broj</code> i <code>naziv_dela</code>; klik na red otvara TP modal.</span>
    </div>
    <div class="loc-table-wrap">
      <table class="loc-table">
        <thead><tr>
          <th>RN (ident)</th>
          <th>Crtež</th>
          <th>Naziv dela</th>
          <th>Materijal / dimenzija</th>
          <th class="loc-qty-cell">Kom. (težina)</th>
          <th>Rok</th>
          <th>Status</th>
        </tr></thead>
        <tbody id="wolRows"><tr><td colspan="7" class="loc-muted">Unesi minimalno 2 karaktera za pretragu.</td></tr></tbody>
      </table>
    </div>`;
  const root = buildOverlay('Pretraga BigTehn radnih naloga', html);
  const input = root.querySelector('#wolQuery');
  const tbody = root.querySelector('#wolRows');

  async function runSearch(q) {
    const qq = String(q || '').trim();
    if (qq.length < 2) {
      tbody.innerHTML = '<tr><td colspan="7" class="loc-muted">Unesi minimalno 2 karaktera za pretragu.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="7" class="loc-muted">Učitavanje…</td></tr>';
    try {
      const rows = await searchBigtehnWorkOrders(qq, 100);
      tbody.innerHTML = renderRnRows(rows);
      tbody.querySelectorAll('[data-wo-id]').forEach(tr => {
        tr.addEventListener('click', () => {
          const id = Number(tr.getAttribute('data-wo-id'));
          if (Number.isFinite(id)) {
            void openTechProcedureModal({ work_order_id: id });
          }
        });
      });
    } catch (err) {
      console.error('[lookup/wo] search failed', err);
      tbody.innerHTML = `<tr><td colspan="7" class="loc-warn">Greška pretrage: ${escHtml(err?.message || String(err))}</td></tr>`;
    }
  }

  const onInput = debounce(() => runSearch(input.value), 300);
  input.addEventListener('input', onInput);
  if (initial.length >= 2) void runSearch(initial);
}

/**
 * Lookup po predmetima iz `bigtehn_items_cache`.
 *
 * @param {{ initialQuery?: string }} [opts]
 */
export function openItemLookupModal(opts = {}) {
  const initial = String(opts.initialQuery || '').trim();
  const html = `
    <div class="loc-search loc-items-search" style="margin-bottom:12px">
      <input type="search" id="ilQuery" class="loc-search-input"
        placeholder="Broj predmeta · naziv · ugovor / narudžbenica…"
        value="${escHtml(initial)}" autocomplete="off" autofocus />
      <span class="loc-muted loc-filter-hint">Predmeti iz <code>bigtehn_items_cache</code> — sinhronizacija dnevno (catalogs_daily).</span>
    </div>
    <div class="loc-table-wrap">
      <table class="loc-table">
        <thead><tr>
          <th>Broj predmeta</th>
          <th>Naziv</th>
          <th>Opis</th>
          <th>Ugovor / Narudžbenica</th>
          <th>Rok završetka</th>
          <th>Status</th>
        </tr></thead>
        <tbody id="ilRows"><tr><td colspan="6" class="loc-muted">Unesi minimalno 2 karaktera za pretragu.</td></tr></tbody>
      </table>
    </div>`;
  const root = buildOverlay('Pretraga BigTehn predmeta', html);
  const input = root.querySelector('#ilQuery');
  const tbody = root.querySelector('#ilRows');

  async function runSearch(q) {
    const qq = String(q || '').trim();
    if (qq.length < 2) {
      tbody.innerHTML = '<tr><td colspan="6" class="loc-muted">Unesi minimalno 2 karaktera za pretragu.</td></tr>';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="6" class="loc-muted">Učitavanje…</td></tr>';
    try {
      const rows = await searchBigtehnItems(qq, 100);
      tbody.innerHTML = renderItemRows(rows);
    } catch (err) {
      console.error('[lookup/items] search failed', err);
      tbody.innerHTML = `<tr><td colspan="6" class="loc-warn">Greška pretrage: ${escHtml(err?.message || String(err))}</td></tr>`;
      showToast(`Pretraga predmeta neuspešna: ${err?.message || err}`);
    }
  }

  const onInput = debounce(() => runSearch(input.value), 300);
  input.addEventListener('input', onInput);
  if (initial.length >= 2) void runSearch(initial);
}

export function teardownLookupModals() {
  closeOverlay();
}
