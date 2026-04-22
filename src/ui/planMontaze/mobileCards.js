/**
 * Plan Montaže — mobilne kartice (F5.2).
 *
 * Renderuje listu kartica za sve faze aktivnog WP-a (filtrovano kroz
 * `planMontazeState.filteredIndices` ako je postavljeno).
 *
 * KLJUČNO: stable expanded state.
 *   - Set `expandedMobileCards` (state/planMontaze.js) drži ID-jeve otvorenih
 *     kartica i opstaje između render ciklusa.
 *   - Toggle koristi data-attribute (`data-mcard-toggle`); klik na sve interaktivne
 *     elemente unutar `.m-card-details` ne propagira do top-a (event handler
 *     proverava da li je target unutar `[data-stop]`).
 *   - Kada `_onChangeRoot()` rerender-uje shell, isti otvoreni ID-jevi
 *     prikazuju otvorenu varijantu — UX zahtev: "kartica koja je bila
 *     otvorena ostaje otvorena posle promene statusa/vođe/inženjera/check".
 *
 * Inputi koriste iste handler-e kao desktop varijanta (planTable._update*),
 * eksportovane preko privremenog API-ja iz planTable.js (`mobileBindings`).
 */

import { escHtml } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  planMontazeState,
  getActivePhases,
  getProjectLocations,
  getLocationColor,
  ENGINEERS,
  VODJA,
  expandedMobileCards,
  getPhaseModel,
} from '../../state/planMontaze.js';
import { openModelDialog } from './modelDialog.js';
import { openDescriptionDialog } from './descriptionDialog.js';
import { openLinkedDrawingsDialog } from './linkedDrawingsDialog.js';
import { openDrawingPdf } from '../../services/drawings.js';
import {
  STATUSES,
  CHECK_SHORT,
} from '../../lib/constants.js';
import {
  calcDuration,
  formatDate,
} from '../../lib/date.js';
import {
  calcReadiness,
  calcRisk,
  normalizePhaseType,
  statusClass,
} from '../../lib/phase.js';
import {
  updatePhaseField,
  handlePersonChange,
  updateCheck,
  togglePhaseType,
  moveRow,
  deleteRow,
} from './planActions.js';

/* ── PUBLIC ──────────────────────────────────────────────────────────── */

export function mobileCardsHtml() {
  const phases = getActivePhases();
  const indices = planMontazeState.filteredIndices !== null
    ? planMontazeState.filteredIndices
    : phases.map((_, i) => i);
  if (!indices.length) {
    return '<div class="mobile-cards" id="mobileCards"><div class="m-empty">Nema faza za prikazanim filterima.</div></div>';
  }
  return `<div class="mobile-cards" id="mobileCards">
    ${indices.map(i => _mobileCardHtml(phases[i], i)).join('')}
  </div>`;
}

