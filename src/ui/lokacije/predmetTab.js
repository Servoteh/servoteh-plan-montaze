/**
 * Lokacije — tab „Pregled predmeta".
 *
 * Pun ekran (ne modal) u sklopu modula Lokacije. Tok:
 *   1. Ako predmet nije izabran → vidljiva pretraga + lista BigTehn predmeta.
 *      Korisnik klikne red → state.predmetSelected se postavi i tab se
 *      re-render-uje sa drugim layout-om.
 *   2. Ako je predmet izabran → vidljiv header sa ID/naziv/komitent + filteri
 *      (TP, Crtež, Sa/Bez lokacije, Ugrađeni) + tabela
 *      tehnoloških postupaka iz `loc_tps_for_predmet` (v3 — server-side
 *      PREFIX match na TP/crtež + has_pdf flag iz bigtehn_drawings_cache)
 *      + Print/Export PDF/Export CSV/Promeni-predmet dugmad.
 *
 * Sve UI state je u `state/lokacije.js` (perzistira u localStorage), pa
 * povratak na tab čuva izabrani predmet i filtere. Klik na red u tabeli
 * otvara postojeći `openTechProcedureModal` iz Plan Proizvodnje.
 *
 * Pored crteža gde u BigTehn arhivi postoji PDF (`storage_path != null`)
 * prikazuje se 📄 ikonica koja kroz `openDrawingPdf` otvara signed URL
 * iz Supabase Storage bucket-a `bigtehn-drawings` u novom tabu.
 *
 * Ne piše u bazu. Sve sortiranje/filtriranje radi se na serveru (RPC).
 */

import { escHtml } from '../../lib/dom.js';
import { rowsToCsv, CSV_BOM } from '../../lib/csv.js';
import {
  searchBigtehnItems,
  fetchTpsForPredmet,
} from '../../services/lokacije.js';
import { openDrawingPdf } from '../../services/drawings.js';
import {
  getLokacijeUiState,
  setPredmetSelected,
  clearPredmetSelected,
  setPredmetFilters,
  resetPredmetFilters,
  setPredmetPage,
  setPredmetPageSize,
} from '../../state/lokacije.js';
import { openTechProcedureModal } from '../planProizvodnje/techProcedureModal.js';

const PAGE_SIZE_OPTIONS = [50, 100, 200, 500];

/**
 * Glavni ulaz — render-uje ceo Predmet tab u dati host element.
 * @param {HTMLElement} host
 * @param {{ onRefresh: () => void|Promise<void> }} [opts]
 */
export async function renderPredmetTab(host, { onRefresh } = {}) {
  if (!host) return;
  const ui = getLokacijeUiState();
  const refresh = typeof onRefresh === 'function' ? onRefresh : () => renderPredmetTab(host, { onRefresh });

  if (!ui.predmetSelected) {
    await renderPickerView(host, refresh);
    return;
  }
  await renderDataView(host, refresh);
}

/* ── 1) Picker view: lista predmeta za izbor ─────────────────────────────── */

