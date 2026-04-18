/**
 * Plan Montaže — Project meta + WP meta modali (on-demand overlay).
 *
 * Modali se kreiraju dinamički kada korisnik klikne "Meta" dugme i uklanjaju
 * iz DOM-a po zatvaranju (Escape, klik van panela, ✕).
 *
 * Project meta: kod, naziv, PM, deadline, PM/LeadPM email, reminder enabled,
 *               + management lokacija projekta (add/rename/delete).
 * WP meta:      naziv pozicije, RN kod, lokacija, deadline, default engineer,
 *               default lead, + "Primeni prazne / Primeni na sve".
 */

import { escHtml, showToast } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  getActiveProject,
  getActiveWP,
  ensureProjectLocations,
  getProjectLocations,
  isLocationInUse,
  renameLocationEverywhere,
  getLocationColor,
  ENGINEERS,
  VODJA,
  addEngineerName,
  addLeadName,
  persistState,
} from '../../state/planMontaze.js';
import { DEFAULT_LOCATIONS } from '../../lib/constants.js';
import { saveWorkPackageToDb } from '../../services/projects.js';
import { queueProjectSave, queueCurrentWpSync } from '../../services/plan.js';
import { personOptionsHtml, locationOptionsHtml } from './shared.js';

let _onChangeRoot = null;

function _triggerRefresh() {
  _onChangeRoot?.();
}

function _closeModal(modal) {
  modal?.remove();
}

function _attachOverlayClose(modal) {
  modal.addEventListener('click', (ev) => {
    if (ev.target === modal) _closeModal(modal);
  });
  const onEsc = (ev) => {
    if (ev.key === 'Escape') {
      _closeModal(modal);
      window.removeEventListener('keydown', onEsc);
    }
  };
  window.addEventListener('keydown', onEsc);
}

/* ── PROJECT META ────────────────────────────────────────────────────── */

