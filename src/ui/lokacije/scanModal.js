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
import { enqueueMovement } from '../../services/offlineQueue.js';

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
 * @param {{
 *   onSuccess?: () => void,
 *   onClose?: () => void,
 *   startMode?: 'scan' | 'manual',
 * }} [opts]
 *   - `startMode: 'manual'` — preskače kamera stage i odmah prikazuje formu;
 *     koristi se iz mobilnog shell-a kada user klikne "Ručni unos".
 *   - `onClose` — poziva se kada user zatvori modal bez uspešnog upisa.
 */
export async function openScanMoveModal({ onSuccess, onClose, startMode = 'scan' } = {}) {
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
    /* Trenutni scope ordera — `''` kada user nije uneo broj naloga i
     * pregledamo sve naloge za taj crtež. Set-uje se pri svakom refresh-u. */
    scopedOrderNo: '',
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

  /** @param {{ bySuccess?: boolean }} [opts] */
  function close(opts = {}) {
    cleanupScan();
    removeModal();
    document.removeEventListener('keydown', onEsc);
    if (!opts.bySuccess) {
      try {
        onClose?.();
      } catch (e) {
        /* ignore */
      }
    }
  }

  function onEsc(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  }
  document.addEventListener('keydown', onEsc);

  async function startScanner() {
    /* NATIVE path (Capacitor APK): ML Kit otvara full-screen native overlay,
     * vraća text, pa mi odmah pređemo na formu. Naš <video> + torch UI
     * se ne koriste — native scanner ima svoj UI. */
    const { isNativeCapacitor, scanNativeOnce } = await import('../../services/nativeBarcode.js');
    if (isNativeCapacitor()) {
      /* Ne gasimo web video jer se uopšte nije pokrenuo; samo overlay
       * držimo prazan dok native scanner radi. */
      const text = await scanNativeOnce();
      if (text) {
        const clean = normalizeBarcodeText(text);
        if (clean) {
          if (navigator.vibrate) navigator.vibrate(80);
          const parsed = parseBigTehnBarcode(clean);
          showForm(parsed || clean);
          return;
        }
      }
      /* Cancel / permission denied → pokaži manualni unos kao fallback. */
      showForm('');
      setTimeout(() => $('#locScanOrder')?.focus(), 50);
      return;
    }

    /* WEB path (Chrome/Safari browser) — postojeći ZXing flow. */
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
      el.innerHTML = '<span class="loc-muted" style="font-size:12px">Crtež + nalog još nisu smešteni (novi unos = INITIAL_PLACEMENT).</span>';
      return;
    }
    const total = pl.reduce((a, r) => a + Number(r.quantity || 0), 0);
    /* Kada je order_no prazan, korisnik pregleda sve naloge za isti crtež —
     * chip nosi i nalog, klik popuni `#locScanOrder` i re-scope-uje pogled. */
    const showOrder = !state.scopedOrderNo;
    const title = showOrder
      ? `Svi nalozi za ovaj crtež (ukupno ${escHtml(String(total))} kom.) — klikni chip da izabereš nalog`
      : `Nalog ${escHtml(state.scopedOrderNo)} — trenutno (ukupno ${escHtml(String(total))} kom.)`;
    el.innerHTML =
      `<div class="loc-current-title">${title}</div>` +
      `<div class="loc-chip-row">${pl
        .map(r => {
          const loc = state.locById.get(r.location_id);
          const locLbl = loc ? loc.location_code : String(r.location_id).slice(0, 8);
          const orderLbl = r.order_no ? `<strong>${escHtml(r.order_no)}</strong> · ` : '';
          const dataAttr = showOrder && r.order_no
            ? ` data-chip-order="${escHtml(r.order_no)}"`
            : '';
          return `<span class="loc-chip${showOrder && r.order_no ? ' loc-chip-click' : ''}"${dataAttr}>${orderLbl}${escHtml(locLbl)} · <strong>${escHtml(String(r.quantity))}</strong></span>`;
        })
        .join('')}</div>`;
  }

  function populateFromSelect() {
    const sel = $('#locScanFrom');
    const pl = state.currentPlacements;
    /* "Sa lokacije" ima smisla samo kada smo scope-ovali na jedan nalog;
     * inače ne možemo sigurno odrediti bucket od kojeg oduzimamo. */
    if (!state.scopedOrderNo || !pl.length) {
      sel.innerHTML = pl.length
        ? '<option value="">— prvo izaberi nalog —</option>'
        : '<option value="">— (INITIAL_PLACEMENT) —</option>';
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

    populateToSelect();
    await refreshPlacements();
  }

  async function refreshPlacements() {
    const id = $('#locScanItemId').value.trim();
    const order = $('#locScanOrder').value.trim();
    state.scopedOrderNo = order;
    if (!id) {
      state.currentPlacements = [];
      renderChips();
      populateFromSelect();
      return;
    }
    /* Ako je nalog unet → striktno scope (order_no=eq.'9000').
     * Ako nije → undefined (vraća SVE naloge za taj crtež, i bucket bez naloga). */
    const rows = await fetchItemPlacements(
      state.item_ref_table,
      id,
      order ? order : undefined,
    );
    state.currentPlacements = (rows || []).filter(r => Number(r.quantity) > 0);
    renderChips();
    populateFromSelect();
  }

  async function submit() {
    const err = $('#locScanErr');
    err.textContent = '';
    const item_ref_id = $('#locScanItemId').value.trim();
    const order_no = $('#locScanOrder').value.trim();
    const to_location_id = $('#locScanTo').value;
    const from_location_id = $('#locScanFrom').value || '';
    const qty = Number($('#locScanQty').value);
    const note = $('#locScanNote').value.trim();
    /* INITIAL = nema nijednog placement-a za (crtež, nalog) par. */
    const isInitial = state.currentPlacements.length === 0;

    if (!item_ref_id) {
      err.textContent = 'Broj crteža je obavezan.';
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

    const payload = {
      item_ref_table: state.item_ref_table,
      item_ref_id,
      order_no,
      to_location_id,
      from_location_id: from_location_id || undefined,
      movement_type: isInitial ? 'INITIAL_PLACEMENT' : 'TRANSFER',
      quantity: qty,
      note: note || undefined,
    };

    /* Offline fallback: ako telefon nije na WiFi-ju, gurni u queue
     * (services/offlineQueue.js) i obavesti radnika. Kad se signal vrati
     * auto-flush će pokušati da pošalje. */
    if (!navigator.onLine) {
      try {
        enqueueMovement(payload);
        if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
        showToast('📥 Offline — zapis sačuvan i poslaće se kad se vrati signal');
        close({ bySuccess: true });
        onSuccess?.();
      } catch (e) {
        err.textContent = `Ne mogu da zapišem u lokalni queue: ${e.message}`;
      } finally {
        btn.disabled = false;
      }
      return;
    }

    let res;
    try {
      res = await locCreateMovement(payload);
    } catch (e) {
      /* Mrežni pad u sred RPC-a → queue (videti napomenu u offlineQueue.js
       * o mogućem duplikatu). */
      enqueueMovement(payload);
      btn.disabled = false;
      if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
      showToast('📥 Mreža pala — zapis sačuvan u queue');
      close({ bySuccess: true });
      onSuccess?.();
      return;
    }
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
    close({ bySuccess: true });
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
      bad_order_no: 'Broj naloga je predugačak (max 40 karaktera).',
      not_authenticated: 'Prijavi se ponovo.',
    };
    return map[code] || code || 'Operacija nije uspela.';
  }

  /* Event wiring */
  overlay.addEventListener('click', async ev => {
    /* Klik na chip sa nalogom → popuni #locScanOrder i re-scope. */
    const chipOrder = ev.target.closest?.('[data-chip-order]')?.getAttribute('data-chip-order');
    if (chipOrder) {
      $('#locScanOrder').value = chipOrder;
      refreshPlacements();
      return;
    }

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

  /* Debounce refresh kada korisnik menja crtež ili nalog ručno. */
  let debT = null;
  overlay.addEventListener('input', ev => {
    if (ev.target.id === 'locScanItemId' || ev.target.id === 'locScanOrder') {
      clearTimeout(debT);
      debT = setTimeout(refreshPlacements, 300);
    }
  });

  /* Preload lokacije odmah, paralelno sa kamerom. */
  (async () => {
    const locs = await fetchLocations();
    state.locs = Array.isArray(locs) ? locs : [];
    state.locById = new Map(state.locs.map(l => [l.id, l]));
    if (startMode === 'manual') {
      /* Populate to-select odmah (inače bi ostao prazan dok korisnik ne klikne). */
      populateToSelect();
    }
  })();

  if (startMode === 'manual') {
    /* Preskoči kamera stage — prikaži formu praznu, fokus na polje `Broj naloga`.
     * Korisno za telefone bez kamere ili kada nalepnica fali. */
    showForm('');
    setTimeout(() => $('#locScanOrder')?.focus(), 60);
  } else {
    startScanner();
  }
}
