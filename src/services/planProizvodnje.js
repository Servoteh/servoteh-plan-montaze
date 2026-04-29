/**
 * Plan Proizvodnje — service sloj.
 *
 * Sve PostgREST queries za:
 *   - listu mašina (iz bigtehn_machines_cache)
 *   - listu otvorenih operacija po efektivnoj mašini (v_production_operations_effective;
 *     isključeni su RN-ovi sa završnom kontrolom 8.3 kucanom u BigTehn-u)
 *   - upsert overlay-a (sort, status, napomena, REASSIGN)
 *   - bulk reorder (drag-drop)
 *
 * Koristi sbReq() iz services/supabase.js — koji automatski hvata trenutni
 * JWT iz state/auth.js. Ako korisnik nema pravo iz can_edit_plan_proizvodnje()
 * (admin / pm / menadzment), RLS na production_overlays će odbiti write.
 */

import { sbReq, getSupabaseUrl, getSupabaseAnonKey } from './supabase.js';
import {
  canEditPlanProizvodnje,
  getCurrentUser,
  getIsOnline,
} from '../state/auth.js';
import {
  BIGTEHN_DRAWINGS_BUCKET,
  getBigtehnDrawingSignedUrl as _getBigtehnDrawingSignedUrlShared,
  parseSupabaseStorageSignResponse,
  absolutizeSupabaseStorageSignedPath,
} from './drawings.js';

const DRAWINGS_BUCKET = 'production-drawings';
/* BIGTEHN_DRAWINGS_BUCKET izvučen u services/drawings.js (shared sa Plan Montaže
 * → polje „Veza sa“). Re-export ispod radi backward-compat. */
export { BIGTEHN_DRAWINGS_BUCKET };

/* ── Konstante ── */

export const LOCAL_STATUSES = ['waiting', 'in_progress', 'blocked'];
/** Sledeći status u ciklusu klika na pill (NE uključuje 'completed' jer to
 *  dolazi iz BigTehn-a, ne pišemo ručno). */
export const STATUS_CYCLE_NEXT = {
  waiting:     'in_progress',
  in_progress: 'blocked',
  blocked:     'waiting',
};

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cmpNullableAsc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpTextAsc(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'sr', { numeric: true, sensitivity: 'base' });
}

/**
 * PostgREST: vrednosti sa tačkom (8.2, 3.10) u filteru `eq.` moraju biti pod navodnicima,
 * inače se `eq.8.2` tumači kao `eq.8` i rezultat je uvek prazan — „nema operacija” za sve mašine.
 */
