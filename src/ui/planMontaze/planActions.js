/**
 * Plan Montaže — shared row-level akcije.
 *
 * Iste funkcije koriste i desktop tabela (planTable.js) i mobilne kartice
 * (mobileCards.js). Sve akcije:
 *   1. Provere `canEdit()` → toast i abort ako je viewer
 *   2. Mutiraju aktivni `wp.phases[i]`
 *   3. Pozovu `applyBusinessRules` gde je relevantno
 *   4. `persistState()` (localStorage)
 *   5. `queuePhaseSaveByIndex(i)` ili `queueCurrentWpSync()` (debounced
 *      Supabase save)
 *
 * Note: ove funkcije ne re-renderuju UI — pozivalac mora da uradi rerender
 * (preko `onChange` callback-a).
 */

import { showToast } from '../../lib/dom.js';
import { canEdit } from '../../state/auth.js';
import {
  planMontazeState,
  getActivePhases,
  getActiveWP,
  addEngineerName,
  addLeadName,
  createBlankPhase,
  expandedMobileCards,
  persistState,
  deletePhaseModel,
} from '../../state/planMontaze.js';
import { applyBusinessRules, normalizePhaseType } from '../../lib/phase.js';
import {
  queuePhaseSaveByIndex,
  queueCurrentWpSync,
  deletePhaseAndPersist,
} from '../../services/plan.js';

export function updatePhaseField(i, field, value) {
  if (!canEdit()) return;
  const row = getActivePhases()[i];
  if (!row) return;
  if (field === 'status' && value === 3 && !row.blocker?.trim()) {
    showToast('⚠ Upiši blokator pre "Na čekanju"');
    return;
  }
  if (field === 'type') value = normalizePhaseType(value);
  row[field] = value;
  applyBusinessRules(row);
  persistState();
  queuePhaseSaveByIndex(i);
}

export function handlePersonChange(el, i, field) {
  const row = getActivePhases()[i];
  if (!row) return;
  if (el.value === '__add__') {
    const kind = field === 'engineer' ? 'odg. inženjera' : 'vođu montaže';
    const raw = prompt('Unesi ime novog ' + kind + ':', '');
    const name = String(raw || '').trim();
    if (!name) {
      el.value = row[field] || '';
      return;
    }
    const added = field === 'engineer' ? addEngineerName(name) : addLeadName(name);
    if (added) {
      updatePhaseField(i, field, added);
      showToast('✅ ' + kind + ' dodato');
    } else {
      el.value = row[field] || '';
    }
    return;
  }
  updatePhaseField(i, field, el.value);
}

export function updateCheck(i, ci, value) {
  if (!canEdit()) return;
  const row = getActivePhases()[i];
  if (!row) return;
  row.checks[ci] = !!value;
  persistState();
  queuePhaseSaveByIndex(i);
}

export function togglePhaseType(i) {
  if (!canEdit()) return;
  const row = getActivePhases()[i];
  if (!row) return;
  row.type = normalizePhaseType(row.type) === 'mechanical' ? 'electrical' : 'mechanical';
  persistState();
  queuePhaseSaveByIndex(i);
}

export function moveRow(i, dir) {
  if (!canEdit()) { showToast('⚠ Pregled — nema izmena'); return; }
  const phases = getActivePhases();
  const j = i + dir;
  if (j < 0 || j >= phases.length) return;
  [phases[i], phases[j]] = [phases[j], phases[i]];
  planMontazeState.filteredIndices = null;
  persistState();
  queueCurrentWpSync();
}

export function deleteRow(i) {
  if (!canEdit()) { showToast('⚠ Pregled — nema izmena'); return; }
  const phases = getActivePhases();
  const ph = phases[i];
  if (!ph) return;
  if (!confirm(`Obriši "${ph.name}"?`)) return;
  const deletedId = ph.id;
  phases.splice(i, 1);
  planMontazeState.filteredIndices = null;
  if (deletedId) {
    expandedMobileCards.delete(deletedId);
    deletePhaseModel(deletedId);
  }
  persistState();
  if (deletedId) deletePhaseAndPersist(deletedId);
  queueCurrentWpSync();
}

export function addPhaseFromInput() {
  if (!canEdit()) { showToast('⚠ Pregled — nema izmena'); return false; }
  const wp = getActiveWP();
  if (!wp) { showToast('⚠ Nema aktivne pozicije'); return false; }
  const inp = document.querySelector('#newPhaseInput');
  const name = String(inp?.value || '').trim();
  if (!name) { showToast('⚠ Unesi naziv'); inp?.focus(); return false; }
  wp.phases.push(createBlankPhase(name, wp));
  if (inp) inp.value = '';
  persistState();
  queueCurrentWpSync();
  showToast('✅ Faza dodata');
  return true;
}
