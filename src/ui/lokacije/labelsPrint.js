/**
 * Nalepnice — priprema podataka, print-ready HTML, štampa u pregledaču (Ctrl+P).
 * Opcioni LAN adapter: `VITE_LABEL_PRINTER_PROXY_URL` (POST JSON) za TSC gateway.
 *
 * **Layout TP nalepnice (80×50mm portrait, redizajn 2026-04):**
 *   - Tekst gore (8 polja, key:value, kompaktno)
 *   - Horizontalni CODE128 barkod dole, FULL WIDTH minus 2mm quiet zone svake strane
 *   - `@page { margin: 0 }` da Chrome NE doda datum / URL / page-num u sam label
 *   - Operater jednom u Chrome print dijalogu isključi „Headers and footers" za TSC printer
 *
 * **TSC ML340P (300 DPI) — clean path:**
 *   Ako je `VITE_LABEL_PRINTER_PROXY_URL` postavljen, šaljemo JSON koji UZ
 *   `payload.fields` sadrži i `payload.tspl2` — raw TSPL2 program kojim
 *   lokalni agent piše direktno u TCP 9100 na štampač (zaobilazi browser
 *   print headers/footers u potpunosti). Vidi `src/lib/tspl2.js`.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  fetchLocations,
  searchBigtehnItems,
  searchBigtehnWorkOrdersForItem,
} from '../../services/lokacije.js';
import { formatBigTehnRnzBarcode, formatBigTehnShortBarcode } from '../../lib/barcodeParse.js';
import { buildTspLabelProgram, buildTspShelfLabelProgram } from '../../lib/tspl2.js';

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

  let tspl2 = '';
  try {
    tspl2 = locs
      .map(l => buildTspShelfLabelProgram({ location_code: l.location_code, name: l.name, copies: 1 }))
      .join('');
  } catch (e) {
    console.warn('[labels/shelf] TSPL2 build failed:', e);
  }
  void dispatchOptionalNetworkLabelPrint({
    mode: 'shelf',
    payload: {
      locations: locs.map(l => ({ id: l.id, code: l.location_code, name: l.name })),
      tspl2,
    },
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
 * Generiše HTML stranu za jednu TP nalepnicu (80×40mm portrait — stvarna
 * dimenzija stoka konfigurisana u TSC ML340P preko admin-a 192.168.70.20).
 *
 * Layout (po specifikaciji operatera):
 *   - Red 1: Broj Predmeta (levo, naglašen) | Komitent (desno)
 *   - Red 2: Naziv predmeta (full width)
 *   - Red 3: Naziv dela (full width)
 *   - Red 4: Br. crteža (levo) | Materijal (desno)
 *   - Red 5: Količina (levo) | Datum (desno)
 *   - Barkod ispod (full width, ~20mm visine)
 *
 * @param {{ fields: object, barcodeValue: string }} spec
 * @param {number} index 0-based redni broj nalepnice u batch-u (za jedinstveni `id` SVG-a)
 * @returns {string}
 */
function buildTechLabelHtmlBlock(spec, index = 0) {
  const f = spec?.fields || {};
  const cell = (label, value, opts = {}) => {
    const v = value == null || value === '' ? '' : String(value);
    if (!v) return '';
    if (opts.bare) return `<span class="lbl-v">${escHtml(v)}</span>`;
    return `<span class="lbl-k">${escHtml(label)}:</span> <span class="lbl-v">${escHtml(v)}</span>`;
  };
  return `<div class="label" data-bc-idx="${index}">
    <div class="lbl-meta">
      <div class="lbl-row lbl-row-split">
        <span class="lbl-cell lbl-rn">${escHtml(f.brojPredmeta || '')}</span>
        <span class="lbl-cell lbl-cell-right">${escHtml(f.komitent || '')}</span>
      </div>
      <div class="lbl-row lbl-row-full">${escHtml(f.nazivPredmeta || '')}</div>
      <div class="lbl-row lbl-row-full">${escHtml(f.nazivDela || '')}</div>
      <div class="lbl-row lbl-row-split">
        <span class="lbl-cell">${cell('Crtež', f.brojCrteza)}</span>
        <span class="lbl-cell lbl-cell-right">${cell('', f.materijal, { bare: true })}</span>
      </div>
      <div class="lbl-row lbl-row-split">
        <span class="lbl-cell">${cell('Kol', f.kolicina)}</span>
        <span class="lbl-cell lbl-cell-right">${cell('', f.datum, { bare: true })}</span>
      </div>
    </div>
    <div class="lbl-bc"><svg id="bc_${index}"></svg></div>
  </div>`;
}

