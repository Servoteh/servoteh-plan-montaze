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
 * @param {{ onResult: (text: string, format?: string) => void, onError?: (err: Error) => void }} handlers
 * @returns {Promise<ScanController>}
 */
export async function startScan(videoEl, { onResult, onError }) {
  if (!videoEl) throw new Error('Video element is required.');
  if (typeof onResult !== 'function') throw new Error('onResult handler is required.');
  if (!isScanSupported()) {
    const e = new Error('Kamera/MediaDevices nije podržana u ovom pregledaču.');
    onError?.(e);
    throw e;
  }

  const reader = new BrowserMultiFormatReader();

  /* ZXing baca `NotFoundException` za svaki frame u kom nema barkoda —
   * to NIJE greška, ignorišemo je. Svi ostali error-i idu u onError. */
  const controls = await reader.decodeFromConstraints(
    {
      video: {
        facingMode: { ideal: 'environment' },
        /* blagi "zoom" da kameri pomognemo: Code128 treba dovoljno piksela */
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    },
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

/**
 * Normalizacija sadržaja barkoda u `item_ref_id` koji aplikacija razume.
 *
 * BigTehn nalepnice mogu u barkod da enkodiraju "Broj predmeta" (npr.
 * `9000/260`) ili "Broj crteža" (npr. `1084924`) ili kombinovani string.
 * Ova funkcija:
 *   - trim-uje whitespace
 *   - skida CR/LF (često dolaze na kraju Code39/128)
 *   - uklanja očigledne kontrolne prefixe tipa `AI_SCAN:` ili `*` (Code39
 *     start/stop karakter)
 *
 * Ako format ispadne složeniji (npr. SSCC sa prefiksima ili multi-AI GS1),
 * proširujemo ovde.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeBarcodeText(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.replace(/[\r\n\t]+/g, '').trim();
  /* Code39 uvek encode-uje `*TEXT*` — čitači obično to skidaju, ali za svaki slučaj. */
  if (t.startsWith('*') && t.endsWith('*') && t.length >= 3) {
    t = t.slice(1, -1);
  }
  return t;
}
