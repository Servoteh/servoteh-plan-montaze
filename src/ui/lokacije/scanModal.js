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
  const { isScanSupported, normalizeBarcodeText, parseBigTehnBarcode, startScan, decodeBarcodeFromFile } = barcodeMod;

  if (!isScanSupported()) {
    showToast('⚠ Ovaj pregledač ne podržava skeniranje');
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = MODAL_ID;
  overlay.className = 'loc-scan-overlay';
  overlay.innerHTML = `
    <div class="loc-scan-stage" data-stage="scan">
      <!-- playsinline + webkit-playsinline je OBAVEZAN na iOS Safari-ju da video
           ne uđe u fullscreen nativni plejer i ne "otme" prikaz kamere.
           muted je preduslov za autoplay u bilo kom browser-u. -->
      <video class="loc-scan-video" id="locScanVideo" playsinline webkit-playsinline autoplay muted></video>
      <div class="loc-scan-reticle" aria-hidden="true"></div>

      <div class="loc-scan-topbar">
        <button type="button" class="loc-scan-btn" data-act="close" aria-label="Zatvori">✕</button>
        <div class="loc-scan-title">Skeniraj barkod</div>
        <button type="button" class="loc-scan-btn" data-act="torch" aria-label="Baterijska lampa">💡</button>
      </div>

      <div class="loc-scan-hint">
        📏 Drži telefon 10-15 cm od nalepnice<br>
        Tap-ni na ekran za fokus ·
        <span class="loc-scan-manual" data-act="pickImage">📂 iz slike</span> ·
        <span class="loc-scan-manual" data-act="manual">unesi ručno</span>
      </div>
      <!-- Skriveni file input za upload slike — klik na "iz slike" u hint-u
           ga okida preko label/for ili programmatic .click(). Prihvatamo
           samo slike (iOS Safari daje Photo Library + Take Photo opcije). -->
      <input type="file" id="locScanFile" accept="image/*" hidden>

      <!-- Zoom slider — pojavi se samo ako track.getCapabilities().zoom
           postoji (iOS 17.2+, Android Chrome). Na iPhone 11+ native hardware
           zoom 1×-5×/15×; jedini način da barkod odjednom ima dovoljno piksela. -->
      <div class="loc-scan-zoom" id="locScanZoom" hidden>
        <button type="button" class="loc-zoom-btn" data-zoom-step="-1" aria-label="Smanji zoom">−</button>
        <input type="range" class="loc-zoom-range" id="locScanZoomRange" min="1" max="5" step="0.1" value="1" aria-label="Zoom">
        <span class="loc-zoom-val" id="locScanZoomVal">1×</span>
        <button type="button" class="loc-zoom-btn" data-zoom-step="1" aria-label="Povećaj zoom">+</button>
      </div>

      <!-- Vidljiv status/dijagnostika dok je skener aktivan. Ne diramo layout:
           apsolutno je pozicioniran iznad video-a. Koristi se i za error poruke
           (koje inače idu u hidden formu i user ih ne vidi). -->
      <div class="loc-scan-status" id="locScanStatus" aria-live="polite"></div>
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

    /* Zeleni ok / crveni error banner unutar scan stage (iOS korisnik nema
     * DevTools, ovo je njegov jedini prozor u stanje kamere). Radi kao
     * šablon za sve statusne poruke. */
    setScanStatus('📷 Tražim kameru…', 'info');

    /* iOS Safari caveats diagnostika — pre nego što zovemo getUserMedia. */
    const diag = detectIOSCameraPitfalls();
    if (diag.blocker) {
      setScanStatus(diag.blocker, 'error');
      return;
    }
    if (diag.warning) {
      /* Nije blocker — samo upozori i nastavi. */
      console.warn('[scan] iOS warning:', diag.warning);
    }

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
          /* ZXing baca `NotFoundException` za svaki frame bez barkoda — to je
           * tiho ignorisano u barcode.js. Sve što stigne ovde je stvarna
           * greška (dekoder, stream drop itd.). */
          console.error('[scan] decode error', err);
        },
      });

      /* Kad se stream inicijalizuje, prikaži šta je back kamera uspela da
       * nam da — ovo user vidi, i ako kaže "front kamera" znamo tačno
       * problem (facingMode ignoring). */
      setTimeout(() => reportCameraDiag(videoEl), 600);
      /* Zoom capability detekcija + UI slider init. Radi samo ako kamera
       * podržava (iPhone 11+, iOS 17.2+, novi Android-i). */
      setTimeout(() => setupZoomUI(), 800);
    } catch (err) {
      /* Ovde stižemo kada getUserMedia odbije permisiju, nema kamere, ili
       * kad je sistem zauzeo kameru (npr. FaceTime). */
      const msg = formatCameraError(err);
      setScanStatus(msg, 'error');
      console.error('[scan] camera start failed', err);
      /* ne zatvaramo modal; user može "manual" da klikne */
    }
  }

  /**
   * Upisi/ažuriraj status traku unutar scan stage. `kind` bira boju.
   * @param {string} text HTML-safe plain text (koristi `\n` za line break).
   * @param {'info'|'ok'|'warn'|'error'} [kind='info']
   */
  function setScanStatus(text, kind = 'info') {
    const el = $('#locScanStatus');
    if (!el) return;
    el.dataset.kind = kind;
    el.textContent = text;
  }

  /** Prikaži kratak info koji stream iOS dao (front/back + rezolucija). */
  function reportCameraDiag(videoEl) {
    try {
      const stream = /** @type {MediaStream|null} */ (videoEl?.srcObject);
      if (!stream) return;
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      const s = track.getSettings?.() || {};
      const label = track.label || '(bez labele)';
      const looksFront = /front|user|face/i.test(label);
      const parts = [
        looksFront ? '⚠ FRONT kamera' : '✓ back kamera',
        `${s.width || '?'}×${s.height || '?'}`,
      ];
      setScanStatus(parts.join(' · ') + ' — drži kod u centru', looksFront ? 'warn' : 'ok');
      /* Ako je front kamera, pokušaj ručno da prebacimo na back preko
       * enumerateDevices → deviceId. iOS Safari često ignoriše
       * `facingMode: ideal` i vrati front. */
      if (looksFront) void tryForceBackCamera(videoEl);
    } catch (e) {
      console.warn('[scan] diag failed', e);
    }
  }

  /**
   * iOS Safari PWA fallback: ako `facingMode: environment` vrati front
   * kameru, enumeriraj uređaje i pokušaj eksplicitni `deviceId` za prvu
   * koja NE miriše na "front/user/face". Restart ZXing stream.
   */
  async function tryForceBackCamera(videoEl) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      if (cams.length < 2) return; /* nema alternative */
      const back = cams.find(d => !/front|user|face/i.test(d.label)) || cams[cams.length - 1];
      if (!back?.deviceId) return;

      /* Restart ZXing sa konkretnim deviceId-em. */
      cleanupScan();
      state.scanCtrl = await startScan(videoEl, {
        /* deviceId idemo pre nego facingMode, pa u startScan ovo mora i da bude
         * podržano. Dodajemo treći argument — vidi barcode.js promene. */
        forceDeviceId: back.deviceId,
        onResult: text => {
          const clean = normalizeBarcodeText(text);
          if (!clean) return;
          cleanupScan();
          if (navigator.vibrate) navigator.vibrate(80);
          const parsed = parseBigTehnBarcode(clean);
          showForm(parsed || clean);
        },
        onError: err => console.error('[scan] decode error (back)', err),
      });
      setTimeout(() => reportCameraDiag(videoEl), 600);
    } catch (e) {
      console.warn('[scan] force back camera failed', e);
    }
  }

  /**
   * Inicijalizuj zoom slider + bind event-e. Zove se posle `startScan`,
   * kad je track.getCapabilities dostupan.
   */
  async function setupZoomUI() {
    if (!state.scanCtrl || typeof state.scanCtrl.getZoom !== 'function') return;
    const cap = await state.scanCtrl.getZoom();
    const wrap = $('#locScanZoom');
    const range = /** @type {HTMLInputElement|null} */ ($('#locScanZoomRange'));
    const label = $('#locScanZoomVal');
    if (!cap || !wrap || !range || !label) return;
    /* Ako kamera vraća zoom range 1..1 (nema zoom-a), sakrij UI. */
    if (cap.max <= cap.min + 0.01) {
      wrap.hidden = true;
      return;
    }
    range.min = String(cap.min);
    range.max = String(cap.max);
    range.step = String(cap.step || 0.1);
    range.value = String(cap.current || cap.min);
    label.textContent = `${Number(range.value).toFixed(1)}×`;
    wrap.hidden = false;
    /* Live update — iOS Safari može da primeni zoom sinhronizovano (hardware),
     * Android često ima 200-300ms latenciju. Radi i jedno i drugo. */
    range.addEventListener('input', async () => {
      const v = Number(range.value);
      label.textContent = `${v.toFixed(1)}×`;
      if (state.scanCtrl?.setZoom) {
        await state.scanCtrl.setZoom(v);
      }
    });
  }

  /**
   * Mapiraj getUserMedia/DOMException u kratku poruku za radnika.
   * @param {any} err
   */
  function formatCameraError(err) {
    const name = err?.name || '';
    const msg = err?.message || String(err);
    if (name === 'NotAllowedError' || /denied|blocked/i.test(msg)) {
      return '🚫 Kamera je blokirana — Settings → Safari → Camera: Allow, pa otvori link ponovo';
    }
    if (name === 'NotFoundError' || /no.*camera|not found/i.test(msg)) {
      return '🚫 Nije pronađena kamera na uređaju';
    }
    if (name === 'NotReadableError' || /in use|busy/i.test(msg)) {
      return '🚫 Kamera je zauzeta drugom aplikacijom — zatvori FaceTime/Kamera app';
    }
    if (name === 'SecurityError' || /secure|https/i.test(msg)) {
      return '🚫 Kamera radi samo preko HTTPS — otvori sa `https://…`';
    }
    return `⚠ Kamera: ${msg}`;
  }

  /**
   * Detektuj poznate iOS Safari "rupe" koje bi blokirale kameru PRE
   * getUserMedia-a (da ne čekamo permission prompt za ništa).
   * @returns {{ blocker?: string, warning?: string }}
   */
  function detectIOSCameraPitfalls() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    if (!isIOS) return {};

    /* Chrome/Firefox na iPhone-u koriste WebKit bez kamera permisija —
     * korisnik MORA da otvori u Safari-ju. */
    const isCriOS = /CriOS|FxiOS|EdgiOS/i.test(ua);
    if (isCriOS) {
      return {
        blocker:
          '🚫 Chrome/Firefox na iPhone-u ne može kameru.\nOtvori isti link u Safari-ju (tamna ikona kompasa).',
      };
    }

    /* PWA standalone mode pre iOS 16.4 blokira getUserMedia. */
    const isStandalone =
      window.matchMedia?.('(display-mode: standalone)')?.matches ||
      /** @type {any} */ (navigator).standalone === true;
    if (isStandalone) {
      /* Pokušaj da parsiraš iOS verziju iz UA-a (npr. "iPhone OS 16_3"). */
      const m = ua.match(/OS (\d+)[_.](\d+)/);
      const major = m ? parseInt(m[1], 10) : 0;
      const minor = m ? parseInt(m[2], 10) : 0;
      if (major && (major < 16 || (major === 16 && minor < 4))) {
        return {
          blocker:
            '🚫 iOS ' + major + '.' + minor + ' ne dopušta kameru u "Add to Home Screen" aplikaciji.\n' +
            'Ili: 1) ukloni ikonu sa home screen-a i otvori u Safari tabu,\n' +
            '     2) ili ažuriraj iOS na 16.4+',
        };
      }
      return { warning: 'iOS standalone mode (16.4+) — ako ne radi, probaj u Safari tabu' };
    }
    return {};
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

    /* Zoom +/− dugmad: pomera slider za ±0.5 (pa ga dispatch-ujemo kao input
     * event da `setupZoomUI` primeni promenu preko istog koda). */
    const zoomStep = ev.target.closest?.('[data-zoom-step]')?.getAttribute('data-zoom-step');
    if (zoomStep) {
      const range = /** @type {HTMLInputElement|null} */ ($('#locScanZoomRange'));
      if (range) {
        const next = Number(range.value) + Number(zoomStep) * 0.5;
        const clamped = Math.max(Number(range.min), Math.min(Number(range.max), next));
        range.value = String(clamped);
        range.dispatchEvent(new Event('input', { bubbles: true }));
      }
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
      case 'pickImage':
        /* Otvori Photo Library — iOS nudi "Take Photo" + "Photo Library".
         * Preporučeno za slike iz Viber-a / SMS-a gde live camera decode
         * ne radi zbog moire/kompresije. */
        $('#locScanFile')?.click();
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

  /* File input za upload slike — decoder radi iz still slike umesto iz
   * live stream-a. Radi i za screenshot iz Viber-a, slike iz mail-a,
   * fotografije sa drugog telefona. */
  $('#locScanFile')?.addEventListener('change', async ev => {
    const file = ev.target.files?.[0];
    ev.target.value = ''; /* reset za ponovni izbor iste slike */
    if (!file) return;
    setScanStatus('🔍 Čitam sliku…', 'info');
    try {
      const res = await decodeBarcodeFromFile(file);
      if ('text' in res) {
        /* Hit — isti tok kao live camera decode. */
        cleanupScan();
        if (navigator.vibrate) navigator.vibrate(80);
        const clean = normalizeBarcodeText(res.text);
        const parsed = parseBigTehnBarcode(clean);
        showForm(parsed || clean);
      } else if (res.error === 'no_barcode') {
        setScanStatus(
          '❌ Na slici nema prepoznatljivog barkoda.\n' +
          'Proba sa većom / oštrijom fotografijom, ili unesi ručno.',
          'warn',
        );
      } else if (res.error === 'not_image') {
        setScanStatus('⚠ Odaberi fajl tipa slike (JPG / PNG).', 'warn');
      } else {
        setScanStatus('⚠ Greška pri čitanju slike — probaj ponovo.', 'error');
      }
    } catch (e) {
      console.error('[scan] decodeFromImage failed', e);
      setScanStatus('⚠ Greška: ' + (e?.message || e), 'error');
    }
  });

  /* Tap-to-focus na video element: šalje pointsOfInterest + single-shot
   * focusMode. Ignoriše klikove po dugmadima i slider-u (oni već imaju
   * svoje handlere gore).
   *
   * Koristimo pointerdown umesto click jer iOS Safari tretira dugački tap
   * kao "force touch" koji ne propagira click. pointerdown radi svuda. */
  const videoEl = $('#locScanVideo');
  videoEl?.addEventListener('pointerdown', async ev => {
    if (!state.scanCtrl?.tapFocus) return;
    const rect = videoEl.getBoundingClientRect();
    const x = (ev.clientX - rect.left) / rect.width;
    const y = (ev.clientY - rect.top) / rect.height;
    const ok = await state.scanCtrl.tapFocus(x, y);
    if (ok) {
      /* Kratak vizuelni feedback — prikaži focus ring na mestu tapa.
       * Koristimo dinamički kreiran div umesto CSS ::after da znamo tačnu
       * poziciju. Auto-remove posle 600ms da ne zagadi overlay. */
      const ring = document.createElement('div');
      ring.className = 'loc-scan-focus-ring';
      ring.style.left = `${ev.clientX - rect.left}px`;
      ring.style.top = `${ev.clientY - rect.top}px`;
      videoEl.parentElement?.appendChild(ring);
      setTimeout(() => ring.remove(), 600);
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
