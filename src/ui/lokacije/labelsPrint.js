/**
 * Nalepnice — priprema podataka, print-ready HTML, štampa u pregledaču (Ctrl+P).
 * Opcioni LAN adapter: `VITE_LABEL_PRINTER_PROXY_URL` (POST JSON) za TSC gateway.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  fetchLocations,
  searchBigtehnItems,
  searchBigtehnWorkOrdersForItem,
} from '../../services/lokacije.js';
import { formatBigTehnRnzBarcode, formatBigTehnShortBarcode } from '../../lib/barcodeParse.js';

const SHELF_TYPES = ['SHELF', 'RACK', 'BIN'];

function removeEl(id) {
  document.getElementById(id)?.remove();
}

function bindEsc(onClose) {
  const h = ev => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    }
  };
  document.addEventListener('keydown', h);
  return () => document.removeEventListener('keydown', h);
}

/**
 * @param {{ mode: 'shelf'|'tech_process', payload: object }} args
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function dispatchOptionalNetworkLabelPrint(args) {
  const url =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LABEL_PRINTER_PROXY_URL) || '';
  if (!url || typeof url !== 'string') {
    return { ok: false, reason: 'no_proxy_url' };
  }
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    return { ok: r.ok, reason: r.ok ? undefined : `http_${r.status}` };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

function labelHtml(loc) {
  const code = escHtml(loc.location_code || '');
  const name = escHtml(loc.name || '');
  return `
    <div class="label">
      <div class="label-code">${code}</div>
      <svg id="bc_${escHtml(String(loc.id))}" class="label-barcode"></svg>
      <div class="label-name">${name}</div>
    </div>`;
}

function labelsHtmlShell(count) {
  return `<!DOCTYPE html>
<html lang="sr-Latn">
<head>
  <meta charset="UTF-8">
  <title>Nalepnice polica (${count})</title>
  <style>
    @page { size: A4; margin: 8mm; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #000; background: #fff;
    }
    .toolbar {
      position: sticky; top: 0; z-index: 10;
      padding: 10px 16px; background: #eef;
      border-bottom: 1px solid #99c;
      font-size: 13px; color: #234;
    }
    .toolbar button {
      padding: 6px 14px; margin-left: 8px; cursor: pointer;
      font-size: 13px; border: 1px solid #334; background: #fff; border-radius: 4px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 4mm;
      padding: 10px 16px 24px;
    }
    .label {
      border: 1px dashed #666;
      border-radius: 2mm;
      padding: 4mm 4mm 3mm;
      text-align: center;
      min-height: 35mm;
      page-break-inside: avoid;
      break-inside: avoid;
      display: flex; flex-direction: column; justify-content: center; align-items: center;
      gap: 2mm;
    }
    .label-code {
      font-size: 20pt; font-weight: 800; letter-spacing: 1px;
      font-family: 'Courier New', monospace;
      line-height: 1;
    }
    .label-barcode { display: block; width: 100%; height: auto; max-height: 20mm; }
    .label-name {
      font-size: 9pt; color: #333; line-height: 1.2;
      text-transform: uppercase;
      word-break: break-word;
    }
    @media print {
      .toolbar { display: none; }
      .grid { padding: 0; gap: 3mm; }
      .label { border: 1px solid #000; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    Nalepnice polica: <strong>${count}</strong>.
    Pritisni <strong>Ctrl + P</strong> za štampu.
    <button onclick="window.print()">Štampaj</button>
    <button onclick="window.close()">Zatvori</button>
  </div>
  <div id="labelGrid" class="grid">
    ${Array.from({ length: count })
      .map(() => '<div class="label"><svg class="label-barcode"></svg></div>')
      .join('')}
  </div>
</body>
</html>`;
}

/**
 * Otvara novi prozor sa jednom ili više nalepnica polica (Code128 = location_code).
 *
 * @param {object[]} locs
 */
