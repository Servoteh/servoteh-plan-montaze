/**
 * Full-screen skener za mobilni workflow:
 *   1. Otvori kameru → radnik usmeri na BigTehn nalepnicu
 *   2. Barkod dekodiran → auto popuni item_ref_id + fetch-uj trenutne placement-e
 *   3. Forma traži samo: Sa lokacije (pre-popunjena ako može), Na lokaciju, Količina
 *   4. Submit → RPC loc_create_movement
 *
 * UX namerno minimalistički za korišćenje jednom rukom u hali (drugi drži komad).
 */

import { escHtml, showToast } from '../../lib/dom.js';
import {
  fetchItemPlacements,
  fetchLocations,
  locCreateMovement,
} from '../../services/lokacije.js';

/* ZXing je ~250KB gzip i treba samo na ovom ekranu — lazy load da ne kasnimo
 * initial load za sve korisnike (većina nikad ne skenira sa desktop-a). */
let _barcodeModPromise = null;
function loadBarcodeModule() {
  if (!_barcodeModPromise) {
    _barcodeModPromise = import('../../services/barcode.js');
  }
  return _barcodeModPromise;
}

const MODAL_ID = 'locScanMoveModal';

function removeModal() {
  document.getElementById(MODAL_ID)?.remove();
}

/**
 * Otvori skener modal.
 * @param {{ onSuccess?: () => void }} [opts]
 */