function postgrestDoubleQuoted(val) {
  const s = String(val ?? '');
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * `sbReq` na grešku vraća `null` (HTTP, mreža, parsiranje). To se ne sme tretirati
 * kao prazan rezultat iz baze — inače UI prikazuje „nema operacija” umesto greške.
 */
function nonNullRows(data, context) {
  if (data === null) {
    const e = new Error(`Supabase čitanje nije uspelo (${context})`);
    e.code = 'SUPABASE_READ_FAILED';
    throw e;
  }
  if (!Array.isArray(data)) {
    const e = new Error(`Supabase odgovor nije JSON niz (${context})`);
    e.code = 'SUPABASE_UNEXPECTED_SHAPE';
    throw e;
  }
  return data;
}

/**
 * G2 dvonivoski sort:
 * 1) ručni redosled/pin (`shift_sort_order`) uvek ide pre auto-sorta,
 * 2) zatim DB bucket spremnosti/hitnosti,
 * 3) rok, BigTehn prioritet i stabilni RN/op tie-breakeri.
 */
export function sortProductionOperations(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice().sort((a, b) => {
    const aManual = numOrNull(a?.shift_sort_order);
    const bManual = numOrNull(b?.shift_sort_order);
    const manualCmp = cmpNullableAsc(aManual, bManual);
    if (manualCmp !== 0) return manualCmp;

    const bucketCmp = cmpNullableAsc(numOrNull(a?.auto_sort_bucket), numOrNull(b?.auto_sort_bucket));
    if (bucketCmp !== 0) return bucketCmp;

    const dateCmp = cmpNullableAsc(
      a?.rok_izrade ? Date.parse(a.rok_izrade) : null,
      b?.rok_izrade ? Date.parse(b.rok_izrade) : null,
    );
    if (dateCmp !== 0) return dateCmp;

    const priCmp = cmpNullableAsc(numOrNull(a?.prioritet_bigtehn), numOrNull(b?.prioritet_bigtehn));
    if (priCmp !== 0) return priCmp;

    const rnCmp = cmpTextAsc(a?.rn_ident_broj, b?.rn_ident_broj);
    if (rnCmp !== 0) return rnCmp;
    return cmpNullableAsc(numOrNull(a?.operacija), numOrNull(b?.operacija));
  });
}

export function machineGroupSlugForCode(rjCode) {
  const code = String(rjCode || '').trim();
  if (!code) return 'ostalo';
  if (['10.1', '10.2', '10.3', '10.4', '10.5'].includes(code)) return 'erodiranje';
  if (code === '8.2') return 'azistiranje';
  if (['1.10', '1.2', '1.30', '1.40', '1.50', '1.60', '1.71', '1.72'].includes(code)) return 'secenje';
  if (['4.1', '4.11', '4.12', '4.2', '4.3', '4.4'].includes(code)) return 'bravarsko';
  if (['5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', '5.11'].includes(code)) return 'farbanje';
  if (['17.0', '17.1'].includes(code)) return 'cam';
  const prefix = code.includes('.') ? code.slice(0, code.indexOf('.')) : code;
  if (prefix === '3') return 'glodanje';
  if (prefix === '2' && !['21.1', '21.2'].includes(code)) return 'struganje';
  if (prefix === '6' && code !== '6.8') return 'brusenje';
  return 'ostalo';
}

export function machineGroupLabel(slug) {
  switch (slug) {
    case 'glodanje': return 'Glodanje';
    case 'struganje': return 'Struganje';
    case 'brusenje': return 'Brušenje';
    case 'erodiranje': return 'Erodiranje';
    case 'azistiranje': return 'Ažistiranje';
    case 'secenje': return 'Sečenje i savijanje';
    case 'bravarsko': return 'Bravarsko';
    case 'farbanje': return 'Farbanje/PZ';
    case 'cam': return 'CAM';
    default: return 'Ostalo';
  }
}

/* ── Reads ── */

/**
 * Vraća listu svih mašina iz BigTehn cache-a (RJ grupe RC).
 * Filter `no_procedure=false` po default-u JESTE primenjen u UI selektoru,
 * ali ovde vraćamo SVE da bi REASSIGN dropdown imao kompletan spisak.
 */
export async function loadMachines() {
  if (!getIsOnline()) return [];
  const data = await sbReq(
    'bigtehn_machines_cache?select=rj_code,name,no_procedure,department_id&order=name.asc',
  );
  return nonNullRows(data, 'bigtehn_machines_cache');
}

/**
 * Vraća listu OTVORENIH operacija (ne završeni u BigTehn-u + nije
 * lokalno označeno 'completed' + overlay nije arhiviran + RN nije završen).
 *
 * Sort: shift_sort_order ASC NULLS LAST, rok_izrade ASC NULLS LAST,
 *       prioritet_bigtehn ASC.
 *
 * @param {string} machineCode — rj_code (npr. "8.3")
 */
export async function loadOperationsForMachine(machineCode) {
  if (!getIsOnline() || !machineCode) return [];
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('effective_machine_code', `eq.${postgrestDoubleQuoted(machineCode)}`);
  params.set('is_done_in_bigtehn', 'eq.false');
  params.set('rn_zavrsen', 'eq.false');
  params.set('is_cooperation_effective', 'eq.false');
  /* PostgREST OR: (local_status.is.null,local_status.neq.completed) */
  params.set('or', '(local_status.is.null,local_status.neq.completed)');
  params.set('overlay_archived_at', 'is.null');
  params.set(
    'order',
    'shift_sort_order.asc.nullslast,auto_sort_bucket.asc,rok_izrade.asc.nullslast,prioritet_bigtehn.asc',
  );
  /* Sigurnosni limit. Realno najopterećenija mašina ima ~1000 otvorenih
     operacija; 2500 daje 2.5× headroom. Ako nekada bude veće, dodaj paging. */
  params.set('limit', '2500');

  const data = await sbReq(`v_production_operations_effective?${params.toString()}`);
  return sortProductionOperations(nonNullRows(data, 'v_production_operations_effective'));
}

/**
 * Vraća OTVORENE operacije za dato „odeljenje" (tab u „Po mašini").
 *
 * Filter zavisi od tipa odeljenja (vidi `src/ui/planProizvodnje/departments.js`):
 *   - `operationExact`        → effective_machine_code IN (...)
 *   - `operationPrefixes`     → effective_machine_code = X OR LIKE 'X.*'
 *   - `operationNamePatterns` → opis_rada ILIKE '%pat%' (server-side, sa
 *                               dodatnim client-side strip-dijakritike pasovima)
 *   - `isFallback` ('ostalo') → SVE operacije, pa client-side filter na
 *                               `operationFallsIntoOstalo(op)`
 *
 * Operacioni tabovi (Ažistiranje, Sečenje+savijanje, Bravarsko, Farbanje+PZ,
 * CAM) prikazuju se direktno (bez izbora mašine) — jedan poziv ovde dovoljan.
 *
 * Skup zajedničkih „otvoreno" filtera identičan je `loadOperationsForMachine`:
 * `is_done_in_bigtehn=false`, `rn_zavrsen=false`,
 * `(local_status IS NULL OR local_status != 'completed')`,
 * `overlay_archived_at IS NULL`.
 *
 * @param {object} dept — definicija iz `DEPARTMENTS` u departments.js
 * @returns {Promise<object[]>}
 */
export async function loadOperationsForDept(dept) {
  if (!getIsOnline() || !dept) return [];

  /* Lazy import — izbegava ciklični import (services ↔ ui). */
  const { operationFallsIntoOstalo } = await import('../ui/planProizvodnje/departments.js');

  const baseParams = () => {
    const p = new URLSearchParams();
    p.set('select', '*');
    p.set('is_done_in_bigtehn', 'eq.false');
    p.set('rn_zavrsen', 'eq.false');
    p.set('is_cooperation_effective', 'eq.false');
    p.set('or', '(local_status.is.null,local_status.neq.completed)');
    p.set('overlay_archived_at', 'is.null');
    p.set(
      'order',
      'shift_sort_order.asc.nullslast,auto_sort_bucket.asc,rok_izrade.asc.nullslast,prioritet_bigtehn.asc',
    );
    p.set('limit', '5000');
    return p;
  };

  /* ─── 1) Fallback „Ostalo" — ne ide ni u jedan specifičan tab.
   *     Strategija: učitaj SVE otvorene operacije (sa effective_machine_code
   *     != NULL, da bismo izbacili tehnologe koji nisu dodelili mašinu —
   *     iste konvencija kao `loadAllOpenOperations()`), pa client-side
   *     filtriraj `operationFallsIntoOstalo`.
   */
  if (dept.isFallback) {
    const p = baseParams();
    /* Ostalo NE filtrira na effective_machine_code IS NOT NULL — operacije
       bez mašine sigurno spadaju u „Ostalo". */
    const data = await sbReq(`v_production_operations_effective?${p.toString()}`);
    const all = nonNullRows(data, 'v_production_operations_effective_ostalo');
    return sortProductionOperations(all.filter(op => operationFallsIntoOstalo(op)));
  }

  const orParts = [];

  /* Exact: PostgREST `in.(...)` — vrednosti sa specijalnim karakterima
     („.", „/" itd.) treba double-quote. */
  if (Array.isArray(dept.operationExact) && dept.operationExact.length > 0) {
    const list = dept.operationExact.map(s => `"${String(s).replace(/"/g, '""')}"`).join(',');
    orParts.push(`effective_machine_code.in.(${list})`);
  }

  /* Prefix: za svaki prefiks „X" → match „X" exact ILI „X.*" like.
     PostgREST `like` koristi `*` kao wildcard. */
  if (Array.isArray(dept.operationPrefixes)) {
    for (const raw of dept.operationPrefixes) {
      const p = String(raw).trim();
      if (!p) continue;
      orParts.push(`effective_machine_code.eq.${postgrestDoubleQuoted(p)}`);
      orParts.push(`effective_machine_code.like.${p}.*`);
    }
  }

  /* Name patterns (server-side ILIKE). Nemamo `unaccent` ekstenziju,
     pa ovo SAMO pokriva ASCII-bazične matchove; client-side dodatno
     proverava sa strip-dijakritike (vidi dole). */
  if (Array.isArray(dept.operationNamePatterns)) {
    for (const raw of dept.operationNamePatterns) {
      const pat = String(raw).trim();
      if (!pat) continue;
      orParts.push(`opis_rada.ilike.*${pat}*`);
    }
  }

  if (orParts.length === 0) {
    /* Defenzivno: ne učitavaj sve operacije ako tab nije dobro definisan. */
    return [];
  }

  /* PostgREST nema „and + or" na top-level (nazivi parametara se gaze
     ako se postave dvaput). Sve filtere kombinujemo u jedan
     `and=(cond1,cond2,or(cond3,cond4),or(cond5))` izraz — `or(...)` unutar
     `and(...)` je prefiksna notacija. */
  const finalParams = new URLSearchParams();
  finalParams.set('select', '*');
  finalParams.set(
    'and',
    `(is_done_in_bigtehn.eq.false,rn_zavrsen.eq.false,overlay_archived_at.is.null,` +
      `is_cooperation_effective.eq.false,` +
      `or(local_status.is.null,local_status.neq.completed),` +
      `or(${orParts.join(',')}))`,
  );
  finalParams.set(
    'order',
    'shift_sort_order.asc.nullslast,auto_sort_bucket.asc,rok_izrade.asc.nullslast,prioritet_bigtehn.asc',
  );
  finalParams.set('limit', '5000');

  const data = await sbReq(`v_production_operations_effective?${finalParams.toString()}`);
  let rows = nonNullRows(data, 'v_production_operations_effective_dept');

  /* Client-side strip-dijakritika provera za name patterns — pokriva slučaj
     kad je server ILIKE bez `unaccent` propustio nešto („bravarÍja" → server
     vidi „bravarÍja" što ne sadrži „bravar" sa default collation u nekim
     setup-ovima). Za EXACT/PREFIX tabove ovaj filter je no-op. */
  if (Array.isArray(dept.operationNamePatterns) && dept.operationNamePatterns.length > 0) {
    const strip = s =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const patsStripped = dept.operationNamePatterns.map(strip);
    /* Ako tab ima SAMO name-patterns (bez exact / prefix), dodatno propusti
       SAMO redove čiji opis stvarno sadrži pattern (server ILIKE već je
       filtirao, ali ovo je extra safety). */
    const onlyName =
      orParts.every(p => p.startsWith('opis_rada.ilike.'));
    if (onlyName) {
      rows = rows.filter(r => {
        const name = strip(r?.opis_rada);
        return patsStripped.some(p => name.includes(p));
      });
    }
  }

  return sortProductionOperations(rows);
}

/**
 * Vraća SVE otvorene operacije (sve mašine), samo kolone potrebne za
 * agregirane prikaze (Zauzetost mašina, Pregled svih).
 *
 * Fetch je široki ali sa minimalnim setom kolona (~8) → ~50 KB za 3000
 * redova. Group/sort/aggregate radi se na klijentu.
 *
 * Filteri: aktivne, ne-arhivirane overlay, RN nije završen, ne-završene
 * u BigTehn-u, ne lokalno označene 'completed'.
 */
export async function loadAllOpenOperations() {
  if (!getIsOnline()) return [];
  const cols = [
    'line_id',
    'work_order_id',
    'effective_machine_code',
    'broj_crteza',
    'naziv_dela',
    'rn_ident_broj',
    'tpz_min',
    'tk_min',
    'komada_total',
    'komada_done',
    'real_seconds',
    'rok_izrade',
    'is_non_machining',
    'assigned_machine_code',
    'local_status',
    'opis_rada',
    'operacija',
    'cam_ready',
    'is_ready_for_processing',
    'is_urgent',
    'auto_sort_bucket',
  ].join(',');
  const params = new URLSearchParams();
  params.set('select', cols);
  params.set('is_done_in_bigtehn', 'eq.false');
  params.set('rn_zavrsen', 'eq.false');
  params.set('is_cooperation_effective', 'eq.false');
  params.set('or', '(local_status.is.null,local_status.neq.completed)');
  params.set('overlay_archived_at', 'is.null');
  /* Effective machine code mora postojati da bi se prikazalo u zbirnom
     pregledu. (Ako tehnolog nije dodelio mašinu i nema reassign, ne brojimo.) */
  params.set('effective_machine_code', 'not.is.null');
  /* Sigurnosni limit: ukupno otvorenih je trenutno ~3000. 10000 daje
     ~3× headroom za naredne godine. */
  params.set('limit', '10000');

  const data = await sbReq(`v_production_operations_effective?${params.toString()}`);
  return sortProductionOperations(nonNullRows(data, 'v_production_operations_effective_all_open'));
}

/**
 * Vrati sve otvorene operacije koje su efektivno u kooperaciji
 * (auto grupa ili ručni overlay flag).
 */
export async function listForCooperation(searchText = '') {
  if (!getIsOnline()) return [];
  const params = new URLSearchParams();
  params.set('select', '*');
  params.set('is_done_in_bigtehn', 'eq.false');
  params.set('rn_zavrsen', 'eq.false');
  params.set('is_cooperation_effective', 'eq.true');
  params.set('or', '(local_status.is.null,local_status.neq.completed)');
  params.set('overlay_archived_at', 'is.null');
  params.set('order', 'rok_izrade.asc.nullslast,rn_ident_broj.asc,operacija.asc');
  params.set('limit', '5000');

  const data = await sbReq(`v_production_operations_effective?${params.toString()}`);
  const rows = nonNullRows(data, 'v_production_operations_effective_coop');
  return filterOperationsByRnOrDrawing(rows, searchText);
}

export async function listAutoCooperationGroups() {
  if (!getIsOnline()) return [];
  const data = await sbReq(
    'production_auto_cooperation_groups?select=rj_group_code,group_label,added_at,added_by,removed_at,removed_by,notes&order=rj_group_code.asc',
  );
  return nonNullRows(data, 'production_auto_cooperation_groups');
}

/**
 * BigTehn snapshot za par (broj naloga, broj TP) iz aktivnih RN-ova u Supabase-u.
 *
 * Čita prvo iz `v_active_bigtehn_work_orders` (po `ident_broj`) — tu su
 * **broj crteža** i **ukupna količina**, i radi i za RN-ove koji nisu u
 * view-u otvorenih operacija (v_production_operations_effective je filtriran na
 * is_done_in_bigtehn=false i rn_zavrsen=false). Zatim, ako postoji
 * operacija (TP), pokušava da dohvati i `komada_done` iz
 * `bigtehn_tech_routing_cache` da predlog količine bude "preostalo".
 *
 * @param {string} rnIdentBroj  npr. `"9000"`
 * @param {string|number|null} operacija  broj TP (npr. `522`); može biti null
 * @returns {Promise<{
 *   rn_ident_broj: string,
 *   broj_crteza: string,
 *   komada_total: number|null,
 *   komada_done: number|null,
 *   naziv_dela: string|null,
 *   materijal: string|null,
 *   dimenzija_materijala: string|null,
 *   customer_id: number|null,
 *   work_order_id: number|null,
 *   operacija: number|null,
 * } | null>}
 */
export async function fetchBigtehnOpSnapshotByRnAndTp(rnIdentBroj, operacija) {
  if (!getIsOnline() || rnIdentBroj == null || rnIdentBroj === '') return null;
  const ident = String(rnIdentBroj).trim();
  if (!ident) return null;
  const opNum =
    operacija == null || operacija === '' ? null : parseInt(String(operacija).trim(), 10);
  const opFinite = Number.isFinite(opNum);

  /* 1) Direktno iz aktivnog RN view-a — nezavisno od BigTehn open/closed statusa,
   * ali poštuje ručnu MES listu aktivnih naloga.
   *
   * BigTehn `tRN.IdentBroj` je u formatu `"nalog/broj_tp"` (npr. `"9000/568"`),
   * TJ. već kombinuje broj naloga i broj TP u jedan string. Zato kod RNZ
   * barkoda `RNZ:XXXX:9000/522:…` tražimo PRVO po punom
   * kombinovanom ident_broj-u (`orderNo + '/' + operacija`), pa tek
   * fallback na samo `orderNo` (ako bi se negde koristio drugi format).
   */
  const woCols = [
    'id',
    'ident_broj',
    'broj_crteza',
    'komada',
    'naziv_dela',
    'materijal',
    'dimenzija_materijala',
    'customer_id',
    'rok_izrade',
    'status_rn',
  ].join(',');

  const tryFetchWo = async idCandidate => {
    const p = new URLSearchParams();
    p.set('select', woCols);
    p.set('ident_broj', `eq.${idCandidate}`);
    p.set('limit', '4');
    const data = await sbReq(`v_active_bigtehn_work_orders?${p.toString()}`);
    return Array.isArray(data) ? data : [];
  };

  /* Primarni lookup: "nalog/operacija" (kombinovani ident_broj u BigTehn-u). */
  const candidates = [];
  if (opFinite) {
    candidates.push(`${ident}/${opNum}`);
    /* Ako je nalog sa vodećim nulama (npr. "07351") a u cache-u je "7351/1088". */
    if (/^\d+$/.test(ident)) {
      const normalized = String(parseInt(ident, 10));
      if (normalized !== ident) candidates.push(`${normalized}/${opNum}`);
    }
  }
  /* Fallback: samo nalog bez TP (legacy, ako se ikad koristi). */
  candidates.push(ident);
  if (/^\d+$/.test(ident)) {
    const normalized = String(parseInt(ident, 10));
    if (normalized !== ident) candidates.push(normalized);
  }

  let woRows = [];
  for (const c of candidates) {
    if (!c) continue;
    woRows = await tryFetchWo(c);
    if (woRows.length > 0) break;
  }
  if (woRows.length === 0) return null;
  if (woRows.length > 1) {
    console.warn('[fetchBigtehnOpSnapshotByRnAndTp] više RN redova za ident_broj — uzimam prvi', {
      ident,
      n: woRows.length,
    });
  }
  const wo = woRows[0];
  const workOrderId = wo.id != null ? Number(wo.id) : null;
  const total = wo.komada != null ? Number(wo.komada) : null;

  /* 2) Ako imamo TP, pokušaj da dohvatiš komada_done iz tech routing cache-a. */
  let done = null;
  if (opFinite && workOrderId != null) {
    try {
      const p = new URLSearchParams();
      p.set('select', 'komada,is_completed');
      p.set('work_order_id', `eq.${workOrderId}`);
      p.set('operacija', `eq.${opNum}`);
      p.set('limit', '200');
      const rows = await sbReq(`bigtehn_tech_routing_cache?${p.toString()}`);
      if (Array.isArray(rows) && rows.length) {
        done = rows.reduce((s, r) => s + (Number(r?.komada) || 0), 0);
      } else {
        done = 0;
      }
    } catch (e) {
      console.warn('[fetchBigtehnOpSnapshotByRnAndTp] tech routing fetch failed', e);
    }
  }

  /* 3) Opciono: kupac (best-effort, ne blokira na grešku). */
  let customerName = null;
  let customerShort = null;
  if (wo.customer_id != null) {
    try {
      const p = new URLSearchParams();
      p.set('select', 'id,name,short_name');
      p.set('id', `eq.${wo.customer_id}`);
      p.set('limit', '1');
      const rows = await sbReq(`bigtehn_customers_cache?${p.toString()}`);
      if (Array.isArray(rows) && rows[0]) {
        customerName = rows[0].name ?? null;
        customerShort = rows[0].short_name ?? null;
      }
    } catch (e) {
      console.warn('[fetchBigtehnOpSnapshotByRnAndTp] customer fetch failed', e);
    }
  }

  return {
    rn_ident_broj: wo.ident_broj != null ? String(wo.ident_broj) : ident,
    broj_crteza: wo.broj_crteza != null ? String(wo.broj_crteza) : '',
    komada_total: Number.isFinite(total) ? total : null,
    komada_done: done,
    naziv_dela: wo.naziv_dela ?? null,
    materijal: wo.materijal ?? null,
    dimenzija_materijala: wo.dimenzija_materijala ?? null,
    customer_id: wo.customer_id ?? null,
    customer_name: customerName,
    customer_short: customerShort,
    work_order_id: workOrderId,
    operacija: opFinite ? opNum : null,
  };
}

/**
 * Distinct brojevi TP za uneti broj predmeta (prvi segment `ident_broj` u
 * `bigtehn_work_orders_cache`, npr. 7351 ili 9400-1). Za RN bez "/" u ident-u
 * čita operacije iz `bigtehn_tech_routing_cache`.
 *
 * @param {string} orderNo
 * @returns {Promise<{ tp: string, broj_crteza: string, ident_broj: string }[]>}
 */
export async function fetchTpOptionsForPredmetOrder(orderNo) {
  if (!getIsOnline()) return [];
  const ident = String(orderNo ?? '').trim();
  if (!ident) return [];

  const variants = new Set([ident]);
  if (/^\d+$/.test(ident)) {
    variants.add(String(parseInt(ident, 10)));
  }

  const byWoId = new Map();
  for (const v of variants) {
    if (!v) continue;
    const orInner = `ident_broj.eq.${encodeURIComponent(v)},ident_broj.like.${encodeURIComponent(`${v}.*`)}`;
    const rows = await sbReq(
      `bigtehn_work_orders_cache?select=id,ident_broj,broj_crteza&or=(${orInner})&limit=500`,
    );
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (r?.id == null) continue;
      byWoId.set(Number(r.id), r);
    }
  }

  const out = [];
  const seenTp = new Set();

  for (const r of byWoId.values()) {
    const ib = String(r.ident_broj ?? '').trim();
    const parts = ib.split('/');
    const tail = parts.length >= 2 ? String(parts[1] ?? '').trim() : '';
    const dr = r.broj_crteza != null ? String(r.broj_crteza).trim() : '';

    if (tail) {
      if (seenTp.has(tail)) continue;
      seenTp.add(tail);
      out.push({ tp: tail, broj_crteza: dr, ident_broj: ib });
      continue;
    }

    const wid = Number(r.id);
    if (!Number.isFinite(wid)) continue;
    const p = new URLSearchParams();
    p.set('select', 'operacija');
    p.set('work_order_id', `eq.${wid}`);
    p.set('order', 'operacija.asc');
    p.set('limit', '800');
    const routes = await sbReq(`bigtehn_tech_routing_cache?${p.toString()}`);
    if (!Array.isArray(routes)) continue;
    for (const row of routes) {
      if (row?.operacija == null) continue;
      const tp = String(row.operacija).trim();
      if (!tp || seenTp.has(tp)) continue;
      seenTp.add(tp);
      out.push({ tp, broj_crteza: dr, ident_broj: ib });
    }
  }

  out.sort((a, b) => {
    const na = parseInt(a.tp, 10);
    const nb = parseInt(b.tp, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === a.tp && String(nb) === b.tp) {
      return na - nb;
    }
    return String(a.tp).localeCompare(String(b.tp), 'sr', { numeric: true });
  });
  return out;
}