export async function printShelfLabelsToBrowserWindow(locs) {
  if (!Array.isArray(locs) || !locs.length) {
    showToast('⚠ Nema lokacija za štampu');
    return;
  }

  const mod = await import('jsbarcode');
  const JsBarcode = mod.default || mod;

  const w = window.open('', '_blank');
  if (!w) {
    showToast('⚠ Dozvoli pop-up da bi štampao nalepnice');
    return;
  }

  w.document.write(labelsHtmlShell(locs.length));
  w.document.close();

  const runWhenReady = () => {
    try {
      const host = w.document.getElementById('labelGrid');
      host.innerHTML = locs.map(labelHtml).join('');
      locs.forEach(loc => {
        const svg = w.document.getElementById(`bc_${loc.id}`);
        if (!svg) return;
        JsBarcode(svg, String(loc.location_code || '').trim(), {
          format: 'CODE128',
          displayValue: false,
          margin: 0,
          height: 50,
          width: 2,
          background: '#ffffff',
          lineColor: '#000000',
        });
      });
    } catch (e) {
      console.error('[labels] render failed', e);
      w.document.body.innerHTML = `<p style="padding:20px;color:#c00">Greška: ${String(e?.message || e)}</p>`;
    }
  };

  if (w.document.readyState === 'complete') runWhenReady();
  else w.addEventListener('load', runWhenReady, { once: true });

  void dispatchOptionalNetworkLabelPrint({
    mode: 'shelf',
    payload: { locations: locs.map(l => ({ id: l.id, code: l.location_code, name: l.name })) },
  });
}

/**
 * Modal: pretraga → izbor police → štampa.
 */
export async function openShelfLabelsPrintPicker() {
  const locs = await fetchLocations();
  if (!Array.isArray(locs) || !locs.length) {
    showToast('⚠ Nema lokacija');
    return;
  }

  const candidates = locs
    .filter(l => l.is_active !== false)
    .filter(l => SHELF_TYPES.includes(l.location_type))
    .sort((a, b) => (a.location_code || '').localeCompare(b.location_code || ''));

  if (!candidates.length) {
    showToast('⚠ Nema aktivnih polica (SHELF/RACK/BIN)');
    return;
  }

  const id = 'locModalShelfLabel';
  removeEl(id);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="kadr-modal-overlay" id="${id}" role="dialog" aria-modal="true">
      <div class="kadr-modal" style="max-width:520px">
        <div class="kadr-modal-title">Štampa nalepnice police</div>
        <div class="kadr-modal-subtitle">Izaberi konkretnu policu. Barkod = šifra police (Code128).</div>
        <div class="kadr-modal-body">
          <label class="loc-filter-field" style="display:block;margin-bottom:10px">
            <span>Pretraga police</span>
            <input type="search" class="loc-search-input" id="locShelfPickQ" autocomplete="off" placeholder="Šifra ili naziv…" />
          </label>
          <div id="locShelfPickList" class="loc-list" style="max-height:220px"></div>
          <div id="locShelfPickPreview" class="loc-muted" style="margin-top:12px;min-height:48px"></div>
          <div class="kadr-modal-actions" style="margin-top:16px">
            <button type="button" class="btn btn-primary" id="locShelfPickDoPrint" disabled>Štampaj</button>
            <button type="button" class="btn" id="locShelfPickCancel">Otkaži</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const overlay = document.getElementById(id);
  const listEl = overlay.querySelector('#locShelfPickList');
  const qEl = overlay.querySelector('#locShelfPickQ');
  const prevEl = overlay.querySelector('#locShelfPickPreview');
  const btnPrint = overlay.querySelector('#locShelfPickDoPrint');
  const btnCancel = overlay.querySelector('#locShelfPickCancel');

  let selected = null;
  let search = '';

  const close = () => {
    unesc();
    removeEl(id);
  };
  const unesc = bindEsc(close);

  const filterList = () => {
    const q = search.trim().toLowerCase();
    const rows = !q
      ? candidates
      : candidates.filter(
          l =>
            String(l.location_code || '')
              .toLowerCase()
              .includes(q) ||
            String(l.name || '')
              .toLowerCase()
              .includes(q) ||
            String(l.path_cached || '')
              .toLowerCase()
              .includes(q),
        );
    listEl.innerHTML = rows.length
      ? rows
          .map(
            l => `<button type="button" class="btn loc-row-click" style="width:100%;text-align:left;margin:2px 0"
              data-loc-id="${escHtml(String(l.id))}">
              <strong>${escHtml(l.location_code || '')}</strong>
              <span class="loc-muted"> · ${escHtml(l.name || '')}</span>
            </button>`,
          )
          .join('')
      : '<p class="loc-muted">Nema pogodaka.</p>';

    listEl.querySelectorAll('[data-loc-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const lid = btn.getAttribute('data-loc-id');
        selected = candidates.find(x => String(x.id) === lid) || null;
        listEl.querySelectorAll('[data-loc-id]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        btnPrint.disabled = !selected;
        if (selected) {
          prevEl.innerHTML = `<strong>${escHtml(selected.location_code || '')}</strong><br/>
            <span class="loc-muted">${escHtml(selected.name || '')}</span><br/>
            <span class="loc-muted">${escHtml((selected.path_cached || '').slice(0, 120))}</span>`;
        }
      });
    });
  };

  qEl.addEventListener('input', () => {
    search = qEl.value;
    filterList();
  });

  btnCancel.addEventListener('click', close);
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) close();
  });

  btnPrint.addEventListener('click', async () => {
    if (!selected) return;
    await printShelfLabelsToBrowserWindow([selected]);
    close();
  });

  filterList();
}

