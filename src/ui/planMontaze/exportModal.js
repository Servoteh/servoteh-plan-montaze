/**
 * Plan Montaže — Export modal (F5.6).
 *
 * Otvori modal sa 4 opcije:
 *   1. JSON  — pun snapshot (allData + phaseModels + locationColorMap),
 *              backward-compatible sa legacy `_version: 5.2`.
 *   2. XLSX  — radni list "Plan montaze" + "Sumarno" po projektu.
 *              Lazy-load preko `loadXlsx()`.
 *   3. PDF (Single Gantt)  — html2canvas + jsPDF, multi-page A4 landscape.
 *   4. PDF (Total Gantt)   — isto, ali iz #totalGanttWrap. Pre snimanja
 *                           prebaci view na 'total' i čekaj tick.
 *   5. Import JSON — file input, replace ili merge u allData (sa potvrdom).
 *
 * Svi handler-i prolaze kroz `canEdit()` proveru gde se menjaju podaci.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  allData,
  planMontazeState,
  phaseModels,
  locationColorMap,
  ensureProjectLocations,
  ensureLocationColorsForProjects,
  ensurePeopleFromProjects,
  persistState,
  persistPhaseModels,
  setActiveView,
  getActiveProject,
  getActiveWP,
} from '../../state/planMontaze.js';
import { loadXlsx } from '../../lib/xlsx.js';
import { loadPdfLibs } from '../../lib/pdf.js';
import { calcDuration } from '../../lib/date.js';
import { calcReadiness, normalizePhaseType } from '../../lib/phase.js';
import { STATUSES } from '../../lib/constants.js';
import { queueCurrentWpSync } from '../../services/plan.js';

let _overlayEl = null;
let _onAfterImport = null;
/** Shell rerender (npr. posle PDF export-a koji privremeno menja view). */
let _onShellRefresh = null;

/* SVG hatch pattern (data URI) za elektro trake u PDF-u.
   Identican onome u `legacy.css` (body.pdf-export blok), ali ga
   ovde drzimo kao konstantu zbog defenzivnog inline-a u onclone i
   crtanja legende u PDF header-u. */
const PDF_ELEC_HATCH_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='6' height='6'>" +
  "<path d='M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5' stroke='%23000' stroke-width='1.6' stroke-opacity='0.6'/>" +
  '</svg>';
const PDF_ELEC_HATCH_BG = `url("data:image/svg+xml;utf8,${PDF_ELEC_HATCH_SVG}")`;

/* ── PUBLIC ──────────────────────────────────────────────────────────── */

