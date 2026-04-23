/**
 * Plan Proizvodnje — TAB „Po mašini" (v2 — tabovi po odeljenju + drill-down).
 *
 * Struktura (v2):
 *   ┌─ Tabovi odeljenja: Sve | Glodanje | Struganje | Brušenje | Erodiranje |
 *   │                    Ažistiranje | Sečenje+savijanje | Bravarsko |
 *   │                    Farbanje+PZ | CAM | Ostalo
 *   └─ Body (zavisi od tipa odeljenja, vidi `departments.js`):
 *      • „Sve"  → dropdown mašine + operacije (legacy flow, regression-safe)
 *      • „machines"-tab (Glodanje/Struganje/Brušenje/Erodiranje) bez izabrane
 *         mašine → LISTA mašina (sortirano numerički po rj_code), klik =
 *         drill-down. Drill-down ima dugme „← Nazad na listu mašina".
 *      • „operations"-tab (Ažistiranje/Sečenje+savijanje/Bravarsko/Farbanje/
 *         CAM) → odmah operacije bez izbora mašine.
 *      • „Ostalo" → mašine koje ne upadaju ni u jedan mašinski tab + operacije
 *         koje ne upadaju ni u jedan operacioni tab. Klik na mašinu → drill-down.
 *
 * U drill-down/„Sve" sa izabranom mašinom funkcioniše sve kao pre:
 *   - drag-drop reorder (postavlja shift_sort_order)
 *   - klik na status pill cycle
 *   - inline edit napomene (textarea, save na blur)
 *   - REASSIGN na drugu mašinu
 *   - skice (📎), PDF crtež (📄), TP modal (📋)
 *
 * U operacionim tabovima drag-drop je DISABLED (sortiranje je per-mašina,
 * mešanje raznih mašina nema smisla).
 *
 * Read-only kada `!canEdit` (leadpm, hr, viewer): edit dugmad disabled.
 *
 * Public API:
 *   renderPoMasiniTab(host, { canEdit })
 *   teardownPoMasiniTab()
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { formatDate } from '../../lib/date.js';
import {
  loadMachines,
  loadOperationsForMachine,
  loadOperationsForDept,
  upsertOverlay,
  reorderOverlays,
  STATUS_CYCLE_NEXT,
  rokUrgencyClass,
  formatSecondsHm,
  plannedSeconds,
} from '../../services/planProizvodnje.js';
import {
  sanitizeDrawingNo,
  isPlaceholderDrawingNo,
  findExistingDrawings,
  resolveBigtehnDrawing,
  signBigtehnDrawingsStoragePath,
} from '../../services/drawings.js';
import { openDrawingManager } from './drawingManager.js';
import { openTechProcedureModal } from './techProcedureModal.js';
import {
  DEPARTMENTS,
  DEPARTMENTS_ROW_1,
  DEPARTMENTS_ROW_2,
  getDepartment,
  filterMachinesForDept,
  findDeptForMachineCode,
  machineMatchesDept,
  machineFallsIntoOstalo,
} from './departments.js';

/* ── LocalStorage ključevi (UX) ── */
const LS_LAST_MACHINE = 'plan-proizvodnje:last-machine';
const LS_LAST_DEPT    = 'plan-proizvodnje:last-department';

/* ── Local state (po instanci taba — postoji jedan u svakom trenutku) ── */
const state = {
  host: null,
  canEdit: false,

  /* Tab state */
  selectedDeptSlug: 'sve',     /* slug iz DEPARTMENTS */
  selectedMachineCode: null,   /* string rj_code — drill-down ili 'sve' dropdown */

  /* Podaci */
  allMachines: [],     /* [{rj_code, name, no_procedure, department_id}] iz loadMachines() */
  rows: [],            /* trenutne operacije (za izabranu mašinu ili dept) */

  /* UI flags */
  loading: false,
  error: null,
  dragRowKey: null,
};

/* ────────────────────────────────────────────────────────────────────────
 * PUBLIC
 * ──────────────────────────────────────────────────────────────────────── */

export async function renderPoMasiniTab(host, { canEdit }) {
  state.host = host;
  state.canEdit = !!canEdit;

  /* Hidratacija iz localStorage (samo na prvi render — ne briše na tab switch). */
  if (!state.selectedDeptSlug || !getDepartment(state.selectedDeptSlug)) {
    state.selectedDeptSlug = localStorage.getItem(LS_LAST_DEPT) || 'sve';
    if (!getDepartment(state.selectedDeptSlug)) state.selectedDeptSlug = 'sve';
  }

  /* Skeleton: tabovi + toolbar + body. Mašine se učitavaju asinhrono. */
  host.innerHTML = `
    <nav class="pp-dept-tabs" id="ppDeptTabs" role="tablist" aria-label="Odeljenja"></nav>

    <div class="pp-toolbar" id="ppToolbar"></div>

    <div id="ppErrorBox"></div>

    <div class="pp-body" id="ppBody">
      <div class="pp-state">
        <div class="pp-state-icon">⏳</div>
        <div class="pp-state-title">Učitavanje mašina…</div>
      </div>
    </div>
  `;

  renderDeptTabs();
  wireDeptTabs();

  /* Fetch mašine jednom (per renderPoMasiniTab poziv). */
  await loadMachinesAndRender();
}

export function teardownPoMasiniTab() {
  state.host = null;
  state.allMachines = [];
  state.rows = [];
  state.dragRowKey = null;
  state.error = null;
  /* Reset selectedDeptSlug / selectedMachineCode na null — sledeći render
     re-čita izbor iz `localStorage` (`LS_LAST_DEPT` / `LS_LAST_MACHINE`).
     Time se podržava „skok iz Zauzetosti / Pregleda svih" tok: index.js
     prvo upiše LS_LAST_DEPT, pa pozove re-render — poMasiniTab pokupi
     novu vrednost. Korisnikov tab choice unutar modula je već persistiran
     u LS pri svakom kliku, pa se i lokalna navigacija očuva. */
  state.selectedDeptSlug = null;
  state.selectedMachineCode = null;
}

/* ────────────────────────────────────────────────────────────────────────
 * UČITAVANJE MAŠINA
 * ──────────────────────────────────────────────────────────────────────── */

async function loadMachinesAndRender() {
  try {
    state.allMachines = await loadMachines();
  } catch (e) {
    console.error('[pp] loadMachines failed', e);
    state.allMachines = [];
    setError('Greška pri učitavanju mašina iz Supabase-a.');
  }

  /* Restore poslednje izabrane mašine iz LS — ali samo ako je validna
     za trenutni odeljenje. Spreči nepoznat scenario tipa „LS_LAST_MACHINE
     je 6.5 (Brušenje), a ja sam upravo otvorio Glodanje tab → ne želim
     drill-down u 6.5". */
  if (!state.selectedMachineCode) {
    const lastMachine = localStorage.getItem(LS_LAST_MACHINE);
    if (lastMachine && state.allMachines.some(m => m.rj_code === lastMachine)) {
      const dept = getDepartment(state.selectedDeptSlug);
      if (dept && machineFitsDept(lastMachine, dept)) {
        state.selectedMachineCode = lastMachine;
      }
    }
  }

  await renderActiveView();
}