/**
 * Štampa jednu nalepnicu za tehnološki postupak. Layout odgovara uzorku
 * koji magacin već koristi (slika dostavljena uz zahtev): 8 tekstualnih
 * polja + Code128 barkod (RNZ format kompatibilan sa postojećim skenerima).
 *
 * Polja (`spec.fields`):
 *   - brojPredmeta   → wo.ident_broj (npr. „7351/1088")
 *   - komitent       → bigtehn_customers_cache.name
 *   - nazivPredmeta  → bigtehn_items_cache.naziv_predmeta
 *   - nazivDela      → wo.naziv_dela
 *   - brojCrteza     → wo.broj_crteza
 *   - kolicina       → „<print_qty>/<komada_rn>" (npr. „1/1")
 *   - materijal      → wo.materijal
 *   - datum          → DD-MM-YY (lokalno)
 * `spec.barcodeValue` — RNZ string iz `formatBigTehnRnzBarcode(...)`.
 *
 * @param {{
 *   fields: {
 *     brojPredmeta?: string, komitent?: string, nazivPredmeta?: string,
 *     nazivDela?: string, brojCrteza?: string, kolicina?: string,
 *     materijal?: string, datum?: string,
 *   },
 *   barcodeValue: string,
 * }} spec
 */
export async function printTechProcessLabelWindow(spec) {
  const mod = await import('jsbarcode');
  const JsBarcode = mod.default || mod;
  const w = window.open('', '_blank');
  if (!w) {
    showToast('⚠ Dozvoli pop-up');
    return;
  }
  const f = spec?.fields || {};
  const row = (label, value, opts = {}) => {
    const v = value == null || value === '' ? '—' : String(value);
    return `<div class="lbl-row${opts.small ? ' lbl-small' : ''}"><span class="lbl-k">${escHtml(label)}:</span> <span class="lbl-v">${escHtml(v)}</span></div>`;
  };
  w.document.write(`<!DOCTYPE html><html lang="sr-Latn"><head><meta charset="UTF-8"><title>Nalepnica TP — ${escHtml(f.brojPredmeta || '')}</title>
  <style>
    @page { size: 80mm 50mm; margin: 1mm; }
    * { box-sizing: border-box; }
    html, body { margin:0; padding:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color:#000; background:#fff; }
    .toolbar { padding: 8px 12px; background:#eef; font-size:12px; border-bottom:1px solid #99c; }
    .toolbar button { margin-left:8px; padding:4px 10px; cursor:pointer; }
    .label {
      width: 78mm; min-height: 48mm;
      padding: 1.5mm 2mm;
      display: grid; grid-template-columns: 28mm 1fr; gap: 2mm;
      align-items: center;
      border: 0;
    }
    .lbl-bc { display: flex; align-items: center; justify-content: center; }
    .lbl-bc svg { width: 27mm; height: 46mm; transform: rotate(90deg); transform-origin: center; }
    .lbl-meta { display: flex; flex-direction: column; gap: 0.6mm; min-width: 0; }
    .lbl-row { font-size: 8.2pt; line-height: 1.2; word-break: break-word; }
    .lbl-row .lbl-k { font-weight: 700; }
    .lbl-row .lbl-v { font-weight: 500; }
    .lbl-small { font-size: 7.4pt; }
    @media print { .toolbar { display: none; } .label { border: 0; } }
  </style></head><body>
  <div class="toolbar">
    Nalepnica TP <strong>${escHtml(f.brojPredmeta || '')}</strong>.
    Pritisni <strong>Ctrl + P</strong> za štampu.
    <button onclick="window.print()">Štampaj</button>
    <button onclick="window.close()">Zatvori</button>
  </div>
  <div class="label">
    <div class="lbl-bc"><svg id="bc"></svg></div>
    <div class="lbl-meta">
      ${row('Broj predmeta', f.brojPredmeta)}
      ${row('Komitent', f.komitent)}
      ${row('Naziv predmeta', f.nazivPredmeta)}
      ${row('Naziv dela', f.nazivDela)}
      ${row('Broj crteža', f.brojCrteza)}
      ${row('Količina', f.kolicina)}
      ${row('Materijal', f.materijal)}
      ${row('Datum', f.datum, { small: true })}
    </div>
  </div>
  </body></html>`);
  w.document.close();
  const run = () => {
    const svg = w.document.getElementById('bc');
    if (svg && spec.barcodeValue) {
      JsBarcode(svg, String(spec.barcodeValue).trim(), {
        format: 'CODE128',
        displayValue: false,
        margin: 0,
        height: 60,
        width: 1.4,
      });
    }
  };
  if (w.document.readyState === 'complete') run();
  else w.addEventListener('load', run, { once: true });

  void dispatchOptionalNetworkLabelPrint({
    mode: 'tech_process',
    payload: { barcode: spec.barcodeValue, fields: spec.fields },
  });
}