/**
 * CSS za TP nalepnice — stvarna dimenzija stock-a u TSC ML340P pogonu:
 * **80mm × 40mm** (po web admin-u: Paper Width 80.34, Paper Height 40.30).
 *
 * Kritično: `@page { margin: 0 }` + `body { margin: 0 }` + prazan
 * `<title>` značajno smanjuje šansu da Chrome ubaci browser headers
 * (datum/URL/page-number) na sam label. Operater takođe MORA jednom u
 * print dijalogu isključiti „Headers and footers" za TSC profil.
 */
const TECH_LABEL_CSS = `
  /* @page = fizicka veličina nalepnice (80mm × 38mm; 38 a ne 40.30 da Chrome
   * line-height varijacije ne izazovu page-break, vidi commit ac68565). */
  @page { size: 80mm 38mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; font-family: 'Arial', 'Liberation Sans', sans-serif; color:#000; background:#fff; }
  /* CSS varijabla --print-scale = ono sto bi operater inace morao da
   * kuca u Chrome print dijalog ▸ Custom scale. Promeni ovde ako treba
   * fino podesavanje (npr. 0.93 ako je previse pomeren u levo, 0.97
   * ako jos uvek udara o desnu ivicu). */
  :root { --print-scale: 0.95; }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    padding: 8px 12px; background:#eef; font-size:12px; border-bottom:1px solid #99c;
  }
  .toolbar button { margin-left:8px; padding:4px 10px; cursor:pointer; }
  .toolbar .hint { color:#444; margin-left:12px; }
  /* Total budget na 38mm: 0.4mm pad + 14mm text zone + 0.3mm gap + 17mm barkod + 0.4mm pad = 32.1mm
   * Padding gore/dole = 0.4mm = 0.0157" — ispod operaterskog limita 0.03" (0.762mm).
   * Padding levo/desno = 2mm — IDENTICNO sa barkod quiet zone-om, tako da
   * tekst NIKAD ne moze da bude siri od barkoda (poravnati levi i desni rub). */
  .label {
    width: 80mm; height: 38mm; max-height: 38mm;
    padding: 0.4mm 2mm; /* top/bottom 0.4mm = 0.0157", left/right 2mm = align sa barkodom */
    display: flex; flex-direction: column;
    gap: 0.2mm;
    page-break-after: always;
    break-after: page;
    overflow: hidden;
    /* Programski Chrome "Custom scale 95%" — operater javio da rucni
     * 95% scale resi problem da se sadrzaj lepi za desnu fizicku ivicu.
     * Sa zoom u CSS-u to je auto: nema potrebe da se rucno podesava
     * pri svakom print-u. Promeni --print-scale gore ako treba drugi %. */
    zoom: var(--print-scale);
  }
  .label:last-child { page-break-after: auto; break-after: auto; }
  .lbl-meta { display: flex; flex-direction: column; gap: 0; flex: 0 0 auto; max-height: 14mm; overflow: hidden; }
  .lbl-row {
    font-size: 6.5pt; line-height: 1;
    display: flex; gap: 3mm;
    overflow: hidden;
    height: 2.6mm;
  }
  .lbl-row-full { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lbl-row-split { display: flex; justify-content: space-between; align-items: baseline; }
  .lbl-cell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 50%; }
  .lbl-cell-right { text-align: right; }
  .lbl-rn { font-size: 10pt; font-weight: 700; line-height: 1; flex: 1 1 auto; }
  .lbl-row-split:first-child { height: 3.6mm; align-items: center; }
  .lbl-k { font-weight: 700; }
  .lbl-v { font-weight: 500; }
  .lbl-bc {
    flex: 0 0 17mm; max-height: 17mm;
    display: flex; align-items: center; justify-content: center;
    margin-top: 0.3mm;
    padding: 0; /* quiet zone vec dolazi iz .label padding (2mm) — ne dupliraj */
    overflow: hidden;
  }
  .lbl-bc svg { width: 100%; height: 100%; max-height: 17mm; display: block; }
  @media print {
    .toolbar { display: none !important; }
    body { margin:0; padding:0; }
    .label { border: 0; }
  }
`;