/**
 * @param {number[]} ids — `bigtehn_work_orders_cache.id` (npr. iz projekt_bigtehn_rn)
 * @returns {Promise<object[]>}
 */
export async function fetchBigtehnWorkOrdersByIds(ids) {
  if (!getIsOnline() || !Array.isArray(ids) || !ids.length) return [];
  const uniq = [...new Set(ids.map(n => Number(n)).filter(Number.isFinite))];
  if (!uniq.length) return [];
  const rows = await sbReq(
    `v_active_bigtehn_work_orders?id=in.(${uniq.join(',')})&select=id,ident_broj,broj_crteza,naziv_dela,komada,is_mes_active`,
  );
  return Array.isArray(rows) ? rows : [];
}

/* ── Writes (overlay) ── */

/**
 * UPSERT overlay-a za jednu operaciju (work_order_id + line_id su unique).
 * Polja koja nisu u patch-u OSTAJU nepromenjena na serveru zahvaljujući
 * UPSERT semantici (PostgREST: on_conflict + Prefer: resolution=merge-duplicates).
 *
 * @param {object} args
 * @param {number} args.work_order_id
 * @param {number} args.line_id
 * @param {object} args.patch  npr. { local_status: 'in_progress' }
 *                              ili  { shift_note: '…' }
 *                              ili  { assigned_machine_code: '10.1' }
 */