export function wireMobileCards(root, { onChange } = {}) {
  const wrap = root.querySelector('#mobileCards');
  if (!wrap) return;

  /* Toggle za otvaranje/zatvaranje kartice */
  wrap.querySelectorAll('[data-mcard-toggle]').forEach(zone => {
    zone.addEventListener('click', (ev) => {
      /* Klik unutar interaktivnog regiona ([data-stop]) ne toggluje. */
      if (ev.target.closest('[data-stop]')) return;
      const card = zone.closest('.m-card');
      const pid = card?.dataset.phaseId;
      if (!pid) return;
      if (expandedMobileCards.has(pid)) expandedMobileCards.delete(pid);
      else expandedMobileCards.add(pid);
      const det = card.querySelector('.m-card-details');
      if (det) det.classList.toggle('open', expandedMobileCards.has(pid));
    });
  });

  /* Field updates */
  wrap.querySelectorAll('[data-mfield]').forEach(el => {
    const evt = (el.tagName === 'INPUT' && el.type === 'range') ? 'input' : 'change';
    el.addEventListener(evt, () => {
      const card = el.closest('.m-card');
      const i = Number(card?.dataset.ri);
      if (Number.isNaN(i)) return;
      const field = el.dataset.mfield;
      let val = el.value;
      if (field === 'status' || field === 'pct') val = parseInt(val, 10);
      updatePhaseField(i, field, val);
      onChange?.();
    });
  });

  /* Person selects */
  wrap.querySelectorAll('[data-mfield-person]').forEach(el => {
    el.addEventListener('change', () => {
      const card = el.closest('.m-card');
      const i = Number(card?.dataset.ri);
      if (Number.isNaN(i)) return;
      const field = el.dataset.mfieldPerson;
      handlePersonChange(el, i, field);
      onChange?.();
    });
  });

  /* Check chips */
  wrap.querySelectorAll('[data-mcheck-i]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.mcheckI);
      const ci = Number(btn.dataset.mcheckCi);
      const next = btn.dataset.mcheckNext === '1';
      updateCheck(i, ci, next);
      onChange?.();
    });
  });

  /* Phase type toggle */
  wrap.querySelectorAll('[data-mtoggle-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.mtoggleType);
      togglePhaseType(i);
      onChange?.();
    });
  });

  /* Row actions */
  wrap.querySelectorAll('[data-mrow-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.mrowAction;
      const i = Number(btn.dataset.ri);
      if (action === 'up') moveRow(i, -1);
      else if (action === 'down') moveRow(i, 1);
      else if (action === 'del') deleteRow(i);
      else if (action === 'model') {
        const card = btn.closest('.m-card');
        const phaseId = card?.dataset.phaseId;
        if (phaseId) openModelDialog(phaseId, () => onChange?.());
        return;
      }
      else if (action === 'desc') {
        openDescriptionDialog(i, () => onChange?.());
        return;
      }
      else if (action === 'linked') {
        openLinkedDrawingsDialog(i, () => onChange?.());
        return;
      }
      onChange?.();
    });
  });

  /* Klik na pojedinačni broj crteža (link u m-card-linked redu) → otvori PDF. */
  wrap.querySelectorAll('[data-mlinked-no]').forEach(a => {
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const no = a.dataset.mlinkedNo;
      if (no) openDrawingPdf(no);
    });
  });
}

/* ── INTERNAL ─────────────────────────────────────────────────────────── */

