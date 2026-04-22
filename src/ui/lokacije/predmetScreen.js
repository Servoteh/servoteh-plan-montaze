/**
 * Lokacije — „Ekran Predmet": izbor jednog Predmeta (BigTehn) i pregled
 * SVIH njegovih tehnoloških postupaka (RN-ova) sa pridruženim placement-ima.
 *
 * Tok:
 *   1. Combobox „Predmet" — debounced pretraga `bigtehn_items_cache` (samo
 *      aktuelni: status='U TOKU' AND datum_zakljucenja IS NULL).
 *   2. Kad korisnik izabere predmet → RPC `loc_tps_for_predmet` vraća
 *      jedan red po (TP × placement). Ako TP nema placement → 1 red sa
 *      praznim location_*. Ako TP ima više placement-a → više redova.
 *   3. Po default-u skrivamo TP-ove čiji su SVI placement-i na
 *      ASSEMBLY/SCRAPPED. Korisnik može uključiti i njih checkbox-om.
 *   4. Klik na red → otvara postojeći `openTechProcedureModal` iz Plan
 *      Proizvodnje (operacije + prijave iz BigTehn cache-a).
 *
 * Ne piše u bazu. Sve sortiranje/filtriranje radi se na serveru (RPC).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { searchBigtehnItems, fetchTpsForPredmet } from '../../services/lokacije.js';
import { openTechProcedureModal } from '../planProizvodnje/techProcedureModal.js';

let activeOverlay = null;

const PAGE_SIZE = 100;

function closeOverlay() {
  if (!activeOverlay) return;
  activeOverlay.remove();
  activeOverlay = null;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function buildOverlay(title, contentHtml) {
  closeOverlay();
  const root = document.createElement('div');
  root.className = 'tpm-overlay';
  root.innerHTML = `
    <div class="tpm-modal" role="dialog" aria-modal="true" aria-label="${escHtml(title)}" style="max-width:1200px;width:96%">
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

/**
 * Combobox Predmet sa debounced search-om i listom.
 * Vraća izabrani predmet preko `onSelect(item)`. Ako je `initialItem`
 * prosleđen, render-uje se kao trenutno izabrani.
 */
function renderPredmetCombobox({ initialItem = null } = {}) {
  return `
    <div class="loc-predmet-combo" style="position:relative;display:flex;flex-direction:column;gap:6px">
      <label class="loc-filter-field">
        <span>Predmet</span>
        <input type="search" id="psPredmetQ" class="loc-search-input"
          placeholder="Broj predmeta, naziv, ugovor / narudžbenica…"
          value="${escHtml(initialItem ? `${initialItem.broj_predmeta} — ${initialItem.naziv_predmeta || ''}` : '')}"
          autocomplete="off" autofocus />
      </label>
      <div id="psPredmetDrop" class="loc-list" style="position:absolute;top:100%;left:0;right:0;z-index:30;background:var(--surface,#fff);border:1px solid var(--border2,#ccc);border-radius:6px;max-height:280px;overflow:auto;display:none;box-shadow:0 6px 18px rgba(0,0,0,.18)"></div>
      <span class="loc-muted loc-filter-hint">Lista uključuje samo predmete u statusu „U TOKU" (nezatvoreni). Sinhronizuje BRIDGE iz BigTehn-a.</span>
    </div>`;
}

function renderItemRow(item) {
  const code = escHtml(item.broj_predmeta || '');
  const naz = escHtml(item.naziv_predmeta || '');
  const cust = escHtml(item.customer_name || '');
  const ug = item.broj_ugovora ? ` · ugovor ${escHtml(item.broj_ugovora)}` : '';
  const nar = item.broj_narudzbenice ? ` · NAR ${escHtml(item.broj_narudzbenice)}` : '';
  return `<button type="button" class="btn loc-row-click" data-item-id="${escHtml(String(item.id))}" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid var(--border2,#eee);padding:8px 12px;background:transparent">
    <div><strong>${code}</strong> · ${naz}</div>
    <div class="loc-muted" style="font-size:12px">${cust}${ug}${nar}</div>
  </button>`;
}

function renderTpRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<tr><td colspan="7" class="loc-muted">Nema tehnoloških postupaka za zadati filter.</td></tr>';
  }
  return rows
    .map(r => {
      const ident = escHtml(r.wo_ident_broj || '');
      const tpNo = escHtml(r.tp_no || '');
      const cr = escHtml(r.wo_broj_crteza || '');
      const nz = escHtml(String(r.naziv_dela || '').slice(0, 80));
      const komRn = r.komada_rn != null ? Number(r.komada_rn) : null;
      const placed = r.qty_total_placed != null ? Number(r.qty_total_placed) : 0;
      const qtyOnLoc = r.qty_on_location != null ? Number(r.qty_on_location) : null;
      const qtyCell = qtyOnLoc != null
        ? `<strong>${escHtml(String(qtyOnLoc))}</strong>${komRn != null ? ` <span class="loc-muted">/ ${escHtml(String(komRn))}</span>` : ''}`
        : komRn != null
          ? `<span class="loc-muted">— / ${escHtml(String(komRn))}</span>`
          : '<span class="loc-muted">—</span>';
      const locCell = r.location_code
        ? `<strong>${escHtml(r.location_code)}</strong>${r.location_name ? `<br><span class="loc-muted">${escHtml(r.location_name)}</span>` : ''}`
        : '<span class="loc-muted">— bez lokacije —</span>';
      const woId = r.work_order_id != null ? String(r.work_order_id) : '';
      const assemblyClass =
        r.location_type === 'ASSEMBLY' || r.location_type === 'SCRAPPED'
          ? ' loc-row-assembled'
          : '';
      const allPlacedNote =
        komRn != null && placed > 0 && placed >= komRn
          ? '<br><span class="loc-muted" style="font-size:11px">✓ raspoređeno u celosti</span>'
          : '';
      return `<tr class="loc-row-click${assemblyClass}" data-wo-id="${escHtml(woId)}" title="Otvori tehnološki postupak (operacije + prijave)">
        <td><strong>${ident}</strong></td>
        <td>${tpNo}</td>
        <td>${cr || '<span class="loc-muted">—</span>'}</td>
        <td>${nz || '<span class="loc-muted">—</span>'}</td>
        <td class="loc-qty-cell">${qtyCell}${allPlacedNote}</td>
        <td>${locCell}</td>
        <td>${escHtml(r.materijal || '')}${r.dimenzija_materijala ? ` <span class="loc-muted">${escHtml(r.dimenzija_materijala)}</span>` : ''}</td>
      </tr>`;
    })
    .join('');
}

function renderPagerHtml({ page, total }) {
  const totalLabel = total == null ? '?' : String(total);
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total ?? (page + 1) * PAGE_SIZE);
  const isLast = total != null ? to >= total : false;
  return `
    <div class="loc-pager" role="navigation" aria-label="Paginacija TP-ova">
      <div class="loc-pager-info"><span>${total === 0 ? '0–0' : `${from}–${to}`} od ${escHtml(totalLabel)}</span></div>
      <div class="loc-pager-controls">
        <button type="button" class="btn btn-xs" id="psPrev" ${page === 0 ? 'disabled' : ''}>← Prethodna</button>
        <button type="button" class="btn btn-xs" id="psNext" ${isLast ? 'disabled' : ''}>Sledeća →</button>
      </div>
    </div>`;
}

/**
 * Otvara modal „Ekran Predmet". Bez argumenata kreće sa praznim selektorom.
 * @param {{ initialItem?: object|null }} [opts]
 */
