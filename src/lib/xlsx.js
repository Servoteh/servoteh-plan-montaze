/**
 * SheetJS (xlsx) lazy loader preko CDN-a.
 *
 * Razlog: xlsx npm paket je ~600 kB i bi nepotrebno naduvao Vite bundle za
 * korisnike koji ne koriste export. CDN load na zahtev — prvi `loadXlsx()` poziv
 * doda <script> tag i čeka `window.XLSX` da se pojavi, ostali pozivi
 * vraćaju cached promise.
 *
 * Verzija je pinned (0.20.x) da bi build bio reproducibilan.
 */

const XLSX_CDN = 'https://cdn.jsdelivr.net/npm/xlsx@0.20.3/dist/xlsx.full.min.js';

let _promise = null;

/** @returns {Promise<typeof window.XLSX>} */
export function loadXlsx() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('XLSX dostupan samo u browser kontekstu'));
  }
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_promise) return _promise;

  _promise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_CDN;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => {
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error('XLSX nije dostupan ni nakon load-a'));
    };
    s.onerror = () => {
      _promise = null;
      reject(new Error('Nije moguće učitati XLSX biblioteku sa ' + XLSX_CDN));
    };
    document.head.appendChild(s);
  });

  return _promise;
}