export function openExportDialog(opts = {}) {
  closeExportDialog();
  _onAfterImport = opts.onAfterImport || null;
  _onShellRefresh = opts.onShellRefresh || null;

  _overlayEl = document.createElement('div');
  _overlayEl.className = 'modal-overlay open';
  _overlayEl.innerHTML = `
    <div class="modal-panel" role="dialog" aria-label="Export / Import">
      <div class="modal-head">
        <h3>📤 Export / 📂 Import</h3>
        <button type="button" class="modal-close" data-exp-action="close" aria-label="Zatvori">✕</button>
      </div>
      <div class="modal-body">
        <p class="form-hint" style="margin-top:0">Izaberi format izvoza ili učitaj postojeći JSON snapshot.</p>
        <div class="export-grid">
          <button type="button" class="export-tile" data-exp-fmt="json">
            <span class="exp-ic">💾</span>
            <span class="exp-lbl">JSON</span>
            <span class="exp-sub">Pun snapshot (allData + 3D + boje)</span>
          </button>
          <button type="button" class="export-tile" data-exp-fmt="xlsx">
            <span class="exp-ic">📊</span>
            <span class="exp-lbl">Excel (XLSX)</span>
            <span class="exp-sub">Plan + sumarno po projektu</span>
          </button>
          <button type="button" class="export-tile" data-exp-fmt="pdf-gantt">
            <span class="exp-ic">📄</span>
            <span class="exp-lbl">PDF — Aktivan Gant</span>
            <span class="exp-sub">${escHtml(_singleGanttSubLabel())}</span>
          </button>
          <button type="button" class="export-tile" data-exp-fmt="pdf-total">
            <span class="exp-ic">📑</span>
            <span class="exp-lbl">PDF — Ukupan Gant</span>
            <span class="exp-sub">Svi projekti / sve pozicije</span>
          </button>
        </div>
        <div class="export-import-row">
          <label class="export-import-label">
            📂 Učitaj JSON snapshot
            <input type="file" accept=".json,application/json" id="expImportFile" ${canEdit() ? '' : 'disabled'}>
          </label>
          <label class="export-import-label" style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <input type="checkbox" id="expImportMerge" ${canEdit() ? '' : 'disabled'}>
            <span>Spoji sa trenutnim podacima (isti ID se ažurira; ostalo ostaje)</span>
          </label>
          <p class="form-hint" style="margin-top:6px">⚠ Bez „Spoji”: zamenjuje sve projekte u memoriji. Sa „Spoji”: ažurira postojeće projekte/WP/faze po ID-u. DB sync posle uvoza.</p>
        </div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-exp-action="close">Zatvori</button>
      </div>
    </div>
  `;
  document.body.appendChild(_overlayEl);

  /* Format buttons */
  _overlayEl.querySelectorAll('[data-exp-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const fmt = btn.dataset.expFmt;
      if (fmt === 'json') exportAsJSON();
      else if (fmt === 'xlsx') exportAsXLSX();
      else if (fmt === 'pdf-gantt') exportGanttAsPDF('gantt');
      else if (fmt === 'pdf-total') exportGanttAsPDF('total');
    });
  });

  /* Import */
  _overlayEl.querySelector('#expImportFile')?.addEventListener('change', _onImportFileChange);

  /* Close */
  _overlayEl.querySelectorAll('[data-exp-action="close"]').forEach(b => {
    b.addEventListener('click', closeExportDialog);
  });
  _overlayEl.addEventListener('click', (ev) => {
    if (ev.target === _overlayEl) closeExportDialog();
  });
  document.addEventListener('keydown', _onEsc);
}

