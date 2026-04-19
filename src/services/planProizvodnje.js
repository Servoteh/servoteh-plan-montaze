/**
 * Plan Proizvodnje — service sloj.
 *
 * Sve PostgREST queries za:
 *   - listu mašina (iz bigtehn_machines_cache)
 *   - listu otvorenih operacija po efektivnoj mašini (v_production_operations)
 *   - upsert overlay-a (sort, status, napomena, REASSIGN)
 *   - bulk reorder (drag-drop)
 *
 * Koristi sbReq() iz services/supabase.js — koji automatski hvata trenutni
 * JWT iz state/auth.js. Ako korisnik nema rolu admin/pm, RLS na
 * production_overlays će ga odbiti na write i sbReq() vraća null.
 */

import { sbReq } from './supabase.js';
import {
  canEditPlanProizvodnje,
  getCurrentUser,
  getIsOnline,
} from '../state/auth.js';

/* ── Konstante ── */

export const LOCAL_STATUSES = ['waiting', 'in_progress', 'blocked'];
/** Sledeći status u ciklusu klika na pill (NE uključuje 'completed' jer to
 *  dolazi iz BigTehn-a, ne pišemo ručno). */
export const STATUS_CYCLE_NEXT = {
  waiting:     'in_progress',
  in_progress: 'blocked',
  blocked:     'waiting',
};

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
  return Array.isArray(data) ? data : [];
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
  params.set('effective_machine_code', `eq.${machineCode}`);
  params.set('is_done_in_bigtehn', 'eq.false');
  params.set('rn_zavrsen', 'eq.false');
  /* PostgREST OR: (local_status.is.null,local_status.neq.completed) */
  params.set('or', '(local_status.is.null,local_status.neq.completed)');
  params.set('overlay_archived_at', 'is.null');
  params.set(
    'order',
    'shift_sort_order.asc.nullslast,rok_izrade.asc.nullslast,prioritet_bigtehn.asc',
  );
  /* Sigurnosni limit. Realno najopterećenija mašina ima ~1000 otvorenih
     operacija; 2500 daje 2.5× headroom. Ako nekada bude veće, dodaj paging. */
  params.set('limit', '2500');

  const data = await sbReq(`v_production_operations?${params.toString()}`);
  return Array.isArray(data) ? data : [];
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
  ].join(',');
  const params = new URLSearchParams();
  params.set('select', cols);
  params.set('is_done_in_bigtehn', 'eq.false');
  params.set('rn_zavrsen', 'eq.false');
  params.set('or', '(local_status.is.null,local_status.neq.completed)');
  params.set('overlay_archived_at', 'is.null');
  /* Effective machine code mora postojati da bi se prikazalo u zbirnom
     pregledu. (Ako tehnolog nije dodelio mašinu i nema reassign, ne brojimo.) */
  params.set('effective_machine_code', 'not.is.null');
  /* Sigurnosni limit: ukupno otvorenih je trenutno ~3000. 10000 daje
     ~3× headroom za naredne godine. */
  params.set('limit', '10000');

  const data = await sbReq(`v_production_operations?${params.toString()}`);
  return Array.isArray(data) ? data : [];
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

/* ── Client-side agregacije (za "Zauzetost mašina" i "Pregled svih") ── */

/**
 * Grupiše operacije po `effective_machine_code` i vraća ZBIRNU statistiku.
 * Koristi se u tabu "Zauzetost mašina".
 *
 * Output (mapa) → array sa sledećom strukturom:
 *   {
 *     machineCode, totalOps, drawingsCount,
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
      };
      byMachine.set(mc, s);
    }
    s.totalOps += 1;
    if (r.broj_crteza) s.drawingsSet.add(String(r.broj_crteza));
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
      m = { machineCode: mc, totalOps: 0, buckets: {
        overdue: 0, future: 0, noDeadline: 0,
      } };
      for (const d of days) m.buckets[d.date] = 0;
      byMachine.set(mc, m);
    }
    m.totalOps += 1;
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
