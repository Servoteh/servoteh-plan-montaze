/**
 * Pure helper-i za barcode tekst — bez kamera/ZXing zavisnosti.
 * Razlog izdvajanja: `src/services/barcode.js` importuje `@zxing/browser` na
 * top-level, što je skup (~250KB gzip). Parsing logiku testiramo odvojeno
 * u Vitest-u bez jsdom/DOM stub-ova.
 */

/**
 * Očisti sirov tekst barkoda u `item_ref_id` kandidat:
 *   - trim whitespace
 *   - skini CR/LF/TAB (često dolaze na kraju Code39/128)
 *   - skini Code39 `*...*` delimitere (ako čitač nije sam)
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeBarcodeText(raw) {
  if (typeof raw !== 'string') return '';
  let t = raw.replace(/[\r\n\t]+/g, '').trim();
  if (t.startsWith('*') && t.endsWith('*') && t.length >= 3) {
    t = t.slice(1, -1);
  }
  return t;
}

/**
 * Parsiraj BigTehn barkod u strukturu `{ orderNo, drawingNo, raw }`.
 *
 * Potvrđeni format (potvrđen sa realne nalepnice):
 *   `9000/1091063`  →  nalog `9000`, crtež `1091063`
 *   `9000/260`      →  nalog `9000`, crtež `260`
 *
 * Dozvoljavamo varijacije (whitespace, razdvajač `\` / `-` / `_` / razmak),
 * jer neki čitači zamenjuju `/` keyboard layout-om na nekim uređajima.
 *
 * **Zašto crtež postaje `item_ref_id`, a ne kombinacija:**
 *   Isti broj crteža može biti na više radnih naloga (50 komada ukupno,
 *   raspoređenih po nekoliko naloga). Tracking količine ima smisla po
 *   crtežu — broj naloga je samo meta podatak koji ide u `notes`.
 *
 * @param {string} raw
 * @returns {{ orderNo: string, drawingNo: string, raw: string } | null}
 *   vraća null ako format nije `NALOG/CRTEŽ`.
 */
export function parseBigTehnBarcode(raw) {
  const clean = normalizeBarcodeText(raw);
  if (!clean) return null;
  const m = clean.match(/^(\d{1,8})\s*[/\\\-_ ]\s*(\d{1,10})$/);
  if (!m) return null;
  const [, orderNo, drawingNo] = m;
  return { orderNo, drawingNo, raw: clean };
}