export function closeExportDialog() {
  document.removeEventListener('keydown', _onEsc);
  if (_overlayEl?.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
  _overlayEl = null;
}

function _onEsc(ev) {
  if (ev.key === 'Escape') closeExportDialog();
}

function _singleGanttSubLabel() {
  const p = getActiveProject();
  const wp = getActiveWP();
  if (!p) return 'Nema aktivnog projekta';
  return (p.code || '') + (wp ? ' / ' + wp.name : '');
}

/* ── EXPORT: JSON ────────────────────────────────────────────────────── */

export function exportAsJSON() {
  closeExportDialog();
  const payload = {
    ...allData,
    _phaseModels: phaseModels,
    _locationColorMap: locationColorMap,
    _exportedAt: new Date().toISOString(),
    _version: '5.2',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const proj = getActiveProject();
  a.download = `plan_${proj?.code || 'export'}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('💾 JSON izvezen');
}

/* ── EXPORT: XLSX ────────────────────────────────────────────────────── */

export async function exportAsXLSX() {
  closeExportDialog();
  showToast('⏳ Učitavam XLSX...');
  let XLSX;
  try {
    XLSX = await loadXlsx();
  } catch (e) {
    showToast('❌ XLSX lib: ' + (e.message || e));
    return;
  }
  const rows = _xlsxPhaseRows();
  if (!rows.length) {
    showToast('⚠ Nema podataka za export');
    return;
  }
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 28 }, { wch: 24 }, { wch: 10 }, { wch: 36 }, { wch: 10 },
    { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 10 }, { wch: 22 },
    { wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 30 },
    { wch: 24 }, { wch: 30 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Plan montaze');

  /* Summary sheet */
  const summary = [];
  (allData.projects || []).forEach(p => {
    let total = 0, done = 0, inP = 0, hold = 0;
    (p.workPackages || []).forEach(wp => (wp.phases || []).forEach(ph => {
      total++;
      if (ph.status === 2) done++;
      if (ph.status === 1) inP++;
      if (ph.status === 3) hold++;
    }));
    summary.push({
      'Projekat': (p.code || '') + ' — ' + (p.name || ''),
      'PM': p.projectM || '',
      'Rok': p.deadline || '',
      'Ukupno faza': total,
      'Završeno': done,
      'U toku': inP,
      'Na čekanju': hold,
    });
  });
  if (summary.length) {
    const ws2 = XLSX.utils.json_to_sheet(summary);
    ws2['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Sumarno');
  }

  const fn = `plan_montaze_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fn);
  showToast('📊 XLSX izvezen');
}

function _xlsxPhaseRows() {
  const rows = [];
  (allData.projects || []).forEach(proj => {
    (proj.workPackages || []).forEach(wp => {
      (wp.phases || []).forEach(ph => {
        const rd = calcReadiness(ph);
        rows.push({
          'Projekat': (proj.code || '') + ' — ' + (proj.name || ''),
          'Pozicija': wp.name || '',
          'RN': wp.rnCode || '',
          'Faza': ph.name || '',
          'Tip': normalizePhaseType(ph.type) === 'electrical' ? 'Elektro' : 'Mašinska',
          'Lokacija': ph.loc || '',
          'Datum početka': ph.start || '',
          'Datum kraja': ph.end || '',
          'Trajanje (d)': calcDuration(ph.start, ph.end) || '',
          'Odgovorni inženjer': ph.engineer || '',
          'Vođa montaže': ph.person || '',
          'Status': STATUSES[ph.status] || '',
          'Procenat (%)': ph.pct || 0,
          'Spremnost': rd.done ? 'Završeno' : (rd.ready ? 'Spreman' : 'Nije spreman'),
          'Razlog': (rd.reasons || []).join(' | '),
          'Blokator': ph.blocker || '',
          'Napomena': ph.note || '',
        });
      });
    });
  });
  return rows;
}

/* ── EXPORT: PDF (Gantt) ─────────────────────────────────────────────── */

export async function exportGanttAsPDF(which) {
  closeExportDialog();

  const targetView = which === 'gantt' ? 'gantt' : 'total';
  const prevView = planMontazeState.activeView;
  const prevProjectId = planMontazeState.activeProjectId;
  const prevWpId = planMontazeState.activeWpId;
  const needTempSwitch = planMontazeState.activeView !== targetView;

  if (needTempSwitch) {
    setActiveView(targetView);
    _onShellRefresh?.();
    showToast('⏳ Pripremam ' + (which === 'gantt' ? 'aktivan' : 'ukupan') + ' Gant...');
    /* Dva rAF da #ganttWrap / #totalGanttWrap postoji u DOM-u. */
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  const finish = (err) => {
    if (needTempSwitch) {
      setActiveView(prevView);
      if (allData.projects.some(p => p.id === prevProjectId)) {
        planMontazeState.activeProjectId = prevProjectId;
        const p = allData.projects.find(p => p.id === prevProjectId);
        if (p?.workPackages?.some(w => w.id === prevWpId)) {
          planMontazeState.activeWpId = prevWpId;
        }
      }
      _onShellRefresh?.();
    }
    if (err) {
      console.error(err);
      showToast('❌ Greška pri PDF-u');
    }
  };

  showToast('⏳ Učitavam PDF lib...');
  let jsPDF, html2canvas;
  try {
    ({ jsPDF, html2canvas } = await loadPdfLibs());
  } catch (e) {
    showToast('❌ PDF lib: ' + (e.message || e));
    finish();
    return;
  }

  /* Nađi DOM kontejner za snapshot. */
  const wrapId = which === 'gantt' ? 'ganttWrap' : 'totalGanttWrap';
  const el = document.getElementById(wrapId);
  if (!el) {
    showToast('⚠ Gant nije renderovan — otvori prvo Gant view');
    finish();
    return;
  }

  showToast('⏳ Generišem PDF...');
  try {
    /* PDF-ove renderujemo uvek u "papirnom" (svetlom) režimu — bez obzira što
       korisnik trenutno gleda dark theme. html2canvas 1.4.1 ne podržava
       `color-mix()` / `oklch()` pa dark-mode stilovi lako završe kao crno.
       Rešenje: u `onclone` callback-u dodajemo `.pdf-export` klasu koja
       aktivira set static (print-safe) pravila van `@media print`. */
    const canvas = await html2canvas(el, {
      backgroundColor: '#ffffff',
      scale: 1.5,
      windowWidth: Math.max(1400, el.scrollWidth),
      scrollX: 0,
      scrollY: 0,
      width: el.scrollWidth,
      height: el.scrollHeight,
      useCORS: true,
      onclone: (clonedDoc) => {
        try {
          /* Forsiraj light temu u klonu (data-theme="light") kako CSS varijable
             iz `[data-theme="light"]` bloka postanu aktivne. */
          clonedDoc.documentElement.setAttribute('data-theme', 'light');
          const bodyEl = clonedDoc.body;
          if (bodyEl) {
            bodyEl.classList.add('pdf-export');
            bodyEl.classList.add(which === 'gantt' ? 'pdf-export-gantt' : 'pdf-export-total');
          }
          /* Defenzivno: html2canvas 1.4.1 ume da preskoci `background-image`
             postavljen samo preko CSS pravila (narocito kada je `background-color`
             postavljen inline sa !important). Eksplicitno injektujemo SVG hatch
             pattern direktno na svaku elektro celiju u klonu kako bi se sigurno
             pojavio u PDF-u. */
          const elecCells = clonedDoc.querySelectorAll(
            '.gantt-cell.bar-elec.bar-phase, .gantt-cell.bar-elec.bar-phase-start, .gantt-cell.bar-elec.bar-phase-end'
          );
          elecCells.forEach(c => {
            c.style.setProperty('background-image', PDF_ELEC_HATCH_BG, 'important');
            c.style.setProperty('background-repeat', 'repeat', 'important');
          });
        } catch (err) {
          console.warn('[export] onclone theme-force failed', err);
        }
      },
    });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    const proj = getActiveProject();
    const wp = getActiveWP();
    const title = which === 'gantt'
      ? 'Gant — ' + (proj?.code || '') + ' / ' + (wp?.name || '')
      : 'Ukupan Gant (svi projekti)';
    const date = new Date().toLocaleDateString('sr-RS');

    const drawHeader = () => {
      pdf.setFontSize(12);
      pdf.text(title, 10, 10);
      pdf.setFontSize(9);
      pdf.text('Datum: ' + date, pageW - 45, 10);
      _drawTypeLegend(pdf, pageW, 10);
    };

    drawHeader();

    const imgW = pageW - 20;
    const imgH = canvas.height * imgW / canvas.width;
    if (imgH <= pageH - 20) {
      pdf.addImage(imgData, 'PNG', 10, 15, imgW, imgH);
    } else {
      /* Multi-page slice */
      const pxPerMM = canvas.width / imgW;
      const pageImgHmm = pageH - 20;
      const sliceHpx = pageImgHmm * pxPerMM;
      let yOffset = 0;
      let first = true;
      while (yOffset < canvas.height) {
        const sliceH = Math.min(sliceHpx, canvas.height - yOffset);
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = canvas.width;
        sliceCanvas.height = sliceH;
        const ctx = sliceCanvas.getContext('2d');
        ctx.drawImage(canvas, 0, yOffset, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
        const data = sliceCanvas.toDataURL('image/png');
        if (!first) {
          pdf.addPage();
          drawHeader();
        }
        pdf.addImage(data, 'PNG', 10, 15, imgW, sliceH / pxPerMM);
        yOffset += sliceH;
        first = false;
      }
    }
    const fn = `gantt_${which}_${new Date().toISOString().slice(0, 10)}.pdf`;
    pdf.save(fn);
    showToast('📄 PDF sačuvan');
    finish();
  } catch (e) {
    finish(e);
  }
}

/* Crta mini legendu (Masinska solid / Elektro hatched) u PDF header-u.
   Pozicionira se levo od datuma kako bi izbegla preklapanje. Crta direktno
   preko jsPDF API-ja (vector) tako da je ostro citljiva u svakom zoom-u.
   `topMm` je y koordinata reda u kome je vec ispisan title. */
function _drawTypeLegend(pdf, pageW, topMm) {
  const swW = 8;
  const swH = 3.6;
  const yLine = topMm - 1.5;
  const ySwatch = topMm - 4.4;

  const labelMech = 'Masinska';
  const labelElec = 'Elektro';

  pdf.setFontSize(8);
  pdf.setTextColor(20, 20, 20);

  const wMech = pdf.getTextWidth(labelMech);
  const wElec = pdf.getTextWidth(labelElec);

  const gap = 3;
  const blockMechW = swW + 1.6 + wMech;
  const blockElecW = swW + 1.6 + wElec;
  const totalW = blockMechW + gap + blockElecW;

  /* Datum se ispisuje kod (pageW - 45). Pomeramo legendu jos vise levo. */
  const xRight = pageW - 50;
  let x = xRight - totalW;

  /* Masinska — solid plava (ista paleta kao .leg-mech swatch). */
  pdf.setFillColor(77, 163, 255);
  pdf.rect(x, ySwatch, swW, swH, 'F');
  pdf.setDrawColor(120, 120, 120);
  pdf.rect(x, ySwatch, swW, swH, 'S');
  pdf.text(labelMech, x + swW + 1.2, yLine);

  x += blockMechW + gap;

  /* Elektro — solid plava + nacrtane tanke dijagonalne linije (vector).
     Linije crtamo unutar clip-ovanog pravougaonika tako da nema overflow-a. */
  pdf.setFillColor(77, 163, 255);
  pdf.rect(x, ySwatch, swW, swH, 'F');

  const hasClipApi = typeof pdf.saveGraphicsState === 'function'
    && typeof pdf.restoreGraphicsState === 'function'
    && typeof pdf.clip === 'function';

  if (hasClipApi) {
    pdf.saveGraphicsState();
    pdf.rect(x, ySwatch, swW, swH);
    pdf.clip();
    if (typeof pdf.discardPath === 'function') pdf.discardPath();
  }

  pdf.setDrawColor(0, 0, 0);
  pdf.setLineWidth(0.18);
  const step = 1.4;
  for (let t = -swH; t <= swW + swH; t += step) {
    /* Linija od (x+t, ySwatch) do (x+t+swH, ySwatch+swH) (45deg dole-desno). */
    const x1 = x + t;
    const y1 = ySwatch;
    const x2 = x + t + swH;
    const y2 = ySwatch + swH;
    if (hasClipApi) {
      pdf.line(x1, y1, x2, y2);
    } else {
      /* Manuelni clip ako nemamo saveGraphicsState. */
      const cx1 = Math.max(x, x1);
      const cy1 = y1 + (cx1 - x1);
      const cx2 = Math.min(x + swW, x2);
      const cy2 = y1 + (cx2 - x1);
      if (cx2 > cx1 && cy2 > cy1 && cy1 <= ySwatch + swH) {
        pdf.line(cx1, cy1, cx2, Math.min(cy2, ySwatch + swH));
      }
    }
  }

  if (hasClipApi) pdf.restoreGraphicsState();

  pdf.setDrawColor(120, 120, 120);
  pdf.setLineWidth(0.2);
  pdf.rect(x, ySwatch, swW, swH, 'S');
  pdf.text(labelElec, x + swW + 1.2, yLine);
}

/* ── IMPORT: merge helpers (isti ID → ažuriranje) ────────────────────── */

function _mergePhasesInto(curPhases, incomingPhases) {
  const list = (curPhases || []).slice();
  for (const np of incomingPhases || []) {
    const i = list.findIndex(p => p.id === np.id);
    if (i === -1) list.push(np);
    else Object.assign(list[i], np);
  }
  return list;
}

function _mergeWorkPackagesInto(curWps, incomingWps) {
  const list = (curWps || []).slice();
  for (const nw of incomingWps || []) {
    const i = list.findIndex(w => w.id === nw.id);
    if (i === -1) {
      list.push(nw);
      continue;
    }
    const cw = list[i];
    Object.keys(nw).forEach(k => {
      if (k === 'phases') return;
      cw[k] = nw[k];
    });
    cw.phases = _mergePhasesInto(cw.phases, nw.phases);
  }
  return list;
}

function _mergeProjectsFromSnapshot(incomingProjects) {
  for (const np of incomingProjects) {
    const idx = allData.projects.findIndex(p => p.id === np.id);
    if (idx === -1) {
      allData.projects.push(np);
      continue;
    }
    const cur = allData.projects[idx];
    Object.keys(np).forEach(k => {
      if (k === 'workPackages') return;
      cur[k] = np[k];
    });
    cur.workPackages = _mergeWorkPackagesInto(cur.workPackages, np.workPackages);
  }
}

function _applyPointersAfterImport({ merge }) {
  planMontazeState.filteredIndices = null;
  if (!merge) {
    planMontazeState.activeProjectId = allData.projects[0]?.id || null;
    planMontazeState.activeWpId = allData.projects[0]?.workPackages?.[0]?.id || null;
    return;
  }
  const stillProject = allData.projects.some(p => p.id === planMontazeState.activeProjectId);
  if (!stillProject) {
    planMontazeState.activeProjectId = allData.projects[0]?.id || null;
    planMontazeState.activeWpId = allData.projects[0]?.workPackages?.[0]?.id || null;
    return;
  }
  const p = allData.projects.find(pr => pr.id === planMontazeState.activeProjectId);
  const stillWp = p?.workPackages?.some(w => w.id === planMontazeState.activeWpId);
  if (!stillWp) {
    planMontazeState.activeWpId = p.workPackages?.[0]?.id || null;
  }
}

/* ── IMPORT: JSON ────────────────────────────────────────────────────── */

function _onImportFileChange(ev) {
  if (!canEdit()) {
    showToast('⚠ Pregled — nema izmena');
    ev.target.value = '';
    return;
  }
  const file = ev.target.files?.[0];
  if (!file) return;
  const merge = document.getElementById('expImportMerge')?.checked;
  const msg = merge
    ? 'Spajanje će ažurirati postojeće projekte/WP/faze sa istim ID-jem i dodati nove. Nastavi?'
    : 'Učitavanje će zameniti trenutne projekte u memoriji. Nastavi?';
  if (!confirm(msg)) {
    ev.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const d = JSON.parse(e.target.result);
      if (!d.projects || !Array.isArray(d.projects)) {
        showToast('❌ Format nije ispravan (očekuje "projects" niz)');
        return;
      }
      if (!merge) {
        allData.projects.length = 0;
        d.projects.forEach(p => allData.projects.push(p));
      } else {
        _mergeProjectsFromSnapshot(d.projects);
      }

      /* Sidecar mape (3D modeli, location colors) — merge umesto replace. */
      if (d._phaseModels && typeof d._phaseModels === 'object') {
        Object.assign(phaseModels, d._phaseModels);
        persistPhaseModels();
      }
      if (d._locationColorMap && typeof d._locationColorMap === 'object') {
        Object.assign(locationColorMap, d._locationColorMap);
      }

      /* Resetuj pointers (merge čuva aktivni proj/WP ako i dalje postoje). */
      _applyPointersAfterImport({ merge });

      allData.projects.forEach(ensureProjectLocations);
      ensureLocationColorsForProjects();
      ensurePeopleFromProjects();
      persistState();

      closeExportDialog();
      showToast('📂 Imported');
      _onAfterImport?.();
      /* Ako smo online — sync prvog WP-a u DB (ostatak će ići preko user
         interakcije). Korisnik će biti svestan da treba ručno raditi
         na pojedinačnim projektima/WP-ovima da bi se i tu okinuo upsert. */
      queueCurrentWpSync();
    } catch (err) {
      console.error(err);
      showToast('❌ JSON greška: ' + (err.message || err));
    }
  };
  reader.readAsText(file);
  ev.target.value = '';
}
