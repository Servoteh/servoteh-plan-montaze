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
 *   5. Import JSON — file input, replace allData (sa potvrdom).
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

/* ── PUBLIC ──────────────────────────────────────────────────────────── */

export function openExportDialog(opts = {}) {
  closeExportDialog();
  _onAfterImport = opts.onAfterImport || null;

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
          <p class="form-hint" style="margin-top:6px">⚠ Učitavanjem se zamenjuju lokalni podaci u memoriji. DB sync se zatim okida sa novim sadržajem.</p>
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

  /* Ako trenutni view nije onaj koji izvozimo, prebaci na njega. */
  const targetView = which === 'gantt' ? 'gantt' : 'total';
  if (planMontazeState.activeView !== targetView) {
    setActiveView(targetView);
    /* Tražimo da neko (parent) rerenderuje shell — onAfterViewSwitch hook
       nije implementiran ovde, pa se oslanjamo na kratak delay i postojeći
       state listener. U slučaju da parent ne reaguje, korisnik može sam
       prebaciti view i pokrenuti export ponovo. */
    showToast('⏳ Pripremam ' + (which === 'gantt' ? 'aktivan' : 'ukupan') + ' Gant...');
    /* Damo browser-u tick da rerenderuje. */
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  showToast('⏳ Učitavam PDF lib...');
  let jsPDF, html2canvas;
  try {
    ({ jsPDF, html2canvas } = await loadPdfLibs());
  } catch (e) {
    showToast('❌ PDF lib: ' + (e.message || e));
    return;
  }

  /* Nađi DOM kontejner za snapshot. */
  const wrapId = which === 'gantt' ? 'ganttWrap' : 'totalGanttWrap';
  const el = document.getElementById(wrapId);
  if (!el) {
    showToast('⚠ Gant nije renderovan — otvori prvo Gant view');
    return;
  }

  showToast('⏳ Generišem PDF...');
  try {
    const isDark = !document.documentElement.classList.contains('theme-light');
    const bg = isDark ? '#0a0e14' : '#ffffff';
    const canvas = await html2canvas(el, {
      backgroundColor: bg,
      scale: 1.5,
      windowWidth: Math.max(1400, el.scrollWidth),
      scrollX: 0,
      scrollY: 0,
      width: el.scrollWidth,
      height: el.scrollHeight,
      useCORS: true,
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
  } catch (e) {
    console.error(e);
    showToast('❌ Greška pri PDF-u');
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
  if (!confirm('Učitavanje će zameniti trenutne projekte u memoriji. Nastavi?')) {
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
      /* Replace allData.projects in place tako da svi postojeći getteri vide novi state. */
      allData.projects.length = 0;
      d.projects.forEach(p => allData.projects.push(p));

      /* Sidecar mape (3D modeli, location colors) — merge umesto replace. */
      if (d._phaseModels && typeof d._phaseModels === 'object') {
        Object.assign(phaseModels, d._phaseModels);
        persistPhaseModels();
      }
      if (d._locationColorMap && typeof d._locationColorMap === 'object') {
        Object.assign(locationColorMap, d._locationColorMap);
      }

      /* Resetuj pointers na prvi projekt/WP. */
      planMontazeState.activeProjectId = allData.projects[0]?.id || null;
      planMontazeState.activeWpId = allData.projects[0]?.workPackages?.[0]?.id || null;
      planMontazeState.filteredIndices = null;

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
