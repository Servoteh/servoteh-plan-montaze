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
  params.set('limit', '500'); /* sigurnosni limit; ako ikad neko ima >500 otvorenih, paging će biti dodat */

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
