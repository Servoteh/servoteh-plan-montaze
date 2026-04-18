/**
 * Date utility — bit-paritetan port iz legacy/index.html.
 *
 * KRUCIJALNO: `new Date('YYYY-MM-DD')` parsira kao UTC ponoć i zatim
 * pomera za TZ offset kada se čita lokalnim getterima → "ofset za 1 dan".
 * SVA matematika i prikaz datuma MORA da prolazi kroz parseDateLocal()
 * kako bi "dan koji je korisnik izabrao" == "dan koji se prikazuje".
 *
 * Globalna `today` referenca je takođe lokalna ponoć (ne UTC).
 */

export const today = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
})();

export function parseDateLocal(s) {
  if (!s) return null;
  if (s instanceof Date) {
    if (isNaN(s)) return null;
    return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  }
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(s);
  if (isNaN(d)) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function formatYMD(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function dateToYMD(dt) {
  if (!(dt instanceof Date) || isNaN(dt)) return null;
  return formatYMD(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

export function formatDate(d) {
  const dt = parseDateLocal(d);
  if (!dt) return '';
  return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}`;
}

export function toIsoDate(d) {
  const dt = parseDateLocal(d);
  return dt ? dateToYMD(dt) : null;
}

/** Inkluzivna razlika u danima; -1 ako je end < start. */
export function calcDuration(s, e) {
  const a = parseDateLocal(s);
  const b = parseDateLocal(e);
  if (!a || !b) return null;
  const d = Math.round((b - a) / 864e5);
  return d < 0 ? -1 : d + 1;
}

/** Razlika danas vs. zadati datum (negativno = u prošlosti, pozitivno = u budućnosti). */
export function dayDiffFromToday(s) {
  const d = parseDateLocal(s);
  if (!d) return null;
  return Math.round((d - today) / 864e5);
}

/** Inkluzivni broj dana od fromStr do toStr. Vraća 0 ako je nevalidno. */
export function daysInclusive(fromStr, toStr) {
  const a = parseDateLocal(fromStr);
  const b = parseDateLocal(toStr);
  if (!a || !b) return 0;
  const diff = Math.round((b - a) / 864e5) + 1;
  return diff > 0 ? diff : 0;
}

export function isWeekend(dt) {
  if (!(dt instanceof Date)) return false;
  const dow = dt.getDay();
  return dow === 0 || dow === 6;
}

export function ymdAddDays(ymd, days) {
  const d = parseDateLocal(ymd);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  return dateToYMD(d);
}