function _mobileCardHtml(row, i) {
  const dis = canEdit() ? '' : 'disabled';
  const _edit = canEdit();
  const dur = calcDuration(row.start, row.end);
  const rd = calcReadiness(row);
  const rk = calcRisk(row);
  const locColor = getLocationColor(row.loc);

  let durT = '—';
  if (dur === -1) durT = '⚠';
  else if (dur !== null) durT = dur + 'd';

  let rI = '✅';
  if (rk.level === 'high') rI = '🔴';
  else if (rk.level === 'med') rI = '🟠';
  else if (rk.level === 'low') rI = '🟡';

  let rB;
  if (rd.done) rB = '<span class="badge-ready badge-done">DONE</span>';
  else if (rd.ready) rB = '<span class="badge-ready badge-yes">✔</span>';
  else rB = '<span class="badge-ready badge-no">✘</span>';

  const stC = statusClass(row.status);
  const rkC = rk.level !== 'none' ? `m-risk-${rk.level}` : '';
  const mF = row.status === 2 ? ' m-finished' : '';
  const pC = row.status === 2 ? 'pct-fill-done' : (row.status === 3 ? 'pct-fill-hold' : 'pct-fill-normal');

  const isOpen = expandedMobileCards.has(row.id);

  /* Check chips (mali, klikabilni) */
  const chH = row.checks.map((c, ci) => {
    const cls = c ? 'ck-y' : 'ck-n';
    const next = c ? '0' : '1';
    if (_edit) {
      return `<span class="m-card-check ${cls}" data-stop data-mcheck-i="${i}" data-mcheck-ci="${ci}" data-mcheck-next="${next}" style="cursor:pointer;user-select:none">${escHtml(CHECK_SHORT[ci])}${c ? ' ✔' : ' ✘'}</span>`;
    }
    return `<span class="m-card-check ${cls}" style="opacity:0.75;user-select:none">${escHtml(CHECK_SHORT[ci])}${c ? ' ✔' : ' ✘'}</span>`;
  }).join('');

  /* Phase type chip */
  const pType = normalizePhaseType(row.type);
  const ptCls = pType === 'electrical' ? 'pt-elec' : 'pt-mech';
  const ptIc = pType === 'electrical' ? '⚡' : '⚙';
  const ptLblShort = pType === 'electrical' ? 'E' : 'M';

  const hasDesc = !!(row.description && row.description.trim());
  const hasModel = !!getPhaseModel(row.id);

  /* „Veza sa“ — povezani crteži (linked_drawings).
     Renderuju se kao chip-ovi (📄 broj) UNUTAR `m-card-name-meta` reda
     (zajedno sa M/E + opis + 3D), kako bismo skratili vertikalu kartice. */
  const linkedNos = Array.isArray(row.linkedDrawings) ? row.linkedDrawings : [];
  const linkedCount = linkedNos.length;
  const linkedChipsHtml = linkedNos.map(no => `
    <button type="button" class="phase-linked-chip" data-stop data-mlinked-no="${escHtml(no)}" title="Otvori PDF crteža u novom tabu">
      <span class="plc-ic">📄</span><span class="plc-no">${escHtml(no)}</span>
    </button>
  `).join('');
  const linkedManageHtml = linkedCount
    ? (_edit ? `<button type="button" class="row-btn btn-linked-manage" data-stop data-mrow-action="linked" data-ri="${i}" title="Izmeni listu crteža">✏️</button>` : '')
    : (_edit ? `<button type="button" class="row-btn btn-linked" data-stop data-mrow-action="linked" data-ri="${i}" title="Dodaj povezane crteže"><span class="rb-ic">🔗</span>＋ Veza sa</button>` : '');

  /* Lokacija/person opcije */
  const locOpts = _locationOptionsHtml(row.loc);
  const engOpts = _personOptionsHtml(ENGINEERS, row.engineer);
  const ldOpts = _personOptionsHtml(VODJA, row.person);

  const blockerSection = (row.blocker || row.status === 3) ? `
    <div class="m-card-detail-item" style="margin-top:6px">
      <span class="m-lbl">Blokator</span>
      <textarea class="note-area" rows="2" data-stop data-mfield="blocker" placeholder="${row.status === 3 ? '⚠!' : ''}" ${dis}>${escHtml(row.blocker || '')}</textarea>
    </div>
  ` : '';

  const dateSection = `
    <div class="m-card-detail-grid" style="margin-top:8px">
      <div class="m-card-detail-item">
        <span class="m-lbl">Početak</span>
        <input type="date" data-stop data-mfield="start" value="${escHtml(row.start || '')}" ${dis}>
      </div>
      <div class="m-card-detail-item">
        <span class="m-lbl">Kraj</span>
        <input type="date" data-stop data-mfield="end" value="${escHtml(row.end || '')}" ${dis}>
      </div>
    </div>
  `;

  return `
    <div class="m-card ${rkC}${mF}" data-ri="${i}" data-phase-id="${escHtml(row.id)}">
      <div class="m-card-top" data-mcard-toggle>
        <div>
          <div class="m-card-name">${escHtml(row.name)}</div>
          <div class="m-card-name-meta">
            <button type="button" class="phase-type-chip ${ptCls}" data-stop data-mtoggle-type="${i}" title="Tip montaže" ${dis}>
              <span class="pt-ic">${ptIc}</span>${ptLblShort}
            </button>
            <button type="button" class="row-btn btn-desc${hasDesc ? ' has-desc' : ''}" data-stop data-mrow-action="desc" data-ri="${i}" title="${hasDesc ? 'Opis dodeljen' : 'Dodaj opis'}">
              <span class="pdb-ic">📝</span> opis
            </button>
            <button type="button" class="row-btn btn-3d${hasModel ? ' has-model' : ''}" data-stop data-mrow-action="model" data-ri="${i}" title="${hasModel ? '3D model dodeljen' : '3D model'}">🧩 3D</button>
            ${linkedChipsHtml}
            ${linkedManageHtml}
          </div>
          <div style="font-size:10px;color:var(--text3);margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="loc-chip" style="border-color:${locColor};color:${locColor};background:${locColor}22">
              <span class="loc-dot" style="background:${locColor}"></span>${escHtml(row.loc || '—')}
            </span>
            · <span class="${stC}" style="padding:1px 6px;border-radius:4px">${escHtml(STATUSES[row.status])}</span>
            · ${row.pct}% · ${durT}
          </div>
        </div>
        <div class="m-card-badges">${rI} ${rB}</div>
      </div>
      <div class="m-card-row" data-mcard-toggle>
        <div class="m-card-field"><span class="m-lbl">Poč:</span> ${formatDate(row.start) || '—'}</div>
        <div class="m-card-field"><span class="m-lbl">Kraj:</span> ${formatDate(row.end) || '—'}</div>
        <div class="m-card-field"><span class="m-lbl">Ing:</span> ${escHtml(row.engineer || '—')}</div>
        <div class="m-card-field"><span class="m-lbl">Vođa:</span> ${escHtml(row.person || '—')}</div>
      </div>
      <div class="m-card-pct" data-mcard-toggle>
        <div class="pct-bar"><div class="pct-bar-fill ${pC}" style="width:${row.pct}%"></div></div>
        <span>${row.pct}%</span>
      </div>
      <div class="m-card-details ${isOpen ? 'open' : ''}" data-stop>
        <div style="margin-bottom:6px;font-weight:600;color:var(--text3);font-size:9px;text-transform:uppercase">Spremnost</div>
        <div class="m-card-checks">${chH}</div>

        <div class="m-card-detail-grid">
          <div class="m-card-detail-item">
            <span class="m-lbl">Status</span>
            <select class="${stC}" data-mfield="status" ${dis}>
              ${STATUSES.map((s, si) => `<option value="${si}"${row.status === si ? ' selected' : ''}>${escHtml(s)}</option>`).join('')}
            </select>
          </div>
          <div class="m-card-detail-item">
            <span class="m-lbl">Lokacija</span>
            <select data-mfield="loc" style="border-left:3px solid ${locColor}" ${dis}>${locOpts}</select>
          </div>
          <div class="m-card-detail-item">
            <span class="m-lbl">Ing.</span>
            <select data-mfield-person="engineer" ${dis}>${engOpts}</select>
          </div>
          <div class="m-card-detail-item">
            <span class="m-lbl">Vođa</span>
            <select data-mfield-person="person" ${dis}>${ldOpts}</select>
          </div>
          <div class="m-card-detail-item">
            <span class="m-lbl">% (${row.pct}%)</span>
            <input type="range" min="0" max="100" step="5" value="${row.pct}" data-mfield="pct" style="width:100%;accent-color:var(--accent)" ${dis}>
          </div>
        </div>

        ${dateSection}
        ${blockerSection}

        <div class="m-card-detail-item" style="margin-top:6px">
          <span class="m-lbl">Napomena</span>
          <textarea class="note-area" rows="2" data-mfield="note" ${dis}>${escHtml(row.note || '')}</textarea>
        </div>

        <div style="display:flex;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid var(--border);flex-wrap:wrap">
          <button type="button" class="row-btn btn-up" data-mrow-action="up" data-ri="${i}" ${dis}>▲</button>
          <button type="button" class="row-btn btn-dn" data-mrow-action="down" data-ri="${i}" ${dis}>▼</button>
          <button type="button" class="row-btn btn-del" data-mrow-action="del" data-ri="${i}" ${dis}>✕</button>
        </div>
      </div>
    </div>
  `;
}

function _locationOptionsHtml(currentValue) {
  const list = getProjectLocations();
  let has = false;
  const opts = list.map(l => {
    const sel = l === currentValue;
    if (sel) has = true;
    return `<option value="${escHtml(l)}"${sel ? ' selected' : ''}>${escHtml(l)}</option>`;
  }).join('');
  if (currentValue && !has) {
    return `<option value="${escHtml(currentValue)}" selected>${escHtml(currentValue)}</option>` + opts;
  }
  return opts;
}

function _personOptionsHtml(list, currentValue) {
  const cur = String(currentValue || '');
  let has = false;
  const opts = list.map(v => {
    const sel = v === cur;
    if (sel) has = true;
    return `<option value="${escHtml(v)}"${sel ? ' selected' : ''}>${escHtml(v) || '—'}</option>`;
  }).join('');
  const unknownOpt = (cur && !has) ? `<option value="${escHtml(cur)}" selected>${escHtml(cur)}</option>` : '';
  return unknownOpt + opts
    + '<option value="__add__" style="font-weight:600;color:var(--accent)">➕ Dodaj novog…</option>';
}