async function renderPickerView(host, refresh) {
  /* Početni HTML — input + lista placeholder. Lista se puni tek nakon prvog
   * fetch-a; dok traje, prikazujemo „Učitavam…" stanje. */
  host.innerHTML = `
    <div class="kadr-panel active loc-panel">
      <h2 class="loc-subh" style="margin:0 0 6px;letter-spacing:0.5px">PREGLED PREDMETA</h2>
      <p class="loc-muted" style="margin:0 0 14px">
        Izaberi jedan Predmet (BigTehn, status „U TOKU"). Posle izbora ćeš videti
        sve njegove tehnološke postupke (RN-ove) sa lokacijama i moći da filtriraš,
        štampaš i exportuješ rezultate.
      </p>
      <div class="loc-predmet-picker" style="display:flex;flex-direction:column;gap:12px;max-width:960px">
        <label class="loc-filter-field" style="max-width:480px">
          <span>Pretraga po broju predmeta, nazivu, ugovoru ili narudžbenici</span>
          <input type="search" id="lpPickerQ" class="loc-search-input"
            placeholder="npr. 7351, 'sistem za…', ugovor, narudžbenica"
            title="Kucaj broj predmeta (npr. 7351), deo naziva, broj ugovora ili narudžbenice. Lista se filtrira automatski dok kucaš."
            autocomplete="off" />
        </label>
        <div id="lpPickerList" class="loc-picker-list"
          title="Klik na red bira Predmet i otvara pregled svih njegovih tehnoloških postupaka (RN-ova) sa lokacijama"
          style="border:1px solid var(--border2,#ccc);border-radius:6px;background:var(--surface,#fff);min-height:200px;max-height:62vh;overflow:auto">
          <div class="loc-muted" style="padding:14px">Učitavam aktuelne predmete…</div>
        </div>
      </div>
    </div>`;

  const inputEl = host.querySelector('#lpPickerQ');
  const listEl = host.querySelector('#lpPickerList');

  let lastReqId = 0;

  async function refreshList(q) {
    const reqId = ++lastReqId;
    listEl.innerHTML = '<div class="loc-muted" style="padding:14px">Učitavam predmete…</div>';
    let rows;
    try {
      rows = await searchBigtehnItems(q, 100);
    } catch (err) {
      if (reqId !== lastReqId) return;
      listEl.innerHTML = `<div class="loc-warn" style="padding:14px">Greška pretrage: ${escHtml(err?.message || String(err))}</div>`;
      return;
    }
    if (reqId !== lastReqId) return;
    if (!Array.isArray(rows) || rows.length === 0) {
      const msg = q
        ? 'Nema aktuelnih predmeta za zadati upit.'
        : 'Nema aktuelnih predmeta sa statusom „U TOKU".';
      listEl.innerHTML = `<div class="loc-muted" style="padding:14px">${escHtml(msg)}</div>`;
      return;
    }
    listEl.innerHTML = rows.map(renderPickerRowHtml).join('');
    listEl.querySelectorAll('[data-pick-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = Number(btn.getAttribute('data-pick-id'));
        const it = rows.find(r => r.id === id);
        if (!it) return;
        setPredmetSelected({
          id: it.id,
          broj_predmeta: it.broj_predmeta,
          naziv_predmeta: it.naziv_predmeta,
          customer_name: it.customer_name,
        });
        void refresh();
      });
    });
  }

  let debTimer = null;
  inputEl.addEventListener('input', () => {
    clearTimeout(debTimer);
    debTimer = setTimeout(() => refreshList(inputEl.value), 220);
  });
  inputEl.focus();
  await refreshList('');
}

function renderPickerRowHtml(item) {
  const code = escHtml(item.broj_predmeta || '');
  const naz = escHtml(item.naziv_predmeta || '');
  const cust = item.customer_name ? `<span class="loc-muted"> · ${escHtml(item.customer_name)}</span>` : '';
  const ug = item.broj_ugovora ? `<span class="loc-muted"> · ugovor ${escHtml(item.broj_ugovora)}</span>` : '';
  const nar = item.broj_narudzbenice ? `<span class="loc-muted"> · NAR ${escHtml(item.broj_narudzbenice)}</span>` : '';
  const rok = item.rok_zavrsetka ? `<span class="loc-muted"> · rok ${escHtml(String(item.rok_zavrsetka).slice(0, 10))}</span>` : '';
  return `<button type="button" class="loc-picker-row" data-pick-id="${escHtml(String(item.id))}"
    title="Otvori pregled predmeta ${code} sa svim tehnološkim postupcima i njihovim lokacijama"
    style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid var(--border2,#eee);padding:10px 14px;background:transparent;cursor:pointer">
    <div style="font-size:14px"><strong>${code}</strong> · ${naz}</div>
    <div style="font-size:12px;margin-top:2px">${cust}${ug}${nar}${rok}</div>
  </button>`;
}

/* ── 2) Data view: izabrani predmet + tabela TP-ova ──────────────────────── */

