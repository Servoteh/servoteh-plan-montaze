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

export { normalizeBarcodeText, parseBigTehnBarcode } from '../lib/barcodeParse.js';

/**
 * @typedef {object} ScanController
 * @property {() => void} stop
 * @property {() => Promise<boolean>} toggleTorch
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

  const reader = new BrowserMultiFormatReader();

  /* Constraint izbor:
   *   - `forceDeviceId` → eksplicitni deviceId (iOS fallback path).
   *   - Inače → `facingMode` sa prvo `exact` pokušajem, pa ako failure
   *     i Safari nema back kameru po toj konvenciji, `ideal` kao safety-net.
   * Na kraju, ako sve padne, bacamo originalnu grešku gore.
   */
  let constraints;
  if (forceDeviceId) {
    constraints = {
      video: {
        deviceId: { exact: forceDeviceId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
  } else {
    constraints = {
      video: {
        /* iOS Safari u CrOS i nekad u običnom tabu ignoriše `ideal` —
         * `exact` je striktnije, ali baca `OverconstrainedError` na iPad-ovima
         * sa jednom kamerom. Pa prvo `ideal`, a scanModal.js detektuje front
         * output i restart-uje sa `forceDeviceId`. */
        facingMode: { ideal: 'environment' },
        /* blagi "zoom" da kameri pomognemo: Code128 treba dovoljno piksela */
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
  }

  /* ZXing baca `NotFoundException` za svaki frame u kom nema barkoda —
   * to NIJE greška, ignorišemo je. Svi ostali error-i idu u onError. */
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
      const stream = videoEl.srcObject;
      if (!(stream instanceof MediaStream)) return false;
      const track = stream.getVideoTracks()[0];
      if (!track) return false;
      const caps = track.getCapabilities?.();
      if (!caps || !('torch' in caps)) return false;
      const settings = track.getSettings?.() || {};
      const next = !settings.torch;
      try {
        await track.applyConstraints({ advanced: [{ torch: next }] });
        return next;
      } catch (e) {
        console.warn('[barcode] torch toggle failed', e);
        return false;
      }
    },
  };
}

/* `normalizeBarcodeText` i `parseBigTehnBarcode` su izvojeni u
 * `src/lib/barcodeParse.js` da bi bili testabilni bez ZXing runtime-a. */
