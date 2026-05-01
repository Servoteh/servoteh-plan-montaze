/**
 * Zajedničke komponente za Projektni biro — modali, alarmi, load meter.
 */

import { escHtml } from '../../lib/dom.js';
import {
  createPbTask,
  updatePbTask,
  softDeletePbTask,
} from '../../services/pb.js';

/** PostgREST / network greška → korisnički tekst (pb.js baca Error sa `code` gde je moguće). */
export function pbErrorMessage(err) {
  if (!err) return 'Nepoznata greška';
  const code = err.code || err?.cause?.code || '';
  const msg = String(err.message || '');
  if (code === '42501' || code === 'PGRST301' || /permission denied|jwt/i.test(msg)) {
    return 'Nemate pravo da izvršite ovu akciju.';
  }
  if (code === '23505') return 'Zapis sa tim podacima već postoji.';
  if (code === '23503') return 'Referencirani podatak ne postoji.';
  if (code === '23514') return 'Uneti podaci nisu ispravni (provera u bazi).';
  if (/fetch|network|failed to fetch|Load failed/i.test(msg)) {
    return 'Nema veze sa serverom. Proverite konekciju.';
  }
  return msg || 'Neočekivana greška.';
}

export function showPbToast(message, type = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.remove('toast--success', 'toast--error', 'toast--warning', 'toast--info');
  if (type === 'success') t.classList.add('toast--success');
  else if (type === 'error') t.classList.add('toast--error');
  else if (type === 'warning') t.classList.add('toast--warning');
  else t.classList.add('toast--info');
  t.classList.add('show');
  clearTimeout(showPbToast._timer);
  showPbToast._timer = setTimeout(() => {
    t.classList.remove('show');
  }, 2800);
}

let izvestajiSpeech = null;
export function setPbIzvestajiSpeechRecog(r) {
  izvestajiSpeech = r;
}
export function stopPbIzvestajiSpeech() {
  if (!izvestajiSpeech) return;
  try {
    izvestajiSpeech.stop();
  } catch {
    /* */
  }
  izvestajiSpeech = null;
}

export const PB_STATE_KEY = 'pb_state_v1';

export const PB_TASK_STATUS = [
  'Nije počelo', 'U toku', 'Pregled', 'Završeno', 'Blokirano',
];
export const PB_TASK_VRSTA = [
  'Projektovanje 3D', 'Dokumentacija', 'Nabavka', 'Algoritam', 'Montaža',
];
export const PB_PRIORITET = ['Visok', 'Srednji', 'Nizak'];

export function loadPbState() {
  try {
    const raw = sessionStorage.getItem(PB_STATE_KEY);
    if (!raw) return defaultPbState();
    const o = JSON.parse(raw);
    return {
      activeProject: o.activeProject ?? 'all',
      activeEngineer: o.activeEngineer ?? 'all',
      activeTab: o.activeTab ?? 'plan',
      moduleSearch: o.moduleSearch ?? '',
      moduleShowDone: o.moduleShowDone ?? false,
      ganttStartDate: o.ganttStartDate ?? null,
    };
  } catch {
    return defaultPbState();
  }
}

export function savePbState(st) {
  sessionStorage.setItem(PB_STATE_KEY, JSON.stringify(st));
}

function defaultPbState() {
  return {
    activeProject: 'all',
    activeEngineer: 'all',
    activeTab: 'plan',
    moduleSearch: '',
    moduleShowDone: false,
    ganttStartDate: null,
  };
}

/** Sinhronizacija Plan / Kanban / Gantt filtera (pretraga + prikaži završene). */
export function syncPbModuleFilters(patch) {
  const s = loadPbState();
  if ('moduleSearch' in patch) s.moduleSearch = patch.moduleSearch;
  if ('moduleShowDone' in patch) s.moduleShowDone = patch.moduleShowDone;
  savePbState(s);
}

/** Čuva mesec za Gantt navigaciju (prvi dan meseca, ISO string). */
export function savePbGanttMonth(isoDateString) {
  const s = loadPbState();
  s.ganttStartDate = isoDateString;
  savePbState(s);
}

export function statusBadgeClass(status) {
  const s = String(status || '');
  if (s === 'Završeno') return 'pb-badge pb-badge--ok';
  if (s === 'Blokirano') return 'pb-badge pb-badge--danger';
  if (s === 'U toku' || s === 'Pregled') return 'pb-badge pb-badge--warn';
  return 'pb-badge';
}

export function prioClass(p) {
  if (p === 'Visok') return 'pb-prio pb-prio--high';
  if (p === 'Nizak') return 'pb-prio pb-prio--low';
  return 'pb-prio pb-prio--mid';
}