export async function upsertOverlay({ work_order_id, line_id, patch }) {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return null;
  if (!work_order_id || !line_id) return null;

  const user = getCurrentUser();
  const email = user?.email || null;

  const payload = {
    work_order_id,
    line_id,
    ...patch,
    updated_by: email,
    /* created_by se postavlja samo na INSERT — Postgres DEFAULT za created_at
       hvata vremenu. Šaljemo i ovde da bismo bili sigurni da je popunjen
       i u slučaju da overlay nije postojao. UPSERT će prihvatiti ovo polje
       ali pri MERGE konfliktu update-uje samo polja iz payload-a (DEFAULT
       fallback ako bi i created_by bio menjan, ali Postgres GENERATED
       columns ostaju netaknute). */
    created_by: email,
  };

  const res = await sbReq(
    'production_overlays?on_conflict=work_order_id,line_id',
    'POST',
    payload,
  );
  return res;
}

/**
 * Toggle "CAM spreman" za jednu operaciju.
 *
 * @param {number} work_order_id
 * @param {number} line_id
 * @param {boolean} ready
 */
export async function setCamReady(work_order_id, line_id, ready) {
  const user = getCurrentUser();
  const email = user?.email || null;
  return await upsertOverlay({
    work_order_id,
    line_id,
    patch: {
      cam_ready: !!ready,
      cam_ready_at: ready ? new Date().toISOString() : null,
      cam_ready_by: ready ? email : null,
    },
  });
}