/**
 * Štampa jednu ili više TP nalepnica u jednom prozoru (svaka na svoj papir).
 * Layout: tekst gore (RN, komitent, predmet, deo, crtež, količina, materijal,
 * datum), CODE128 barkod dole — full-width minus 2mm quiet zone svake strane.
 *
 * Polja (`fields`):
 *   - brojPredmeta   → wo.ident_broj (npr. „7351/1088")
 *   - komitent       → bigtehn_customers_cache.name
 *   - nazivPredmeta  → bigtehn_items_cache.naziv_predmeta
 *   - nazivDela      → wo.naziv_dela
 *   - brojCrteza     → wo.broj_crteza
 *   - kolicina       → „<print_qty>/<komada_rn>" (npr. „1/1")
 *   - materijal      → wo.materijal
 *   - datum          → DD-MM-YY (lokalno)
 * `barcodeValue` — RNZ string iz `formatBigTehnRnzBarcode(...)`.
 *
 * @param {Array<{
 *   fields: {
 *     brojPredmeta?: string, komitent?: string, nazivPredmeta?: string,
 *     nazivDela?: string, brojCrteza?: string, kolicina?: string,
 *     materijal?: string, datum?: string,
 *   },
 *   barcodeValue: string,
 *   copies?: number,
 * }>} specs
 */
export async function printTechProcessLabelsBatch(specs) {
  if (!Array.isArray(specs) || !specs.length) {
    showToast('⚠ Nema nalepnica za štampu');
    return;
  }

  /* Razvi `copies` u flat listu: ako spec ima copies=3, ide 3x u listu. */
  const flat = [];
  for (const s of specs) {
    const n = Math.max(1, Math.floor(Number(s?.copies) || 1));
    for (let i = 0; i < n; i++) flat.push(s);
  }

  const mod = await import('jsbarcode');
  const JsBarcode = mod.default || mod;
  const w = window.open('', '_blank');
  if (!w) {
    showToast('⚠ Dozvoli pop-up');
    return;
  }

  const labelsHtml = flat.map((s, i) => buildTechLabelHtmlBlock(s, i)).join('');
  const totalCount = flat.length;
  const firstRn = String(flat[0]?.fields?.brojPredmeta || '');

  /* Prazan <title> da Chrome ne odštampa „Nalepnica TP — 7351/1088" u
   * gornjem-levom uglu papira (deo „datum i naslov na sredini papira"
   * problema o kome operater govori). */
  w.document.write(`<!DOCTYPE html><html lang="sr-Latn"><head><meta charset="UTF-8"><title> </title>
  <style>${TECH_LABEL_CSS}</style></head><body>
  <div class="toolbar">
    <strong>${totalCount}</strong> nalepnic${totalCount === 1 ? 'a' : totalCount < 5 ? 'e' : 'a'}${firstRn ? ` (prva: <strong>${escHtml(firstRn)}</strong>)` : ''}.
    <button onclick="window.print()">Štampaj</button>
    <button onclick="window.close()">Zatvori</button>
    <span class="hint">U Chrome dijalogu ▸ <em>More settings</em> ▸ isključi <em>Headers and footers</em> i postavi marginu na <em>None</em> (samo prvi put po štampaču).</span>
  </div>
  ${labelsHtml}
  </body></html>`);
  w.document.close();

  const run = () => {
    flat.forEach((s, i) => {
      const svg = w.document.getElementById(`bc_${i}`);
      if (!svg || !s.barcodeValue) return;
      try {
        JsBarcode(svg, String(s.barcodeValue).trim(), {
          format: 'CODE128',
          displayValue: false,
          margin: 0,
          height: 80,
          width: 2.2,
          background: '#ffffff',
          lineColor: '#000000',
        });
      } catch (e) {
        console.error('[labels/tp] JsBarcode render failed for', s.barcodeValue, e);
      }
    });
  };
  if (w.document.readyState === 'complete') run();
  else w.addEventListener('load', run, { once: true });

  /* TSPL2 paralelno — ako proxy postoji, šalje raw program direktno
   * štampaču (zaobilazi sve browser print artifacts). Browser print
   * ostaje kao fallback / preview. */
  let tspl2 = '';
  try {
    tspl2 = flat
      .map(s => buildTspLabelProgram({ fields: s.fields, barcodeValue: s.barcodeValue, copies: 1 }))
      .join('');
  } catch (e) {
    console.warn('[labels/tp] TSPL2 build failed:', e);
  }
  void dispatchOptionalNetworkLabelPrint({
    mode: 'tech_process_batch',
    count: totalCount,
    payload: {
      labels: flat.map(s => ({ barcode: s.barcodeValue, fields: s.fields })),
      tspl2,
    },
  });
}

