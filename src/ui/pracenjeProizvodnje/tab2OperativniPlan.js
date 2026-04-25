import { escHtml } from '../../lib/dom.js';
import {
  getFilteredActivities,
  resetOperativniFilters,
  setOperativniFilter,
} from '../../state/pracenjeProizvodnjeState.js';
import { priorityBadgeHtml, statusBadgeHtml } from './statusBadge.js';
import { openAktivnostModal } from './aktivnostModal.js';
import { dashboardFooterHtml } from './dashboardFooter.js';
import { openPromoteAkcionaTackaModal } from './promoteAkcionaTackaModal.js';
import { exportTab2ToExcel } from '../../services/pracenjeExport.js';

export function tab2OperativniPlanHtml(state) {
  const activities = getFilteredActivities();
  return `
    <section class="form-card" style="margin-bottom:14px">
      <div class="pp-toolbar" style="margin:0;align-items:flex-end">
        <label class="pp-rn-filter">
          <span>Pretraga</span>
          <input type="search" id="oaSearch" value="${escHtml(state.filters.search)}" placeholder="Naziv, TP, odgovoran…">
        </label>
        <label class="pp-rn-filter">
          <span>Odeljenja</span>
          <select id="oaDeptFilter" multiple size="3">
            ${departmentOptions(state)}
          </select>
        </label>
        <label class="pp-rn-filter">
          <span>Statusi</span>
          <select id="oaStatusFilter" multiple size="3">
            ${statusOptions(state.filters.statusi)}
          </select>
        </label>
        <label class="pp-rn-filter"><span>Prioritet</span><select id="oaPriorityFilter" multiple size="3">${priorityOptions(state.filters.prioriteti)}</select></label>
        <label class="pp-rn-filter"><span>Odgovoran</span><input id="oaOwnerFilter" type="search" value="${escHtml(state.filters.odgovoran)}" placeholder="Ime…"></label>
        <label class="pp-rn-filter"><span>Rok od</span><input id="oaDateFrom" type="date" value="${escHtml(state.filters.dateFrom)}"></label>
        <label class="pp-rn-filter"><span>Rok do</span><input id="oaDateTo" type="date" value="${escHtml(state.filters.dateTo)}"></label>
        <label class="form-checkbox-row"><input type="checkbox" id="oaOnlyLate" ${state.filters.onlyLate ? 'checked' : ''}><span>Samo kasni</span></label>
        <label class="form-checkbox-row"><input type="checkbox" id="oaOnlyBlocked" ${state.filters.onlyBlocked ? 'checked' : ''}><span>Samo blokirano</span></label>
        <label class="form-checkbox-row"><input type="checkbox" id="oaHideClosed" ${state.filters.hideClosed ? 'checked' : ''}><span>Sakrij zatvorene</span></label>
        <button type="button" class="pp-refresh-btn" id="oaResetFilters">Reset</button>
      </div>
      <div class="pp-toolbar" style="margin:10px 0 0">
        <span class="pp-toolbar-label">Quick:</span>
        ${quickChip('visok', 'Visok prioritet', state.filters.quick)}
        ${quickChip('kasni7', 'Kasni > 7 dana', state.filters.quick)}
        ${quickChip('bez_odgovornog', 'Bez odgovornog', state.filters.quick)}
        <div class="pp-toolbar-spacer"></div>
        <div>${activeFilterChips(state)}</div>
      </div>
      <div class="pp-toolbar" style="margin:10px 0 0">
        <div class="pp-toolbar-spacer"></div>
        ${state.canEdit ? '<button type="button" class="pp-refresh-btn" id="newAktivnostBtn">+ Nova aktivnost</button>' : '<span class="pp-readonly-badge">read-only</span>'}
        ${state.canEdit ? '<button type="button" class="pp-refresh-btn" id="promoteAkcijaBtn">Iz akcione tačke</button>' : ''}
        <button type="button" class="pp-refresh-btn" id="exportTab2Btn">Excel export</button>
      </div>
    </section>
    ${activities.length ? tableHtml(activities) : emptyHtml(state)}
    ${dashboardFooterHtml(state)}
  `;
}

