/**
 * Nalepnice — priprema podataka, print-ready HTML, štampa u pregledaču (Ctrl+P).
 * Opcioni LAN adapter: `VITE_LABEL_PRINTER_PROXY_URL` (POST JSON) za TSC gateway.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { fetchLocations, fetchPlacementsByDrawing } from '../../services/lokacije.js';
import { formatBigTehnRnzBarcode, formatBigTehnShortBarcode } from '../../lib/barcodeParse.js';
import { loadProjektiLite, loadBigtehnRnsForProjekat } from '../../services/projekti.js';
import {
  fetchBigtehnOpSnapshotByRnAndTp,
  fetchBigtehnWorkOrdersByIds,
} from '../../services/planProizvodnje.js';

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
 * @param {{ title: string, lines: { text: string, small?: boolean }[], barcodeValue: string }} spec
 */
export async function printTechProcessLabelWindow(spec) {
  const mod = await import('jsbarcode');
  const JsBarcode = mod.default || mod;
  const w = window.open('', '_blank');
  if (!w) {
    showToast('⚠ Dozvoli pop-up');
    return;
  }
  const linesHtml = (spec.lines || [])
    .map(
      ln =>
        `<div class="tp-line${ln.small ? ' tp-small' : ''}">${escHtml(ln.text || '')}</div>`,
    )
    .join('');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escHtml(spec.title || 'TP')}</title>
  <style>
    @page { size: 62mm 40mm; margin: 2mm; }
    body { margin:0; font-family: system-ui,sans-serif; color:#000; background:#fff; }
    .box { padding: 2mm; text-align: center; }
    .tp-line { font-size: 11pt; font-weight: 600; }
    .tp-small { font-size: 8pt; font-weight: 500; color: #333; }
    #bc { max-height: 14mm; width: 100%; }
    .toolbar { padding: 6px; background:#eef; font-size:12px; }
    @media print { .toolbar { display: none; } }
  </style></head><body>
  <div class="toolbar">Ctrl+P štampa · <button onclick="window.print()">Štampaj</button> <button onclick="window.close()">Zatvori</button></div>
  <div class="box">
    ${linesHtml}
    <svg id="bc"></svg>
  </div>
  </body></html>`);
  w.document.close();
  const run = () => {
    const svg = w.document.getElementById('bc');
    if (svg && spec.barcodeValue) {
      JsBarcode(svg, String(spec.barcodeValue).trim(), {
        format: 'CODE128',
        displayValue: true,
        margin: 0,
        height: 36,
        width: 1.6,
        fontSize: 11,
      });
    }
  };
  if (w.document.readyState === 'complete') run();
  else w.addEventListener('load', run, { once: true });

  void dispatchOptionalNetworkLabelPrint({
    mode: 'tech_process',
    payload: { barcode: spec.barcodeValue, title: spec.title, lines: spec.lines },
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

export async function openTechProcessLabelPrintModal() {
  const id = 'locModalTpLabel';
  removeEl(id);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="kadr-modal-overlay" id="${id}" role="dialog" aria-modal="true">
      <div class="kadr-modal" style="max-width:640px">
        <div class="kadr-modal-title">Štampa nalepnice za tehnološki postupak</div>
        <div class="kadr-modal-subtitle">Barkod u RNZ ili kratkom formatu — isti kao pri skeniranju u modulu.</div>
        <div class="kadr-modal-body">
          <div class="loc-view-switch" role="tablist" style="margin-bottom:12px">
            <button type="button" class="btn btn-xs is-active" data-tp-mode="proj">Predmet + TP</button>
            <button type="button" class="btn btn-xs" data-tp-mode="draw">Broj crteža</button>
          </div>
          <div id="tpPanelProj">
            <p class="loc-muted">Izaberi projekat i unesi broj TP. Ako projekat nema vezanih RN, koristi „Broj crteža“.</p>
            <label class="loc-filter-field"><span>Projekat</span>
              <select id="tpProjSelect" class="loc-search-input"></select>
            </label>
            <label class="loc-filter-field"><span>Broj TP</span>
              <input type="text" id="tpProjTp" class="loc-search-input" maxlength="8" inputmode="numeric" />
            </label>
            <button type="button" class="btn btn-xs" id="tpProjLoad">Učitaj RN iz projekta</button>
            <div id="tpProjWoList" class="loc-list" style="margin-top:10px;max-height:140px"></div>
          </div>
          <div id="tpPanelDraw" style="display:none">
            <label class="loc-filter-field"><span>Broj crteža</span>
              <input type="text" id="tpDrawNo" class="loc-search-input" maxlength="20" />
            </label>
            <button type="button" class="btn btn-xs" id="tpDrawSearch">Pretraži placement-e</button>
            <div id="tpDrawTableWrap" style="margin-top:10px;max-height:200px;overflow:auto"></div>
          </div>
          <hr style="border:none;border-top:1px solid var(--border2);margin:14px 0" />
          <div id="tpPreview" class="loc-muted" style="min-height:56px"></div>
          <div class="kadr-modal-actions">
            <button type="button" class="btn btn-primary" id="tpDoPrint" disabled>Štampaj nalepnicu</button>
            <button type="button" class="btn" id="tpCancel">Zatvori</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap.firstElementChild);
  const overlay = document.getElementById(id);
  const panelProj = overlay.querySelector('#tpPanelProj');
  const panelDraw = overlay.querySelector('#tpPanelDraw');
  const projSel = overlay.querySelector('#tpProjSelect');
  const tpInput = overlay.querySelector('#tpProjTp');
  const btnLoad = overlay.querySelector('#tpProjLoad');
  const woList = overlay.querySelector('#tpProjWoList');
  const drawNo = overlay.querySelector('#tpDrawNo');
  const btnDrawSearch = overlay.querySelector('#tpDrawSearch');
  const drawWrap = overlay.querySelector('#tpDrawTableWrap');
  const preview = overlay.querySelector('#tpPreview');
  const btnPrint = overlay.querySelector('#tpDoPrint');
  const btnCancel = overlay.querySelector('#tpCancel');

  let previewSpec = null;

  const close = () => {
    unesc();
    removeEl(id);
  };
  const unesc = bindEsc(close);

  btnCancel.addEventListener('click', close);
  overlay.addEventListener('click', ev => {
    if (ev.target === overlay) close();
  });

  overlay.querySelectorAll('[data-tp-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-tp-mode');
      overlay.querySelectorAll('[data-tp-mode]').forEach(b => b.classList.toggle('is-active', b === btn));
      panelProj.style.display = m === 'proj' ? '' : 'none';
      panelDraw.style.display = m === 'draw' ? '' : 'none';
    });
  });

  const projects = await loadProjektiLite({ includeArchived: false });
  projSel.innerHTML =
    `<option value="">— Izaberi projekat —</option>` +
    (projects || [])
      .map(
        p =>
          `<option value="${escHtml(String(p.id))}">${escHtml(p.label || p.code || p.id)}</option>`,
      )
      .join('');

  const setPreview = async (barcodeValue, meta) => {
    if (!barcodeValue) {
      previewSpec = null;
      preview.innerHTML = '<p class="loc-muted">Nema podataka za barkod.</p>';
      btnPrint.disabled = true;
      return;
    }
    const snap =
      meta?.orderNo && meta?.tpNo
        ? await fetchBigtehnOpSnapshotByRnAndTp(meta.orderNo, meta.tpNo)
        : null;
    const naz = snap?.naziv_dela || meta?.naziv || '—';
    const cr = snap?.broj_crteza || meta?.drawing || '—';
    previewSpec = {
      barcodeValue,
      meta: {
        ...meta,
        naziv: snap?.naziv_dela || meta?.naziv || null,
        drawing: snap?.broj_crteza || meta?.drawing || null,
      },
    };
    preview.innerHTML = `
      <div><strong>Barkod:</strong> <code>${escHtml(barcodeValue)}</code></div>
      <div><strong>Crtež:</strong> ${escHtml(String(cr))} · <strong>Naziv:</strong> ${escHtml(String(naz).slice(0, 80))}</div>`;
    btnPrint.disabled = false;
  };

  btnLoad.addEventListener('click', async () => {
    woList.innerHTML = '<p class="loc-muted">Učitavam…</p>';
    const pid = projSel.value;
    const tp = String(tpInput.value || '').replace(/\D/g, '');
    if (!pid || !tp) {
      showToast('⚠ Izaberi projekat i unesi TP');
      woList.innerHTML = '';
      return;
    }
    const links = await loadBigtehnRnsForProjekat(pid);
    const ids = (links || []).map(x => x.bigtehnRnId).filter(Number.isFinite);
    if (!ids.length) {
      woList.innerHTML = '<p class="loc-muted">Projekat nema vezanih BigTehn RN — koristi „Broj crteža“.</p>';
      return;
    }
    const wos = await fetchBigtehnWorkOrdersByIds(ids);
    const hit = (wos || []).filter(wo => {
      const idb = String(wo.ident_broj || '');
      if (idb.endsWith(`/${tp}`)) return true;
      const parts = idb.split('/');
      return parts.length === 2 && parts[1] === tp;
    });
    if (!hit.length) {
      woList.innerHTML = '<p class="loc-muted">Nema RN koji odgovara TP-u u vezi sa ovim projektom.</p>';
      return;
    }
    woList.innerHTML = hit
      .map(wo => {
        const idb = escHtml(String(wo.ident_broj || ''));
        return `<button type="button" class="btn loc-row-click" style="width:100%;text-align:left;margin:2px 0" data-wo-id="${wo.id}">
          <strong>${idb}</strong> · crtež ${escHtml(String(wo.broj_crteza || '—'))}
        </button>`;
      })
      .join('');
    woList.querySelectorAll('[data-wo-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        woList.querySelectorAll('[data-wo-id]').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        const wo = hit.find(x => String(x.id) === btn.getAttribute('data-wo-id'));
        const idb = String(wo?.ident_broj || '');
        const slash = idb.indexOf('/');
        const orderPart = slash >= 0 ? idb.slice(0, slash) : idb;
        const tpPart = slash >= 0 ? idb.slice(slash + 1) : tp;
        const bc = formatBigTehnRnzBarcode({ orderNo: orderPart, tpNo: tpPart });
        await setPreview(bc, {
          orderNo: orderPart,
          tpNo: tpPart,
          drawing: wo?.broj_crteza,
          naziv: wo?.naziv_dela,
        });
      });
    });
  });

  btnDrawSearch.addEventListener('click', async () => {
    const d = String(drawNo.value || '').trim();
    if (!d) {
      showToast('⚠ Unesi broj crteža');
      return;
    }
    drawWrap.innerHTML = '<p class="loc-muted">Pretražujem…</p>';
    const rows = await fetchPlacementsByDrawing(d);
    if (!Array.isArray(rows) || !rows.length) {
      drawWrap.innerHTML = '<p class="loc-muted">Nema placement-a za taj crtež.</p>';
      return;
    }
    const locIdx = new Map();
    const allLocs = await fetchLocations({ activeOnly: false });
    if (Array.isArray(allLocs)) {
      for (const l of allLocs) {
        if (l?.id) locIdx.set(String(l.id), l);
      }
    }
    const head =
      '<table class="loc-table"><thead><tr><th>Nalog</th><th>TP / ref</th><th>Crtež</th><th>Lokacija</th><th>Kol.</th></tr></thead><tbody>';
    const body = rows
      .map((r, idx) => {
        const loc = locIdx.get(String(r.location_id || ''));
        const locLabel = loc
          ? `${escHtml(loc.location_code || '')}`
          : `${escHtml(String(r.location_id || '').slice(0, 8))}…`;
        return `<tr class="loc-row-click" data-ridx="${idx}" style="cursor:pointer">
          <td>${escHtml(String(r.order_no || ''))}</td>
          <td>${escHtml(String(r.item_ref_id || ''))}</td>
          <td>${escHtml(String(r.drawing_no || ''))}</td>
          <td>${locLabel}</td>
          <td>${escHtml(String(r.quantity ?? ''))}</td>
        </tr>`;
      })
      .join('');
    drawWrap.innerHTML = `${head}${body}</tbody></table>`;
    drawWrap.querySelectorAll('tr[data-ridx]').forEach(tr => {
      tr.addEventListener('click', async () => {
        const idx = Number(tr.getAttribute('data-ridx'));
        const p = rows[idx];
        if (!p) return;
        const bc = barcodeForPlacementRow(p);
        await setPreview(bc, {
          orderNo: p.order_no,
          tpNo: p.item_ref_table === 'bigtehn_rn' ? p.item_ref_id : '',
          drawing: p.drawing_no || p.item_ref_id,
          naziv: null,
        });
      });
    });
  });

  btnPrint.addEventListener('click', async () => {
    if (!previewSpec?.barcodeValue) return;
    const m = previewSpec.meta || {};
    const lines = [];
    if (m.orderNo && m.tpNo) {
      lines.push({ text: `RN ${m.orderNo} · TP ${m.tpNo}` });
    } else if (m.orderNo) {
      lines.push({ text: `RN ${m.orderNo}` });
    } else {
      lines.push({ text: 'Radni nalog' });
    }
    lines.push({ text: `Crtež: ${m.drawing || '—'}`, small: true });
    if (m.naziv) lines.push({ text: String(m.naziv).slice(0, 72), small: true });
    await printTechProcessLabelWindow({
      title: 'Tehnološki postupak',
      lines,
      barcodeValue: previewSpec.barcodeValue,
    });
    close();
  });
}