async function renderDataView(host, refresh) {
  const ui = getLokacijeUiState();
  const sel = ui.predmetSelected;
  const f = ui.predmetFilters;
  const page = ui.predmetPage;
  const pageSize = ui.predmetPageSize;

  /* Render shell odmah pa pošalji asinhroni fetch — odziv je trenutan i
   * korisnik vidi izabrani Predmet i filtere bez čekanja na RPC. */
  host.innerHTML = `
    <div class="kadr-panel active loc-panel">
      <h2 class="loc-subh" style="margin:0 0 10px;letter-spacing:0.5px">PREGLED PREDMETA</h2>
      ${renderHeaderHtml(sel)}
      ${renderFiltersHtml(f)}
      <div class="loc-predmet-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
        <button type="button" class="btn btn-xs" id="lpApply"
          title="Primeni unete filtere (Broj TP, Crtež, Lokacija, Ugrađeni) i ponovo učitaj listu aktivnih RN-ova sa servera">Primeni filtere</button>
        <button type="button" class="btn btn-xs" id="lpReset"
          title="Vrati sve filtere na podrazumevane vrednosti (prazan TP/crtež, sve lokacije, bez ugrađenih)">Resetuj filtere</button>
        <span style="flex:1"></span>
        <button type="button" class="btn btn-xs" id="lpPrint"
          title="Otvori novi prozor sa formatiranom tabelom svih trenutno filtriranih redova i automatski pokreni dijalog štampe">🖨 Štampa</button>
        <button type="button" class="btn btn-xs" id="lpExportPdf"
          title="Otvori formatiranu stranicu za štampu — u dijalogu izaberi „Sačuvaj kao PDF" da dobiješ PDF fajl izveštaja">📄 Export PDF</button>
        <button type="button" class="btn btn-xs" id="lpExportCsv"
          title="Preuzmi CSV (Excel kompatibilan, UTF-8 BOM) sa SVIM redovima koji odgovaraju trenutnim filterima — ide kroz sve stranice (do 50 000 redova)">⬇ Export CSV</button>
      </div>
      <div id="lpSummary" class="loc-muted" style="margin:6px 0">Učitavam…</div>
      <div class="loc-table-wrap">
        <table class="loc-table">
          <thead><tr>
            <th title="Pun ident broj radnog naloga: format Predmet/TP (npr. 7351/1088)">RN (Predmet/TP)</th>
            <th title="Drugi deo ident broja — broj tehnološkog postupka unutar predmeta">TP #</th>
            <th title="Broj crteža iz BigTehn baze. Ako postoji PDF crteža, prikazuje se ikonica za otvaranje">Crtež</th>
            <th title="Naziv dela / pozicije iz tehnološkog postupka">Naziv dela</th>
            <th class="loc-qty-cell" title="Količina koja se nalazi na konkretnoj lokaciji / ukupna količina po RN-u">Količina (lok / RN)</th>
            <th title="Lokacija na kojoj se deo nalazi (šifra i naziv). Ako je polje prazno — deo još nije postavljen ni na jednu lokaciju">Lokacija</th>
            <th title="Materijal i dimenzija materijala iz tehnološkog postupka">Materijal</th>
          </tr></thead>
          <tbody id="lpRows"><tr><td colspan="7" class="loc-muted" style="padding:24px;text-align:center">Učitavam tehnološke postupke…</td></tr></tbody>
        </table>
      </div>
      <div id="lpPager"></div>
    </div>`;

  attachHeaderHandlers(host, refresh);
  attachFilterHandlers(host, refresh);

  /* Fetch + render tabele */
  let res;
  try {
    res = await fetchTpsForPredmet(sel.id, {
      onlyOpen: true,
      includeAssembled: f.includeAssembled,
      tpNo: f.tpNo,
      drawingNo: f.drawingNo,
      locationFilter: f.locationFilter,
      limit: pageSize,
      offset: page * pageSize,
    });
  } catch (err) {
    console.error('[predmetTab] fetchTpsForPredmet failed', err);
    host.querySelector('#lpRows').innerHTML =
      `<tr><td colspan="7" class="loc-warn" style="padding:18px">Greška pri učitavanju: ${escHtml(err?.message || String(err))}</td></tr>`;
    host.querySelector('#lpSummary').textContent = '';
    return;
  }

  const rows = res?.rows || [];
  const total = res?.total ?? 0;

  host.querySelector('#lpRows').innerHTML = renderTpRowsHtml(rows);
  host.querySelector('#lpSummary').innerHTML = renderSummaryHtml({ sel, total, page, pageSize, rowsLen: rows.length, filters: f });
  host.querySelector('#lpPager').innerHTML = renderPagerHtml({ page, pageSize, total });

  attachTableRowClicks(host);
  attachPagerHandlers(host, refresh);
  attachExportPrintHandlers(host, sel, f);
}

