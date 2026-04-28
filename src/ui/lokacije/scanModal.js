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
import { parsePredmetTpFromLabelText } from '../../lib/barcodeParse.js';
import { getLocationKind } from '../../lib/lokacijeTypes.js';
import {
  fetchItemPlacements,
  fetchLocations,
  locCreateMovement,
} from '../../services/lokacije.js';
import { fetchBigtehnOpSnapshotByRnAndTp } from '../../services/planProizvodnje.js';
import { enqueueMovement } from '../../services/offlineQueue.js';
import { getIsOnline } from '../../state/auth.js';

/* `__APP_VERSION__` je string koji Vite inject-uje u build time (git SHA ili
 * CF_PAGES_COMMIT_SHA). Koristimo ga u dijagnostičkom badge-u pored polja
 * crtež da magacioner može odmah da vidi koja verzija app-a se izvršava
 * (bitno za "ne pokazuje crtež" troubleshooting — PWA često isporučuje stari
 * JS iz service worker cache-a). */
/* global __APP_VERSION__ */
const APP_VERSION =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';

/**
 * "Hard reset" za PWA na telefonu kad magacioner vidi da autofill ne radi
 * (tipično stari JS cached od prethodnog deploy-a). Redosled:
 *   1. unregister svih service worker-a
 *   2. obriši sve `caches` (Workbox precache + runtime cache-ove)
 *   3. obriši localStorage drawing cache (ne toucha login token)
 *   4. reload sa no-cache hint
 * Sve korake zavrti BEST-EFFORT: ako pojedinačni korak fail-uje (npr. stari
 * browser), idemo na sledeći.
 */
async function forceAppReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
    }
  } catch (e) {
    console.warn('[scan] SW unregister failed', e);
  }
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map(n => caches.delete(n).catch(() => {})));
    }
  } catch (e) {
    console.warn('[scan] caches.delete failed', e);
  }
  /* Dodaj cache-bust query da browser sigurno ne posluži iz HTTP cache-a. */
  const url = new URL(window.location.href);
  url.searchParams.set('_r', String(Date.now()));
  window.location.replace(url.toString());
}

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

/* ── Drawing-number cache (localStorage) ─────────────────────────────────
 * RNZ barkod ne nosi broj crteža — radnik ga prvi put prepisuje sa teksta
 * nalepnice. Mi mapu (order_no, item_ref_id) → drawing_no čuvamo lokalno
 * da sledeći skenir iste nalepnice autofill-uje. Keš je best-effort: ne
 * zove server, pa ako se telefon očisti / promeni uređaj — radnik upiše
 * ponovo (sledeći put ponovo keš).
 *
 * Struktura: { "7351|1088": "1128816", ... }
 * Ograničenje: 500 unosa (LRU pruning) da LS ne eksplodira.
 */
const DRAWING_CACHE_KEY = 'loc_drawing_cache_v1';
const DRAWING_CACHE_LIMIT = 500;