export function openPredmetScreen(opts = {}) {
  let selectedItem = opts.initialItem || null;
  let page = 0;
  let includeAssembled = false;
  let onlyOpen = true;
  let lastResult = null;

  const html = `
    <div class="loc-predmet-screen" style="display:flex;flex-direction:column;gap:14px">
      ${renderPredmetCombobox({ initialItem: selectedItem })}
      <div class="loc-history-filters" style="gap:14px;align-items:center;flex-wrap:wrap">
        <label class="loc-inline-check"><input type="checkbox" id="psShowAssembled" ${includeAssembled ? 'checked' : ''}><span>Prikaži i ugrađene / otpisane</span></label>
        <label class="loc-inline-check"><input type="checkbox" id="psOnlyOpen" ${onlyOpen ? 'checked' : ''}><span>Samo otvoreni RN (status_rn = false)</span></label>
        <span id="psSummary" class="loc-muted"></span>
      </div>
      <div id="psTableWrap" class="loc-table-wrap" style="max-height:60vh;overflow:auto">
        <table class="loc-table">
          <thead><tr>
            <th>RN (Predmet/TP)</th>
            <th>TP #</th>
            <th>Crtež</th>
            <th>Naziv dela</th>
            <th class="loc-qty-cell">Količina (lok / RN)</th>
            <th>Lokacija</th>
            <th>Materijal</th>
          </tr></thead>
          <tbody id="psRows"><tr><td colspan="7" class="loc-muted" style="padding:24px;text-align:center">Izaberi Predmet iznad da bi se učitala lista tehnoloških postupaka.</td></tr></tbody>
        </table>
      </div>
      <div id="psPager"></div>
    </div>`;

  const root = buildOverlay('Predmet — pregled tehnoloških postupaka i lokacija', html);
  const inputEl = root.querySelector('#psPredmetQ');
  const dropEl = root.querySelector('#psPredmetDrop');
  const tbody = root.querySelector('#psRows');
  const summaryEl = root.querySelector('#psSummary');
  const pagerEl = root.querySelector('#psPager');
  const cbAssembled = root.querySelector('#psShowAssembled');
  const cbOnlyOpen = root.querySelector('#psOnlyOpen');

  function showDrop() { dropEl.style.display = 'block'; }
  function hideDrop() { dropEl.style.display = 'none'; }

  async function refreshDrop(q) {
    const rows = await searchBigtehnItems(q, 50);
    if (!Array.isArray(rows) || rows.length === 0) {
      dropEl.innerHTML = '<div class="loc-muted" style="padding:10px 12px">Nema rezultata.</div>';
    } else {
      dropEl.innerHTML = rows.map(renderItemRow).join('');
      dropEl.querySelectorAll('[data-item-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = Number(btn.getAttribute('data-item-id'));
          const it = rows.find(r => r.id === id);
          if (it) selectItem(it);
        });
      });
    }
    showDrop();
  }

  const onInputDeb = debounce(() => {
    void refreshDrop(inputEl.value);
  }, 250);

  inputEl.addEventListener('input', onInputDeb);
  inputEl.addEventListener('focus', () => {
    void refreshDrop(inputEl.value);
  });
  document.addEventListener('click', ev => {
    if (!root.contains(ev.target)) return;
    if (ev.target !== inputEl && !dropEl.contains(ev.target)) hideDrop();
  });

  function selectItem(item) {
    selectedItem = item;
    inputEl.value = `${item.broj_predmeta} — ${item.naziv_predmeta || ''}`;
    hideDrop();
    page = 0;
    void loadTps();
  }

  cbAssembled.addEventListener('change', () => {
    includeAssembled = !!cbAssembled.checked;
    page = 0;
    void loadTps();
  });
  cbOnlyOpen.addEventListener('change', () => {
    onlyOpen = !!cbOnlyOpen.checked;
    page = 0;
    void loadTps();
  });

  async function loadTps() {
    if (!selectedItem) {
      tbody.innerHTML = '<tr><td colspan="7" class="loc-muted" style="padding:24px;text-align:center">Izaberi Predmet iznad da bi se učitala lista tehnoloških postupaka.</td></tr>';
      summaryEl.textContent = '';
      pagerEl.innerHTML = '';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="7" class="loc-muted" style="padding:24px;text-align:center">Učitavam tehnološke postupke…</td></tr>';
    try {
      const res = await fetchTpsForPredmet(selectedItem.id, {
        onlyOpen,
        includeAssembled,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      lastResult = res;
      const rows = res?.rows || [];
      const total = res?.total ?? 0;
      tbody.innerHTML = renderTpRows(rows);
      summaryEl.innerHTML =
        `Predmet <strong>${escHtml(selectedItem.broj_predmeta || '')}</strong>` +
        (selectedItem.customer_name ? ` · komitent <strong>${escHtml(selectedItem.customer_name)}</strong>` : '') +
        ` · ukupno <strong>${total}</strong> reda` +
        (includeAssembled ? '' : ' (ugrađeni/otpisani sakriveni)');
      pagerEl.innerHTML = renderPagerHtml({ page, total });
      pagerEl.querySelector('#psPrev')?.addEventListener('click', () => {
        if (page > 0) { page -= 1; void loadTps(); }
      });
      pagerEl.querySelector('#psNext')?.addEventListener('click', () => {
        page += 1;
        void loadTps();
      });
      tbody.querySelectorAll('[data-wo-id]').forEach(tr => {
        tr.addEventListener('click', () => {
          const id = Number(tr.getAttribute('data-wo-id'));
          if (Number.isFinite(id) && id > 0) {
            void openTechProcedureModal({ work_order_id: id });
          }
        });
      });
    } catch (err) {
      console.error('[predmetScreen] load TPs failed', err);
      tbody.innerHTML = `<tr><td colspan="7" class="loc-warn">Greška pri učitavanju: ${escHtml(err?.message || String(err))}</td></tr>`;
      showToast(`Učitavanje TP-ova neuspešno: ${err?.message || err}`);
    }
  }

  if (selectedItem) {
    void loadTps();
  } else {
    void refreshDrop('');
  }
}

export function teardownPredmetScreen() {
  closeOverlay();
}
