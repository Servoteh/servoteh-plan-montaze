/**
 * jsPDF + html2canvas lazy loader preko CDN-a.
 *
 * Razlog: oba paketa zajedno su >500 kB i koriste se samo za PDF export.
 * Ne želimo da budu deo glavnog Vite bundle-a. CDN load na zahtev — prvi
 * `loadPdfLibs()` poziv doda <script> tagove, ostali pozivi vraćaju cached
 * promise.
 *
 * Verzije pinned za reproducibilan build.
 */

const HTML2CANVAS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
const JSPDF_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';

let _promise = null;

/** @returns {Promise<{ jsPDF: typeof window.jspdf.jsPDF, html2canvas: typeof window.html2canvas }>} */
export function loadPdfLibs() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('PDF biblioteke su dostupne samo u browser kontekstu'));
  }
  if (window.jspdf && window.html2canvas) {
    return Promise.resolve({ jsPDF: window.jspdf.jsPDF, html2canvas: window.html2canvas });
  }
  if (_promise) return _promise;

  _promise = Promise.all([
    _loadScript(HTML2CANVAS_CDN),
    _loadScript(JSPDF_CDN),
  ]).then(() => {
    if (!window.jspdf || !window.html2canvas) {
      _promise = null;
      throw new Error('PDF biblioteke nisu dostupne ni nakon load-a');
    }
    return { jsPDF: window.jspdf.jsPDF, html2canvas: window.html2canvas };
  }).catch(e => {
    _promise = null;
    throw e;
  });

  return _promise;
}

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Script load fail: ' + src)));
      }
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = () => reject(new Error('Nije moguće učitati ' + src));
    document.head.appendChild(s);
  });
}