function renderHeaderHtml(sel) {
  const cust = sel.customer_name ? ` <span class="loc-muted">· ${escHtml(sel.customer_name)}</span>` : '';
  return `
    <div class="loc-predmet-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;padding:10px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--text2)">Izabrani Predmet</div>
        <div style="font-size:18px;font-weight:600;line-height:1.2">
          ${escHtml(sel.broj_predmeta || '')} <span class="loc-muted">·</span> ${escHtml(sel.naziv_predmeta || '')}
          ${cust}
        </div>
      </div>
      <button type="button" class="btn btn-xs" id="lpChangePredmet"
        title="Vrati se na izbor predmeta — bira drugi predmet bez napuštanja Lokacije modula">↻ Promeni predmet</button>
    </div>`;
}

function renderFiltersHtml(f) {
  const lf = f.locationFilter;
  return `
    <div class="loc-history-filters" role="group" aria-label="Filteri u okviru Predmeta" style="gap:14px;align-items:flex-end;flex-wrap:wrap">
      <label class="loc-filter-field"
        title="Filter po broju tehnološkog postupka (drugi deo ident-a iza /). Pretraga je „počinje sa…": unos 10 prikazuje 10, 100, 1014, 1015 — zato što je TP 10 sklop, a 100/101/1014/1015 njegovi podsklopovi/crteži.">
        <span>Broj TP (počinje sa…)</span>
        <input type="text" id="lpFiltTp" class="loc-search-input" value="${escHtml(f.tpNo)}" maxlength="12" inputmode="numeric"
          placeholder="npr. 10 (matchuje 10, 100, 101, 1014…)"
          title="Unos „10" pronalazi sve TP-ove koji počinju sa 10 (10, 100, 101, 1014, 1015…). Korisno za hijerarhiju sklopova. Pritisni Enter ili „Primeni filtere"." />
      </label>
      <label class="loc-filter-field"
        title="Filter po broju crteža (počinje sa…). Case-insensitive — npr. unos „1084" pronalazi 1084924 i sve revizije koje počinju sa 1084.">
        <span>Broj crteža (počinje sa…)</span>
        <input type="text" id="lpFiltDr" class="loc-search-input" value="${escHtml(f.drawingNo)}" maxlength="40"
          placeholder="npr. 1084 (matchuje 1084924, 1084925…)"
          title="Pretraga „počinje sa…". Pritisni Enter ili „Primeni filtere" za pokretanje." />
      </label>
      <label class="loc-filter-field"
        title="Filter po prisutnosti lokacije: prikaži sve, samo TP-ove koji imaju aktivan placement, ili samo one BEZ ijedne lokacije.">
        <span>Lokacija</span>
        <select id="lpFiltLoc" class="loc-search-input"
          title="Svi = i sa i bez lokacije. Sa lokacijom = bar jedan aktivan placement. BEZ lokacije = nije postavljeno nigde.">
          <option value="all"${lf === 'all' ? ' selected' : ''}>Svi (sa i bez lokacije)</option>
          <option value="with"${lf === 'with' ? ' selected' : ''}>Samo sa lokacijom</option>
          <option value="without"${lf === 'without' ? ' selected' : ''}>Samo BEZ lokacije</option>
        </select>
      </label>
      <label class="loc-inline-check" title="Uključi i delove koji su već ugrađeni u finalni proizvod (lokacija UGRADJENO/ASSEMBLY) ili otpisani (SCRAPPED). Po default-u su sakriveni jer su završeni.">
        <input type="checkbox" id="lpFiltAssembled" ${f.includeAssembled ? 'checked' : ''}>
        <span>Prikaži i ugrađene / otpisane</span>
      </label>
      <span class="loc-muted" title="Pregled uvek koristi ručnu MES listu aktivnih RN-ova. BigTehn status otvoren/zatvoren ostaje samo informativan u exportu.">Samo aktivni RN</span>
    </div>`;
}

function attachHeaderHandlers(host, refresh) {
  host.querySelector('#lpChangePredmet')?.addEventListener('click', () => {
    clearPredmetSelected();
    void refresh();
  });
}

