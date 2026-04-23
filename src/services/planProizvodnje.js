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

/* ── Reads ── */

/**
 * Vraća listu svih mašina iz BigTehn cache-a (RJ grupe RC).
 * Filter `no_procedure=false` po default-u JESTE primenjen u UI selektoru,
 * ali ovde vraćamo SVE da bi REASSIGN dropdown imao kompletan spisak.
 *
 * Uz osnovne kolone, embedduje i naziv odeljenja iz
 * `bigtehn_departments_cache` (FK `department_id` → `id`). Naziv se
 * koristi u `poMasiniTab.js` za filtriranje mašina po odeljenju (tabovi
 * iznad dropdown-a). Ako embed iz bilo kog razloga padne, fallback na
 * dva odvojena query-ja sa client-side merge — bitno je da svaka mašina
 * dobije polje `departmentName`.
 */
export async function loadMachines() {
  if (!getIsOnline()) return [];

  /* Primarno: PostgREST resource embedding preko FK relacije. Alias
     `department:` daje stabilan ključ u JSON-u bez obzira na ime FK-a. */
  let data = await sbReq(
    'bigtehn_machines_cache?select=rj_code,name,no_procedure,department_id,department:bigtehn_departments_cache(id,name)&order=name.asc',
  );

  if (!Array.isArray(data)) {
    /* Fallback: dva odvojena fetcha + client-side merge. */
    const [machines, departments] = await Promise.all([
      sbReq('bigtehn_machines_cache?select=rj_code,name,no_procedure,department_id&order=name.asc'),
      sbReq('bigtehn_departments_cache?select=id,name'),
    ]);
    if (!Array.isArray(machines)) return [];
    const deptById = new Map(
      (Array.isArray(departments) ? departments : []).map(d => [String(d.id), d]),
    );
    data = machines.map(m => ({
      ...m,
      department: m.department_id != null ? deptById.get(String(m.department_id)) || null : null,
    }));
  }

  return data.map(m => ({
    rj_code:        m.rj_code,
    name:           m.name,
    no_procedure:   m.no_procedure,
    department_id:  m.department_id ?? null,
    departmentId:   m.department_id ?? null,
    departmentName: m.department?.name ?? null,
  }));
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

/**
 * BigTehn snapshot za par (broj naloga, broj TP) iz RN cache-a u Supabase-u.
 *
 * Čita prvo iz `bigtehn_work_orders_cache` (po `ident_broj`) — tu su
 * **broj crteža** i **ukupna količina**, i radi i za RN-ove koji nisu u
 * view-u otvorenih operacija (v_production_operations je filtriran na
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

  /* 1) Direktno iz RN cache-a — radi bez obzira da li je RN otvoren ili zatvoren.
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
    const data = await sbReq(`bigtehn_work_orders_cache?${p.toString()}`);
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
 * @param {number[]} ids — `bigtehn_work_orders_cache.id` (npr. iz projekt_bigtehn_rn)
 * @returns {Promise<object[]>}
 */
export async function fetchBigtehnWorkOrdersByIds(ids) {
  if (!getIsOnline() || !Array.isArray(ids) || !ids.length) return [];
  const uniq = [...new Set(ids.map(n => Number(n)).filter(Number.isFinite))];
  if (!uniq.length) return [];
  const rows = await sbReq(
    `bigtehn_work_orders_cache?id=in.(${uniq.join(',')})&select=id,ident_broj,broj_crteza,naziv_dela,komada`,
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
 * Koristi se u modal-u koji se otvara klikom na 📋 pored RN-a u "Po mašini".
 * Vraća:
 *   - operations: sve linije RN-a iz v_production_operations (sa svim
 *     denormalizovanim podacima — mašina, planirano vreme, status, itd.)
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

  /* 1) Sve operacije za RN (poredak: po Operacija ASC). View već ima
     denormalizovane podatke (mašina, plan/real time, komada, status…). */
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
