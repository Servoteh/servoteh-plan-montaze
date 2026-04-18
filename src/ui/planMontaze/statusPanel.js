/**
 * Plan Montaže — Save & connection status panel (F5.5).
 *
 * Mali, fixni indikator (donji desni ugao) sa:
 *   - Online/Offline indikator (zeleni/crveni dot)
 *   - Save queue (queued + inflight) — prikaže `⏳ N` kada nije 0
 *   - "Sve sačuvano" kratak fade kada bi prešlo iz N>0 → 0
 *   - Last error tooltip (hover pokazuje errorMessage)
 *
 * Koristi `subscribeSaveStatus` i `subscribeConnState` iz services/plan.js.
 * Renderuje samo jednom u `document.body` (singleton). Bezbedno za multipni
 * `mountStatusPanel()` poziv — drugi se ignoriše.
 */

import { subscribeSaveStatus, subscribeConnState } from '../../services/plan.js';

let _mounted = false;
let _root = null;
let _unsubSave = null;
let _unsubConn = null;
let _lastQueued = 0;
let _lastInflight = 0;
let _doneTimer = null;

export function mountStatusPanel() {
  if (_mounted) return;
  _mounted = true;
  _root = document.createElement('div');
  _root.id = 'planStatusPanel';
  _root.className = 'plan-status-panel';
  _root.innerHTML = `
    <span class="psp-conn" id="pspConn" title="Konekcija">
      <span class="psp-dot"></span><span class="psp-conn-lbl">…</span>
    </span>
    <span class="psp-sep"></span>
    <span class="psp-save" id="pspSave" title="Save status">…</span>
  `;
  document.body.appendChild(_root);

  _unsubSave = subscribeSaveStatus((s) => _renderSave(s));
  _unsubConn = subscribeConnState((on) => _renderConn(on));
}

export function unmountStatusPanel() {
  if (!_mounted) return;
  _mounted = false;
  if (_unsubSave) { _unsubSave(); _unsubSave = null; }
  if (_unsubConn) { _unsubConn(); _unsubConn = null; }
  if (_doneTimer) { clearTimeout(_doneTimer); _doneTimer = null; }
  if (_root?.parentNode) _root.parentNode.removeChild(_root);
  _root = null;
}

function _renderConn(isOnline) {
  if (!_root) return;
  const wrap = _root.querySelector('#pspConn');
  if (!wrap) return;
  wrap.classList.toggle('psp-on', !!isOnline);
  wrap.classList.toggle('psp-off', !isOnline);
  const lbl = wrap.querySelector('.psp-conn-lbl');
  if (lbl) lbl.textContent = isOnline ? 'online' : 'offline';
  wrap.title = isOnline ? 'Konekcija OK — promene se sinhronizuju' : 'Offline — promene se čuvaju lokalno';
}

function _renderSave(status) {
  if (!_root) return;
  const el = _root.querySelector('#pspSave');
  if (!el) return;
  const total = (status.queued || 0) + (status.inflight || 0);
  const wasBusy = (_lastQueued + _lastInflight) > 0;
  _lastQueued = status.queued || 0;
  _lastInflight = status.inflight || 0;

  if (status.lastError) {
    el.className = 'psp-save psp-err';
    el.innerHTML = '⚠ Greška';
    el.title = 'Save error: ' + status.lastError;
    return;
  }

  if (total > 0) {
    el.className = 'psp-save psp-busy';
    const inflightTxt = status.inflight ? ` (${status.inflight} u toku)` : '';
    el.innerHTML = `⏳ ${total}${inflightTxt}`;
    el.title = `Pending save: ${total}${inflightTxt}`;
    if (_doneTimer) { clearTimeout(_doneTimer); _doneTimer = null; }
    return;
  }

  /* total === 0 */
  if (wasBusy) {
    el.className = 'psp-save psp-done';
    el.innerHTML = '✔ Sačuvano';
    el.title = 'Sve promene su sinhronizovane';
    if (_doneTimer) clearTimeout(_doneTimer);
    _doneTimer = setTimeout(() => {
      if (!_root) return;
      const e2 = _root.querySelector('#pspSave');
      if (!e2) return;
      e2.className = 'psp-save psp-idle';
      e2.innerHTML = '·';
      e2.title = 'Nema pending save-ova';
    }, 1800);
  } else {
    el.className = 'psp-save psp-idle';
    el.innerHTML = '·';
    el.title = 'Nema pending save-ova';
  }
}
