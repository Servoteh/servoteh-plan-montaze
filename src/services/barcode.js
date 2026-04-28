/**
 * Barcode skeniranje preko kamere (Android Chrome + iOS Safari + desktop).
 *
 * Koristi `@zxing/browser` jer je to jedini pristup koji uniformno radi u
 * iOS Safariju (gde nema native `BarcodeDetector` API). Android Chrome i
 * desktop takođe prolaze kroz istu biblioteku — jednostavnije nego da
 * održavamo dva koda.
 *
 * Usage:
 *   const ctrl = await startScan(videoEl, {
 *     onResult: (text) => { ... },
 *     onError: (err) => { ... }
 *   });
 *   // kasnije:
 *   ctrl.stop();
 */

import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

export { normalizeBarcodeText, parseBigTehnBarcode } from '../lib/barcodeParse.js';

/**
 * ZXing decode hints koje značajno poboljšavaju uspešnost na malim/
 * blurry barkodovima (BigTehn Code128 na A4 nalepnicama).
 *
 *   - POSSIBLE_FORMATS: ograničavamo ZXing da ne proba 14+ formata za svaki
 *     frame. Code128 je BigTehn standard; Code39 rezerva; QR ako neko kasnije
 *     stampa QR; EAN fallback. Ovo samo po sebi ~2× ubrzava dekodiranje.
 *   - TRY_HARDER: ZXing ulaže više CPU-a po frame-u (rotira, skaluje, probava
 *     više binarizacija). Na iPhone 11+ to znači samo +5-10ms po frame-u, a
 *     uspešnost na manjim/blurry kodovima skače znatno.
 *   - ASSUME_GS1: ne koristimo GS1 format, isključujemo ga eksplicitno da
 *     ZXing ne trati ciklus na tom grani.
 */
const SCAN_HINTS = new Map();
SCAN_HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
]);
SCAN_HINTS.set(DecodeHintType.TRY_HARDER, true);

/**
 * @typedef {object} ScanController
 * @property {() => void} stop
 * @property {() => Promise<boolean>} toggleTorch
 * @property {() => Promise<ZoomCapability|null>} getZoom
 * @property {(value: number) => Promise<boolean>} setZoom
 * @property {(x:number,y:number) => Promise<boolean>} tapFocus
 */

/**
 * @typedef {object} ZoomCapability
 * @property {number} min
 * @property {number} max
 * @property {number} step
 * @property {number} current
 */

/**
 * Proveri da li je trenutni browser sposoban za skeniranje.
 * @returns {boolean}
 */
export function isScanSupported() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined'
  );
}

/**
 * Android (Chrome, Samsung Internet, Firefox, WebView): torch i kontinuirani
 * zoom preko `applyConstraints` retko rade pouzdano na stražnjoj kameri — UI
 * ih ne prikazujemo da korisnik ne misli da je „pokvareno“.
 *
 * Pored `User-Agent` sa "Android", uključuje i **Desktop site** režim gde UA
 * često nema "Android", ali `navigator.userAgentData` i dalje javlja mobilni
 * Android (brands).
 */