export async function setCooperationManual({
  workOrderId,
  lineId,
  status = 'external',
  partner = null,
  expectedReturn = null,
}) {
  const user = getCurrentUser();
  const email = user?.email || null;
  return await upsertOverlay({
    work_order_id: workOrderId,
    line_id: lineId,
    patch: {
      cooperation_status: status,
      cooperation_partner: partner || null,
      cooperation_expected_return: expectedReturn || null,
      cooperation_set_by: email,
      cooperation_set_at: new Date().toISOString(),
    },
  });
}

export async function clearCooperationManual({ workOrderId, lineId }) {
  return await upsertOverlay({
    work_order_id: workOrderId,
    line_id: lineId,
    patch: {
      cooperation_status: 'none',
      cooperation_partner: null,
      cooperation_expected_return: null,
      cooperation_set_by: null,
      cooperation_set_at: null,
    },
  });
}

export async function setUrgent(workOrderId, reason = '') {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return null;
  const id = Number(workOrderId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const user = getCurrentUser();
  const email = user?.email || null;
  const payload = {
    work_order_id: id,
    is_urgent: true,
    reason: String(reason || '').trim() || null,
    set_by: email,
    set_at: new Date().toISOString(),
    cleared_at: null,
    cleared_by: null,
  };

  return await sbReq(
    'production_urgency_overrides?on_conflict=work_order_id',
    'POST',
    payload,
  );
}

export async function clearUrgent(workOrderId) {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return null;
  const id = Number(workOrderId);
  if (!Number.isFinite(id) || id <= 0) return null;

  const user = getCurrentUser();
  const email = user?.email || null;
  const payload = {
    work_order_id: id,
    is_urgent: false,
    cleared_at: new Date().toISOString(),
    cleared_by: email,
  };

  return await sbReq(
    'production_urgency_overrides?on_conflict=work_order_id',
    'POST',
    payload,
  );
}

export async function pinToTop(row, currentRows = []) {
  if (!row?.work_order_id || !row?.line_id) return null;
  const manualOrders = Array.isArray(currentRows)
    ? currentRows.map(r => numOrNull(r?.shift_sort_order)).filter(n => n != null)
    : [];
  const nextOrder = manualOrders.length > 0 ? Math.min(...manualOrders) - 1 : 1;
  return await upsertOverlay({
    work_order_id: row.work_order_id,
    line_id: row.line_id,
    patch: { shift_sort_order: nextOrder },
  });
}

export async function unpin(row) {
  if (!row?.work_order_id || !row?.line_id) return null;
  return await upsertOverlay({
    work_order_id: row.work_order_id,
    line_id: row.line_id,
    patch: { shift_sort_order: null },
  });
}

export async function reassignLine({
  workOrderId,
  lineId,
  targetMachine,
  force = false,
  reason = null,
}) {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return null;
  if (!workOrderId || !lineId) return null;
  const res = await sbReq('rpc/reassign_production_line', 'POST', {
    p_work_order_id: Number(workOrderId),
    p_line_id: Number(lineId),
    p_target_machine: targetMachine || null,
    p_force: !!force,
    p_force_reason: reason || null,
  }, { upsert: false });
  return res;
}

export async function bulkReassignLines({
  pairs,
  targetMachine,
  force = false,
  reason = null,
}) {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return null;
  const cleanPairs = Array.isArray(pairs)
    ? pairs
        .map(p => ({ wo: Number(p?.wo ?? p?.work_order_id), line: Number(p?.line ?? p?.line_id) }))
        .filter(p => Number.isFinite(p.wo) && Number.isFinite(p.line))
    : [];
  if (cleanPairs.length === 0) return null;
  const res = await sbReq('rpc/bulk_reassign_production_lines', 'POST', {
    p_pairs: cleanPairs,
    p_target_machine: targetMachine || null,
    p_force: !!force,
    p_force_reason: reason || null,
  }, { upsert: false });
  return res;
}

/**
 * Bulk reorder posle drag-drop. Šalje se ARRAY overlay payload-a;
 * Postgres UPSERT po unique (work_order_id, line_id) pravi/ažurira sve
 * u jednoj REST round-trip.
 *
 * @param {Array<{work_order_id:number, line_id:number}>} orderedItems
 *   — itemi u novom redosledu (prvi = sort_order=1)
 */
export async function reorderOverlays(orderedItems) {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return null;
  if (!Array.isArray(orderedItems) || orderedItems.length === 0) return null;

  const user = getCurrentUser();
  const email = user?.email || null;
  const payload = orderedItems.map((it, idx) => ({
    work_order_id: it.work_order_id,
    line_id:       it.line_id,
    shift_sort_order: idx + 1,
    updated_by: email,
    created_by: email,
  }));

  return await sbReq(
    'production_overlays?on_conflict=work_order_id,line_id',
    'POST',
    payload,
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * SPRINT F.4 — Skice / slike (production_drawings + Storage)
 *
 * Storage layout: bucket "production-drawings", putanja
 *   <work_order_id>/<line_id>/<uuid>_<sanitized-original-name>.<ext>
 *
 * Bucket NIJE javan → svi pristupi idu kroz signed URL (5 min expiry).
 * RLS: read za sve authenticated, write samo za admin/pm
 * (kontroliše se i u DB tabeli i na storage.objects).
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Vrati listu AKTIVNIH (deleted_at IS NULL) skica za jednu operaciju.
 * Sortirano po uploaded_at DESC (najnovije prvo).
 */
export async function loadDrawings({ work_order_id, line_id }) {
  if (!getIsOnline() || !work_order_id || !line_id) return [];
  const params = new URLSearchParams();
  params.set('select', 'id,storage_path,file_name,mime_type,size_bytes,uploaded_at,uploaded_by');
  params.set('work_order_id', `eq.${work_order_id}`);
  params.set('line_id',       `eq.${line_id}`);
  params.set('deleted_at',    'is.null');
  params.set('order',         'uploaded_at.desc');
  const data = await sbReq(`production_drawings?${params.toString()}`);
  return Array.isArray(data) ? data : [];
}

/**
 * Upload jednog file-a. Radi:
 *   1) PUT u Storage bucket
 *   2) INSERT u production_drawings sa metadata
 *
 * @returns {Promise<object|null>} novi drawing red iz DB, ili null na fail.
 */
export async function uploadDrawing({ work_order_id, line_id, file }) {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return null;
  if (!work_order_id || !line_id || !file) return null;

  const user = getCurrentUser();
  const token = user?._token || getSupabaseAnonKey();
  const apiKey = getSupabaseAnonKey();
  const baseUrl = getSupabaseUrl();

  /* Sanitize ime: ukloni ne-ASCII i shell-unsafe karaktere */
  const safeName = String(file.name)
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'file';
  const uuid = (crypto?.randomUUID?.() || String(Date.now())).replace(/-/g, '').slice(0, 12);
  const storagePath = `${work_order_id}/${line_id}/${uuid}_${safeName}`;

  /* 1) Upload binary u Storage */
  try {
    const r = await fetch(
      `${baseUrl}/storage/v1/object/${DRAWINGS_BUCKET}/${encodeURI(storagePath)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'apikey': apiKey,
          'Content-Type': file.type || 'application/octet-stream',
          'x-upsert': 'false',
          'cache-control': '3600',
        },
        body: file,
      },
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[uploadDrawing] storage failed', r.status, txt);
      return null;
    }
  } catch (e) {
    console.error('[uploadDrawing] storage exception', e);
    return null;
  }

  /* 2) Insert metadata u tabelu */
  const payload = {
    work_order_id,
    line_id,
    storage_path: storagePath,
    file_name:    file.name,
    mime_type:    file.type || null,
    size_bytes:   file.size || null,
    uploaded_by:  user?.email || null,
  };
  const res = await sbReq('production_drawings', 'POST', payload);
  /* PostgREST sa Prefer:return=representation vraća array od 1 row-a */
  return Array.isArray(res) ? (res[0] || null) : (res || null);
}

/**
 * Soft-delete: postavi deleted_at = NOW() u tabeli i pokušaj da obrišeš
 * fajl iz Storage-a (best-effort; ako Storage delete failuje, metadata
 * je već sakriven od UI-a kroz `deleted_at IS NULL` filter).
 */
export async function softDeleteDrawing(drawing) {
  if (!getIsOnline() || !canEditPlanProizvodnje()) return false;
  if (!drawing?.id) return false;

  const user = getCurrentUser();
  const email = user?.email || null;

  /* 1) UPDATE tabela */
  const params = new URLSearchParams();
  params.set('id', `eq.${drawing.id}`);
  const ok = await sbReq(
    `production_drawings?${params.toString()}`,
    'PATCH',
    { deleted_at: new Date().toISOString(), deleted_by: email },
  );
  if (ok === null) {
    console.error('[softDeleteDrawing] DB update failed', drawing.id);
    return false;
  }

  /* 2) Storage delete (best-effort) */
  if (drawing.storage_path) {
    try {
      const token = user?._token || getSupabaseAnonKey();
      const apiKey = getSupabaseAnonKey();
      const baseUrl = getSupabaseUrl();
      const r = await fetch(
        `${baseUrl}/storage/v1/object/${DRAWINGS_BUCKET}/${encodeURI(drawing.storage_path)}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': 'Bearer ' + token,
            'apikey': apiKey,
          },
        },
      );
      if (!r.ok) {
        console.warn('[softDeleteDrawing] storage delete failed (DB ok)', r.status);
      }
    } catch (e) {
      console.warn('[softDeleteDrawing] storage delete exception (DB ok)', e);
    }
  }
  return true;
}

