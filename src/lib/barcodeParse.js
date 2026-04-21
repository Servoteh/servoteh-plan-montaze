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
 * @typedef {object} ParsedBarcode
 * @property {string} orderNo Broj radnog naloga (npr. "7351").
 * @property {string} itemRefId Kompozitni ili prost identifikator stavke
 *   koji ide u `loc_item_placements.item_ref_id`:
 *     - RNZ format → broj tehnološkog postupka (TP, npr. "1088");
 *     - short format → broj crteža (legacy, npr. "1091063").
 * @property {string} drawingNo Broj crteža ako je u barkodu (short format);
 *   u RNZ formatu je prazno jer barkod ne sadrži crtež — čita se sa teksta
 *   nalepnice ili se auto-popunjava iz prethodnih placement-a.
 * @property {'rnz'|'short'} format Koji je format prepoznat.
 * @property {string} raw Originalni očišćeni tekst.
 */

/**
 * Parsiraj BigTehn barkod iz jednog od dva potvrđena formata.
 *
 * **Format A — RNZ (trenutno u produkciji):**
 *   `RNZ:8693:7351/1088:0:39757`
 *     - `RNZ`          prefix (konstantan)
 *     - `8693`         interni BigTehn ID — ignorišemo
 *     - `7351/1088`    **broj naloga / broj TP** ← koristimo
 *     - `0:39757`      interni separatori/ID-ovi — ignorišemo
 *
 *   U ovom formatu broj crteža NIJE u barkodu — samo na štampanom tekstu
 *   nalepnice. Parser vraća `drawingNo = ''`; UI ga auto-popunjava iz
 *   prethodnih placement-a za isti (order_no, item_ref_id) par, ili ga
 *   radnik prepisuje ručno sa teksta.
 *
 * **Format B — short (legacy, manje nalepnica):**
 *   `9000/1091063` → nalog `9000`, crtež `1091063`
 *
 * Oba formata vraćaju istu strukturu; polje `format` kaže koji je bio.
 *
 * @param {string} raw
 * @returns {ParsedBarcode | null}
 *   `null` ako ni jedan format ne odgovara.
 */
export function parseBigTehnBarcode(raw) {
  const clean = normalizeBarcodeText(raw);
  if (!clean) return null;

  /* RNZ format — isprobava se PRVI jer je stroža regex (mora da počne sa
   * RNZ:). Ako ne prolazi, fallback na short. */
  const rnz = clean.match(
    /^RNZ\s*[:|]\s*\d{1,10}\s*[:|]\s*(\d{1,8})\s*[/\\\-_ ]\s*(\d{1,8})\s*[:|]\s*\d+\s*[:|]\s*\d+\s*$/i,
  );
  if (rnz) {
    const [, orderNo, tpNo] = rnz;
    return {
      orderNo,
      itemRefId: tpNo,
      drawingNo: '',
      format: 'rnz',
      raw: clean,
    };
  }

  /* Short format — zadržavamo kao fallback za stare nalepnice ako ih
   * negde ima. Dozvoljavamo varijacije razdvajača (`/`, `\`, `-`, `_`,
   * razmak) jer neki čitači menjaju `/` keyboard layout-om. */
  const short = clean.match(/^(\d{1,8})\s*[/\\\-_ ]\s*(\d{1,10})$/);
  if (short) {
    const [, orderNo, drawingNo] = short;
    return {
      orderNo,
      itemRefId: drawingNo,
      drawingNo,
      format: 'short',
      raw: clean,
    };
  }

  return null;
}