export function isAndroidWebCameraTorchZoomHidden() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return true;
  try {
    const uad = /** @type {{ mobile?: boolean, brands?: { brand?: string }[] }} */ (
      /** @type {unknown} */ (navigator).userAgentData
    );
    if (uad && uad.mobile === true && Array.isArray(uad.brands)) {
      const brands = uad.brands.map(b => String(b.brand || '')).join(' ');
      if (/Android/i.test(brands)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Mobilni / tablet: niži ideal (1280×720) → brži `getUserMedia` i `video.play`
 * nego 1080p; i dalje dovoljno za Code128 na nalepnici. Desktop zadržava 1080p.
 * @returns {boolean}
 */
function prefersFastCameraConstraints() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return true;
  } catch {
    /* ignore */
  }
  if (isAndroidWebCameraTorchZoomHidden()) return true;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (/iPhone|iPod|iPad/i.test(ua)) return true;
  if (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    return true;
  }
  return false;
}

/** @zxing/browser podrazumevano 500 ms između NotFound pokušaja — previše spor „osećaj“. */
const ZXING_READER_OPTIONS = {
  delayBetweenScanAttempts: 80,
  delayBetweenScanSuccess: 280,
  tryPlayVideoTimeout: 5000,
};

/**
 * Pokreni kontinualno skeniranje. Callback `onResult` se poziva sa SVAKIM
 * validnim dekodiranjem; obično ga zaustavljaš (ctrl.stop()) čim dobiješ
 * prvi hit, ali ostavljamo klijentu da odluči (npr. double-read).
 *
 * @param {HTMLVideoElement} videoEl
 * @param {{
 *   onResult: (text: string, format?: string) => void,
 *   onError?: (err: Error) => void,
 *   forceDeviceId?: string,
 * }} handlers
 *   - `forceDeviceId` — zaobilazi facingMode logiku i bira tačno zadatu
 *     kameru. Koristi se kao iOS Safari fallback kada `ideal: environment`
 *     vrati front kameru (poznat WebKit bug).
 * @returns {Promise<ScanController>}
 */
export async function startScan(videoEl, { onResult, onError, forceDeviceId }) {
  if (!videoEl) throw new Error('Video element is required.');
  if (typeof onResult !== 'function') throw new Error('onResult handler is required.');
  if (!isScanSupported()) {
    const e = new Error('Kamera/MediaDevices nije podržana u ovom pregledaču.');
    onError?.(e);
    throw e;
  }

  /* Hints-aware reader → značajno brži i pouzdaniji za BigTehn Code128. */
  const reader = new BrowserMultiFormatReader(SCAN_HINTS, ZXING_READER_OPTIONS);

  const isAndroid = isAndroidWebCameraTorchZoomHidden();

  /* Constraint izbor:
   *   - `forceDeviceId` → eksplicitni deviceId (iOS fallback path).
   *   - Inače → `facingMode: ideal`; scanModal.js detektuje front output i
   *     restart-uje sa `forceDeviceId`.
   *
   * Rezolucija: na telefonu/tabletu 1280×720 (brži start kamere od 1080p);
   * desktop 1920×1080 za više px/mm na sitnim kodovima.
   */
  const videoBase = prefersFastCameraConstraints()
    ? {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      }
    : {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      };
  const constraints = forceDeviceId
    ? { video: { ...videoBase, deviceId: { exact: forceDeviceId } } }
    : { video: { ...videoBase, facingMode: { ideal: 'environment' } } };

  /* ZXing baca `NotFoundException` za svaki frame u kom nema barkoda —
   * to NIJE greška, ignorišemo je. Svi ostali error-i idu u onError. */
  /**
   * Primeni torch/zoom na video track.
   * - Android (Chrome/Samsung/FF): često **samo** `advanced: [{ … }]` radi;
   *   probamo advanced prvo, pa ravan objekat.
   * - iOS/desktop: prvo ravan constraint (Firefox desktop), pa advanced.
   * @param {MediaStreamTrack} track
   * @param {Record<string, unknown>} flat npr. `{ torch: true }` ili `{ zoom: 2 }`
   * @returns {Promise<boolean>}
   */
  async function applyVideoConstraintCompat(track, flat) {
    if (!track?.applyConstraints) return false;
    const attempts = isAndroid
      ? [
          () => track.applyConstraints({ advanced: [flat] }),
          () => track.applyConstraints(flat),
        ]
      : [
          () => track.applyConstraints(flat),
          () => track.applyConstraints({ advanced: [flat] }),
        ];
    /** @type {unknown} */
    let lastErr;
    for (const run of attempts) {
      try {
        await run();
        return true;
      } catch (e) {
        lastErr = e;
      }
    }
    console.warn('[barcode] applyVideoConstraintCompat failed', flat, lastErr);
    return false;
  }

  const controls = await reader.decodeFromConstraints(
    constraints,
    videoEl,
    (result, err) => {
      if (result) {
        try {
          onResult(result.getText(), result.getBarcodeFormat?.().toString());
        } catch (e) {
          onError?.(e);
        }
      } else if (err && err.name && err.name !== 'NotFoundException') {
        /* Ne logujemo "not found" — to je normalno ponašanje izmedju frame-ova. */
        onError?.(err);
      }
    },
  );

  /** Uzmi aktivni videoTrack ili `null`. */
  function getTrack() {
    const stream = /** @type {MediaStream|null} */ (videoEl.srcObject);
    if (!(stream instanceof MediaStream)) return null;
    return stream.getVideoTracks()[0] || null;
  }

  return {
    stop: () => {
      try {
        controls.stop();
      } catch (e) {
        console.warn('[barcode] stop failed', e);
      }
    },
    /**
     * Pokušaj da uključiš/isključiš flash (torch). Mnogi desktop browseri i
     * stariji iOS ne podržavaju — vraćamo false u tom slučaju.
     * @returns {Promise<boolean>} novo stanje torcha; false ako torch nije dostupan.
     */
    toggleTorch: async () => {
      const track = getTrack();
      if (!track) return false;
      const caps = track.getCapabilities?.() || {};
      const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
      if (isAndroidWebCameraTorchZoomHidden()) return false;
      const torchAdvertised = 'torch' in caps || supported.torch === true;
      if (!torchAdvertised) return false;
      const settings = track.getSettings?.() || {};
      const next = !settings.torch;
      const ok = await applyVideoConstraintCompat(track, { torch: next });
      return ok ? next : false;
    },

    /**
     * Dohvati trenutne zoom capabilities kamere. `null` ako kamera ili
     * browser ne podržavaju zoom API (većina desktop webcam-a, iOS < 17.2).
     *
     * iOS Safari 17.2+ podržava ovo na iPhone 11+ i svim iPad-ovima sa
     * dual/triple kamerom. U CapabilitiesRecord-u `zoom` daje opseg
     * {min, max, step} — na iPhone-u je tipično 1.0-5.0 (ili do 15.0
     * ako ima telephoto lens).
     *
     * @returns {Promise<ZoomCapability|null>}
     */
    getZoom: async () => {
      const track = getTrack();
      if (!track) return null;
      if (isAndroidWebCameraTorchZoomHidden()) return null;
      const caps = track.getCapabilities?.() || {};
      const s = track.getSettings?.() || {};
      const zRaw = caps.zoom;
      if (zRaw != null && typeof zRaw === 'object' && !Array.isArray(zRaw)) {
        const z = /** @type {any} */ (zRaw);
        return {
          min: Number(z.min ?? 1),
          max: Number(z.max ?? 1),
          step: Number(z.step ?? 0.1),
          current: Number(s.zoom ?? z.min ?? 1),
        };
      }
      return null;
    },

    /**
     * Postavi zoom level. Value mora biti između min i max iz getZoom.
     * Na iOS Safari-ju se vrednost primenjuje glatko (hardware zoom); na
     * Android Chrome-u često sa latencijom 200-400ms.
     *
     * @param {number} value
     * @returns {Promise<boolean>} true ako je uspešno primenjeno.
     */
    setZoom: async value => {
      if (isAndroidWebCameraTorchZoomHidden()) return false;
      const track = getTrack();
      if (!track) return false;
      return applyVideoConstraintCompat(track, { zoom: value });
    },

    /**
     * Tap-to-focus preko `pointsOfInterest` + `focusMode: single-shot`.
     * Safari od 17.2 podržava; Android Chrome većim delom od 2023.
     * `x`, `y` su normalizovani [0, 1] unutar video elementa.
     *
     * @param {number} x
     * @param {number} y
     * @returns {Promise<boolean>}
     */
    tapFocus: async (x, y) => {
      const track = getTrack();
      if (!track) return false;
      const caps = track.getCapabilities?.() || {};
      try {
        /** @type {any} */
        const adv = {};
        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('single-shot')) {
          adv.focusMode = 'single-shot';
        }
        if ('pointsOfInterest' in caps) {
          adv.pointsOfInterest = [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }];
        }
        if (!Object.keys(adv).length) return false;
        await track.applyConstraints({ advanced: [adv] });
        return true;
      } catch (e) {
        console.warn('[barcode] tapFocus failed', e);
        return false;
      }
    },
  };
}