/**
 * Kreiraj signed URL za pregled (default 5 min trajanje).
 * Vraća apsolutni URL koji možeš direktno da staviš u <img src> ili otvoriš
 * u novom tab-u.
 */
export async function getDrawingSignedUrl(storagePath, expiresIn = 300) {
  if (!getIsOnline() || !storagePath) return null;
  const user = getCurrentUser();
  const token = user?._token || getSupabaseAnonKey();
  const apiKey = getSupabaseAnonKey();
  const baseUrl = getSupabaseUrl();
  const headers = {
    'Authorization': 'Bearer ' + token,
    'apikey': apiKey,
    'Content-Type': 'application/json',
  };
  try {
    const rBatch = await fetch(
      `${baseUrl}/storage/v1/object/sign/${DRAWINGS_BUCKET}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ expiresIn, paths: [storagePath] }),
      },
    );
    if (rBatch.ok) {
      const j = await rBatch.json().catch(() => null);
      const rel = parseSupabaseStorageSignResponse(j);
      const full = absolutizeSupabaseStorageSignedPath(baseUrl, rel);
      if (full) return full;
    }
    const r = await fetch(
      `${baseUrl}/storage/v1/object/sign/${DRAWINGS_BUCKET}/${encodeURIComponent(storagePath)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ expiresIn }),
      },
    );
    if (!r.ok) {
      console.error('[getDrawingSignedUrl] failed', r.status);
      return null;
    }
    const j = await r.json().catch(() => null);
    const rel = parseSupabaseStorageSignResponse(j);
    return absolutizeSupabaseStorageSignedPath(baseUrl, rel);
  } catch (e) {
    console.error('[getDrawingSignedUrl] exception', e);
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * SPRINT F.5a — BigTehn crteži (PDF iz BigBit foldera)
 *
 * Bridge sinhronizuje fajlove iz C:\PDMExport\PDFImportovano u Supabase
 * bucket "bigtehn-drawings". Frontend samo otvara signed URL-ove.
 *
 * NAPOMENA: stvarna implementacija sada živi u `src/services/drawings.js`
 * (shared sloj) jer je isti helper potreban i Plan Montaži (polje „Veza sa“).
 * Ovde ostaje thin re-export radi backward-compat sa postojećim importima.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Vraća signed URL (5 min) za PDF crtež po broju crteža.
 * Vraća null ako broj nije poznat ili ako Bridge još nije sinhronizovao.
 *
 * @param {string} brojCrteza  Naziv crteža (= naziv fajla bez .pdf)
 * @param {number} [expiresIn=300] Trajanje URL-a u sekundama (default 5 min)
 */
export async function getBigtehnDrawingSignedUrl(brojCrteza, expiresIn = 300) {
  return _getBigtehnDrawingSignedUrlShared(brojCrteza, expiresIn);
}

/* ────────────────────────────────────────────────────────────────────────
 * SPRINT F.5b — Tehnološki postupak (sve operacije za jedan RN)
 *
 * Koristi se u modal-u (Plan + Lokacije). Vraća:
 *   - operations: sve linije RN-a iz v_production_operations (ceo TP; effective view
 *     skriva RN iz plana posle završne kontrole)
 *   - logs: sve prijave iz bigtehn_tech_routing_cache za taj RN (po opcijama)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Učitaj kompletan tehnološki postupak za jedan RN.
 *
 * @param {number} workOrderId  bigtehn_work_orders_cache.id
 * @returns {Promise<{operations: object[], logs: object[], header: object|null}>}
 */
export async function loadFullTechProcedure(workOrderId) {
  if (!getIsOnline() || !workOrderId) {
    return { operations: [], logs: [], header: null };
  }

  /* 1) Sve operacije za RN (poredak: po Operacija ASC). Bazni view (ne effective):
     posle završne kontrole RN i dalje prikazuje ceo TP u modalu iz Lokacija. */
  const opParams = new URLSearchParams();
  opParams.set('select', '*');
  opParams.set('work_order_id', `eq.${workOrderId}`);
  opParams.set('order', 'operacija.asc');
  opParams.set('limit', '500');
  const operations = await sbReq(`v_production_operations?${opParams.toString()}`);

  /* 2) Sve prijave iz tech_routing cache-a (svi radnici, sve operacije). */
  const logParams = new URLSearchParams();
  logParams.set(
    'select',
    'id,operacija,machine_code,worker_id,komada,prn_timer_seconds,started_at,finished_at,is_completed,napomena,potpis',
  );
  logParams.set('work_order_id', `eq.${workOrderId}`);
  logParams.set('order', 'operacija.asc,started_at.asc');
  logParams.set('limit', '2000');
  const logs = await sbReq(`bigtehn_tech_routing_cache?${logParams.toString()}`);

  /* 3) Header info (1. operacija ima sve potrebne RN polja u view-u) */
  const ops = Array.isArray(operations) ? operations : [];
  const header = ops[0]
    ? {
        rn_ident_broj:        ops[0].rn_ident_broj,
        broj_crteza:          ops[0].broj_crteza,
        naziv_dela:           ops[0].naziv_dela,
        materijal:            ops[0].materijal,
        dimenzija_materijala: ops[0].dimenzija_materijala,
        komada_total:         ops[0].komada_total,
        rok_izrade:           ops[0].rok_izrade,
        customer_name:        ops[0].customer_name,
        customer_short:       ops[0].customer_short,
        rn_napomena:          ops[0].rn_napomena,
        rn_zavrsen:           ops[0].rn_zavrsen,
        rn_zakljucano:        ops[0].rn_zakljucano,
        has_bigtehn_drawing:  ops[0].has_bigtehn_drawing,
      }
    : null;

  return { operations: ops, logs: Array.isArray(logs) ? logs : [], header };
}

/* ── Helpers (čisti, no-side-effects) ── */

/**
 * Vrati klasu hitnosti za boju roka.
 *   - "overdue"  — rok je u prošlosti (<= juče)
 *   - "today"    — rok je danas
 *   - "soon"     — rok je u sledeća 3 dana
 *   - "warn"     — rok je u sledećih 4–7 dana
 *   - "ok"       — rok je dalje od 7 dana
 *   - ""         — nema roka
 */
export function rokUrgencyClass(rokIzrade) {
  if (!rokIzrade) return '';
  const now = Date.now();
  const rok = new Date(rokIzrade).getTime();
  if (Number.isNaN(rok)) return '';
  const diffDays = Math.floor((rok - now) / (24 * 3600 * 1000));
  if (diffDays < 0)  return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays <= 3) return 'soon';
  if (diffDays <= 7) return 'warn';
  return 'ok';
}