export function wireTab2OperativniPlan(root, state, onChange) {
  root.querySelector('#oaSearch')?.addEventListener('input', (ev) => {
    setOperativniFilter('search', ev.target.value || '');
    onChange?.();
  });
  root.querySelector('#oaDeptFilter')?.addEventListener('change', (ev) => {
    setOperativniFilter('odeljenja', selectedValues(ev.target));
    onChange?.();
  });
  root.querySelector('#oaStatusFilter')?.addEventListener('change', (ev) => {
    setOperativniFilter('statusi', selectedValues(ev.target));
    onChange?.();
  });
  root.querySelector('#oaPriorityFilter')?.addEventListener('change', (ev) => {
    setOperativniFilter('prioriteti', selectedValues(ev.target));
    onChange?.();
  });
  bindFilterInput(root, '#oaOwnerFilter', 'odgovoran', onChange);
  bindFilterInput(root, '#oaDateFrom', 'dateFrom', onChange);
  bindFilterInput(root, '#oaDateTo', 'dateTo', onChange);
  bindFilterCheckbox(root, '#oaOnlyLate', 'onlyLate', onChange);
  bindFilterCheckbox(root, '#oaOnlyBlocked', 'onlyBlocked', onChange);
  bindFilterCheckbox(root, '#oaHideClosed', 'hideClosed', onChange);
  root.querySelector('#oaResetFilters')?.addEventListener('click', () => { resetOperativniFilters(); onChange?.(); });
  root.querySelectorAll('[data-quick-filter]').forEach(btn => btn.addEventListener('click', () => {
    setOperativniFilter('quick', state.filters.quick === btn.dataset.quickFilter ? '' : btn.dataset.quickFilter);
    onChange?.();
  }));
  root.querySelector('#newAktivnostBtn')?.addEventListener('click', () => {
    openAktivnostModal({ state, activity: null, onSaved: onChange });
  });
  root.querySelector('#promoteAkcijaBtn')?.addEventListener('click', () => {
    openPromoteAkcionaTackaModal({ state, onPromoted: onChange });
  });
  root.querySelector('#exportTab2Btn')?.addEventListener('click', () => {
    void exportTab2ToExcel(state.rnId, {
      header: state.header,
      activities: state.tab2Data?.activities || [],
      dashboard: state.dashboard,
    });
  });
  root.querySelectorAll('[data-activity-id]').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.activityId;
      const activity = (state.tab2Data?.activities || []).find(a => a.id === id);
      if (activity) openAktivnostModal({ state, activity, onSaved: onChange });
    });
  });
}