/**
 * Da li mašina (po rj_code) „pripada" datom departmentu — koristi se za
 * validaciju restore-a iz LS-a (vidi `loadMachinesAndRender`).
 *
 * - 'sve' → uvek true (dropdown ima sve mašine)
 * - 'machines' tab → match po prefiksu rj_code-a
 * - 'ostalo' → mašina koja ne upada ni u jedan mašinski tab
 * - 'operations' → false (operacioni tabovi nemaju drill-down u mašinu)
 */
function machineFitsDept(rjCode, dept) {
  if (!dept) return false;
  if (dept.kind === 'all' && !dept.isFallback) return true;
  if (dept.kind === 'machines') {
    return machineMatchesDept({ rj_code: rjCode }, dept);
  }
  if (dept.isFallback) {
    return machineFallsIntoOstalo({ rj_code: rjCode });
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────
 * TABS (odeljenja)
 * ──────────────────────────────────────────────────────────────────────── */

function renderDeptTabs() {
  const el = state.host?.querySelector('#ppDeptTabs');
  if (!el) return;
  /* Forsiramo 2 reda — Red 1 (6 tabova) i Red 2 (5 tabova). Bez
     `flex-wrap: wrap` na single rowu, jer browser prelama gde stigne i
     korisnik dobije nepravilne rasporede u zavisnosti od širine. */
  const renderRow = (depts) => depts.map(d => `
    <button
      type="button" role="tab"
      class="pp-dept-tab${d.slug === state.selectedDeptSlug ? ' is-active' : ''}"
      data-slug="${escHtml(d.slug)}"
      aria-selected="${d.slug === state.selectedDeptSlug ? 'true' : 'false'}">
      ${escHtml(d.label)}
    </button>
  `).join('');
  el.innerHTML = `
    <div class="pp-dept-tabs-row">${renderRow(DEPARTMENTS_ROW_1)}</div>
    <div class="pp-dept-tabs-row">${renderRow(DEPARTMENTS_ROW_2)}</div>
  `;
}

function wireDeptTabs() {
  const el = state.host?.querySelector('#ppDeptTabs');
  if (!el) return;
  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pp-dept-tab');
    if (!btn) return;
    const slug = btn.dataset.slug;
    if (!slug || slug === state.selectedDeptSlug) return;
    state.selectedDeptSlug = slug;
    /* Promena taba → reset drill-down. Za 'sve' tab dropdown kasnije
       restore-uje izabranu mašinu iz LS-a. */
    state.selectedMachineCode = null;
    state.rows = [];
    localStorage.setItem(LS_LAST_DEPT, slug);
    renderDeptTabs();
    await renderActiveView();
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * RENDER: izbor stanja (sve / machines list / drill-down / operations / ostalo)
 * ──────────────────────────────────────────────────────────────────────── */

async function renderActiveView() {
  const dept = getDepartment(state.selectedDeptSlug);
  if (!dept) {
    state.selectedDeptSlug = 'sve';
    return renderActiveView();
  }

  /* 1) "Sve" → klasičan flow sa dropdown-om */
  if (dept.kind === 'all' && !dept.isFallback) {
    return renderSveView();
  }

  /* 2) "machines" tab */
  if (dept.kind === 'machines') {
    if (state.selectedMachineCode) {
      return renderDrillDownView(dept);
    }
    return renderMachineListView(dept);
  }

  /* 3) "operations" tab — direktno operacije */
  if (dept.kind === 'operations') {
    return renderOperationsDeptView(dept);
  }

  /* 4) "Ostalo" — kombinacija: lista mašina iz ostalo + operacije iz ostalo
     ILI drill-down ako je mašina izabrana. */
  if (dept.kind === 'all' && dept.isFallback) {
    if (state.selectedMachineCode) {
      return renderDrillDownView(dept);
    }
    return renderOstaloView(dept);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * VIEW: "Sve" (dropdown mašine + operacije — legacy flow)
 * ──────────────────────────────────────────────────────────────────────── */

async function renderSveView() {
  renderToolbarSve();

  /* 'Sve' tab dropdown pamti zadnju mašinu iz LS-a — čak i kad smo
     upravo došli sa drugog taba (gde je selectedMachineCode resetovan na
     null). Razlika u odnosu na machines tab: dropdown je glavni UI, ne
     drill-down, pa ima smisla auto-selektovati. */
  if (!state.selectedMachineCode) {
    const lastMachine = localStorage.getItem(LS_LAST_MACHINE);
    if (lastMachine && state.allMachines.some(m => m.rj_code === lastMachine)) {
      state.selectedMachineCode = lastMachine;
    }
  }

  const sel = state.host?.querySelector('#ppMachineSelect');
  const btn = state.host?.querySelector('#ppRefreshBtn');
  if (!sel) return;

  if (state.allMachines.length === 0) {
    sel.innerHTML = '<option>Nema mašina (pokreni Bridge sync)</option>';
    sel.disabled = true;
    if (btn) btn.disabled = true;
    renderEmptyBody('Nijedna mašina nije pronađena u <code>bigtehn_machines_cache</code>.');
    return;
  }

  /* Dropdown: procedural mašine na vrhu, non-procedural na dnu. */
  const procedural = state.allMachines.filter(m => !m.no_procedure);
  const nonProcedural = state.allMachines.filter(m => m.no_procedure);
  sel.innerHTML = `
    <option value="">— izaberi mašinu —</option>
    <optgroup label="Mašine">
      ${procedural.map(m =>
        `<option value="${escHtml(m.rj_code)}">${escHtml(m.name)} (${escHtml(m.rj_code)})</option>`,
      ).join('')}
    </optgroup>
    ${nonProcedural.length ? `<optgroup label="Ostalo (kontrola, kooperacija…)">
      ${nonProcedural.map(m =>
        `<option value="${escHtml(m.rj_code)}">${escHtml(m.name)} (${escHtml(m.rj_code)})</option>`,
      ).join('')}
    </optgroup>` : ''}
  `;
  sel.disabled = false;
  if (btn) btn.disabled = false;

  /* Restore selection iz state-a (već hidriran iz LS-a). */
  if (state.selectedMachineCode &&
      state.allMachines.some(m => m.rj_code === state.selectedMachineCode)) {
    sel.value = state.selectedMachineCode;
    await refreshOperationsForMachine();
  } else {
    state.selectedMachineCode = null;
    renderEmptyBody('Izaberi mašinu iz dropdown-a iznad da vidiš njene otvorene operacije.');
    setCounter(null);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * VIEW: Lista mašina (machines tab bez izabrane mašine)
 * ──────────────────────────────────────────────────────────────────────── */

function renderMachineListView(dept) {
  renderToolbarMachineList(dept);

  const list = filterMachinesForDept(state.allMachines, dept);
  setCounter(list.length, { unit: 'machines' });

  const body = state.host?.querySelector('#ppBody');
  if (!body) return;

  if (list.length === 0) {
    body.innerHTML = `
      <div class="pp-state">
        <div class="pp-state-icon">🛠</div>
        <div class="pp-state-title">Nema mašina u ovom odeljenju</div>
        <div class="pp-state-hint">
          Proveri da li su mašine sa prefiksom <code>${escHtml(
            (dept.machinePrefixes || []).join(', '),
          )}</code> sinhronizovane iz BigTehn-a.
        </div>
      </div>
    `;
    return;
  }

  body.innerHTML = `
    <div class="pp-machine-list">
      ${list.map(m => `
        <button type="button" class="pp-machine-row" data-rj="${escHtml(m.rj_code)}">
          <span class="pp-machine-code">${escHtml(m.rj_code)}</span>
          <span class="pp-machine-name">${escHtml(m.name || '—')}</span>
          ${m.no_procedure
            ? '<span class="pp-machine-tag" title="Bez tehnološke procedure (kontrola, kooperacija…)">⚙</span>'
            : ''}
          <span class="pp-machine-chevron" aria-hidden="true">›</span>
        </button>
      `).join('')}
    </div>
  `;

  body.querySelector('.pp-machine-list').addEventListener('click', async (e) => {
    const row = e.target.closest('.pp-machine-row');
    if (!row) return;
    state.selectedMachineCode = row.dataset.rj;
    localStorage.setItem(LS_LAST_MACHINE, state.selectedMachineCode);
    await renderActiveView();
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * VIEW: Drill-down (machines tab sa izabranom mašinom, ili Ostalo + mašina)
 * ──────────────────────────────────────────────────────────────────────── */

async function renderDrillDownView(dept) {
  renderToolbarDrillDown(dept);
  await refreshOperationsForMachine();
}

/* ────────────────────────────────────────────────────────────────────────
 * VIEW: Operations dept (Ažistiranje, Sečenje+savijanje, Bravarsko, …)
 * ──────────────────────────────────────────────────────────────────────── */

async function renderOperationsDeptView(dept) {
  renderToolbarOperations(dept);
  await refreshOperationsForDept(dept);
}

/* ────────────────────────────────────────────────────────────────────────
 * VIEW: Ostalo (mašine bez kategorije + operacije bez kategorije)
 * ──────────────────────────────────────────────────────────────────────── */

async function renderOstaloView(dept) {
  renderToolbarOperations(dept, { isOstalo: true });

  const body = state.host?.querySelector('#ppBody');
  if (!body) return;

  /* Renderuj layout: prvo lista mašina (klik → drill-down), pa ispod operacije. */
  const machines = filterMachinesForDept(state.allMachines, dept);
  body.innerHTML = `
    <div class="pp-ostalo-section">
      <div class="pp-ostalo-section-title">
        Mašine bez kategorije
        <span class="pp-ostalo-count">${machines.length}</span>
      </div>
      ${machines.length === 0
        ? '<div class="pp-state pp-state-mini">Sve mašine pripadaju nekom mašinskom tabu.</div>'
        : `<div class="pp-machine-list">
            ${machines.map(m => `
              <button type="button" class="pp-machine-row" data-rj="${escHtml(m.rj_code)}">
                <span class="pp-machine-code">${escHtml(m.rj_code)}</span>
                <span class="pp-machine-name">${escHtml(m.name || '—')}</span>
                <span class="pp-machine-chevron" aria-hidden="true">›</span>
              </button>
            `).join('')}
          </div>`}
    </div>
    <div class="pp-ostalo-section">
      <div class="pp-ostalo-section-title">Operacije bez kategorije</div>
      <div class="pp-table-wrap" id="ppTableWrap">
        <div class="pp-state">
          <div class="pp-state-icon">⏳</div>
          <div class="pp-state-title">Učitavanje operacija…</div>
        </div>
      </div>
    </div>
  `;

  /* Click handler za mašine u Ostalo */
  const ml = body.querySelector('.pp-machine-list');
  if (ml) {
    ml.addEventListener('click', async (e) => {
      const row = e.target.closest('.pp-machine-row');
      if (!row) return;
      state.selectedMachineCode = row.dataset.rj;
      localStorage.setItem(LS_LAST_MACHINE, state.selectedMachineCode);
      await renderActiveView();
    });
  }

  /* Asinhrono učitaj operacije „Ostalo" — koristi `loadOperationsForDept`
     sa `isFallback=true`. */
  await refreshOperationsForDept(dept, { keepBodyShell: true });
}

/* ────────────────────────────────────────────────────────────────────────
 * TOOLBAR variante
 * ──────────────────────────────────────────────────────────────────────── */

function renderToolbarSve() {
  const tb = state.host?.querySelector('#ppToolbar');
  if (!tb) return;
  tb.innerHTML = `
    <span class="pp-toolbar-label">Mašina:</span>
    <select class="pp-machine-select" id="ppMachineSelect" disabled>
      <option>Učitavanje…</option>
    </select>
    <button class="pp-refresh-btn" id="ppRefreshBtn" disabled title="Osvezi listu operacija">
      <span aria-hidden="true">↻</span> Osveži
    </button>
    <div class="pp-toolbar-spacer"></div>
    <span class="pp-counter" id="ppCounter">— operacija</span>
    ${state.canEdit ? '' : '<span class="pp-readonly-badge">🔒 Read-only</span>'}
  `;
  wireSveToolbar();
}

function wireSveToolbar() {
  const sel = state.host?.querySelector('#ppMachineSelect');
  const btn = state.host?.querySelector('#ppRefreshBtn');
  if (sel) {
    sel.addEventListener('change', async () => {
      state.selectedMachineCode = sel.value || null;
      if (state.selectedMachineCode) {
        localStorage.setItem(LS_LAST_MACHINE, state.selectedMachineCode);
      }
      await refreshOperationsForMachine();
    });
  }
  if (btn) {
    btn.addEventListener('click', async () => {
      if (state.loading) return;
      const dept = getDepartment(state.selectedDeptSlug);
      if (state.selectedMachineCode) {
        await refreshOperationsForMachine({ force: true });
      } else if (dept?.kind === 'operations' || dept?.isFallback) {
        await refreshOperationsForDept(dept, { force: true });
      }
    });
  }
}

function renderToolbarMachineList(dept) {
  const tb = state.host?.querySelector('#ppToolbar');
  if (!tb) return;
  tb.innerHTML = `
    <span class="pp-toolbar-label">Odeljenje:</span>
    <span class="pp-toolbar-title">${escHtml(dept.label)}</span>
    <div class="pp-toolbar-spacer"></div>
    <span class="pp-counter" id="ppCounter">— mašina</span>
    ${state.canEdit ? '' : '<span class="pp-readonly-badge">🔒 Read-only</span>'}
  `;
}

function renderToolbarDrillDown(dept) {
  const tb = state.host?.querySelector('#ppToolbar');
  if (!tb) return;
  const machine = state.allMachines.find(m => m.rj_code === state.selectedMachineCode);
  const machineName = machine?.name || '';
  tb.innerHTML = `
    <button type="button" class="pp-back-btn" id="ppBackBtn"
            title="Nazad na listu mašina">← Nazad</button>
    <span class="pp-toolbar-title pp-drilldown-title">
      <span class="pp-drilldown-dept">${escHtml(dept.label)}</span>
      <span class="pp-drilldown-sep">›</span>
      <span class="pp-drilldown-machine">
        ${escHtml(state.selectedMachineCode)}
        ${machineName ? ` — ${escHtml(machineName)}` : ''}
      </span>
    </span>
    <button class="pp-refresh-btn" id="ppRefreshBtn" title="Osvezi listu operacija">
      <span aria-hidden="true">↻</span> Osveži
    </button>
    <div class="pp-toolbar-spacer"></div>
    <span class="pp-counter" id="ppCounter">— operacija</span>
    ${state.canEdit ? '' : '<span class="pp-readonly-badge">🔒 Read-only</span>'}
  `;
  const back = tb.querySelector('#ppBackBtn');
  if (back) back.addEventListener('click', async () => {
    /* Vrati na listu mašina istog taba; ne briše LS_LAST_MACHINE
       (sledeća poseta tabu pamti zadnju, ali korisnik je sada eksplicitno
       izašao iz drill-down-a, pa lokalno čistimo selectedMachineCode). */
    state.selectedMachineCode = null;
    state.rows = [];
    await renderActiveView();
  });
  const refresh = tb.querySelector('#ppRefreshBtn');
  if (refresh) refresh.addEventListener('click', async () => {
    if (state.loading) return;
    await refreshOperationsForMachine({ force: true });
  });
}

function renderToolbarOperations(dept, opts = {}) {
  const tb = state.host?.querySelector('#ppToolbar');
  if (!tb) return;
  tb.innerHTML = `
    <span class="pp-toolbar-label">${opts.isOstalo ? 'Ostalo:' : 'Operacije:'}</span>
    <span class="pp-toolbar-title">${escHtml(dept.label)}</span>
    <button class="pp-refresh-btn" id="ppRefreshBtn" title="Osvezi listu operacija">
      <span aria-hidden="true">↻</span> Osveži
    </button>
    <div class="pp-toolbar-spacer"></div>
    <span class="pp-counter" id="ppCounter">— operacija</span>
    ${state.canEdit ? '' : '<span class="pp-readonly-badge">🔒 Read-only</span>'}
  `;
  const refresh = tb.querySelector('#ppRefreshBtn');
  if (refresh) refresh.addEventListener('click', async () => {
    if (state.loading) return;
    await refreshOperationsForDept(dept, { force: true });
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * REFRESH OPERATIONS — dva izvora podataka
 * ──────────────────────────────────────────────────────────────────────── */

async function refreshOperationsForMachine() {
  if (!state.selectedMachineCode) {
    renderEmptyBody('Izaberi mašinu da vidiš njene operacije.');
    setCounter(null);
    return;
  }
  state.loading = true;
  setError(null);
  setRefreshSpinner(true);
  try {
    state.rows = await loadOperationsForMachine(state.selectedMachineCode);
    await annotateRowsWithPdfAvailability(state.rows);
  } catch (e) {
    console.error('[pp] loadOperationsForMachine failed', e);
    state.rows = [];
    setError('Greška pri učitavanju operacija. Pogledaj konzolu (DevTools) za detalje.');
  } finally {
    state.loading = false;
    setRefreshSpinner(false);
  }
  renderTable({ allowDragDrop: true });
  setCounter(state.rows.length);
}

async function refreshOperationsForDept(dept, opts = {}) {
  state.loading = true;
  setError(null);
  setRefreshSpinner(true);

  /* Pripremi body shell ako još nije renderovan (npr. direktan ulazak u
     operacioni tab). U Ostalo view shell već postoji (`keepBodyShell:true`). */
  if (!opts.keepBodyShell) {
    const body = state.host?.querySelector('#ppBody');
    if (body) {
      body.innerHTML = `
        <div class="pp-table-wrap" id="ppTableWrap">
          <div class="pp-state">
            <div class="pp-state-icon">⏳</div>
            <div class="pp-state-title">Učitavanje operacija…</div>
          </div>
        </div>
      `;
    }
  }

  try {
    state.rows = await loadOperationsForDept(dept);
    await annotateRowsWithPdfAvailability(state.rows);
  } catch (e) {
    console.error('[pp] loadOperationsForDept failed', e);
    state.rows = [];
    setError('Greška pri učitavanju operacija. Pogledaj konzolu (DevTools) za detalje.');
  } finally {
    state.loading = false;
    setRefreshSpinner(false);
  }

  /* Drag-drop reorder NIJE dozvoljen u operacionim tabovima — sortiranje
     je per-mašina, mešanje raznih mašina nema smisla. */
  renderTable({ allowDragDrop: false });
  setCounter(state.rows.length);
}

async function annotateRowsWithPdfAvailability(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const sanitizedList = rows
    .map(r => sanitizeDrawingNo(r.broj_crteza))
    .filter(Boolean);
  if (sanitizedList.length === 0) {
    rows.forEach(r => { r._hasPdf = false; });
    return;
  }
  let existing;
  try {
    existing = await findExistingDrawings(sanitizedList);
  } catch (e) {
    console.warn('[pp] findExistingDrawings failed → fail-open (prikazuje PDF dugme svuda)', e);
    rows.forEach(r => {
      r._hasPdf = !isPlaceholderDrawingNo(r.broj_crteza);
    });
    return;
  }
  for (const r of rows) {
    const san = sanitizeDrawingNo(r.broj_crteza);
    r._hasPdf = !!san && existing.has(san);
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * BODY HELPERS
 * ──────────────────────────────────────────────────────────────────────── */

function renderEmptyBody(htmlMsg) {
  const body = state.host?.querySelector('#ppBody');
  if (!body) return;
  body.innerHTML = `
    <div class="pp-table-wrap">
      <div class="pp-state">
        <div class="pp-state-icon">🛠</div>
        <div class="pp-state-title">Nema operacija za prikaz</div>
        <div class="pp-state-hint">${htmlMsg}</div>
      </div>
    </div>
  `;
}

function renderTable({ allowDragDrop }) {
  /* Tabela renderuje se u `#ppTableWrap` ako postoji (Ostalo view ima ga
     pre-renderovanog ispod liste mašina). Inače popunjava `#ppBody`. */
  const wrap =
    state.host?.querySelector('#ppTableWrap') ||
    (() => {
      const body = state.host?.querySelector('#ppBody');
      if (!body) return null;
      body.innerHTML = '<div class="pp-table-wrap" id="ppTableWrap"></div>';
      return body.querySelector('#ppTableWrap');
    })();
  if (!wrap) return;

  if (state.rows.length === 0) {
    const dept = getDepartment(state.selectedDeptSlug);
    let hint = 'Sve operacije su završene ili nisu još kreirane u BigTehn-u.';
    if (dept?.kind === 'machines' && state.selectedMachineCode) {
      hint = 'Sve operacije za ovu mašinu su završene ili nisu još kreirane u BigTehn-u.<br>'
        + 'Pokušaj <strong>Osveži</strong> ili izaberi drugu mašinu.';
    } else if (dept?.kind === 'operations') {
      hint = 'Nema otvorenih operacija u ovom odeljenju.';
    } else if (dept?.isFallback) {
      hint = 'Nema operacija koje ne pripadaju nekom drugom tabu — sve je kategorisano. 👍';
    }
    wrap.innerHTML = `
      <div class="pp-state">
        <div class="pp-state-icon">🛠</div>
        <div class="pp-state-title">Nema operacija za prikaz</div>
        <div class="pp-state-hint">${hint}</div>
      </div>
    `;
    return;
  }

  /* NAPOMENA o vidljivim kolonama (po dogovoru sa korisnikom):
   *  - „Op" i „Opis" su SAKRIVENI iz glavne tabele (više mesta za ostale).
   *    Te informacije su i dalje dostupne u 📋 Tehnološki postupak modalu
   *    (tamo se ne dira ništa).
   *  - „Kupac" ima `min-width: 140px` (CSS) da se ne wrap-uje u 3 reda.
   *  - „Crtež" prikazuje broj u prvom redu i klikabilnu 📄 ikonu ispod
   *    (u drugom redu) — vidi `pp-drawing-cell` blok u rowHtml.
   */
  wrap.innerHTML = `
    <table class="pp-table" data-readonly="${state.canEdit ? 'false' : 'true'}">
      <thead>
        <tr>
          <th title="Drag-drop redosled" style="width:28px"></th>
          <th title="Prioritet (drag-drop)" style="width:48px">Pri</th>
          <th>RN</th>
          <th>Crtež</th>
          <th>Deo</th>
          <th class="pp-col-customer">Kupac</th>
          <th>Rok</th>
          <th class="pp-cell-num" title="Urađeno / Ukupno komada">Done / Plan</th>
          <th class="pp-cell-num" title="Tehnološko / Stvarno vreme">T / R</th>
          <th>Status</th>
          <th style="min-width:200px">Šefova napomena</th>
          <th title="Skice / slike">📎</th>
          <th>Mašina</th>
        </tr>
      </thead>
      <tbody>
        ${state.rows.map(r => rowHtml(r, { allowDragDrop })).join('')}
      </tbody>
    </table>
  `;

  wireRows(wrap, { allowDragDrop });
}

function rowKey(r) {
  return `${r.work_order_id}-${r.line_id}`;
}

function rowHtml(r, { allowDragDrop }) {
  const urgency = rokUrgencyClass(r.rok_izrade);
  const rokLabel = r.rok_izrade ? formatDate(r.rok_izrade) : '—';
  const status = r.local_status || 'waiting';
  const planSec = plannedSeconds(r);
  const isReassigned = !!r.assigned_machine_code
    && r.assigned_machine_code !== r.original_machine_code;
  const customerLabel =
    r.customer_short || r.customer_name || (r.customer_id ? `#${r.customer_id}` : '—');

  /* Broj crteža: BigTehn često ima garbage/dirty vrednosti (`.`, `..`,
     `1109245.` sa trailing tačkom itd.). Sanitizujemo za prikaz, a
     `_hasPdf` (set u `annotateRowsWithPdfAvailability` posle učitavanja)
     odlučuje da li uopšte prikazati 📄 PDF dugme. Tako korisnik vidi
     dugme SAMO za crteže koji realno imaju PDF u Bridge keš-u. */
  const brojRaw = r.broj_crteza || '';
  const brojSan = sanitizeDrawingNo(brojRaw);
  const showPdfBtn = !!r._hasPdf;
  const brojDisplay = brojSan || (brojRaw && brojRaw.trim() ? brojRaw : '—');
  const brojTooltip = brojSan && brojSan !== brojRaw.trim()
    ? `${brojSan} (BigTehn: "${brojRaw}")`
    : brojDisplay;

  const noteVal = r.shift_note || '';
  const noteId = `note-${r.work_order_id}-${r.line_id}`;

  const sortVal = r.shift_sort_order;
  const priCell = sortVal != null
    ? `<span class="pp-pri">${escHtml(String(sortVal))}</span>`
    : `<span class="pp-pri is-empty" title="Nije rangirano">–</span>`;

  /* F.5c: HITNE pozicije — overdue (kasni) i today (rok je danas) dobijaju
     crveni leftborder, suptilno crveni background i ⚠ ikonu pre prioriteta.
     ⚠ je pravi DOM <span> sa title/aria-label (ranije je bio CSS ::before
     pseudo-element, koji ne prima tooltip — bug fix). */
  const isUrgent = (urgency === 'overdue' || urgency === 'today');
  const urgentClass = isUrgent
    ? (urgency === 'overdue' ? ' is-urgent is-urgent-overdue' : ' is-urgent is-urgent-today')
    : '';
  const urgentTitle = urgency === 'overdue'
    ? `Rok je istekao (${rokLabel}) — hitno!`
    : urgency === 'today'
      ? `Rok je danas (${rokLabel})!`
      : '';
  const urgentBadgeHtml = isUrgent
    ? `<span class="pp-urgent-badge ${urgency === 'overdue' ? 'pp-urgent-overdue' : 'pp-urgent-today'}" title="${escHtml(urgentTitle)}" aria-label="${escHtml(urgentTitle)}">⚠</span>`
    : '';

  const draggable = allowDragDrop && state.canEdit;

  return `
    <tr
      data-key="${escHtml(rowKey(r))}"
      data-wo="${r.work_order_id}"
      data-line="${r.line_id}"
      class="${r.is_non_machining ? 'is-non-machining' : ''}${isReassigned ? ' is-reassigned' : ''}${urgentClass}"
      ${draggable ? 'draggable="true"' : ''}>
      <td class="pp-drag-handle" title="${draggable
        ? 'Prevuci za prioritet'
        : (state.canEdit
            ? 'Drag dostupan u prikazu jedne mašine (Sve / drill-down)'
            : 'Drag dostupan samo za pm/admin')}">⠿</td>
      <td class="pp-cell-center">${urgentBadgeHtml}${priCell}</td>
      <td class="pp-cell-strong" title="RN ${escHtml(r.rn_ident_broj || '')}">
        ${escHtml(r.rn_ident_broj || '—')}
        <button type="button"
                class="pp-tech-procedure-btn"
                data-action="open-tech-procedure"
                title="Otvori kompletan tehnološki postupak ovog RN-a">📋</button>
      </td>
      <td class="pp-cell-muted pp-cell-drawing" title="${escHtml(brojTooltip)}">
        <div class="pp-drawing-cell">
          <span class="pp-drawing-no">${escHtml(brojDisplay)}</span>
          ${showPdfBtn
            ? `<button type="button"
                       class="pp-drawing-pdf-icon"
                       data-action="open-bigtehn-drawing"
                       data-broj="${escHtml(brojSan)}"
                       data-broj-raw="${escHtml(brojRaw)}"
                       title="Otvori PDF crtež ${escHtml(brojSan)} u novom tab-u">
                 📄 PDF
               </button>`
            : ''}
        </div>
      </td>
      <td class="pp-cell-clip" title="${escHtml(r.naziv_dela || '')}">${escHtml(r.naziv_dela || '—')}</td>
      <td class="pp-cell-muted pp-col-customer" title="${escHtml(r.customer_name || '')}">${escHtml(customerLabel)}</td>
      <td>
        <span class="pp-rok urgency-${urgency || 'none'}" title="${rokLabel}">
          ${escHtml(rokLabel)}
        </span>
      </td>
      <td class="pp-cell-num">
        <span class="pp-cell-strong">${escHtml(String(r.komada_done ?? 0))}</span>
        <span class="pp-cell-muted"> / ${escHtml(String(r.komada_total ?? 0))}</span>
      </td>
      <td class="pp-cell-num pp-cell-muted" title="Tehnološko / Stvarno vreme">
        ${escHtml(formatSecondsHm(planSec))}
        <span class="pp-cell-sep">/</span>
        <span style="color:#86efac">${escHtml(formatSecondsHm(r.real_seconds))}</span>
      </td>
      <td>
        <button type="button"
                class="pp-status s-${status}"
                data-action="cycle-status"
                ${state.canEdit ? '' : 'disabled'}
                title="${state.canEdit ? 'Klikni za sledeći status' : 'Edit dostupan samo za pm/admin'}">
          ${statusLabel(status)}
        </button>
      </td>
      <td>
        <textarea
          id="${noteId}"
          class="pp-note-input"
          rows="1"
          placeholder="${state.canEdit ? 'Napomena…' : '—'}"
          data-action="edit-note"
          ${state.canEdit ? '' : 'disabled'}>${escHtml(noteVal)}</textarea>
        <span class="pp-note-saved" data-saved-for="${noteId}">✓ sačuvano</span>
      </td>
      <td class="pp-cell-center">
        <button type="button"
                class="pp-drawings-btn ${(r.drawings_count || 0) > 0 ? 'has-files' : ''}"
                data-action="open-drawings"
                title="${(r.drawings_count || 0) > 0
                  ? `Pogledaj ${r.drawings_count} skic${r.drawings_count === 1 ? 'u' : 'a'}`
                  : (state.canEdit ? 'Dodaj skicu/sliku' : 'Nema skica')}">
          📎 <span class="pp-drawings-num">${r.drawings_count || 0}</span>
        </button>
      </td>
      <td>
        <div class="pp-machine-cell">
          <span class="pp-machine-current ${isReassigned ? 'is-reassigned' : ''}"
                title="${isReassigned ? 'REASSIGNED iz BigTehn-a' : 'Originalna mašina iz BigTehn-a'}">
            ${escHtml(r.assigned_machine_code || r.original_machine_code || '—')}
          </span>
          ${isReassigned
            ? `<span class="pp-machine-original is-overridden" title="Originalno iz BigTehn-a">
                 (orig: ${escHtml(r.original_machine_code || '—')})
               </span>`
            : ''}
          <button type="button"
                  class="pp-reassign-btn"
                  data-action="reassign-open"
                  ${state.canEdit ? '' : 'disabled'}>
            ${isReassigned ? '↩ Vrati na original' : '⇄ Premesti'}
          </button>
        </div>
      </td>
    </tr>
  `;
}

function statusLabel(s) {
  switch (s) {
    case 'waiting':     return 'Čeka';
    case 'in_progress': return 'U radu';
    case 'blocked':     return 'Blokirano';
    case 'completed':   return 'Završeno';
    default:            return s;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * WIRE: događaji u tabeli (status, napomena, REASSIGN, drawings, drag-drop)
 * ──────────────────────────────────────────────────────────────────────── */

function wireRows(wrap, { allowDragDrop }) {
  wrap.querySelectorAll('button[data-action="cycle-status"]').forEach(btn => {
    btn.addEventListener('click', () => onCycleStatus(btn));
  });

  wrap.querySelectorAll('textarea[data-action="edit-note"]').forEach(ta => {
    let originalVal = ta.value;
    ta.addEventListener('focus', () => { originalVal = ta.value; });
    ta.addEventListener('blur',  () => onSaveNote(ta, originalVal));
  });

  wrap.querySelectorAll('button[data-action="reassign-open"]').forEach(btn => {
    btn.addEventListener('click', () => onReassign(btn));
  });

  wrap.querySelectorAll('button[data-action="open-drawings"]').forEach(btn => {
    btn.addEventListener('click', () => onOpenDrawings(btn));
  });

  wrap.querySelectorAll('button[data-action="open-bigtehn-drawing"]').forEach(btn => {
    btn.addEventListener('click', () => onOpenBigtehnDrawing(btn));
  });

  wrap.querySelectorAll('button[data-action="open-tech-procedure"]').forEach(btn => {
    btn.addEventListener('click', () => onOpenTechProcedure(btn));
  });

  if (allowDragDrop && state.canEdit) {
    wireDragDrop(wrap);
  }
}

async function onOpenDrawings(btn) {
  const tr = btn.closest('tr');
  if (!tr) return;
  const woId   = Number(tr.dataset.wo);
  const lineId = Number(tr.dataset.line);
  const row = state.rows.find(r => r.work_order_id === woId && r.line_id === lineId);
  if (!row) return;

  const opTitle =
    `RN ${row.rn_ident_broj || '?'} · op ${row.operacija || '?'} · ${row.naziv_dela || ''}`.trim();

  await openDrawingManager({
    work_order_id: woId,
    line_id:       lineId,
    opTitle,
    canEdit:       state.canEdit,
    onChange:      (newCount) => {
      row.drawings_count = newCount;
      const numEl = btn.querySelector('.pp-drawings-num');
      if (numEl) numEl.textContent = String(newCount);
      btn.classList.toggle('has-files', newCount > 0);
      btn.title = newCount > 0
        ? `Pogledaj ${newCount} skic${newCount === 1 ? 'u' : 'a'}`
        : (state.canEdit ? 'Dodaj skicu/sliku' : 'Nema skica');
    },
  });
}

/**
 * Klik na 📄 kod broja crteža → otvori PDF iz BigTehn-a u novom tab-u.
 *
 * Pop-up blocker workaround: prvo otvorimo prazan window u user-gesture
 * sinhrono, pa async fetch-ujemo signed URL i postavimo location na otvoreni
 * window. Ako fetch ne uspe, zatvori window i prikaži toast.
 */
async function onOpenBigtehnDrawing(btn) {
  const brojRaw = btn.dataset.brojRaw || '';
  const broj = (btn.dataset.broj && sanitizeDrawingNo(btn.dataset.broj)) || sanitizeDrawingNo(brojRaw) || btn.dataset.broj;
  if (!broj) return;
  console.log('[pp-pdf] klik', { broj, brojRaw: brojRaw || undefined, ver: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?' });
  const tab = window.open('about:blank', '_blank');
  if (!tab) {
    showToast('Pop-up blokiran. Dozvoli pop-up za ovaj sajt.');
    return;
  }
  try {
    const resolved = await resolveBigtehnDrawing(broj);
    console.log('[pp-pdf] resolve', { broj, ok: !!resolved?.storagePath, path: resolved?.storagePath });
    if (!resolved?.storagePath) {
      tab.close();
      const cleaned = brojRaw && brojRaw.trim() !== broj
        ? ` (BigTehn: "${brojRaw}", traženo: "${broj}")`
        : '';
      showToast(
        `PDF crtež "${broj}"${cleaned} nije u Bridge keš-u. ` +
        `Pokreni Bridge sync ili proveri da li PDF postoji u PDM-u.`,
      );
      return;
    }
    const url = await signBigtehnDrawingsStoragePath(resolved.storagePath);
    console.log('[pp-pdf] sign', { ok: !!url });
    if (!url) {
      tab.close();
      showToast(
        'Storage nije mogao da potpiše PDF (proveri da si prijavljen, ili prava na bucket bigtehn-drawings). ' +
        'U konzoli (F12) uključi sve nivoe poruka i traži: pp-pdf ili drawings.sign',
      );
      return;
    }
    tab.location.href = url;
  } catch (e) {
    tab.close();
    showToast('Greška pri otvaranju PDF-a.');
    console.error('[onOpenBigtehnDrawing]', e);
  }
}

/**
 * Klik na 📋 pored RN-a → modal sa kompletnim tehnološkim postupkom
 * (sve operacije + sve prijave radnika za taj RN).
 */
async function onOpenTechProcedure(btn) {
  const tr = btn.closest('tr');
  if (!tr) return;
  const woId = Number(tr.dataset.wo);
  const lineId = Number(tr.dataset.line);
  const row = state.rows.find(r => r.work_order_id === woId && r.line_id === lineId);
  const opTitle = row
    ? `RN ${row.rn_ident_broj || '?'} · ${row.naziv_dela || ''}`.trim()
    : `RN #${woId}`;
  await openTechProcedureModal({ work_order_id: woId, opTitle });
}

/* ── Status cycle ── */

async function onCycleStatus(btn) {
  if (!state.canEdit) return;
  const tr = btn.closest('tr');
  const woId = Number(tr?.dataset.wo);
  const lineId = Number(tr?.dataset.line);
  const row = state.rows.find(r => r.work_order_id === woId && r.line_id === lineId);
  if (!row) return;

  const cur = row.local_status || 'waiting';
  const next = STATUS_CYCLE_NEXT[cur] || 'waiting';

  /* Optimistic UI */
  btn.disabled = true;
  const prevClass = btn.className;
  btn.className = `pp-status s-${next}`;
  btn.textContent = statusLabel(next);

  const res = await upsertOverlay({
    work_order_id: woId,
    line_id: lineId,
    patch: { local_status: next },
  });

  if (res === null) {
    btn.className = prevClass;
    btn.textContent = statusLabel(cur);
    btn.disabled = false;
    showToast('⚠ Status nije sačuvan (proveri konekciju ili rolu)');
    return;
  }

  row.local_status = next;
  btn.disabled = false;
}

/* ── Napomena ── */

async function onSaveNote(ta, originalVal) {
  if (!state.canEdit) return;
  const newVal = ta.value;
  if (newVal === originalVal) return;
  const tr = ta.closest('tr');
  const woId = Number(tr?.dataset.wo);
  const lineId = Number(tr?.dataset.line);
  const row = state.rows.find(r => r.work_order_id === woId && r.line_id === lineId);
  if (!row) return;

  ta.disabled = true;
  const res = await upsertOverlay({
    work_order_id: woId,
    line_id: lineId,
    patch: { shift_note: newVal },
  });
  ta.disabled = false;

  if (res === null) {
    ta.value = originalVal;
    showToast('⚠ Napomena nije sačuvana');
    return;
  }
  row.shift_note = newVal;

  const indicator = ta.parentElement.querySelector('.pp-note-saved');
  if (indicator) {
    indicator.classList.add('is-visible');
    setTimeout(() => indicator.classList.remove('is-visible'), 1400);
  }
}

/* ── REASSIGN ── */

async function onReassign(btn) {
  if (!state.canEdit) return;
  const tr = btn.closest('tr');
  const woId = Number(tr?.dataset.wo);
  const lineId = Number(tr?.dataset.line);
  const row = state.rows.find(r => r.work_order_id === woId && r.line_id === lineId);
  if (!row) return;

  /* Ako je već REASSIGNED → klik znači "vrati na original" */
  const isReassigned = !!row.assigned_machine_code
    && row.assigned_machine_code !== row.original_machine_code;
  if (isReassigned) {
    btn.disabled = true;
    const res = await upsertOverlay({
      work_order_id: woId,
      line_id: lineId,
      patch: { assigned_machine_code: null },
    });
    btn.disabled = false;
    if (res === null) {
      showToast('⚠ Vraćanje na originalnu mašinu nije uspelo');
      return;
    }
    showToast('✓ Vraćeno na originalnu mašinu — operacija će nestati iz ove liste');
    /* Operacija sada ne pripada izabranoj mašini → refresh */
    await refreshAfterReassign();
    return;
  }

  /* Prikazi inline select */
  const cell = tr.querySelector('.pp-machine-cell');
  if (!cell) return;
  if (cell.querySelector('.pp-reassign-select')) return; /* već otvoren */

  const select = document.createElement('select');
  select.className = 'pp-reassign-select';
  select.innerHTML = `
    <option value="">— izaberi mašinu —</option>
    ${state.allMachines
      .filter(m => m.rj_code !== row.original_machine_code)
      .map(m => `<option value="${escHtml(m.rj_code)}">${escHtml(m.name)} (${escHtml(m.rj_code)})</option>`)
      .join('')}
  `;
  cell.appendChild(select);
  select.focus();

  select.addEventListener('change', async () => {
    const newMachine = select.value || null;
    select.disabled = true;
    if (!newMachine) {
      select.remove();
      return;
    }
    const res = await upsertOverlay({
      work_order_id: woId,
      line_id: lineId,
      patch: { assigned_machine_code: newMachine },
    });
    select.disabled = false;
    if (res === null) {
      showToast('⚠ Premestanje nije uspelo');
      select.remove();
      return;
    }
    showToast(`✓ Operacija premeštena na ${newMachine}`);
    await refreshAfterReassign();
  });
  /* Click anywhere else cancels */
  select.addEventListener('blur', () => {
    setTimeout(() => select.parentElement && select.remove(), 150);
  });
}

/**
 * Posle REASSIGN-a (ili „vrati na original") osveži aktuelni view.
 * Operacija je možda nestala iz trenutne mašine ili dept-a.
 */
async function refreshAfterReassign() {
  const dept = getDepartment(state.selectedDeptSlug);
  if (state.selectedMachineCode) {
    await refreshOperationsForMachine();
  } else if (dept?.kind === 'operations' || dept?.isFallback) {
    await refreshOperationsForDept(dept);
  }
}

/* ── Drag-drop reorder ── */

function wireDragDrop(wrap) {
  const tbody = wrap.querySelector('tbody');
  if (!tbody) return;

  tbody.addEventListener('dragstart', e => {
    const tr = e.target.closest('tr[draggable="true"]');
    if (!tr) return;
    state.dragRowKey = tr.dataset.key;
    tr.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', state.dragRowKey);
  });

  tbody.addEventListener('dragend', () => {
    tbody.querySelectorAll('tr.is-dragging').forEach(t => t.classList.remove('is-dragging'));
    tbody.querySelectorAll('.drop-target-above,.drop-target-below').forEach(t => {
      t.classList.remove('drop-target-above', 'drop-target-below');
    });
    state.dragRowKey = null;
  });

  tbody.addEventListener('dragover', e => {
    if (!state.dragRowKey) return;
    const tr = e.target.closest('tr');
    if (!tr || tr.dataset.key === state.dragRowKey) return;
    e.preventDefault();
    tbody.querySelectorAll('.drop-target-above,.drop-target-below').forEach(t => {
      t.classList.remove('drop-target-above', 'drop-target-below');
    });
    const rect = tr.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (e.clientY < mid) tr.classList.add('drop-target-above');
    else                 tr.classList.add('drop-target-below');
  });

  tbody.addEventListener('drop', async e => {
    e.preventDefault();
    if (!state.dragRowKey) return;
    const targetTr = e.target.closest('tr');
    if (!targetTr || targetTr.dataset.key === state.dragRowKey) {
      state.dragRowKey = null;
      return;
    }

    const draggedKey = state.dragRowKey;
    state.dragRowKey = null;

    const before = targetTr.classList.contains('drop-target-above');
    tbody.querySelectorAll('.drop-target-above,.drop-target-below').forEach(t => {
      t.classList.remove('drop-target-above', 'drop-target-below');
    });

    const fromIdx = state.rows.findIndex(r => rowKey(r) === draggedKey);
    let toIdx = state.rows.findIndex(r => rowKey(r) === targetTr.dataset.key);
    if (fromIdx === -1 || toIdx === -1) return;
    if (!before) toIdx += 1;
    if (fromIdx < toIdx) toIdx -= 1;

    const arr = state.rows.slice();
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    state.rows = arr;

    /* Optimistic re-render */
    renderTable({ allowDragDrop: true });

    const res = await reorderOverlays(
      state.rows.map(r => ({ work_order_id: r.work_order_id, line_id: r.line_id })),
    );
    if (res === null) {
      showToast('⚠ Redosled nije sačuvan — osvežavam');
      await refreshOperationsForMachine();
      return;
    }
    state.rows.forEach((r, i) => { r.shift_sort_order = i + 1; });
    renderTable({ allowDragDrop: true });
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * TOOLBAR HELPERS
 * ──────────────────────────────────────────────────────────────────────── */

function setCounter(n, opts = {}) {
  const el = state.host?.querySelector('#ppCounter');
  if (!el) return;
  if (n == null) {
    el.textContent = opts.unit === 'machines' ? '— mašina' : '— operacija';
    return;
  }
  if (opts.unit === 'machines') {
    el.textContent = `${n} ${plural(n, 'mašina', 'mašine', 'mašina')}`;
  } else {
    el.textContent = `${n} ${plural(n, 'operacija', 'operacije', 'operacija')}`;
  }
}

function plural(n, one, two, more) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return two;
  return more;
}

function setError(msg) {
  state.error = msg || null;
  const box = state.host?.querySelector('#ppErrorBox');
  if (!box) return;
  box.innerHTML = msg ? `<div class="pp-error">⚠ ${escHtml(msg)}</div>` : '';
}

function setRefreshSpinner(on) {
  const btn = state.host?.querySelector('#ppRefreshBtn');
  if (!btn) return;
  btn.disabled = !!on;
  const span = btn.querySelector('span');
  if (!span) return;
  if (on) span.classList.add('pp-spin');
  else    span.classList.remove('pp-spin');
}

/* ────────────────────────────────────────────────────────────────────────
 * Re-export findDeptForMachineCode — `index.js` ga koristi za jump iz
 * Zauzetost / Pregled svih (postavlja LS_LAST_DEPT pre nego što renderuje
 * Po mašini tab).
 * ──────────────────────────────────────────────────────────────────────── */
export { findDeptForMachineCode };