/* `normalizeBarcodeText` i `parseBigTehnBarcode` su izvojeni u
 * `src/lib/barcodeParse.js` da bi bili testabilni bez ZXing runtime-a. */

/**
 * Dekoduj barkod iz unapred izabrane slike (iz Photos / Files / Viber).
 * Korisno kada:
 *   - radnik ima fotografiju nalepnice na telefonu (nije ispred nje);
 *   - live kamera pati od moire-a / refleksije / fokusa;
 *   - prošle nalepnice sa oštećenog komada su dokumentovane slikom.
 *
 * ZXing `decodeFromImageElement` radi nad nativnim `HTMLImageElement`-om —
 * ne treba WebRTC kamera, radi čak i na uređajima koji odbijaju
 * getUserMedia. Takođe značajno pouzdanije od live feed-a jer slika
 * ne trepeće — ZXing radi TRY_HARDER na punoj rezoluciji koliko god
 * je dugo potrebno.
 *
 * @param {File|Blob} file Slika iz `<input type="file">`, drag-drop, ili clipboard.
 * @returns {Promise<{ text: string, format?: string } | { error: 'not_image' | 'no_barcode' | 'decode_failed', cause?: any }>}
 */
export async function decodeBarcodeFromFile(file) {
  if (!file || !(file instanceof Blob)) return { error: 'not_image' };
  if (!/^image\//.test(file.type || '')) return { error: 'not_image' };

  /* Kreiraj <img> iz File blob-a preko ObjectURL — 10× efikasnije od
   * FileReader.readAsDataURL (koji base64 encode-uje u memoriji). */
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const reader = new BrowserMultiFormatReader(SCAN_HINTS);
    try {
      const result = await reader.decodeFromImageElement(img);
      return { text: result.getText(), format: result.getBarcodeFormat?.().toString() };
    } catch (e) {
      /* ZXing baca `NotFoundException` kada ne vidi barkod — tretira se
       * kao "nije pronađen" a ne kao error. */
      if (e?.name === 'NotFoundException') return { error: 'no_barcode' };
      return { error: 'decode_failed', cause: e };
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** @param {string} url */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