export function barcodeForPlacementRow(p) {
  const tbl = String(p.item_ref_table || '');
  const ord = String(p.order_no || '').trim();
  const iid = String(p.item_ref_id || '').trim();
  const dr = String(p.drawing_no || '').trim();
  if (tbl === 'bigtehn_rn' && ord && iid) {
    return formatBigTehnRnzBarcode({ orderNo: ord, tpNo: iid });
  }
  if (ord && (dr || iid)) {
    return formatBigTehnShortBarcode(ord, dr || iid);
  }
  return null;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function todayStrDDMMYY() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${String(d.getFullYear()).slice(-2)}`;
}

/**
 * Modal za štampu nalepnice za tehnološki postupak — usklađen sa zahtevom:
 *
 *   1. Combobox „Predmet" — pretraga BigTehn `bigtehn_items_cache` (samo
 *      aktuelni: status='U TOKU' AND datum_zakljucenja IS NULL).
 *   2. Po izboru predmeta, učita se lista TP-ova (otvoreni RN-ovi za taj
 *      predmet) sa pretragom unutar liste.
 *   3. Korisnik bira TP iz liste (validacija — bez slobodnog unosa, jer
 *      naknadno skeniranje ne bi pronašlo zapis ako ga nema u BigTehn-u).
 *   4. Korisnik unosi količinu za štampu (može biti manja od ukupne).
 *   5. Štampa nalepnicu sa svim poljima (Broj predmeta, Komitent, Naziv
 *      predmeta, Naziv dela, Broj crteža, Količina, Materijal, Datum) +
 *      Code128 RNZ barkod (postojeći standard koji skener već čita).
 */
export async function openTechProcessLabelPrintModal() {
  const id = 'locModalTpLabel';
  removeEl(id);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="kadr-modal-overlay" id="${id}" role="dialog" aria-modal="true">
      <div class="kadr-modal" style="max-width:760px">
        <div class="kadr-modal-title">Štampa nalepnice za tehnološki postupak</div>
        <div class="kadr-modal-subtitle">Predmet → TP → količina. Barkod RNZ — isti standard koji modul već čita pri skeniranju.</div>
        <div class="kadr-modal-body">
          <div style="position:relative;margin-bottom:12px">
            <label class="loc-filter-field"><span>Predmet</span>
              <input type="search" id="tpPredmetQ" class="loc-search-input"
                placeholder="Broj predmeta · naziv · ugovor…" autocomplete="off" autofocus />
            </label>
            <div id="tpPredmetDrop" class="loc-list" style="position:absolute;top:100%;left:0;right:0;z-index:30;background:var(--surface,#fff);border:1px solid var(--border2,#ccc);border-radius:6px;max-height:240px;overflow:auto;display:none;box-shadow:0 6px 18px rgba(0,0,0,.18)"></div>
            <span class="loc-muted loc-filter-hint">Lista uključuje samo nezatvorene predmete iz BigTehn-a (status „U TOKU").</span>
          </div>
          <div id="tpSelectedPredmet" class="loc-muted" style="margin:6px 0 12px;padding:8px 10px;border:1px dashed var(--border2,#ccc);border-radius:6px;display:none"></div>
          <div id="tpTpsBlock" style="display:none">
            <label class="loc-filter-field"><span>Tehnološki postupak (RN)</span>
              <input type="search" id="tpTpQ" class="loc-search-input" placeholder="Filter po ident_broju, crtežu ili nazivu dela…" autocomplete="off" />
            </label>
            <div id="tpTpList" class="loc-list" style="max-height:220px;overflow:auto;border:1px solid var(--border2,#eee);border-radius:6px;margin-top:6px"></div>
            <p class="loc-muted" style="font-size:12px;margin:6px 2px 0">TP mora biti izabran iz liste — bez slobodnog unosa. Skener naknadno može da pročita samo barkode koji odgovaraju zapisima u BigTehn-u.</p>
          </div>
          <div id="tpQtyBlock" style="display:none;margin-top:14px">
            <label class="loc-filter-field"><span>Količina za štampu</span>
              <input type="number" id="tpPrintQty" class="loc-search-input" min="1" step="1" value="1" inputmode="numeric" />
            </label>
            <span class="loc-muted loc-filter-hint" id="tpQtyHint"></span>
          </div>
          <hr style="border:none;border-top:1px solid var(--border2,#eee);margin:14px 0" />
          <div id="tpPreview" class="loc-muted" style="min-height:64px"></div>
          <div class="kadr-modal-actions">
            <button type="button" class="btn btn-primary" id="tpDoPrint" disabled>Štampaj nalepnicu</button>
            <button type="button" class="btn" id="tpCancel">Zatvori</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const overlay = document.getElementById(id);
  const inputPredmet = overlay.querySelector('#tpPredmetQ');
  const dropPredmet = overlay.querySelector('#tpPredmetDrop');
  const selectedPredmetEl = overlay.querySelector('#tpSelectedPredmet');
  const tpsBlock = overlay.querySelector('#tpTpsBlock');
  const tpQ = overlay.querySelector('#tpTpQ');
  const tpListEl = overlay.querySelector('#tpTpList');
  const qtyBlock = overlay.querySelector('#tpQtyBlock');
  const qtyInput = overlay.querySelector('#tpPrintQty');
  const qtyHint = overlay.querySelector('#tpQtyHint');
  const previewEl = overlay.querySelector('#tpPreview');
  const btnPrint = overlay.querySelector('#tpDoPrint');
  const btnCancel = overlay.querySelector('#tpCancel');

  let selectedPredmet = null;
  let tpsCache = [];
  let selectedTp = null;

  const close = () => {
    unesc();
    removeEl(id);
  };
  const unesc = bindEsc(close);

  btnCancel.addEventListener('click', close);
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) close();
  });

  function showDrop() { dropPredmet.style.display = 'block'; }
  function hideDrop() { dropPredmet.style.display = 'none'; }

  async function refreshPredmetDrop(q) {
    try {
      const rows = await searchBigtehnItems(q, 50);
      if (!rows.length) {
        dropPredmet.innerHTML = '<div class="loc-muted" style="padding:10px 12px">Nema rezultata.</div>';
      } else {
        dropPredmet.innerHTML = rows
          .map(r => {
            const code = escHtml(r.broj_predmeta || '');
            const naz = escHtml(r.naziv_predmeta || '');
            const cust = escHtml(r.customer_name || '');
            return `<button type="button" class="btn" data-pid="${escHtml(String(r.id))}" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid var(--border2,#eee);padding:8px 12px;background:transparent">
              <div><strong>${code}</strong> · ${naz}</div>
              <div class="loc-muted" style="font-size:12px">${cust}</div>
            </button>`;
          })
          .join('');
        dropPredmet.querySelectorAll('[data-pid]').forEach(btn => {
          btn.addEventListener('click', () => {
            const pid = Number(btn.getAttribute('data-pid'));
            const item = rows.find(r => r.id === pid);
            if (item) selectPredmet(item);
          });
        });
      }
      showDrop();
    } catch (err) {
      console.error('[label/predmet] search failed', err);
      dropPredmet.innerHTML = `<div class="loc-warn" style="padding:10px 12px">Greška pretrage: ${escHtml(err?.message || String(err))}</div>`;
      showDrop();
    }
  }

  inputPredmet.addEventListener('input', debounce(() => refreshPredmetDrop(inputPredmet.value), 250));
  inputPredmet.addEventListener('focus', () => refreshPredmetDrop(inputPredmet.value));
  document.addEventListener('click', ev => {
    if (!overlay.contains(ev.target)) return;
    if (ev.target !== inputPredmet && !dropPredmet.contains(ev.target)) hideDrop();
  });

  async function selectPredmet(item) {
    selectedPredmet = item;
    selectedTp = null;
    inputPredmet.value = `${item.broj_predmeta} — ${item.naziv_predmeta || ''}`;
    hideDrop();
    selectedPredmetEl.style.display = 'block';
    selectedPredmetEl.innerHTML = `
      <div><strong>Predmet ${escHtml(item.broj_predmeta || '')}</strong> · ${escHtml(item.naziv_predmeta || '')}</div>
      <div style="font-size:12px">Komitent: <strong>${escHtml(item.customer_name || '—')}</strong></div>`;
    tpsBlock.style.display = 'block';
    qtyBlock.style.display = 'none';
    tpListEl.innerHTML = '<p class="loc-muted" style="padding:10px">Učitavam tehnološke postupke…</p>';
    try {
      tpsCache = await searchBigtehnWorkOrdersForItem(item.id, { onlyOpen: true, limit: 500 });
      renderTpList('');
    } catch (err) {
      console.error('[label/tps] load failed', err);
      tpListEl.innerHTML = `<p class="loc-warn" style="padding:10px">Greška: ${escHtml(err?.message || String(err))}</p>`;
    }
    updatePreview();
  }

  function renderTpList(filter) {
    const f = String(filter || '').trim().toLowerCase();
    const list = !f
      ? tpsCache
      : tpsCache.filter(
          x =>
            String(x.ident_broj || '').toLowerCase().includes(f) ||
            String(x.broj_crteza || '').toLowerCase().includes(f) ||
            String(x.naziv_dela || '').toLowerCase().includes(f),
        );
    if (!list.length) {
      tpListEl.innerHTML = '<p class="loc-muted" style="padding:10px">Nema otvorenih tehnoloških postupaka za ovaj predmet (ili filter).</p>';
      return;
    }
    tpListEl.innerHTML = list
      .map(wo => {
        const idb = escHtml(String(wo.ident_broj || ''));
        const cr = escHtml(String(wo.broj_crteza || '—'));
        const nz = escHtml(String(wo.naziv_dela || '').slice(0, 80));
        const km = wo.komada != null ? `· ${escHtml(String(wo.komada))} kom` : '';
        return `<button type="button" class="btn" data-tp-id="${escHtml(String(wo.id))}" style="display:block;width:100%;text-align:left;border:none;border-bottom:1px solid var(--border2,#eee);padding:8px 12px;background:transparent">
          <div><strong>${idb}</strong> · crtež <strong>${cr}</strong> ${km}</div>
          <div class="loc-muted" style="font-size:12px">${nz}${wo.materijal ? ` · ${escHtml(wo.materijal)}` : ''}</div>
        </button>`;
      })
      .join('');
    tpListEl.querySelectorAll('[data-tp-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tpId = Number(btn.getAttribute('data-tp-id'));
        const wo = tpsCache.find(x => x.id === tpId);
        if (!wo) return;
        tpListEl.querySelectorAll('[data-tp-id]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        selectTp(wo);
      });
    });
  }

  tpQ.addEventListener('input', debounce(() => renderTpList(tpQ.value), 150));

  function selectTp(wo) {
    selectedTp = wo;
    qtyBlock.style.display = 'block';
    const max = Number(wo.komada) || 1;
    qtyInput.value = String(Math.min(1, max));
    qtyInput.max = String(max);
    qtyHint.textContent = `Ukupna količina po RN: ${max}. Možeš uneti manju vrednost ako se štampa parcijalno.`;
    updatePreview();
  }

  qtyInput.addEventListener('input', () => updatePreview());

  function updatePreview() {
    if (!selectedPredmet || !selectedTp) {
      previewEl.innerHTML = '<p class="loc-muted">Izaberi Predmet i tehnološki postupak iz liste, pa unesi količinu.</p>';
      btnPrint.disabled = true;
      return;
    }
    const idb = String(selectedTp.ident_broj || '');
    const slash = idb.indexOf('/');
    const orderPart = slash >= 0 ? idb.slice(0, slash) : idb;
    const tpPart = slash >= 0 ? idb.slice(slash + 1) : '';
    const bc = formatBigTehnRnzBarcode({ orderNo: orderPart, tpNo: tpPart });
    if (!bc) {
      previewEl.innerHTML = '<p class="loc-warn">Nije moguće generisati RNZ barkod za izabrani RN.</p>';
      btnPrint.disabled = true;
      return;
    }
    const printQty = Math.max(1, Number(qtyInput.value) || 1);
    const totalQty = Number(selectedTp.komada) || printQty;
    previewEl.innerHTML = `
      <div><strong>Barkod (RNZ):</strong> <code>${escHtml(bc)}</code></div>
      <div style="margin-top:6px"><strong>Broj predmeta:</strong> ${escHtml(idb)} · <strong>Crtež:</strong> ${escHtml(selectedTp.broj_crteza || '—')}</div>
      <div><strong>Naziv dela:</strong> ${escHtml(selectedTp.naziv_dela || '—')}</div>
      <div><strong>Količina:</strong> ${printQty}/${totalQty} · <strong>Materijal:</strong> ${escHtml(selectedTp.materijal || '—')}</div>`;
    btnPrint.disabled = false;
  }

  btnPrint.addEventListener('click', async () => {
    if (!selectedPredmet || !selectedTp) return;
    const idb = String(selectedTp.ident_broj || '');
    const slash = idb.indexOf('/');
    const orderPart = slash >= 0 ? idb.slice(0, slash) : idb;
    const tpPart = slash >= 0 ? idb.slice(slash + 1) : '';
    const bc = formatBigTehnRnzBarcode({ orderNo: orderPart, tpNo: tpPart });
    if (!bc) {
      showToast('⚠ Nije moguće generisati barkod');
      return;
    }
    const printQty = Math.max(1, Number(qtyInput.value) || 1);
    const totalQty = Number(selectedTp.komada) || printQty;
    await printTechProcessLabelWindow({
      barcodeValue: bc,
      fields: {
        brojPredmeta: idb,
        komitent: selectedPredmet.customer_name || '',
        nazivPredmeta: selectedPredmet.naziv_predmeta || '',
        nazivDela: selectedTp.naziv_dela || '',
        brojCrteza: selectedTp.broj_crteza || '',
        kolicina: `${printQty}/${totalQty}`,
        materijal: selectedTp.materijal || '',
        datum: todayStrDDMMYY(),
      },
    });
    close();
  });

  void refreshPredmetDrop('');
}