/**
 * Backward-compatible single-label API. Pozivi iz starog koda
 * (`printTechProcessLabelWindow({fields, barcodeValue})`) i dalje rade.
 *
 * @param {{ fields: object, barcodeValue: string }} spec
 */
export async function printTechProcessLabelWindow(spec) {
  return printTechProcessLabelsBatch([spec]);
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
 * Modal za štampu nalepnice za tehnološki postupak.
 *
 * Tok (refaktor 2026-04 — Task 3a):
 *
 *   1. Predmet picker — pretraga BigTehn `bigtehn_items_cache` (samo aktuelni).
 *   2. Po izboru Predmeta → učita se lista TP-ova (ručno aktivni RN-ovi).
 *   3. Po izboru TP-a iz liste → **lista se sklopi**, prikaže se „selected
 *      panel" sa Predmetom + TP brojem + nazivom dela. Operater jasno vidi
 *      šta će biti odštampano.
 *   4. Klik na selected panel ili „↻ Promeni TP" → lista se ponovo otvara
 *      i izabrani TP se briše (clean slate, bez zaostalih polja).
 *   5. Količina + Štampa.
 *
 * Tastature:
 *   - Esc — zatvara modal (bind kroz `bindEsc`)
 *   - Enter (kad je TP izabran) — pokreće Štampa
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

          <div id="tpTpsPickBlock" style="display:none">
            <label class="loc-filter-field"><span>Tehnološki postupak (RN)</span>
              <input type="search" id="tpTpQ" class="loc-search-input" placeholder="Filter po ident_broju, crtežu ili nazivu dela…" autocomplete="off" />
            </label>
            <div id="tpTpList" class="loc-list" style="max-height:260px;overflow:auto;border:1px solid var(--border2,#eee);border-radius:6px;margin-top:6px"></div>
            <p class="loc-muted" style="font-size:12px;margin:6px 2px 0">TP mora biti izabran iz liste — bez slobodnog unosa. Skener kasnije čita samo barkode koji odgovaraju zapisima u BigTehn-u.</p>
          </div>

          <div id="tpSelectedTp" class="loc-tp-selected" role="button" tabindex="0"
            style="display:none;margin:6px 0 0;padding:12px 14px;border:2px solid var(--accent,#2b6cb0);border-radius:8px;background:var(--surface2,#f4f8ff);cursor:pointer"
            title="Klikni da promeniš TP (lista se ponovo otvara, trenutni izbor se briše)">
          </div>

          <div id="tpQtyBlock" style="display:none;margin-top:14px">
            <label class="loc-filter-field"><span>Količina za štampu</span>
              <input type="number" id="tpPrintQty" class="loc-search-input" min="1" step="1" value="1" inputmode="numeric" />
            </label>
            <span class="loc-muted loc-filter-hint" id="tpQtyHint"></span>
          </div>
          <hr style="border:none;border-top:1px solid var(--border2,#eee);margin:14px 0" />
          <div id="tpPreview" class="loc-muted" style="min-height:48px"></div>
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
  const tpsPickBlock = overlay.querySelector('#tpTpsPickBlock');
  const tpQ = overlay.querySelector('#tpTpQ');
  const tpListEl = overlay.querySelector('#tpTpList');
  const tpSelectedEl = overlay.querySelector('#tpSelectedTp');
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
    /* Pri promeni Predmeta — pokaži TP picker, sakri selected TP panel i kvantitet */
    tpsPickBlock.style.display = 'block';
    tpSelectedEl.style.display = 'none';
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
      tpListEl.innerHTML = '<p class="loc-muted" style="padding:10px">Nema aktivnih tehnoloških postupaka za ovaj predmet (ili filter).</p>';
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
        if (wo) selectTp(wo);
      });
    });
  }

  tpQ.addEventListener('input', debounce(() => renderTpList(tpQ.value), 150));

  function selectTp(wo) {
    selectedTp = wo;
    /* Sklopi listu, otvori selected panel + kvantitet (Task 3a). */
    tpsPickBlock.style.display = 'none';
    tpSelectedEl.style.display = 'block';
    tpSelectedEl.innerHTML = `
      <div style="display:flex;gap:12px;align-items:flex-start;justify-content:space-between">
        <div style="min-width:0;flex:1">
          <div style="font-size:11px;color:var(--text2,#666);text-transform:uppercase;letter-spacing:0.5px">Izabrani TP</div>
          <div style="font-size:16px;font-weight:700;margin-top:2px">${escHtml(String(wo.ident_broj || ''))}</div>
          <div style="font-size:13px;margin-top:2px">${escHtml(String(wo.naziv_dela || '—'))}</div>
          <div class="loc-muted" style="font-size:12px;margin-top:4px">
            Crtež: <strong>${escHtml(String(wo.broj_crteza || '—'))}</strong>
            ${wo.materijal ? ` · Materijal: <strong>${escHtml(String(wo.materijal))}</strong>` : ''}
            ${wo.komada != null ? ` · Komada po RN: <strong>${escHtml(String(wo.komada))}</strong>` : ''}
          </div>
        </div>
        <button type="button" class="btn btn-xs" id="tpChangeTp"
          title="Otvori listu TP-ova ponovo (briše trenutni izbor)">↻ Promeni TP</button>
      </div>`;
    /* Klik bilo gde u panelu (osim na ↻ dugmetu — ono ima isti efekat) reotvara listu. */
    tpSelectedEl.onclick = (ev) => {
      ev.stopPropagation();
      reopenTpList();
    };
    tpSelectedEl.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        reopenTpList();
      }
    };
    /* Kvantitet — default 1, max = komada po RN-u */
    qtyBlock.style.display = 'block';
    const max = Number(wo.komada) || 1;
    qtyInput.value = '1';
    qtyInput.max = String(Math.max(1, max));
    qtyHint.textContent = `Ukupna količina po RN: ${max}. Možeš uneti manju vrednost ako se štampa parcijalno.`;
    updatePreview();
    /* Fokusiraj kvantitet input — operater po pravilu samo pritisne Enter */
    setTimeout(() => qtyInput.focus(), 0);
  }

  function reopenTpList() {
    /* Clean slate: briši trenutni TP, vrati TP picker, sakri kvantitet i preview */
    selectedTp = null;
    tpSelectedEl.style.display = 'none';
    tpSelectedEl.innerHTML = '';
    tpsPickBlock.style.display = 'block';
    qtyBlock.style.display = 'none';
    qtyInput.value = '1';
    qtyHint.textContent = '';
    updatePreview();
    /* Vrati listu na pun set (bez filtera) i fokusiraj search */
    tpQ.value = '';
    renderTpList('');
    setTimeout(() => tpQ.focus(), 0);
  }

  qtyInput.addEventListener('input', () => updatePreview());

  /* Enter na Količina input-u → odmah Štampa (kad je TP izabran). */
  qtyInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !btnPrint.disabled) {
      ev.preventDefault();
      btnPrint.click();
    }
  });

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
      <div style="margin-top:4px"><strong>Količina:</strong> ${printQty}/${totalQty} nalepnic${printQty === 1 ? 'a' : printQty < 5 ? 'e' : 'a'}</div>`;
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
    await printTechProcessLabelsBatch([
      {
        barcodeValue: bc,
        copies: printQty,
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
      },
    ]);
    close();
  });

  void refreshPredmetDrop('');
}