export async function openScanMoveModal({ onSuccess } = {}) {
  removeModal();

  /* Učitaj ZXing wrapper sinhrono pre nego što otvorimo overlay — tako
   * izbegavamo "prazan crn ekran dok se chunk ne download-uje". */
  let barcodeMod;
  try {
    barcodeMod = await loadBarcodeModule();
  } catch (e) {
    console.error('[scan] failed to load barcode module', e);
    showToast('⚠ Ne mogu da učitam modul za skeniranje');
    return;
  }
  const { isScanSupported, normalizeBarcodeText, parseBigTehnBarcode, startScan } = barcodeMod;

  if (!isScanSupported()) {
    showToast('⚠ Ovaj pregledač ne podržava skeniranje');
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'loc-scan-overlay';
  overlay.innerHTML = `
    <div class="loc-scan-stage" data-stage="scan">
      <video class="loc-scan-video" id="locScanVideo" playsinline autoplay muted></video>
      <div class="loc-scan-reticle" aria-hidden="true"></div>

      <div class="loc-scan-topbar">
        <button type="button" class="loc-scan-btn" data-act="close" aria-label="Zatvori">✕</button>
        <div class="loc-scan-title">Skeniraj barkod</div>
        <button type="button" class="loc-scan-btn" data-act="torch" aria-label="Baterijska lampa">💡</button>
      </div>

      <div class="loc-scan-hint">
        Drži kod u centru — automatski se pokupi<br>
        <span class="loc-scan-manual" data-act="manual">…ili unesi ručno</span>
      </div>
    </div>

    <div class="loc-scan-form-wrap" hidden data-stage="form">
      <div class="loc-scan-form-inner">
        <div class="loc-scan-form-head">
          <button type="button" class="loc-scan-btn" data-act="back" aria-label="Skeniraj ponovo">←</button>
          <div class="loc-scan-title">Premesti stavku</div>
          <button type="button" class="loc-scan-btn" data-act="close2" aria-label="Zatvori">✕</button>
        </div>

        <div class="loc-scan-form-body">
          <div class="loc-scan-parsed" id="locScanParsed" hidden></div>

          <div class="emp-form-grid">
            <div class="emp-field">
              <label for="locScanOrder">Broj naloga</label>
              <input type="text" id="locScanOrder" autocomplete="off" maxlength="20" placeholder="npr. 9000">
            </div>
            <div class="emp-field">
              <label for="locScanItemId">Broj crteža *</label>
              <input type="text" id="locScanItemId" autocomplete="off" maxlength="40" required>
            </div>
          </div>

          <div class="loc-scan-chips" id="locScanChips"></div>

          <div class="emp-form-grid">
            <div class="emp-field">
              <label for="locScanFrom">Sa lokacije</label>
              <select id="locScanFrom"></select>
            </div>
            <div class="emp-field">
              <label for="locScanQty">Količina</label>
              <input type="number" id="locScanQty" min="0.001" step="1" value="1" inputmode="decimal">
            </div>
            <div class="emp-field col-full">
              <label for="locScanTo">Na lokaciju *</label>
              <select id="locScanTo" required></select>
            </div>
            <div class="emp-field col-full">
              <label for="locScanNote">Napomena</label>
              <input type="text" id="locScanNote" maxlength="200" placeholder="Opciono — prebačeno iz naloga">
            </div>
          </div>

          <div class="loc-scan-err" id="locScanErr"></div>

          <div class="loc-scan-actions">
            <button type="button" class="btn" data-act="rescan">Skeniraj ponovo</button>
            <button type="button" class="btn btn-primary" data-act="submit">Izvrši premeštanje</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const state = {
    scanCtrl: null,
    locs: [],
    locById: new Map(),
    currentPlacements: [],
    item_ref_table: 'bigtehn_rn',
  };

  const $ = sel => overlay.querySelector(sel);
  const stageScan = overlay.querySelector('[data-stage="scan"]');
  const stageForm = overlay.querySelector('[data-stage="form"]');

  function cleanupScan() {
    if (state.scanCtrl) {
      state.scanCtrl.stop();
      state.scanCtrl = null;
    }
  }

  function close() {
    cleanupScan();
    removeModal();
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }
  document.addEventListener('keydown', onEsc);

  async function startScanner() {
    stageForm.hidden = true;
    stageScan.hidden = false;
    const videoEl = $('#locScanVideo');
    try {
      state.scanCtrl = await startScan(videoEl, {
        onResult: text => {
          const clean = normalizeBarcodeText(text);
          if (!clean) return;
          cleanupScan();
          if (navigator.vibrate) navigator.vibrate(80);
          /* BigTehn format je potvrđen kao `NALOG/CRTEŽ` (npr. `9000/1091063`). */
          const parsed = parseBigTehnBarcode(clean);
          showForm(parsed || clean);
        },
        onError: err => {
          console.error('[scan] error', err);
        },
      });
    } catch (err) {
      $('#locScanErr') && ($('#locScanErr').textContent = `Kamera: ${err.message || err}`);
      showToast('⚠ Ne mogu da uključim kameru — proveri permisije');
      /* ne zatvaramo modal; user može "manual" da klikne */
    }
  }

  function renderChips() {
    const el = $('#locScanChips');
    const pl = state.currentPlacements;
    if (!pl.length) {
      el.innerHTML = '<span class="loc-muted" style="font-size:12px">Stavka nije trenutno nigde smeštena (novi unos = INITIAL_PLACEMENT).</span>';
      return;
    }
    const total = pl.reduce((a, r) => a + Number(r.quantity || 0), 0);
    el.innerHTML =
      `<div class="loc-current-title">Trenutno (ukupno ${escHtml(String(total))} kom.)</div>` +
      `<div class="loc-chip-row">${pl
        .map(r => {
          const loc = state.locById.get(r.location_id);
          const label = loc ? `${loc.location_code}` : r.location_id.slice(0, 8);
          return `<span class="loc-chip">${escHtml(label)} · <strong>${escHtml(String(r.quantity))}</strong></span>`;
        })
        .join('')}</div>`;
  }

  function populateFromSelect() {
    const sel = $('#locScanFrom');
    const pl = state.currentPlacements;
    if (!pl.length) {
      sel.innerHTML = '<option value="">— (INITIAL_PLACEMENT) —</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = pl
      .map(r => {
        const loc = state.locById.get(r.location_id);
        const label = loc ? `${loc.location_code} — ${loc.name}` : r.location_id;
        return `<option value="${escHtml(r.location_id)}" data-qty="${escHtml(String(r.quantity))}">${escHtml(label)} (${escHtml(String(r.quantity))} kom.)</option>`;
      })
      .join('');
    /* Default qty = all iz prve lokacije (radnik obično cela premešta). */
    const first = pl[0];
    if (first) $('#locScanQty').value = String(first.quantity);
  }

  function populateToSelect() {
    $('#locScanTo').innerHTML =
      '<option value="">— izaberi odredište —</option>' +
      state.locs
        .filter(l => l.is_active !== false)
        .map(
          l => `<option value="${escHtml(l.id)}">${escHtml(l.location_code)} — ${escHtml(l.name)}</option>`,
        )
        .join('');
  }

  /**
   * @param {string | {orderNo:string, drawingNo:string, raw:string}} payload
   *   - string: plain barcode (user input ili neprepoznati format)
   *   - object: BigTehn parsed `{ orderNo, drawingNo, raw }`
   */
  async function showForm(payload) {
    stageScan.hidden = true;
    stageForm.hidden = false;
    $('#locScanErr').textContent = '';

    let drawingNo = '';
    let orderNo = '';
    let rawHint = '';

    if (payload && typeof payload === 'object') {
      drawingNo = payload.drawingNo;
      orderNo = payload.orderNo;
      rawHint = payload.raw;
    } else if (typeof payload === 'string') {
      drawingNo = payload;
    }

    $('#locScanItemId').value = drawingNo;
    $('#locScanOrder').value = orderNo;

    const hint = $('#locScanParsed');
    if (rawHint && orderNo && drawingNo) {
      hint.hidden = false;
      hint.innerHTML =
        `<span class="loc-scan-parsed-raw">Skenirano: <strong>${escHtml(rawHint)}</strong></span> ` +
        `<span class="loc-muted">→ nalog <strong>${escHtml(orderNo)}</strong>, crtež <strong>${escHtml(drawingNo)}</strong></span>`;
    } else {
      hint.hidden = true;
      hint.innerHTML = '';
    }

    /* Nalog u `notes` — radnik može da izbriše ako ne želi. */
    const noteInput = $('#locScanNote');
    if (orderNo && !noteInput.value) {
      noteInput.value = `Nalog: ${orderNo}`;
    }

    populateToSelect();
    await refreshPlacements();
  }

  async function refreshPlacements() {
    const id = $('#locScanItemId').value.trim();
    if (!id) {
      state.currentPlacements = [];
      renderChips();
      populateFromSelect();
      return;
    }
    const rows = await fetchItemPlacements(state.item_ref_table, id);
    state.currentPlacements = (rows || []).filter(r => Number(r.quantity) > 0);
    renderChips();
    populateFromSelect();
  }

  async function submit() {
    const err = $('#locScanErr');
    err.textContent = '';
    const item_ref_id = $('#locScanItemId').value.trim();
    const to_location_id = $('#locScanTo').value;
    const from_location_id = $('#locScanFrom').value || '';
    const qty = Number($('#locScanQty').value);
    const note = $('#locScanNote').value.trim();
    const isInitial = state.currentPlacements.length === 0;

    if (!item_ref_id) {
      err.textContent = 'ID stavke je obavezan.';
      return;
    }
    if (!to_location_id) {
      err.textContent = 'Izaberi odredišnu lokaciju.';
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      err.textContent = 'Količina mora biti veća od 0.';
      return;
    }
    if (!isInitial && !from_location_id) {
      err.textContent = 'Izaberi polaznu lokaciju.';
      return;
    }
    if (from_location_id && from_location_id === to_location_id) {
      err.textContent = 'Polazna i odredišna lokacija moraju biti različite.';
      return;
    }

    const btn = overlay.querySelector('[data-act="submit"]');
    btn.disabled = true;
    const res = await locCreateMovement({
      item_ref_table: state.item_ref_table,
      item_ref_id,
      to_location_id,
      from_location_id: from_location_id || undefined,
      movement_type: isInitial ? 'INITIAL_PLACEMENT' : 'TRANSFER',
      quantity: qty,
      note: note || undefined,
    });
    btn.disabled = false;

    if (!res) {
      err.textContent = 'Server nije odgovorio.';
      return;
    }
    if (!res.ok) {
      err.textContent = errMsg(res);
      return;
    }

    showToast('✓ Premeštanje zabeleženo');
    if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
    close();
    onSuccess?.();
  }

  function errMsg(res) {
    const code = res.error;
    const map = {
      insufficient_quantity: res.available != null
        ? `Tražena količina (${res.requested ?? '?'}) > raspoloživa (${res.available}).`
        : 'Tražena količina > raspoloživa.',
      already_placed: 'Stavka već postoji — koristi TRANSFER.',
      no_current_placement: 'Stavka nije nigde smeštena — ovo je INITIAL_PLACEMENT.',
      from_ambiguous: 'Stavka je na više lokacija — izaberi polaznu.',
      from_has_no_placement: 'Na polaznoj lokaciji nema komada ove stavke.',
      bad_to_location: 'Odredišna lokacija nije validna.',
      bad_quantity: 'Količina mora biti > 0.',
      not_authenticated: 'Prijavi se ponovo.',
    };
    return map[code] || code || 'Operacija nije uspela.';
  }

  /* Event wiring */
  overlay.addEventListener('click', async ev => {
    const act = ev.target.dataset?.act;
    if (!act) return;
    switch (act) {
      case 'close':
      case 'close2':
        close();
        break;
      case 'torch':
        if (state.scanCtrl) {
          const on = await state.scanCtrl.toggleTorch();
          ev.target.style.opacity = on ? '1' : '0.5';
        }
        break;
      case 'manual':
        cleanupScan();
        showForm('');
        /* Fokus na nalog — radnik obično prvo gleda prvi broj na nalepnici. */
        setTimeout(() => $('#locScanOrder').focus(), 50);
        break;
      case 'back':
      case 'rescan':
        startScanner();
        break;
      case 'submit':
        submit();
        break;
      default:
        break;
    }
  });

  /* Debounce refresh kada korisnik menja ID ručno. */
  let debT = null;
  overlay.addEventListener('input', ev => {
    if (ev.target.id === 'locScanItemId') {
      clearTimeout(debT);
      debT = setTimeout(refreshPlacements, 300);
    }
  });

  /* Preload lokacije odmah, paralelno sa kamerom. */
  (async () => {
    const locs = await fetchLocations();
    state.locs = Array.isArray(locs) ? locs : [];
    state.locById = new Map(state.locs.map(l => [l.id, l]));
  })();

  startScanner();
}