/**
 * Pretvori sekunde u "Xh Ym" prijatan string.
 */
export function formatSecondsHm(secs) {
  if (!secs || secs <= 0) return '–';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Procena planiranog tehnološkog vremena u sekundama:
 *   t_total = (tpz + tk * komada_total) * 60
 * (tpz, tk su u minutima u BigTehn-u.)
 */
export function plannedSeconds(row) {
  const tpz = Number(row.tpz_min) || 0;
  const tk  = Number(row.tk_min)  || 0;
  const k   = Number(row.komada_total) || 0;
  return Math.round((tpz + tk * k) * 60);
}

/**
 * Client-side filter za "RN ili crtež" u Planiranju proizvodnje.
 * Pretražuje BigTehn ident RN-a i broj crteža, case-insensitive contains.
 */
export function operationMatchesRnOrDrawing(row, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row?.rn_ident_broj,
    row?.ident_broj,
    row?.broj_crteza,
  ]
    .filter(v => v != null && v !== '')
    .map(v => String(v).toLowerCase());
  return haystack.some(v => v.includes(q));
}

export function filterOperationsByRnOrDrawing(rows, query) {
  if (!Array.isArray(rows)) return [];
  const q = String(query || '').trim();
  if (!q) return rows;
  return rows.filter(row => operationMatchesRnOrDrawing(row, q));
}

