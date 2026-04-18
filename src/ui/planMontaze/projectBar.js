/**
 * Plan Montaže — project bar + WP tabs.
 *
 *   - Project selector: <select> svih projekata + "Novi" + "Meta" + "Obriši"
 *   - WP tabs: tabovi po work package-ovima aktivnog projekta + "+ Nova pozicija"
 *   - Switch logika: switchProject() radi async reload sa race protekcijom
 *     (`activeProjectLoadToken`), switchWP() je sinhroni rerender.
 *
 * UI handleri pozivaju eksternu `onChange` callback koju prosleđuje root
 * (`renderPlanMontazeModule`) — root onda triggeruje rerender plan tabele i
 * gantt-a po potrebi.
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { canEdit, isLeadPM, getIsOnline } from '../../state/auth.js';
import {
  allData,
  planMontazeState,
  getActiveProject,
  getActiveWP,
  setActiveProject,
  setActiveWp,
  ensureProjectLocations,
  ensureLocationColorsForProjects,
  createBlankProject,
  createBlankWP,
  persistState,
} from '../../state/planMontaze.js';
import {
  loadAllProjectData,
  saveProjectToDb,
  saveWorkPackageToDb,
  deleteProjectFromDb,
} from '../../services/projects.js';

let panelRoot = null;
let onChangeCb = null;

/** Render HTML za project bar (bez wire-ovanja). */
export function projectBarHtml() {
  const p = getActiveProject();
  const opts = (allData.projects || [])
    .map(pr => `<option value="${escHtml(pr.id)}"${pr.id === planMontazeState.activeProjectId ? ' selected' : ''}>${escHtml(pr.code)} — ${escHtml(pr.name)}</option>`)
    .join('');
  const isAdmin = canEdit();
  return `
    <div class="project-bar" role="toolbar" aria-label="Projekat">
      <label class="project-select-wrap">
        <span class="project-select-label">Projekat</span>
        <select id="projectSelect" aria-label="Izaberi projekat">${opts}</select>
      </label>
      <div class="project-bar-actions">
        <button type="button" class="btn btn-ghost" id="projectMetaBtn" title="Uredi meta podatke projekta" ${isAdmin ? '' : 'disabled'}>✏️ Meta</button>
        <button type="button" class="btn btn-ghost" id="projectAddBtn" title="Novi projekat" ${isAdmin ? '' : 'disabled'}>＋ Novi</button>
        <button type="button" class="btn btn-ghost danger" id="projectDeleteBtn" title="Obriši aktivni projekat (samo LeadPM)" ${isLeadPM() ? '' : 'disabled'}>🗑 Obriši</button>
      </div>
      <div class="project-bar-meta">
        <span class="project-bar-rok" title="Krajnji rok projekta">${p?.deadline ? '📅 Rok: ' + escHtml(p.deadline) : ''}</span>
      </div>
    </div>
  `;
}

/** Render HTML za WP tab strip (bez wire-ovanja). */
export function wpTabsHtml() {
  const p = getActiveProject();
  if (!p) return '<div class="wp-tabs"></div>';
  const tabs = (p.workPackages || [])
    .map(w => `<button type="button" class="wp-tab${w.id === planMontazeState.activeWpId ? ' active' : ''}" data-wp-id="${escHtml(w.id)}">${escHtml(w.name)} <span class="wp-code">${escHtml(w.rnCode)}</span></button>`)
    .join('');
  const canAdd = canEdit();
  return `
    <div class="wp-tabs-wrap">
      <div class="wp-tabs" role="tablist" aria-label="Pozicije projekta">${tabs}</div>
      <div class="wp-tabs-actions">
        <button type="button" class="btn btn-ghost" id="wpAddBtn" title="Nova pozicija (Work Package)" ${canAdd ? '' : 'disabled'}>＋ Pozicija</button>
        <button type="button" class="btn btn-ghost" id="wpMetaBtn" title="Uredi meta podatke pozicije" ${canAdd ? '' : 'disabled'}>✏️ Meta</button>
      </div>
    </div>
  `;
}

/* ── Switch logic ────────────────────────────────────────────────────── */

/**
 * Switch active project. Race-safe: token štiti od starog async load-a.
 */
export async function switchProject(id) {
  const token = ++planMontazeState.activeProjectLoadToken;
  setActiveProject(id);
  const p = getActiveProject();
  /* Izaberi prvi WP samo ako trenutni activeWpId nije u novom projektu. */
  if (!p || !p.workPackages?.some(w => w.id === planMontazeState.activeWpId)) {
    setActiveWp(p?.workPackages?.[0]?.id || null);
  }
  planMontazeState.filteredIndices = null;
  ensureProjectLocations(p);
  onChangeCb?.();

  if (getIsOnline() && p) {
    try {
      const wps = await loadAllProjectData(p.id);
      if (token !== planMontazeState.activeProjectLoadToken) return;
      if (!wps) return;
      p.workPackages = wps;
      ensureProjectLocations(p);
      ensureLocationColorsForProjects();
      if (!wps.some(w => w.id === planMontazeState.activeWpId)) {
        setActiveWp(wps[0]?.id || null);
      }
      persistState();
      onChangeCb?.();
    } catch (e) {
      console.warn('[plan] switchProject reload failed', e);
    }
  }
}