function tableHtml(activities) {
  return `
    <section class="pp-table-wrap">
      <table class="pp-table">
        <thead>
          <tr>
            <th>RB</th><th>Odeljenje</th><th>Aktivnost</th><th>Br. TP</th><th>Količina</th>
            <th>Plan. početak</th><th>Plan. završetak</th><th>Odgovoran</th><th>Zavisi od</th>
            <th>Status</th><th>Prioritet</th><th>Rizik</th><th class="pp-cell-num">Rezerva</th><th>Kasni</th>
          </tr>
        </thead>
        <tbody>
          ${activities.map(a => `
            <tr data-activity-id="${escHtml(a.id)}" style="cursor:pointer" class="${rowClass(a, activities)}">
              <td class="pp-cell-num">${escHtml(a.rb ?? '')}</td>
              <td>${escHtml(a.odeljenje || a.odeljenje_naziv || '—')}</td>
              <td>
                <div class="pp-cell-strong">${escHtml(a.naziv_aktivnosti || '—')}</div>
                ${a.opis ? `<div class="form-hint">${escHtml(a.opis)}</div>` : ''}
              </td>
              <td>${escHtml(a.broj_tp || '—')}</td>
              <td>${escHtml(a.kolicina_text || '—')}</td>
              <td>${escHtml(a.planirani_pocetak || '—')}</td>
              <td>${escHtml(a.planirani_zavrsetak || '—')}</td>
              <td>${escHtml(a.odgovoran || a.odgovoran_label || '—')}</td>
              <td>${escHtml(a.zavisi_od || a.zavisi_od_text || '—')}</td>
              <td>${statusBadgeHtml(a, { button: false })}</td>
              <td>${priorityBadgeHtml(a.prioritet)}</td>
              <td class="pp-cell-clip">${escHtml(a.rizik_napomena || '—')}</td>
              <td class="pp-cell-num">${escHtml(a.rezerva_dani ?? '—')}</td>
              <td>${a.kasni ? '<span class="pp-rok urgency-overdue">Da</span>' : '<span class="pp-rok urgency-ok">Ne</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function emptyHtml(state) {
  const hasAny = (state.tab2Data?.activities || []).length > 0;
  return `
    <div class="pp-state">
      <div class="pp-state-icon">...</div>
      <div class="pp-state-title">${hasAny ? 'Nema rezultata za filtere' : 'Nema operativnih aktivnosti'}</div>
      <div class="pp-state-desc">${hasAny ? 'Promeni filtere da vidiš aktivnosti.' : 'Dodaj prvu aktivnost kroz dugme Nova aktivnost.'}</div>
    </div>
  `;
}

function departmentOptions(state) {
  const selected = state.filters.odeljenja || [];
  const names = new Set();
  (state.departments || []).forEach(d => names.add(d.naziv));
  (state.tab2Data?.activities || []).forEach(a => names.add(a.odeljenje || a.odeljenje_naziv));
  return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, 'sr')).map(name =>
    `<option value="${escHtml(name)}"${selected.includes(name) ? ' selected' : ''}>${escHtml(name)}</option>`,
  ).join('');
}

function statusOptions(selected) {
  const opts = [
    ['', 'Svi'],
    ['nije_krenulo', 'Nije krenulo'],
    ['u_toku', 'U toku'],
    ['blokirano', 'Blokirano'],
    ['zavrseno', 'Završeno'],
  ];
  const arr = selected || [];
  return opts.filter(([value]) => value).map(([value, label]) =>
    `<option value="${escHtml(value)}"${arr.includes(value) ? ' selected' : ''}>${escHtml(label)}</option>`,
  ).join('');
}

function priorityOptions(selected = []) {
  return [['nizak', 'Nizak'], ['srednji', 'Srednji'], ['visok', 'Visok']]
    .map(([value, label]) => `<option value="${escHtml(value)}"${selected.includes(value) ? ' selected' : ''}>${escHtml(label)}</option>`)
    .join('');
}

function selectedValues(select) {
  return Array.from(select.selectedOptions || []).map(o => o.value).filter(Boolean);
}

function bindFilterInput(root, sel, key, onChange) {
  root.querySelector(sel)?.addEventListener('input', ev => {
    setOperativniFilter(key, ev.target.value || '');
    onChange?.();
  });
}

function bindFilterCheckbox(root, sel, key, onChange) {
  root.querySelector(sel)?.addEventListener('change', ev => {
    setOperativniFilter(key, ev.target.checked);
    onChange?.();
  });
}

function quickChip(id, label, active) {
  return `<button type="button" class="zm-filter-btn${active === id ? ' is-active' : ''}" data-quick-filter="${escHtml(id)}">${escHtml(label)}</button>`;
}

function activeFilterChips(state) {
  const f = state.filters;
  const chips = [];
  if (f.odeljenja.length) chips.push(`Odeljenja: ${f.odeljenja.join(', ')}`);
  if (f.statusi.length) chips.push(`Status: ${f.statusi.join(', ')}`);
  if (f.prioriteti.length) chips.push(`Prioritet: ${f.prioriteti.join(', ')}`);
  if (f.onlyLate) chips.push('Samo kasni');
  if (f.onlyBlocked) chips.push('Samo blokirano');
  if (f.hideClosed) chips.push('Sakrij zatvorene');
  if (!chips.length) return '<span class="form-hint">Nema aktivnih filtera</span>';
  return chips.map(c => `<span class="pp-counter">${escHtml(c)}</span>`).join(' ');
}

function rowClass(a) {
  const cls = [];
  if (a.kasni) cls.push('is-urgent', 'is-urgent-overdue');
  return cls.join(' ');
}