function attachFilterHandlers(host, refresh) {
  /* "Primeni" je eksplicitan da korisnik ne pokreće RPC za svaki tipkani znak.
   * Enter u text input-ima takođe primenjuje filtere. */
  const apply = () => {
    setPredmetFilters({
      tpNo: host.querySelector('#lpFiltTp')?.value || '',
      drawingNo: host.querySelector('#lpFiltDr')?.value || '',
      locationFilter: host.querySelector('#lpFiltLoc')?.value || 'all',
      includeAssembled: !!host.querySelector('#lpFiltAssembled')?.checked,
      onlyOpen: true,
    });
    void refresh();
  };

  host.querySelector('#lpApply')?.addEventListener('click', apply);
  host.querySelector('#lpReset')?.addEventListener('click', () => {
    resetPredmetFilters();
    void refresh();
  });

  host.querySelector('#lpFiltTp')?.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
  host.querySelector('#lpFiltDr')?.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });

  /* Dropdown i checkbox su jeftini — odmah primeni. */
  host.querySelector('#lpFiltLoc')?.addEventListener('change', apply);
  host.querySelector('#lpFiltAssembled')?.addEventListener('change', apply);
}

function renderTpRowsHtml(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<tr><td colspan="7" class="loc-muted" style="padding:18px;text-align:center">Nema tehnoloških postupaka za zadati filter.</td></tr>';
  }
  return rows.map(renderTpRowHtml).join('');
}

function renderTpRowHtml(r) {
  const ident = escHtml(r.wo_ident_broj || '');
  const tpNo = escHtml(r.tp_no || '');
  const crRaw = r.wo_broj_crteza || '';
  const cr = escHtml(crRaw);
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
  /* PDF ikonica: prikaži samo ako u bigtehn_drawings_cache postoji storage_path
   * za ovaj broj crteža (RPC vraća has_pdf=true). Klik = stopPropagation pa
   * red ne otvara TP modal. data-pdf-drawing nosi broj crteža za handler. */
  const pdfBtn = (crRaw && r.has_pdf === true)
    ? ` <button type="button" class="loc-pdf-btn" data-pdf-drawing="${cr}"
        title="Otvori PDF crteža ${cr} u novom tabu (BigTehn arhiva)"
        aria-label="Otvori PDF crteža ${cr}"
        style="border:none;background:transparent;cursor:pointer;padding:0 2px;font-size:14px;line-height:1;vertical-align:middle">📄</button>`
    : '';
  return `<tr class="loc-row-click${assemblyClass}" data-wo-id="${escHtml(woId)}" title="Klikni red da otvoriš tehnološki postupak: operacije, prijave radova i detalje (modal iz Plan Proizvodnje)">
    <td><strong>${ident}</strong></td>
    <td>${tpNo}</td>
    <td>${cr ? `${cr}${pdfBtn}` : '<span class="loc-muted">—</span>'}</td>
    <td>${nz || '<span class="loc-muted">—</span>'}</td>
    <td class="loc-qty-cell">${qtyCell}${allPlacedNote}</td>
    <td>${locCell}</td>
    <td>${escHtml(r.materijal || '')}${r.dimenzija_materijala ? ` <span class="loc-muted">${escHtml(r.dimenzija_materijala)}</span>` : ''}</td>
  </tr>`;
}

function renderSummaryHtml({ sel, total, page, pageSize, rowsLen, filters }) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = page * pageSize + rowsLen;
  const filtSummary = [];
  if (filters.tpNo) filtSummary.push(`TP <strong>${escHtml(filters.tpNo)}</strong>`);
  if (filters.drawingNo) filtSummary.push(`crtež <strong>${escHtml(filters.drawingNo)}</strong>`);
  if (filters.locationFilter === 'with') filtSummary.push('samo sa lokacijom');
  if (filters.locationFilter === 'without') filtSummary.push('samo BEZ lokacije');
  filtSummary.push('samo aktivni RN');
  if (filters.includeAssembled) filtSummary.push('+ ugrađeni / otpisani');
  const filtStr = filtSummary.length ? ` · filteri: ${filtSummary.join(', ')}` : '';
  return `
    <span>Predmet <strong>${escHtml(sel.broj_predmeta || '')}</strong>${sel.customer_name ? ` · komitent <strong>${escHtml(sel.customer_name)}</strong>` : ''}</span>
    <span> · prikazano <strong>${total === 0 ? '0–0' : `${from}–${to}`}</strong> od <strong>${escHtml(String(total))}</strong> reda${filtStr}</span>`;
}