export function openProjectMetaModal(onChange) {
  _onChangeRoot = onChange || _onChangeRoot;
  if (!canEdit()) { showToast('⚠ Pregled — nema izmena'); return; }
  const p = getActiveProject();
  if (!p) return;
  ensureProjectLocations(p);

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'projectMetaModal';
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-labelledby="projectMetaTitle">
      <div class="modal-header">
        <h3 id="projectMetaTitle">Meta: ${escHtml(p.code)} — ${escHtml(p.name)}</h3>
        <button type="button" class="modal-close" aria-label="Zatvori">✕</button>
      </div>
      <div class="modal-body" id="projectMetaBody">${_projectFormHtml(p)}</div>
    </div>
  `;
  document.body.appendChild(modal);
  _wireProjectMeta(modal, p);
  _attachOverlayClose(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => _closeModal(modal));
}

function _projectFormHtml(p) {
  const locs = getProjectLocations(p);
  const locsHtml = locs.length
    ? locs.map((l, idx) => `
        <div class="loc-row" data-loc-idx="${idx}">
          <span class="loc-color-dot" style="background:${getLocationColor(l)}" aria-hidden="true"></span>
          <input type="text" value="${escHtml(l)}" data-loc-input="${idx}">
          <button type="button" class="loc-del" title="Obriši" data-loc-del="${idx}">✕</button>
        </div>
      `).join('')
    : '<div class="form-hint">Nema lokacija</div>';
  return `
    <div class="form-grid">
      <label>Kod<input type="text" id="pmCode" value="${escHtml(p.code)}"></label>
      <label>Naziv<input type="text" id="pmName" value="${escHtml(p.name)}"></label>
      <label>Project Manager<input type="text" id="pmM" value="${escHtml(p.projectM)}"></label>
      <label>Rok<input type="date" id="pmDeadline" value="${escHtml(p.deadline || '')}"></label>
      <label>PM Email<input type="text" id="pmPmEmail" value="${escHtml(p.pmEmail)}"></label>
      <label>LeadPM Email<input type="text" id="pmLeadEmail" value="${escHtml(p.leadPmEmail)}"></label>
      <label class="form-checkbox-row">
        <input type="checkbox" id="pmReminder" ${p.reminderEnabled ? 'checked' : ''}>
        <span>Reminder uključen</span>
      </label>
    </div>
    <hr class="form-sep">
    <div class="form-section-title">Lokacije projekta</div>
    <div class="loc-list" id="locList">${locsHtml}</div>
    <div class="loc-add-row">
      <input type="text" id="newLocInput" placeholder="Nova lokacija…">
      <button type="button" class="btn btn-ghost" id="addLocBtn">＋ Dodaj</button>
    </div>
  `;
}

function _wireProjectMeta(modal, p) {
  const refresh = () => {
    queueProjectSave();
    persistState();
    _triggerRefresh();
  };

  const bind = (id, prop, isCheckbox = false) => {
    modal.querySelector('#' + id)?.addEventListener('change', (ev) => {
      const proj = getActiveProject();
      if (!proj) return;
      proj[prop] = isCheckbox ? ev.target.checked : ev.target.value;
      refresh();
    });
  };
  bind('pmCode', 'code');
  bind('pmName', 'name');
  bind('pmM', 'projectM');
  bind('pmDeadline', 'deadline');
  bind('pmPmEmail', 'pmEmail');
  bind('pmLeadEmail', 'leadPmEmail');
  bind('pmReminder', 'reminderEnabled', true);

  /* Locations */
  modal.querySelectorAll('[data-loc-input]').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.dataset.locInput);
      const proj = getActiveProject();
      if (!proj) return;
      ensureProjectLocations(proj);
      const newName = String(inp.value || '').trim();
      if (!newName) { showToast('⚠ Naziv ne može biti prazan'); _refreshProjectModal(modal); return; }
      const oldName = proj.locations[idx];
      if (oldName == null || oldName === newName) return;
      if (proj.locations.some((x, i) => i !== idx && String(x).trim().toLowerCase() === newName.toLowerCase())) {
        showToast('⚠ Ime već postoji');
        _refreshProjectModal(modal);
        return;
      }
      proj.locations[idx] = newName;
      renameLocationEverywhere(proj, oldName, newName);
      queueProjectSave();
      queueCurrentWpSync();
      persistState();
      _refreshProjectModal(modal);
      _triggerRefresh();
      showToast('✏️ Preimenovano');
    });
  });
  modal.querySelectorAll('[data-loc-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.locDel);
      const proj = getActiveProject();
      if (!proj) return;
      ensureProjectLocations(proj);
      const loc = proj.locations[idx];
      if (loc == null) return;
      const inUse = isLocationInUse(proj, loc);
      const msg = inUse
        ? `Lokacija "${loc}" je u upotrebi. Sigurno je ukloniti? Postojeće faze će zadržati vrednost.`
        : `Ukloniti lokaciju "${loc}"?`;
      if (!confirm(msg)) return;
      proj.locations.splice(idx, 1);
      if (!proj.locations.length) proj.locations = DEFAULT_LOCATIONS.slice();
      queueProjectSave();
      persistState();
      _refreshProjectModal(modal);
      _triggerRefresh();
      showToast('🗑 Uklonjena');
    });
  });
  modal.querySelector('#addLocBtn')?.addEventListener('click', () => {
    const inp = modal.querySelector('#newLocInput');
    const v = String(inp?.value || '').trim();
    if (!v) { inp?.focus(); return; }
    const proj = getActiveProject();
    if (!proj) return;
    ensureProjectLocations(proj);
    if (proj.locations.some(x => String(x).trim().toLowerCase() === v.toLowerCase())) {
      showToast('⚠ Lokacija već postoji');
      return;
    }
    proj.locations.push(v);
    getLocationColor(v);
    queueProjectSave();
    persistState();
    _refreshProjectModal(modal);
    _triggerRefresh();
    showToast('✅ Lokacija dodata');
  });
}

function _refreshProjectModal(modal) {
  const p = getActiveProject();
  if (!p) { _closeModal(modal); return; }
  const body = modal.querySelector('#projectMetaBody');
  if (!body) return;
  body.innerHTML = _projectFormHtml(p);
  _wireProjectMeta(modal, p);
}

/* ── WP META ─────────────────────────────────────────────────────────── */

export function openWpMetaModal(onChange) {
  _onChangeRoot = onChange || _onChangeRoot;
  if (!canEdit()) { showToast('⚠ Pregled — nema izmena'); return; }
  const wp = getActiveWP();
  if (!wp) { showToast('⚠ Nema aktivne pozicije'); return; }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'wpMetaModal';
  modal.innerHTML = `
    <div class="modal-panel" role="dialog" aria-labelledby="wpMetaTitle">
      <div class="modal-header">
        <h3 id="wpMetaTitle">Meta pozicije: ${escHtml(wp.name)}</h3>
        <button type="button" class="modal-close" aria-label="Zatvori">✕</button>
      </div>
      <div class="modal-body" id="wpMetaBody">${_wpFormHtml(wp)}</div>
    </div>
  `;
  document.body.appendChild(modal);
  _wireWpMeta(modal, wp);
  _attachOverlayClose(modal);
  modal.querySelector('.modal-close').addEventListener('click', () => _closeModal(modal));
}

function _wpFormHtml(wp) {
  return `
    <div class="form-grid">
      <label>Naziv pozicije<input type="text" id="wpName" value="${escHtml(wp.name)}"></label>
      <label>RN kod<input type="text" id="wpRnCode" value="${escHtml(wp.rnCode)}"></label>
      <label>Lokacija<select id="wpLocation">${locationOptionsHtml(wp.location)}</select></label>
      <label>Rok<input type="date" id="wpDeadline" value="${escHtml(wp.deadline || '')}"></label>
      <label>Podrazumevani odgovorni inženjer<select id="wpDefEng">${personOptionsHtml(ENGINEERS, wp.defaultEngineer)}</select></label>
      <label>Podrazumevani vođa montaže<select id="wpDefLead">${personOptionsHtml(VODJA, wp.defaultLead)}</select></label>
    </div>
    <div class="form-hint">Kada dodaš novu fazu, automatski dobija ove podrazumevane vrednosti. Postojeće faze se ne menjaju.</div>
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" id="wpApplyEmpty">↓ Primeni na prazne</button>
      <button type="button" class="btn btn-ghost" id="wpApplyAll">↓ Primeni na sve</button>
    </div>
  `;
}

function _wireWpMeta(modal, wp) {
  const persistAndRefresh = (refreshModal = false) => {
    queueCurrentWpSync();
    persistState();
    /* Save WP record sam (ne čekaj queue) — meta polja se ne snimaju kroz queueCurrentWpSync. */
    const proj = getActiveProject();
    if (proj) saveWorkPackageToDb(wp, proj.id);
    if (refreshModal) {
      const body = modal.querySelector('#wpMetaBody');
      if (body) {
        body.innerHTML = _wpFormHtml(wp);
        _wireWpMeta(modal, wp);
      }
    }
    _triggerRefresh();
  };

  const bind = (id, prop) => {
    modal.querySelector('#' + id)?.addEventListener('change', (ev) => {
      wp[prop] = ev.target.value;
      if (prop === 'location' && ev.target.value) getLocationColor(ev.target.value);
      persistAndRefresh();
    });
  };
  bind('wpName', 'name');
  bind('wpRnCode', 'rnCode');
  bind('wpLocation', 'location');
  bind('wpDeadline', 'deadline');

  modal.querySelector('#wpDefEng')?.addEventListener('change', (ev) => {
    if (ev.target.value === '__add__') {
      const raw = prompt('Unesi ime novog odgovornog inženjera:', '');
      const added = addEngineerName(String(raw || '').trim());
      if (added) {
        wp.defaultEngineer = added;
        showToast('✅ Dodato');
        persistAndRefresh(true);
      } else {
        ev.target.value = wp.defaultEngineer || '';
      }
      return;
    }
    wp.defaultEngineer = ev.target.value;
    persistAndRefresh();
  });
  modal.querySelector('#wpDefLead')?.addEventListener('change', (ev) => {
    if (ev.target.value === '__add__') {
      const raw = prompt('Unesi ime novog vođe montaže:', '');
      const added = addLeadName(String(raw || '').trim());
      if (added) {
        wp.defaultLead = added;
        showToast('✅ Dodato');
        persistAndRefresh(true);
      } else {
        ev.target.value = wp.defaultLead || '';
      }
      return;
    }
    wp.defaultLead = ev.target.value;
    persistAndRefresh();
  });

  modal.querySelector('#wpApplyEmpty')?.addEventListener('click', () => {
    let n = 0;
    wp.phases.forEach(p => {
      if (!p.engineer && wp.defaultEngineer) { p.engineer = wp.defaultEngineer; n++; }
      if (!p.person && wp.defaultLead) { p.person = wp.defaultLead; n++; }
    });
    queueCurrentWpSync();
    persistState();
    showToast(n > 0 ? `✅ Primenjeno na prazne (${n})` : 'ℹ Nema praznih polja');
    _triggerRefresh();
  });
  modal.querySelector('#wpApplyAll')?.addEventListener('click', () => {
    if (!confirm('Primeniti default vođu i inženjera na SVE faze ove pozicije? Postojeće vrednosti će biti pregažene.')) return;
    wp.phases.forEach(p => {
      if (wp.defaultEngineer) p.engineer = wp.defaultEngineer;
      if (wp.defaultLead) p.person = wp.defaultLead;
    });
    queueCurrentWpSync();
    persistState();
    showToast('✅ Primenjeno na sve');
    _triggerRefresh();
  });
}