/* ── Client-side agregacije (za "Zauzetost mašina" i "Pregled svih") ── */

/**
 * Grupiše operacije po `effective_machine_code` i vraća ZBIRNU statistiku.
 * Koristi se u tabu "Zauzetost mašina".
 *
 * Output (mapa) → array sa sledećom strukturom:
 *   {
 *     machineCode, totalOps, drawingsCount, camReadyOps,
 *     overdueOps, todayOps, soonOps, warnOps, okOps, noDeadlineOps,
 *     plannedSec, realSec, nonMachiningOps,
 *     reassignedInOps  // operacije koje su REASSIGNED u ovu mašinu
 *                      // (tj. assigned_machine_code === machineCode i
 *                      //  različito od originalnog — ne možemo precizno
 *                      //  bez originalnog, pa brojimo sve sa
 *                      //  assigned_machine_code IS NOT NULL.)
 *   }
 */
export function summarizeByMachine(rows) {
  const byMachine = new Map();
  for (const r of rows) {
    const mc = r.effective_machine_code;
    if (!mc) continue;
    let s = byMachine.get(mc);
    if (!s) {
      s = {
        machineCode: mc,
        totalOps: 0,
        drawingsSet: new Set(),
        overdueOps: 0, todayOps: 0, soonOps: 0, warnOps: 0, okOps: 0,
        noDeadlineOps: 0,
        plannedSec: 0, realSec: 0,
        nonMachiningOps: 0,
        reassignedInOps: 0,
        camReadyOps: 0,
        readyOps: 0,
        urgentOps: 0,
      };
      byMachine.set(mc, s);
    }
    s.totalOps += 1;
    if (r.broj_crteza) s.drawingsSet.add(String(r.broj_crteza));
    if (r.cam_ready) s.camReadyOps += 1;
    if (r.is_ready_for_processing) s.readyOps += 1;
    if (r.is_urgent) s.urgentOps += 1;
    if (r.is_non_machining) s.nonMachiningOps += 1;
    if (r.assigned_machine_code) s.reassignedInOps += 1;
    s.plannedSec += plannedSeconds(r);
    s.realSec += Number(r.real_seconds) || 0;

    const u = rokUrgencyClass(r.rok_izrade);
    if (!u)              s.noDeadlineOps += 1;
    else if (u === 'overdue') s.overdueOps += 1;
    else if (u === 'today')   s.todayOps += 1;
    else if (u === 'soon')    s.soonOps += 1;
    else if (u === 'warn')    s.warnOps += 1;
    else                      s.okOps += 1;
  }
  /* Pretvori Set → broj i vrati array */
  const out = [];
  for (const s of byMachine.values()) {
    out.push({
      ...s,
      drawingsCount: s.drawingsSet.size,
      drawingsSet: undefined,
    });
  }
  return out;
}

/**
 * Vraća listu od `numWorkingDays` narednih radnih dana (Pon–Pet) počevši
 * od današnjeg dana (uključujući danas ako je radni dan).
 *
 * Output: array of { date: 'YYYY-MM-DD', dow: 1..5, label: 'Pon 21.04', isToday }
 */
export function nextWorkingDays(numWorkingDays = 5, fromDate = new Date()) {
  const out = [];
  const dayNames = ['Ned', 'Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub'];
  const cur = new Date(fromDate);
  cur.setHours(0, 0, 0, 0);
  const todayStr = isoDay(new Date());
  /* Maksimum 14 kalendarskih dana napred (dovoljno za 5 radnih, čak i sa praznicima) */
  for (let i = 0; i < 14 && out.length < numWorkingDays; i++) {
    const d = new Date(cur);
    d.setDate(cur.getDate() + i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; /* preskoči vikende */
    const isoStr = isoDay(d);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    out.push({
      date:   isoStr,
      dow,
      label:  `${dayNames[dow]} ${dd}.${mm}`,
      isToday: isoStr === todayStr,
    });
  }
  return out;
}

/**
 * Build matrice mašine × dani.
 *
 * Vraća:
 *   {
 *     days: [{date, label, isToday}, ...],
 *     machines: [
 *       {
 *         machineCode,
 *         totalOps,
 *         camReadyOps,
 *         buckets: {
 *           overdue: N,           // rok < danas
 *           '2026-04-21': N,      // rok je tog dana
 *           '2026-04-22': N,
 *           ...
 *           future: N,            // rok > poslednji prikazani dan
 *           noDeadline: N,        // bez roka
 *         }
 *       }, ...
 *     ]
 *   }
 */
export function buildDeadlineMatrix(rows, numWorkingDays = 5) {
  const days = nextWorkingDays(numWorkingDays);
  const lastDay = days.length ? days[days.length - 1].date : null;
  const todayStr = isoDay(new Date());

  const byMachine = new Map();
  for (const r of rows) {
    const mc = r.effective_machine_code;
    if (!mc) continue;
    let m = byMachine.get(mc);
    if (!m) {
      m = { machineCode: mc, totalOps: 0, camReadyOps: 0, readyOps: 0, urgentOps: 0, buckets: {
        overdue: 0, future: 0, noDeadline: 0,
      } };
      for (const d of days) m.buckets[d.date] = 0;
      byMachine.set(mc, m);
    }
    m.totalOps += 1;
    if (r.cam_ready) m.camReadyOps += 1;
    if (r.is_ready_for_processing) m.readyOps += 1;
    if (r.is_urgent) m.urgentOps += 1;
    const rok = r.rok_izrade ? isoDay(new Date(r.rok_izrade)) : null;
    if (!rok) {
      m.buckets.noDeadline += 1;
    } else if (rok < todayStr) {
      m.buckets.overdue += 1;
    } else if (lastDay && rok > lastDay) {
      m.buckets.future += 1;
    } else if (m.buckets[rok] !== undefined) {
      m.buckets[rok] += 1;
    } else {
      /* Vikend pao između prikazanih radnih dana → broj kao "future"
         (prikazaće se u koloni "Sledeća sedmica+"). */
      m.buckets.future += 1;
    }
  }

  return { days, machines: Array.from(byMachine.values()) };
}

/** Helper: format Date kao 'YYYY-MM-DD' (lokalna zona). */
function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