/** Switch active WP — sinhroni rerender bez DB reload-a. */
export function switchWP(id) {
  const p = getActiveProject();
  if (!p || !p.workPackages?.some(w => w.id === id)) return;
  setActiveWp(id);
  planMontazeState.filteredIndices = null;
  onChangeCb?.();
}

/* ── Add / Delete project + WP ───────────────────────────────────────── */

async function addProject() {
  if (!canEdit()) { showToast('⚠ Pregled — nema izmena'); return; }
  const code = prompt('Kod projekta:', '');
  if (!code) return;
  const name = prompt('Naziv:', '');
  if (!name) return;
  const p = createBlankProject(code, name);
  allData.projects.push(p);
  setActiveProject(p.id);
  setActiveWp(p.workPackages[0]?.id || null);
  if (getIsOnline()) {
    await saveProjectToDb(p);
    for (const wp of p.workPackages) await saveWorkPackageToDb(wp, p.id);
  }
  persistState();
  ensureLocationColorsForProjects();
  onChangeCb?.();
  showToast('✅ Projekat kreiran');
}

async function deleteActiveProject() {
  if (!isLeadPM()) { showToast('⚠ Samo LeadPM može obrisati projekat'); return; }
  const p = getActiveProject();
  if (!p) { showToast('⚠ Nema aktivnog projekta'); return; }
  const code = prompt(
    `⚠ OPASNA AKCIJA: Obrisaćeš projekat "${p.code} — ${p.name}" i SVE njegove pozicije i faze.\n\nOvo nije moguće poništiti.\n\nAko si siguran, upiši tačan kod projekta (${p.code}) za potvrdu:`,
    ''
  );
  if (code == null) return;
  if (String(code).trim() !== String(p.code).trim()) {
    showToast('❌ Kod se ne poklapa — otkazano');
    return;
  }
  if (!confirm(`Poslednja potvrda: obriši projekat "${p.name}" zauvek?`)) return;
  const targetId = p.id;
  if (getIsOnline()) await deleteProjectFromDb(targetId);
  /* Lokalni purge */
  const idx = allData.projects.findIndex(pp => pp.id === targetId);
  if (idx !== -1) allData.projects.splice(idx, 1);
  const next = allData.projects[0];
  setActiveProject(next?.id || null);
  setActiveWp(next?.workPackages?.[0]?.id || null);
  persistState();
  onChangeCb?.();
  showToast('🗑 Projekat obrisan');
}

async function addWorkPackage() {
  if (!canEdit()) { showToast('⚠ Pregled — nema izmena'); return; }
  const p = getActiveProject();
  if (!p) { showToast('⚠ Nema aktivnog projekta'); return; }
  const name = prompt('Naziv pozicije (npr. Presa 350t):', '');
  if (!name) return;
  const order = (p.workPackages?.length || 0) + 1;
  const rnCode = p.code ? `${p.code}/${order}` : '';
  const wp = createBlankWP(name, rnCode, order);
  p.workPackages.push(wp);
  setActiveWp(wp.id);
  if (getIsOnline()) {
    await saveWorkPackageToDb(wp, p.id);
    /* Phases will be saved by queueCurrentWpSync upon next render. */
  }
  persistState();
  ensureLocationColorsForProjects();
  onChangeCb?.();
  showToast('✅ Pozicija dodata');
}

/* ── PUBLIC: WIRE ────────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} root
 * @param {object} options
 * @param {() => void} options.onChange — pozove se posle svake promene state-a
 *   (switch project/WP, add/delete project/WP). Root rerendera celu sekciju.
 * @param {() => void} options.onEditWpMeta — otvori WP meta modal.
 * @param {() => void} options.onEditProjectMeta — otvori project meta modal.
 */
export function wireProjectBar(root, { onChange, onEditWpMeta, onEditProjectMeta } = {}) {
  panelRoot = root;
  onChangeCb = onChange || null;

  root.querySelector('#projectSelect')?.addEventListener('change', (ev) => {
    const id = ev.target.value;
    if (id) switchProject(id);
  });
  root.querySelector('#projectMetaBtn')?.addEventListener('click', () => {
    onEditProjectMeta?.();
  });
  root.querySelector('#projectAddBtn')?.addEventListener('click', addProject);
  root.querySelector('#projectDeleteBtn')?.addEventListener('click', deleteActiveProject);

  root.querySelectorAll('.wp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.wpId;
      if (id) switchWP(id);
    });
  });
  root.querySelector('#wpAddBtn')?.addEventListener('click', addWorkPackage);
  root.querySelector('#wpMetaBtn')?.addEventListener('click', () => {
    if (!getActiveWP()) { showToast('⚠ Nema aktivne pozicije'); return; }
    onEditWpMeta?.();
  });
}