/** @param {HTMLElement} root */
export function isPbMobile(root) {
  return root?.closest('.pb-module')?.classList.contains('pb-module--mobile')
    ?? window.matchMedia('(max-width: 767px)').matches;
}

/**
 * @param {{
 *   task: object,
 *   projects: Array<{id:string,project_code:string,project_name:string}>,
 *   engineers: Array<{id:string,full_name:string}>,
 *   canEdit: boolean,
 *   onSaved: () => void,
 * }} opts
 */
export function openTaskEditorModal(opts) {
  const { task, projects, engineers, canEdit, onSaved } = opts;
  const wrap = document.createElement('div');
  const mobile = window.matchMedia('(max-width: 767px)').matches;
  wrap.className = mobile ? 'modal-overlay open pb-modal pb-modal--sheet' : 'modal-overlay open pb-modal';
  const isNew = !task?.id;
  const t = task || {};

  wrap.innerHTML = `
    <div class="modal-panel pb-task-panel" role="dialog" aria-label="${isNew ? 'Novi zadatak' : 'Izmeni zadatak'}">
      <div class="pb-modal-head">
        <h2>${isNew ? 'Novi zadatak' : 'Izmena zadatka'}</h2>
        <button type="button" class="btn btn-ghost pb-close-modal" aria-label="Zatvori">✕</button>
      </div>
      <div class="pb-task-form">
        <label class="pb-field"><span>Naziv *</span>
          <input type="text" id="pbTfNaziv" required value="${escHtml(t.naziv || '')}" ${canEdit ? '' : 'disabled'} />
        </label>
        <label class="pb-field"><span>Projekat *</span>
          <select id="pbTfProject" ${canEdit ? '' : 'disabled'}>
            <option value="">— izaberi —</option>
            ${projects.map(p => `
              <option value="${escHtml(p.id)}" ${t.project_id === p.id ? 'selected' : ''}>
                ${escHtml(p.project_code)} — ${escHtml(p.project_name)}
              </option>`).join('')}
          </select>
        </label>
        <label class="pb-field"><span>Inženjer</span>
          <select id="pbTfEng" ${canEdit ? '' : 'disabled'}>
            <option value="">— nije dodeljen —</option>
            ${engineers.map(e => `
              <option value="${escHtml(e.id)}" ${t.employee_id === e.id ? 'selected' : ''}>
                ${escHtml(e.full_name)}
              </option>`).join('')}
          </select>
        </label>
        <div class="pb-field-row">
          <label class="pb-field"><span>Vrsta</span>
            <select id="pbTfVrsta" ${canEdit ? '' : 'disabled'}>
              ${PB_TASK_VRSTA.map(v => `<option value="${escHtml(v)}" ${t.vrsta === v ? 'selected' : ''}>${escHtml(v)}</option>`).join('')}
            </select>
          </label>
          <label class="pb-field"><span>Prioritet</span>
            <select id="pbTfPrio" ${canEdit ? '' : 'disabled'}>
              ${PB_PRIORITET.map(v => `<option value="${escHtml(v)}" ${t.prioritet === v ? 'selected' : ''}>${escHtml(v)}</option>`).join('')}
            </select>
          </label>
          <label class="pb-field"><span>Status</span>
            <select id="pbTfStatus" ${canEdit ? '' : 'disabled'}>
              ${PB_TASK_STATUS.map(v => `<option value="${escHtml(v)}" ${t.status === v ? 'selected' : ''}>${escHtml(v)}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="pb-dates-grid">
          <label><span>Plan početak</span><input type="date" id="pbTfDp" value="${escHtml((t.datum_pocetka_plan || '').slice(0, 10))}" ${canEdit ? '' : 'disabled'} /></label>
          <label><span>Plan rok</span><input type="date" id="pbTfDr" value="${escHtml((t.datum_zavrsetka_plan || '').slice(0, 10))}" ${canEdit ? '' : 'disabled'} /></label>
          <label><span>Realni poč.</span><input type="date" id="pbTfRp" value="${escHtml((t.datum_pocetka_real || '').slice(0, 10))}" ${canEdit ? '' : 'disabled'} /></label>
          <label><span>Realni završetak</span><input type="date" id="pbTfRz" value="${escHtml((t.datum_zavrsetka_real || '').slice(0, 10))}" ${canEdit ? '' : 'disabled'} /></label>
        </div>
        <label class="pb-field"><span>Norma (h/dan)</span>
          <div class="pb-norm-row">
            <input type="range" id="pbTfNormR" min="1" max="7" value="${Number(t.norma_sati_dan) || 4}" ${canEdit ? '' : 'disabled'} />
            <input type="number" id="pbTfNormN" min="1" max="7" value="${Number(t.norma_sati_dan) || 4}" ${canEdit ? '' : 'disabled'} />
          </div>
        </label>
        <label class="pb-field"><span>Završenost %</span>
          <input type="number" id="pbTfPct" min="0" max="100" value="${Number(t.procenat_zavrsenosti) || 0}" ${canEdit ? '' : 'disabled'} />
        </label>
        <div class="pb-modal-actions">
          ${canEdit ? `<button type="button" class="btn btn-primary" id="pbTfSave">Sačuvaj</button>` : ''}
          <!-- TODO(PB4): dugme Istorija — audit_log timeline — docs/pb_review_report.md F3 -->
          <button type="button" class="btn" id="pbTfCancel">Otkaži</button>
        </div>
      </div>
    </div>`;

  function close() {
    wrap.remove();
  }

  wrap.querySelector('.pb-close-modal')?.addEventListener('click', close);
  wrap.querySelector('#pbTfCancel')?.addEventListener('click', close);
  wrap.addEventListener('click', e => {
    if (e.target === wrap) close();
  });

  const normR = wrap.querySelector('#pbTfNormR');
  const normN = wrap.querySelector('#pbTfNormN');
  normR?.addEventListener('input', () => { if (normN) normN.value = normR.value; });
  normN?.addEventListener('input', () => { if (normR) normR.value = normN.value; });

  wrap.querySelector('#pbTfSave')?.addEventListener('click', async () => {
    const naziv = wrap.querySelector('#pbTfNaziv')?.value?.trim();
    const projectId = wrap.querySelector('#pbTfProject')?.value || null;
    if (!naziv || !projectId) {
      showPbToast('Unesi naziv i projekat', 'warning');
      return;
    }
    const payload = {
      naziv,
      project_id: projectId,
      employee_id: wrap.querySelector('#pbTfEng')?.value || null,
      vrsta: wrap.querySelector('#pbTfVrsta')?.value,
      prioritet: wrap.querySelector('#pbTfPrio')?.value,
      status: wrap.querySelector('#pbTfStatus')?.value,
      datum_pocetka_plan: wrap.querySelector('#pbTfDp')?.value || null,
      datum_zavrsetka_plan: wrap.querySelector('#pbTfDr')?.value || null,
      datum_pocetka_real: wrap.querySelector('#pbTfRp')?.value || null,
      datum_zavrsetka_real: wrap.querySelector('#pbTfRz')?.value || null,
      norma_sati_dan: Number(normN?.value) || 4,
      procenat_zavrsenosti: Number(wrap.querySelector('#pbTfPct')?.value) || 0,
    };
    try {
      if (isNew) await createPbTask(payload);
      else await updatePbTask(t.id, payload);
      showPbToast('Sačuvano', 'success');
      close();
      onSaved?.();
    } catch (err) {
      showPbToast(pbErrorMessage(err), 'error');
    }
  });

  document.body.appendChild(wrap);
}

export function openTextAreaModal({ title, initial, hint, canEdit, onSave }) {
  const wrap = document.createElement('div');
  const mobile = window.matchMedia('(max-width: 767px)').matches;
  wrap.className = mobile ? 'modal-overlay open pb-modal pb-modal--sheet' : 'modal-overlay open pb-modal';
  wrap.innerHTML = `
    <div class="modal-panel pb-text-panel" role="dialog">
      <div class="pb-modal-head"><h2>${escHtml(title)}</h2>
        <button type="button" class="btn btn-ghost pb-close-modal">✕</button></div>
      ${hint ? `<p class="pb-hint">${escHtml(hint)}</p>` : ''}
      <textarea id="pbTaBody" class="pb-textarea-lg" ${canEdit ? '' : 'disabled'}></textarea>
      <div class="pb-modal-actions">
        ${canEdit ? `<button type="button" class="btn btn-primary" id="pbTaSave">Sačuvaj</button>` : ''}
        <button type="button" class="btn" id="pbTaCancel">Otkaži</button>
      </div>
    </div>`;
  const ta = wrap.querySelector('#pbTaBody');
  if (ta) ta.value = initial || '';
  function close() { wrap.remove(); }
  wrap.querySelector('.pb-close-modal')?.addEventListener('click', close);
  wrap.querySelector('#pbTaCancel')?.addEventListener('click', close);
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#pbTaSave')?.addEventListener('click', async () => {
    const v = wrap.querySelector('#pbTaBody')?.value ?? '';
    await onSave?.(v);
    close();
  });
  document.body.appendChild(wrap);
}

export async function confirmDeletePbTask(id, onDone) {
  if (!id || !confirm('Označiti zadatak kao obrisan (soft delete)?')) return;
  try {
    await softDeletePbTask(id);
    showPbToast('Zadatak obrisan', 'success');
    onDone?.();
  } catch (err) {
    showPbToast(pbErrorMessage(err), 'error');
  }
}
