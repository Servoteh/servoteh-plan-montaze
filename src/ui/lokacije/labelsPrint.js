/**
 * Generator nalepnica za police — otvori novu karticu pregledača sa gotovim
 * print-ready HTML-om (A4, 3 kolone × 8 redova = 24 nalepnice). Ti pritisneš
 * Ctrl+P i štampaš. Za delove ne štampamo (BigTehn to već radi).
 *
 * Zašto nova kartica a ne modal: print dialog iz modala u SPA često ponese
 * i CSS ostatka aplikacije (koji ne odgovara štampi). Poseban dokument je
 * izolovan i nikad ne zavisi od trenutne teme.
 */

import { fetchLocations } from '../../services/lokacije.js';
import { showToast } from '../../lib/dom.js';

/**
 * Renderuj stranicu i otvori u novom prozoru/tabu.
 *
 * @param {{ onlyTypes?: string[] }} [opts] - default renderuje SHELF, RACK, BIN
 *   (police i bin-ove); warehouse i virtualne izostavljamo jer nema smisla
 *   lepiti ih na fizičke police.
 */
export async function openShelfLabelsPrint({
  onlyTypes = ['SHELF', 'RACK', 'BIN'],
} = {}) {
  const locs = await fetchLocations();
  if (!Array.isArray(locs) || !locs.length) {
    showToast('⚠ Nema lokacija za štampu');
    return;
  }

  const filtered = locs
    .filter(l => l.is_active !== false)
    .filter(l => onlyTypes.includes(l.location_type))
    .sort((a, b) => (a.location_code || '').localeCompare(b.location_code || ''));

  if (!filtered.length) {
    showToast('⚠ Nema aktivnih polica (SHELF/RACK/BIN) za štampu');
    return;
  }

  const mod = await import('jsbarcode');
  const JsBarcode = mod.default || mod;

  const w = window.open('', '_blank');
  if (!w) {
    showToast('⚠ Dozvoli pop-up da bi štampao nalepnice');
    return;
  }

  w.document.write(labelsHtmlShell(filtered.length));
  w.document.close();

  /* jsbarcode renderuje u <svg> elemente — moramo da čekamo da DOM stigne. */
  const runWhenReady = () => {
    try {
      const host = w.document.getElementById('labelGrid');
      host.innerHTML = filtered.map(labelHtml).join('');
      filtered.forEach(loc => {
        const svg = w.document.getElementById(`bc_${loc.id}`);
        if (!svg) return;
        JsBarcode(svg, loc.location_code, {
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
      w.document.body.innerHTML = `<p style="padding:20px;color:#c00">Greška pri generisanju: ${String(e?.message || e)}</p>`;
    }
  };

  if (w.document.readyState === 'complete') {
    runWhenReady();
  } else {
    w.addEventListener('load', runWhenReady, { once: true });
  }
}

function labelHtml(loc) {
  const code = escapeHtml(loc.location_code || '');
  const name = escapeHtml(loc.name || '');
  return `
    <div class="label">
      <div class="label-code">${code}</div>
      <svg id="bc_${escapeHtml(loc.id)}" class="label-barcode"></svg>
      <div class="label-name">${name}</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
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
    Pritisni <strong>Ctrl + P</strong> (ili Cmd + P na Mac-u) za štampu.
    <button onclick="window.print()">Štampaj</button>
    <button onclick="window.close()">Zatvori</button>
  </div>
  <div id="labelGrid" class="grid">
    ${Array.from({ length: count }).map(() => '<div class="label"><svg class="label-barcode"></svg></div>').join('')}
  </div>
</body>
</html>`;
}