function renderPagerHtml({ page, pageSize, total }) {
  const isLast = (page + 1) * pageSize >= total;
  const sizeOpts = PAGE_SIZE_OPTIONS
    .map(n => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`)
    .join('');
  return `
    <div class="loc-pager" role="navigation" aria-label="Paginacija TP-ova predmeta">
      <div class="loc-pager-info"><span>Strana ${page + 1} od ${Math.max(1, Math.ceil(total / pageSize))}</span></div>
      <div class="loc-pager-controls">
        <label class="loc-pager-size" title="Broj redova po stranici. Veće vrednosti opterećuju pretraživač pri velikim predmetima.">
          <span>Po stranici:</span>
          <select id="lpPageSize" title="Izaberi koliko TP-ova da se prikaže po stranici">${sizeOpts}</select>
        </label>
        <button type="button" class="btn btn-xs" id="lpPrev" ${page === 0 ? 'disabled' : ''}
          title="Idi na prethodnu stranicu rezultata">← Prethodna</button>
        <button type="button" class="btn btn-xs" id="lpNext" ${isLast ? 'disabled' : ''}
          title="Idi na sledeću stranicu rezultata">Sledeća →</button>
      </div>
    </div>`;
}

function attachTableRowClicks(host) {
  /* PDF dugme prvo — stopPropagation sprečava da klik na ikonicu i otvori
   * TP modal kao "klik na red". Open u novom tabu kroz signed URL. */
  host.querySelectorAll('#lpRows [data-pdf-drawing]').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      ev.preventDefault();
      const drawing = btn.getAttribute('data-pdf-drawing') || '';
      if (drawing) void openDrawingPdf(drawing);
    });
  });

  host.querySelectorAll('#lpRows [data-wo-id]').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = Number(tr.getAttribute('data-wo-id'));
      if (Number.isFinite(id) && id > 0) {
        void openTechProcedureModal({ work_order_id: id });
      }
    });
  });
}

function attachPagerHandlers(host, refresh) {
  host.querySelector('#lpPrev')?.addEventListener('click', () => {
    const ui = getLokacijeUiState();
    if (ui.predmetPage > 0) {
      setPredmetPage(ui.predmetPage - 1);
      void refresh();
    }
  });
  host.querySelector('#lpNext')?.addEventListener('click', () => {
    const ui = getLokacijeUiState();
    setPredmetPage(ui.predmetPage + 1);
    void refresh();
  });
  host.querySelector('#lpPageSize')?.addEventListener('change', e => {
    setPredmetPageSize(Number(e.target.value));
    void refresh();
  });
}

/* ── Print / Export PDF / Export CSV ─────────────────────────────────────── */

function attachExportPrintHandlers(host, sel, filters) {
  host.querySelector('#lpExportCsv')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    if (!(btn instanceof HTMLButtonElement)) return;
    const orig = btn.textContent || 'Export CSV';
    btn.disabled = true;
    btn.textContent = 'Export…';
    try {
      const all = await fetchAllFiltered(sel, filters, p => {
        btn.textContent = `Export… ${p.loaded}/${p.total ?? '?'}`;
      });
      if (!all.rows.length) {
        alert('Nema redova za export sa trenutnim filterima.');
        return;
      }
      const csv = CSV_BOM + buildCsvText(all.rows);
      downloadBlob(csv, buildExportFilename(sel, 'csv'), 'text/csv;charset=utf-8');
    } catch (err) {
      console.error('[predmetTab] CSV export failed', err);
      alert(`Export neuspešan: ${err?.message || err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  const printOrPdf = async (mode) => {
    const btnId = mode === 'pdf' ? '#lpExportPdf' : '#lpPrint';
    const btn = host.querySelector(btnId);
    if (!(btn instanceof HTMLButtonElement)) return;
    const orig = btn.textContent || (mode === 'pdf' ? '📄 Export PDF' : '🖨 Štampa');
    btn.disabled = true;
    btn.textContent = mode === 'pdf' ? 'Pripremam PDF…' : 'Pripremam…';
    try {
      const all = await fetchAllFiltered(sel, filters, p => {
        btn.textContent = `${mode === 'pdf' ? 'PDF' : 'Štampa'}… ${p.loaded}/${p.total ?? '?'}`;
      });
      openPrintWindow({ rows: all.rows, total: all.total, sel, filters, mode });
    } catch (err) {
      console.error('[predmetTab] print/pdf failed', err);
      alert(`Greška: ${err?.message || err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  };
  host.querySelector('#lpPrint')?.addEventListener('click', () => printOrPdf('print'));
  host.querySelector('#lpExportPdf')?.addEventListener('click', () => printOrPdf('pdf'));
}

/**
 * Dovuče SVE redove koji odgovaraju trenutnim filterima (kroz više page-ova).
 * Limit po pozivu je 1000 (server-side cap), pa se ide u petlji dok god ima.
 * Sigurnosni cap od 50 000 redova da slučajno ne urušimo pregledač.
 */
async function fetchAllFiltered(sel, filters, onProgress) {
  const PAGE = 1000;
  const MAX_ROWS = 50000;
  const all = [];
  let offset = 0;
  let total = null;
  while (true) {
    const res = await fetchTpsForPredmet(sel.id, {
      onlyOpen: true,
      includeAssembled: filters.includeAssembled,
      tpNo: filters.tpNo,
      drawingNo: filters.drawingNo,
      locationFilter: filters.locationFilter,
      limit: PAGE,
      offset,
    });
    if (!res || !Array.isArray(res.rows)) break;
    if (total == null) total = res.total ?? null;
    all.push(...res.rows);
    if (typeof onProgress === 'function') onProgress({ loaded: all.length, total });
    if (res.rows.length < PAGE) break;
    offset += PAGE;
    if (all.length >= MAX_ROWS) break;
    if (total != null && all.length >= total) break;
  }
  return { rows: all, total: total ?? all.length };
}

function buildCsvText(rows) {
  const headers = [
    'RN (Predmet/TP)',
    'Broj TP',
    'Broj crteža',
    'Naziv dela',
    'Materijal',
    'Dimenzija materijala',
    'Komada (RN)',
    'Količina na lokaciji',
    'Ukupno raspoređeno',
    'Lokacija šifra',
    'Lokacija naziv',
    'Putanja lokacije',
    'Tip lokacije',
    'Status placement',
    'Status RN',
    'Revizija',
    'Rok izrade',
    'Težina obr (kg)',
  ];
  const data = rows.map(r => [
    r.wo_ident_broj || '',
    r.tp_no || '',
    r.wo_broj_crteza || '',
    r.naziv_dela || '',
    r.materijal || '',
    r.dimenzija_materijala || '',
    r.komada_rn ?? '',
    r.qty_on_location ?? '',
    r.qty_total_placed ?? '',
    r.location_code || '',
    r.location_name || '',
    r.location_path || '',
    r.location_type || '',
    r.placement_status || '',
    r.status_rn === true ? 'Zatvoren' : r.status_rn === false ? 'Otvoren' : '',
    r.revizija || '',
    r.rok_izrade ? String(r.rok_izrade).slice(0, 10) : '',
    r.tezina_obr != null && Number(r.tezina_obr) > 0 ? Number(r.tezina_obr).toFixed(2) : '',
  ]);
  return rowsToCsv(headers, data);
}

function buildExportFilename(sel, ext) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const code = (sel?.broj_predmeta || 'predmet').toString().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 30);
  return `lokacije_predmet_${code}_${ts}.${ext}`;
}

function downloadBlob(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

/**
 * Otvori novi prozor sa formatiranom HTML stranicom za štampu.
 * Korisnik u dijalogu štampe bira "Sačuvaj kao PDF" za PDF export
 * (mode='pdf' samo menja default naslov i hint).
 */
function openPrintWindow({ rows, total, sel, filters, mode }) {
  const win = window.open('', '_blank', 'width=1200,height=900');
  if (!win) {
    alert('Pop-up blocker je sprečio otvaranje prozora za štampu. Dozvoli pop-up za ovaj sajt.');
    return;
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateLabel =
    `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;

  const filtChips = [];
  if (filters.tpNo) filtChips.push(`TP: ${escHtml(filters.tpNo)}`);
  if (filters.drawingNo) filtChips.push(`Crtež: ${escHtml(filters.drawingNo)}`);
  if (filters.locationFilter === 'with') filtChips.push('Samo sa lokacijom');
  else if (filters.locationFilter === 'without') filtChips.push('Samo BEZ lokacije');
  filtChips.push('Samo aktivni RN');
  if (filters.includeAssembled) filtChips.push('Uključeni ugrađeni/otpisani');
  const filtHtml = filtChips.length
    ? `<div class="filt"><strong>Filteri:</strong> ${filtChips.join(' · ')}</div>`
    : '<div class="filt"><strong>Filteri:</strong> nema (svi tehnološki postupci ovog predmeta)</div>';

  const tableBody = rows.map(r => {
    const qtyLoc = r.qty_on_location != null ? r.qty_on_location : '';
    const qtyRn = r.komada_rn != null ? r.komada_rn : '';
    const loc = r.location_code
      ? `${escHtml(r.location_code)}${r.location_name ? ` — ${escHtml(r.location_name)}` : ''}`
      : '<span class="muted">— bez lokacije —</span>';
    const status = r.status_rn === true ? 'Zatvoren' : r.status_rn === false ? 'Otvoren' : '';
    return `<tr>
      <td><strong>${escHtml(r.wo_ident_broj || '')}</strong></td>
      <td>${escHtml(r.wo_broj_crteza || '')}</td>
      <td>${escHtml(String(r.naziv_dela || '').slice(0, 80))}</td>
      <td class="num">${escHtml(String(qtyLoc))}${qtyRn !== '' ? ` <span class="muted">/ ${escHtml(String(qtyRn))}</span>` : ''}</td>
      <td>${loc}</td>
      <td>${escHtml(String(r.materijal || ''))}${r.dimenzija_materijala ? ` <span class="muted">${escHtml(r.dimenzija_materijala)}</span>` : ''}</td>
      <td>${escHtml(status)}</td>
    </tr>`;
  }).join('');

  const docTitle = `Predmet ${sel.broj_predmeta || ''} — lokacije TP`;
  const html = `<!doctype html>
<html lang="sr">
<head>
<meta charset="utf-8" />
<title>${escHtml(docTitle)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 18mm 12mm 14mm; color: #111; font-size: 11px; }
  h1 { margin: 0 0 4px; font-size: 16px; }
  h2 { margin: 0 0 10px; font-size: 13px; font-weight: 500; color: #333; }
  .meta { margin: 6px 0 12px; font-size: 11px; color: #444; }
  .filt { margin: 6px 0 12px; font-size: 11px; color: #333; padding: 6px 8px; background: #f3f4f6; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  thead th { background: #e5e7eb; text-align: left; padding: 6px 8px; border: 1px solid #9ca3af; font-weight: 600; }
  tbody td { padding: 5px 8px; border: 1px solid #d1d5db; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f9fafb; }
  td.num { text-align: right; }
  .muted { color: #6b7280; }
  .actions { margin: 0 0 12px; }
  .actions button { font-size: 12px; padding: 6px 12px; cursor: pointer; }
  @media print {
    .actions { display: none !important; }
    body { margin: 12mm 8mm 10mm; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <div class="actions">
    <button type="button" onclick="window.print()">${mode === 'pdf' ? 'Sačuvaj kao PDF (preko dijaloga štampe)' : 'Štampaj'}</button>
    <button type="button" onclick="window.close()">Zatvori</button>
    ${mode === 'pdf' ? '<span class="muted" style="margin-left:8px">U dijalogu štampe izaberi „Sačuvaj kao PDF" kao destinaciju.</span>' : ''}
  </div>
  <h1>Predmet ${escHtml(sel.broj_predmeta || '')} — ${escHtml(sel.naziv_predmeta || '')}</h1>
  ${sel.customer_name ? `<h2>Komitent: ${escHtml(sel.customer_name)}</h2>` : ''}
  <div class="meta">Datum izveštaja: ${escHtml(dateLabel)} · Ukupno redova: ${escHtml(String(total))}</div>
  ${filtHtml}
  <table>
    <thead><tr>
      <th>RN (Predmet/TP)</th>
      <th>Crtež</th>
      <th>Naziv dela</th>
      <th class="num">Količina (lok / RN)</th>
      <th>Lokacija</th>
      <th>Materijal</th>
      <th>Status RN</th>
    </tr></thead>
    <tbody>${tableBody || '<tr><td colspan="7" class="muted" style="text-align:center;padding:14px">Nema redova za zadate filtere.</td></tr>'}</tbody>
  </table>
  <script>
    window.addEventListener('load', () => {
      ${mode === 'pdf' ? "setTimeout(() => window.print(), 250);" : ''}
    });
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
  if (mode === 'print') {
    /* Za "Štampa" odmah otvori print dijalog. PDF mode čeka load + 250ms da
     * se font-ovi stignu primeniti. */
    setTimeout(() => {
      try { win.print(); } catch { /* ignore */ }
    }, 200);
  }
}