function readDrawingCache() {
  try {
    const raw = localStorage.getItem(DRAWING_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeDrawingCache(obj) {
  try {
    localStorage.setItem(DRAWING_CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* Quota exceeded — tiho preskoči; autofill je nice-to-have, ne kritično. */
  }
}

function getDrawingCache(orderNo, itemRefId) {
  if (!orderNo || !itemRefId) return '';
  const key = `${orderNo}|${itemRefId}`;
  return readDrawingCache()[key] || '';
}

function setDrawingCache(orderNo, itemRefId, drawingNo) {
  if (!orderNo || !itemRefId || !drawingNo) return;
  const key = `${orderNo}|${itemRefId}`;
  const cache = readDrawingCache();
  cache[key] = String(drawingNo);

  /* LRU pruning: ako pređemo limit, obriši najstarije (prvi ključ-evi u
   * insertion order-u — JS ES2015+ garantuje redosled). */
  const keys = Object.keys(cache);
  if (keys.length > DRAWING_CACHE_LIMIT) {
    const toDrop = keys.slice(0, keys.length - DRAWING_CACHE_LIMIT);
    for (const k of toDrop) delete cache[k];
  }
  writeDrawingCache(cache);
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
/**
 * @param {object} [opts]
 * @param {() => void} [opts.onSuccess]
 * @param {() => void} [opts.onClose]
 * @param {'scan'|'manual'} [opts.startMode]
 * @param {'shelf'|'warehouse'|null} [opts.preferLocationCategory]
 *   Prečica sa mobilne home strane: 'shelf' = POLICA dugme, 'warehouse' = HALA.
 *   Kad je setovano, optgroup te kategorije ide prvi u "Na lokaciju" selectu i
 *   header dobije subtilni chip "filter: POLICA / HALA".
 * @param {{
 *   itemRefTable?: string,
 *   itemRefId?: string,
 *   orderNo?: string,
 *   drawingNo?: string,
 *   fromLocationId?: string,
 * }} [opts.prefill]
 *   Pre-popuni formu (npr. iz /m/lookup kartice: "Premesti odavde"). Kad je
 *   setovano, preskače scan stage i otvara odmah formu sa popunjenim poljima
 *   i odabranom polaznom lokacijom.
 */
export async function openScanMoveModal({
  onSuccess,
  onClose,
  startMode = 'scan',
  preferLocationCategory = null,
  prefill = null,
} = {}) {
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
      <div class="loc-scan-laser" aria-hidden="true"></div>

      <div class="loc-scan-topbar">
        <button type="button" class="loc-scan-btn" data-act="close" aria-label="Zatvori">✕</button>
        <div class="loc-scan-title">Skeniraj barkod</div>
        <button type="button" class="loc-scan-btn" data-act="torch" aria-label="Baterijska lampa">💡</button>
      </div>

      <div class="loc-scan-hint">
        📏 Drži telefon 10-15 cm od nalepnice · usmeri gornji desni ugao (broj predmeta/TP) kad koristiš OCR<br>
        Tap-ni na ekran za fokus ·
        <span class="loc-scan-manual" data-act="pickImage">📂 iz slike</span> ·
        <span class="loc-scan-manual" data-act="ocrScan">OCR skeniraj</span> ·
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
              <label for="locScanOrder">Broj naloga *</label>
              <input type="text" id="locScanOrder" autocomplete="off" maxlength="20" placeholder="npr. 7351" required>
            </div>
            <div class="emp-field">
              <label for="locScanItemId">Broj TP *</label>
              <input type="text" id="locScanItemId" autocomplete="off" maxlength="40" placeholder="npr. 1088" required>
            </div>
            <div class="emp-field col-full">
              <label for="locScanDrawing">
                Broj crteža
                <span class="loc-muted" style="font-weight:400;font-size:12px">
                  — prepiši sa teksta nalepnice (nije u barkodu)
                </span>
              </label>
              <input type="text" id="locScanDrawing" autocomplete="off" maxlength="40" placeholder="npr. 1128816">
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
              <label for="locScanTo">
                Na lokaciju *
                <span class="loc-muted" id="locScanToHint" style="font-weight:400;font-size:12px"></span>
              </label>
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
  /* Android Web: torch/zoom kroz MediaStream retko rade — sakrij dugme da ne zbunjuje. */
  if (/Android/i.test(navigator.userAgent || '')) {
    overlay.querySelector('.loc-scan-topbar [data-act="torch"]')?.setAttribute('hidden', '');
  }

  const state = {
    scanCtrl: null,
    /** Da li smo pokušali fullscreen + orientation.lock (samo coarse/mobile). */
    scanPresentationActive: false,
    locs: [],
    locById: new Map(),
    currentPlacements: [],
    /* Trenutni scope ordera — `''` kada user nije uneo broj naloga i
     * pregledamo sve naloge za taj crtež. Set-uje se pri svakom refresh-u. */
    scopedOrderNo: '',
    item_ref_table: 'bigtehn_rn',
    /** @type {object|null} red iz v_production_operations (BigTehn cache) */
    erpSnapshot: null,
  };

  const $ = sel => overlay.querySelector(sel);
  const stageScan = overlay.querySelector('[data-stage="scan"]');
  const stageForm = overlay.querySelector('[data-stage="form"]');

  function canUseAggressiveScanPresentation() {
    try {
      return (
        window.matchMedia('(pointer: coarse)').matches ||
        /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
      );
    } catch {
      return false;
    }
  }

  /** Širi okvir + laser; na telefonu još fullscreen + landscape gde browser dozvoljava. */
  function enterScanPresentation() {
    overlay.classList.add('loc-scan-presentation');
    if (!canUseAggressiveScanPresentation() || state.scanPresentationActive) return;
    state.scanPresentationActive = true;
    const root = stageScan;
    try {
      const req = root.requestFullscreen || /** @type {any} */ (root).webkitRequestFullscreen;
      if (typeof req === 'function') void Promise.resolve(req.call(root)).catch(() => {});
    } catch (_) {
      /* ignore */
    }
    try {
      const o = screen.orientation;
      if (o && typeof o.lock === 'function') void o.lock('landscape').catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  function leaveScanPresentation() {
    overlay.classList.remove('loc-scan-presentation');
    state.scanPresentationActive = false;
    try {
      const fsEl = /** @type {any} */ (document).fullscreenElement || /** @type {any} */ (document).webkitFullscreenElement;
      if (fsEl && (fsEl === overlay || fsEl === stageScan)) {
        const ex = document.exitFullscreen || /** @type {any} */ (document).webkitExitFullscreen;
        if (typeof ex === 'function') void Promise.resolve(ex.call(document)).catch(() => {});
      }
    } catch (_) {
      /* ignore */
    }
    try {
      screen.orientation?.unlock?.();
    } catch (_) {
      /* ignore */
    }
  }

  function cleanupScan() {
    leaveScanPresentation();
    if (state.scanCtrl) {
      state.scanCtrl.stop();
      state.scanCtrl = null;
    }
  }

  /** @param {{ bySuccess?: boolean }} [opts] */
  function close(opts = {}) {
    cleanupScan();
    import('../../services/labelOcr.js')
      .then(m => m.terminateLabelOcrWorker())
      .catch(() => {});
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

  /** ZXing live scan stage — koristi se u browseru i nakon native barkoda kao OCR fallback. */
  async function startWebScanner() {
    stageForm.hidden = true;
    stageScan.hidden = false;
    enterScanPresentation();
    const videoEl = $('#locScanVideo');

    setScanStatus('📷 Tražim kameru…', 'info');

    const diag = detectIOSCameraPitfalls();
    if (diag.blocker) {
      leaveScanPresentation();
      setScanStatus(diag.blocker, 'error');
      return;
    }
    if (diag.warning) {
      console.warn('[scan] iOS warning:', diag.warning);
    }

    try {
      state.scanCtrl = await startScan(videoEl, {
        onResult: async text => {
          const clean = normalizeBarcodeText(text);
          if (!clean) return;
          cleanupScan();
          if (navigator.vibrate) navigator.vibrate(80);
          const parsed = parseBigTehnBarcode(clean);
          try {
            await showForm(parsed || clean);
          } catch (e) {
            console.error('[scan] showForm failed', e);
          }
        },
        onError: err => {
          console.error('[scan] decode error', err);
        },
      });

      setTimeout(() => reportCameraDiag(videoEl), 600);
      setTimeout(() => setupZoomUI(), 800);
    } catch (err) {
      leaveScanPresentation();
      const msg = formatCameraError(err);
      setScanStatus(msg, 'error');
      console.error('[scan] camera start failed', err);
    }
  }

  async function startScanner() {
    /* NATIVE path (Capacitor): ML Kit barkod; ako otkaže — otvara web kameru za barkod + OCR. */
    const { isNativeCapacitor, scanNativeOnce } = await import('../../services/nativeBarcode.js');
    if (isNativeCapacitor()) {
      const text = await scanNativeOnce();
      if (text) {
        const clean = normalizeBarcodeText(text);
        if (clean) {
          if (navigator.vibrate) navigator.vibrate(80);
          const parsed = parseBigTehnBarcode(clean);
          try {
            await showForm(parsed || clean);
          } catch (e) {
            console.error('[scan] showForm failed (native)', e);
          }
          return;
        }
      }
      await startWebScanner();
      return;
    }

    await startWebScanner();
  }

  /** Snimi gornji desni ugao kadra, OCR, ponudi nalog/TP ako regex nađe par. */
  async function applyOcrFromVideo() {
    const videoEl = $('#locScanVideo');
    if (!videoEl || stageScan.hidden || !state.scanCtrl) {
      showToast('⚠ Prvo pokreni kameru (Skeniraj ponovo)');
      return;
    }
    setScanStatus('🔤 Čitam tekst (OCR)… može potrajati nekoliko sekundi prvi put', 'info');
    try {
      const { cropTopRightLabelRegion, recognizeLabelCanvas } = await import('../../services/labelOcr.js');
      const canvas = cropTopRightLabelRegion(videoEl);
      if (!canvas) {
        setScanStatus('⚠ Sačekaj da kamera stabilizuje kadar, pa probaj ponovo.', 'warn');
        return;
      }
      const res = await recognizeLabelCanvas(canvas);
      if ('error' in res) {
        setScanStatus('⚠ OCR nije uspeo — probaj zum ili ručni unos.', 'warn');
        return;
      }
      const parsed = parsePredmetTpFromLabelText(res.text);
      if (!parsed) {
        setScanStatus(
          '❌ Nije prepoznat „broj predmeta / TP”. Usmeri gornji desni ugao liste ili unesi ručno.',
          'warn',
        );
        return;
      }
      cleanupScan();
      if (navigator.vibrate) navigator.vibrate(80);
      await showForm(parsed);
    } catch (e) {
      console.error('[scan] OCR failed', e);
      setScanStatus('⚠ OCR greška — probaj ponovo ili ručni unos.', 'error');
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
      enterScanPresentation();
      state.scanCtrl = await startScan(videoEl, {
        /* deviceId idemo pre nego facingMode, pa u startScan ovo mora i da bude
         * podržano. Dodajemo treći argument — vidi barcode.js promene. */
        forceDeviceId: back.deviceId,
        onResult: async text => {
          const clean = normalizeBarcodeText(text);
          if (!clean) return;
          cleanupScan();
          if (navigator.vibrate) navigator.vibrate(80);
          const parsed = parseBigTehnBarcode(clean);
          try {
            await showForm(parsed || clean);
          } catch (e) {
            console.error('[scan] showForm failed (back)', e);
          }
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
    if (/Android/i.test(navigator.userAgent || '')) return;
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
   * Kratko uputstvo gde dozvoliti kameru (različito za Android / iOS / desktop).
   */
  function cameraBlockedUserHint() {
    const ua = navigator.userAgent || '';
    const isAndroid = /Android/i.test(ua);
    const isIOS =
      /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
    if (isAndroid) {
      return (
        '🚫 Kamera je blokirana — Podešavanja → Aplikacije → tvoj pregledač (Chrome, Samsung Internet…) → ' +
        'Dozvole → Kamera → Dozvoli, pa osveži stranicu'
      );
    }
    if (isIOS) {
      return (
        '🚫 Kamera je blokirana — Podešavanja → Safari → Kamera → Dozvoli ' +
        '(ili Podešavanja → ova aplikacija ako je PWA), pa otvori link ponovo'
      );
    }
    return (
      '🚫 Kamera je blokirana — u adresnoj traci klikni ikonicu kamere / lokacije i dozvoli pristup, ' +
      'ili u podešavanjima pregledača: privatnost / dozvole za sajt → Kamera'
    );
  }

  /**
   * Mapiraj getUserMedia/DOMException u kratku poruku za radnika.
   * @param {any} err
   */
  function formatCameraError(err) {
    const name = err?.name || '';
    const msg = err?.message || String(err);
    if (name === 'NotAllowedError' || /denied|blocked/i.test(msg)) {
      return cameraBlockedUserHint();
    }
    if (name === 'NotFoundError' || /no.*camera|not found/i.test(msg)) {
      return '🚫 Nije pronađena kamera na uređaju';
    }
    if (name === 'NotReadableError' || /in use|busy/i.test(msg)) {
      const ua = navigator.userAgent || '';
      const isIOS =
        /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
      if (isIOS) {
        return '🚫 Kamera je zauzeta — zatvori FaceTime ili Kamera aplikaciju i probaj ponovo';
      }
      return '🚫 Kamera je zauzeta — zatvori druge aplikacije koje koriste kameru i probaj ponovo';
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

  /**
   * Popuni "Na lokaciju" select grupisano po kategorijama da user brže nađe
   * odredište. Kategorije (po `location_type`):
   *   📍 POLICE  — SHELF / RACK / BIN (konkretan fizički spot; dugačka lista)
   *   🏭 HALE     — WAREHOUSE / PRODUCTION / ASSEMBLY / FIELD / TEMP (veći prostor)
   *   📦 OSTALE   — SCRAPPED / OFFICE / TRANSIT / SERVICE / PROJECT / OTHER
   *
   * Ako je `preferLocationCategory` prosleđeno (iz mobilne POLICA/HALA prečice),
   * preferirana grupa ide PRVA u listi (user prvo vidi ono što mu treba), ali
   * ostale su i dalje dostupne — ne filtriramo tvrdо jer user u toku rada
   * može odlučiti da promeni kategoriju (npr. "ipak ide u škart").
   */
  function populateToSelect() {
    const shelves = [];
    const halls = [];
    const others = [];
    for (const l of state.locs) {
      if (l.is_active === false) continue;
      const kind = getLocationKind(l.location_type);
      if (kind === 'shelf') shelves.push(l);
      else if (kind === 'hall') halls.push(l);
      else others.push(l);
    }
    const renderGroup = (label, items) => {
      if (!items.length) return '';
      const opts = items
        .map(
          l =>
            `<option value="${escHtml(l.id)}">${escHtml(l.location_code)} — ${escHtml(l.name)}</option>`,
        )
        .join('');
      return `<optgroup label="${escHtml(label)}">${opts}</optgroup>`;
    };
    const shelfGroup = renderGroup('📍 POLICE', shelves);
    const hallGroup = renderGroup('🏭 HALE', halls);
    const otherGroup = renderGroup('📦 OSTALE', others);

    let grouped;
    if (preferLocationCategory === 'shelf') {
      grouped = shelfGroup + hallGroup + otherGroup;
    } else if (preferLocationCategory === 'warehouse') {
      grouped = hallGroup + shelfGroup + otherGroup;
    } else {
      grouped = shelfGroup + hallGroup + otherGroup;
    }

    $('#locScanTo').innerHTML =
      '<option value="">— izaberi odredište —</option>' + grouped;

    /* Kratak tekstualni ključ iznad selecta — pomaže da user razume zašto je
     * neka grupa prva (npr. kliknuo je "POLICA" prečicu sa home-a). */
    const hintEl = $('#locScanToHint');
    if (hintEl) {
      if (preferLocationCategory === 'shelf') {
        hintEl.textContent = '— prečica sa home: POLICE su prve u listi';
      } else if (preferLocationCategory === 'warehouse') {
        hintEl.textContent = '— prečica sa home: HALE su prve u listi';
      } else {
        hintEl.textContent = '';
      }
    }
  }

  /**
   * @param {string | {orderNo:string, drawingNo:string, raw:string}} payload
   *   - string: plain barcode (user input ili neprepoznati format)
   *   - object: BigTehn parsed `{ orderNo, drawingNo, raw }`
   */
  async function showForm(payload) {
    leaveScanPresentation();
    stageScan.hidden = true;
    stageForm.hidden = false;
    $('#locScanErr').textContent = '';

    /* Payload može biti:
     *   - object iz parseBigTehnBarcode: { orderNo, itemRefId, drawingNo, format, raw }
     *   - plain string (ručni unos sa manual bubble-a) → tretiramo kao itemRefId
     *   - prazan string → čista forma (user popunjava sve ručno) */
    let itemRefId = '';
    let orderNo = '';
    let drawingNo = '';
    let rawHint = '';
    let format = '';

    if (payload && typeof payload === 'object') {
      /* Backward compat: stariji parser nije imao `itemRefId`, samo `drawingNo`.
       * Ako je objekat bez `itemRefId`, fall-back na `drawingNo`. */
      itemRefId = payload.itemRefId ?? payload.drawingNo ?? '';
      orderNo = payload.orderNo || '';
      drawingNo = payload.drawingNo || '';
      rawHint = payload.raw || '';
      format = payload.format || '';
    } else if (typeof payload === 'string') {
      itemRefId = payload;
    }

    $('#locScanItemId').value = itemRefId;
    $('#locScanOrder').value = orderNo;

    state.erpSnapshot = null;
    let erpSnap = null;
    /* `erpLookupStatus` ide u dijagnostičku liniju hint-a i pokazuje magacioneru
     * šta se desilo sa ERP lookup-om: 'ok' | 'not_found' | 'offline' | 'error' | 'skip'. */
    let erpLookupStatus = 'skip';
    let erpLookupErr = '';
    /* BigTehn cache: RNZ/OCR + i „short“ (nalog/druga-grupa) — iOS često pročita
     * samo `7351/1088` bez `RNZ:` pa parser mapira na short sa drawingNo=TP;
     * fetch po (nalog, drugi broj) kao TP i dalje nalazi red i broj_crteza. */
    if ((format === 'rnz' || format === 'ocr' || format === 'short') && orderNo && itemRefId) {
      if (!getIsOnline()) {
        erpLookupStatus = 'offline';
      } else {
        try {
          erpSnap = await fetchBigtehnOpSnapshotByRnAndTp(orderNo, itemRefId);
          erpLookupStatus = erpSnap ? 'ok' : 'not_found';
        } catch (e) {
          console.warn('[scan] ERP snapshot failed', e);
          erpLookupStatus = 'error';
          erpLookupErr = e?.message || String(e);
        }
      }
      state.erpSnapshot = erpSnap;
    }

    /* Autofill broja crteža: 1) ERP (autoritativno), 2) vrednost sa barkoda (short),
     * 3) localStorage keš. Redosled rešava pogrešan short kada je drugi segment TP. */
    const cachedDrawing =
      !drawingNo && orderNo && itemRefId ? getDrawingCache(orderNo, itemRefId) : '';
    const erpDrawing = erpSnap?.broj_crteza ? String(erpSnap.broj_crteza).trim() : '';
    const finalDrawing = (erpDrawing || drawingNo || cachedDrawing || '').trim();
    $('#locScanDrawing').value = finalDrawing;

    const hint = $('#locScanParsed');
    if (rawHint && (orderNo || itemRefId)) {
      hint.hidden = false;
      const fmtBadge =
        format === 'rnz' ? 'RNZ' : format === 'short' ? 'legacy' : format === 'ocr' ? 'OCR' : '';
      const badgeHtml = fmtBadge
        ? `<span class="loc-scan-parsed-badge">${escHtml(fmtBadge)}</span> `
        : '';
      let drawingPart = '';
      if (finalDrawing) {
        if (erpDrawing && finalDrawing === erpDrawing) {
          drawingPart = `, crtež <strong>${escHtml(erpDrawing)}</strong> <em class="loc-muted">(iz plana / BigTehn)</em>`;
        } else if (cachedDrawing && finalDrawing === cachedDrawing) {
          drawingPart = `, crtež <strong>${escHtml(cachedDrawing)}</strong> <em class="loc-muted">(iz keša)</em>`;
        } else {
          drawingPart = `, crtež <strong>${escHtml(finalDrawing)}</strong>`;
        }
      } else {
        drawingPart = ' <em class="loc-muted">(upiši broj crteža sa teksta nalepnice)</em>';
      }

      let erpExtra = '';
      if (erpSnap) {
        const nd = erpSnap.naziv_dela ? escHtml(String(erpSnap.naziv_dela)) : '';
        const kt = erpSnap.komada_total != null ? escHtml(String(erpSnap.komada_total)) : '';
        const kd = erpSnap.komada_done != null ? escHtml(String(erpSnap.komada_done)) : '';
        const mat = erpSnap.materijal ? escHtml(String(erpSnap.materijal)) : '';
        const cust = erpSnap.customer_short || erpSnap.customer_name;
        const custH = cust ? escHtml(String(cust)) : '';
        const parts = [];
        if (nd) parts.push(`deo: ${nd}`);
        if (kt) parts.push(`kom. ukupno: ${kt}${kd !== '' ? ` (urađeno ${kd})` : ''}`);
        if (mat) parts.push(`mat.: ${mat}`);
        if (custH) parts.push(`kupac: ${custH}`);
        if (parts.length) {
          erpExtra = `<div class="loc-muted" style="margin-top:6px;font-size:12px;line-height:1.35">${parts.join(' · ')}</div>`;
        }
      }

      /* Dijagnostička linija — UVEK vidljiva za RNZ skeniranja. Pokazuje:
       *   - verziju aplikacije (`__APP_VERSION__` iz Vite build-a) → user vidi
       *     odmah da li je PWA skinuo novi JS ili i dalje vrti stari cache;
       *   - status ERP lookup-a (cache nađen / nije / offline / greška);
       *   - dugme "Osveži app" ako je status NOT_FOUND ili ERROR — jedan klik
       *     deregistruje service worker + briše caches + reload. Neophodno kad
       *     magacioner vidi stari autofill flow. */
      let diagHtml = '';
      if (format === 'rnz' || format === 'ocr' || format === 'short') {
        const statusTxt =
          erpLookupStatus === 'ok'
            ? '✔ nađen u BigTehn cache-u'
            : erpLookupStatus === 'not_found'
              ? '✖ nema u BigTehn cache-u'
              : erpLookupStatus === 'offline'
                ? '⚠ offline — ne mogu da proverim'
                : erpLookupStatus === 'error'
                  ? `⚠ greška: ${escHtml(erpLookupErr || 'nepoznata')}`
                  : '—';
        const needsReload = erpLookupStatus === 'not_found' || erpLookupStatus === 'error';
        const btnHtml = needsReload
          ? ` <button type="button" class="loc-scan-btn-reload" data-act="reloadApp">🔄 Osveži app</button>`
          : '';
        diagHtml =
          `<div class="loc-scan-diag loc-muted" style="margin-top:6px;font-size:11px;line-height:1.4">` +
          `<span>app v${escHtml(APP_VERSION)}</span> · ` +
          `<span>ERP cache: ${statusTxt}</span>` +
          btnHtml +
          `</div>`;
      }

      hint.innerHTML =
        `${badgeHtml}<span class="loc-scan-parsed-raw">Skenirano: <strong>${escHtml(rawHint)}</strong></span> ` +
        `<span class="loc-muted">→ nalog <strong>${escHtml(orderNo)}</strong>, TP <strong>${escHtml(itemRefId)}</strong>${drawingPart}</span>${erpExtra}${diagHtml}`;
    } else {
      hint.hidden = true;
      hint.innerHTML = '';
    }

    /* Čekaj fetch lokacija pre „Na lokaciju“ — na iOS sporijoj mreži inače
     * populateToSelect vidi prazan state.locs i ostane samo placeholder. */
    await locsReady;
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

    /* Ako nema postojećih placement-a, predloži količinu iz ERP-a (preostalo za TP). */
    const snap = state.erpSnapshot;
    if (snap && state.currentPlacements.length === 0) {
      const total = Number(snap.komada_total);
      const done = Number(snap.komada_done ?? 0);
      if (Number.isFinite(total) && total > 0) {
        const remaining = Math.max(0, total - (Number.isFinite(done) ? done : 0));
        const q = remaining > 0 ? remaining : total;
        const qtyEl = /** @type {HTMLInputElement|null} */ ($('#locScanQty'));
        if (qtyEl) qtyEl.value = String(q);
      }
    }
  }

  async function submit() {
    const err = $('#locScanErr');
    err.textContent = '';
    const item_ref_id = $('#locScanItemId').value.trim();
    const order_no = $('#locScanOrder').value.trim();
    const drawing_no = $('#locScanDrawing').value.trim();
    const to_location_id = $('#locScanTo').value;
    const from_location_id = $('#locScanFrom').value || '';
    const qty = Number($('#locScanQty').value);
    const note_raw = $('#locScanNote').value.trim();
    /* INITIAL = nema nijednog placement-a za (TP, nalog) par. */
    const isInitial = state.currentPlacements.length === 0;

    if (!item_ref_id) {
      err.textContent = 'Broj TP (sa barkoda) je obavezan.';
      return;
    }
    if (!order_no) {
      err.textContent = 'Broj naloga je obavezan.';
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
    if (btn) btn.disabled = true;

    /* Od v4 migracije `drawing_no` je prvoklasna kolona u movement/placement
     * tabeli (trigger je propagira, RPC prihvata). Ipak, i dalje dupliramo
     * "Crtež:NNN" prefix u `note` da bi legacy trigger-i i istorijske vizu-
     * elizacije (badge "📐 crtež X" u movement-ima) radili bez dodatnih
     * promena. Parsing iz note je idempotentan (trigger backfilluje prazne). */
    const noteParts = [];
    if (drawing_no) noteParts.push(`Crtež:${drawing_no}`);
    if (note_raw) noteParts.push(note_raw);
    const note = noteParts.join(' | ');

    /* Keširaj (order_no, item_ref_id) → drawing_no za sledeći skenir iste
     * nalepnice. Cache živi u localStorage, deli se između skener-a i
     * manual flow-a. Pogoni autofill u `showForm`. */
    if (drawing_no && order_no && item_ref_id) {
      setDrawingCache(order_no, item_ref_id, drawing_no);
    }

    const payload = {
      item_ref_table: state.item_ref_table,
      item_ref_id,
      order_no,
      drawing_no: drawing_no || undefined,
      to_location_id,
      from_location_id: from_location_id || undefined,
      movement_type: isInitial ? 'INITIAL_PLACEMENT' : 'TRANSFER',
      quantity: qty,
      note: note || undefined,
    };

    /* Offline fallback: ako telefon nije na WiFi-ju, gurni u queue
     * (services/offlineQueue.js) i obavesti radnika. Kad se signal vrati
     * auto-flush će pokušati da pošalje. */
    try {
      if (!navigator.onLine) {
        try {
          enqueueMovement(payload);
          if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
          showToast('📥 Offline — zapis sačuvan i poslaće se kad se vrati signal');
          close({ bySuccess: true });
          onSuccess?.();
        } catch (e) {
          err.textContent = `Ne mogu da zapišem u lokalni queue: ${e?.message || e}`;
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
        if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
        showToast('📥 Mreža pala — zapis sačuvan u queue');
        close({ bySuccess: true });
        onSuccess?.();
        return;
      }

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
    } catch (e) {
      console.error('[scan] submit exception', e);
      err.textContent =
        e?.name === 'TypeError'
          ? 'Greška u prikazu forme — osveži stranicu i probaj ponovo.'
          : `Greška: ${e?.message || String(e)}`;
    } finally {
      if (btn) btn.disabled = false;
    }
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
      missing_fields: 'Nedostaju obavezni podaci (lokacija, stavka ili tip). Osveži listu lokacija pa probaj ponovo.',
      bad_to_uuid: 'Odredišna lokacija nije validna — izaberi ponovo iz liste.',
      bad_from_uuid: 'Polazna lokacija nije validna — izaberi ponovo.',
      from_mismatch: 'Polazna lokacija ne odgovara trenutnom smeštaju stavke.',
      bad_movement_type: 'Neispravan tip pokreta.',
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
      case 'ocrScan':
        await applyOcrFromVideo();
        break;
      case 'back':
      case 'rescan':
        startScanner();
        break;
      case 'submit':
        await submit();
        break;
      case 'reloadApp':
        /* Hard reset PWA cache-a — vidi forceAppReload() za redosled koraka.
         * Ovo rešava "stari autofill flow nakon novog deploy-a" bez da radnik
         * mora da deinstalira i ponovo doda app na home screen. */
        showToast('♻ Osvežavam aplikaciju…');
        try {
          await forceAppReload();
        } catch (e) {
          console.warn('[scan] force reload failed', e);
          window.location.reload();
        }
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
        try {
          await showForm(parsed || clean);
        } catch (e) {
          console.error('[scan] showForm failed (file)', e);
        }
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
  const locsReady = (async () => {
    const locs = await fetchLocations();
    state.locs = Array.isArray(locs) ? locs : [];
    state.locById = new Map(state.locs.map(l => [l.id, l]));
    /* Uvek osveži odredišta kad stigne lista (showForm može biti ranije). */
    populateToSelect();
  })();

  /* Prefill flow: preskoči scan stage i odmah popuni formu poznatim poljima.
   * Koristi se iz /m/lookup kartice "Premesti odavde" — radnik već zna crtež,
   * nalog i trenutnu policu pa ga ne teramo da ponovo skenira. */
  if (prefill && (prefill.itemRefId || prefill.orderNo || prefill.drawingNo)) {
    if (prefill.itemRefTable) state.item_ref_table = prefill.itemRefTable;
    /* Čekamo locsReady pre showForm-a jer showForm → refreshPlacements →
     * populateFromSelect koristi state.locById za labele. Bez toga from-select
     * bi se na trenutak prikazao sa golim UUID-evima. */
    locsReady.then(() => {
      showForm({
        itemRefId: prefill.itemRefId || '',
        orderNo: prefill.orderNo || '',
        drawingNo: prefill.drawingNo || '',
        raw: '',
        format: '',
      }).then(() => {
        if (prefill.fromLocationId) {
          const fromEl = /** @type {HTMLSelectElement} */ ($('#locScanFrom'));
          if (fromEl) fromEl.value = prefill.fromLocationId;
        }
        setTimeout(() => $('#locScanTo')?.focus(), 80);
      });
    });
  } else if (startMode === 'manual') {
    /* Preskoči kamera stage — prikaži formu praznu, fokus na polje `Broj naloga`.
     * Korisno za telefone bez kamere ili kada nalepnica fali. */
    await showForm('');
    setTimeout(() => $('#locScanOrder')?.focus(), 60);
  } else {
    startScanner();
  }
}
