/**
 * Lokacije delova — REST/RPC nad loc_* tabelama.
 * Zahteva primenjenu migraciju sql/migrations/add_loc_module.sql.
 */

import { sbReq, sbReqWithCount } from './supabase.js';

/**
 * @returns {Promise<object[]|null>}
 */
export async function fetchLocations({ activeOnly = true } = {}) {
  let q = 'loc_locations?select=*&order=path_cached.asc';
  if (activeOnly) q += '&is_active=eq.true';
  return sbReq(q);
}

/**
 * PATCH nad `loc_locations` (RLS: `loc_can_manage_locations()` — admin / leadpm / pm / menadzment).
 * @param {string} id UUID lokacije
 * @param {Partial<{ name: string, location_type: string, parent_id: string|null, is_active: boolean, capacity_note: string, notes: string }>} patch
 * @returns {Promise<object|null>}
 */
export async function updateLocation(id, patch) {
  const q = `loc_locations?id=eq.${encodeURIComponent(id)}`;
  const data = await sbReq(q, 'PATCH', patch);
  if (Array.isArray(data) && data.length) return data[0];
  return null;
}

/**
 * Server-side pretraga + paginacija nad `loc_item_placements`.
 *
 * @param {{ limit?: number, offset?: number, wantCount?: boolean, search?: string, locationId?: string, orderNo?: string }} [opts]
 *   - `search` — case-insensitive `ilike` nad `item_ref_id`, `item_ref_table` i `order_no`
 *     (status je enum; za pretragu po statusu koristi poseban UI filter).
 *   - `locationId` — stroga jednakost `location_id=eq.UUID`.
 *   - `orderNo` — striktna jednakost `order_no=eq.<trim>` (koristi se kada se
 *     crtež zumira na konkretan radni nalog; `''` znači "bez naloga").
 * @returns {Promise<object[]|null|{rows:object[]|null,total:number|null}>}
 *   Kada je `wantCount=true` vraća `{ rows, total }` (total iz Content-Range header-a).
 */
export async function fetchPlacements({
  limit = 200,
  offset = 0,
  wantCount = false,
  search = '',
  locationId = '',
  orderNo = undefined,
} = {}) {
  const l = Math.max(1, Math.min(Number(limit) || 200, 500));
  const o = Math.max(0, Number(offset) || 0);
  const parts = [`select=*`, `order=updated_at.desc`, `limit=${l}`, `offset=${o}`];

  const s = typeof search === 'string' ? search.trim() : '';
  if (s) {
    /* PostgREST `or=(cond,cond)` — item_ref_id/item_ref_table/order_no/drawing_no su TEXT.
     * `drawing_no` (v4) je first-class kolona, pa je pretraga po crtežu direktna.
     * Wildcards * postaju % na server-u. URI-encode radi zbog , : . koji su PostgREST separatori. */
    const needle = `*${s}*`;
    const enc = encodeURIComponent(needle);
    parts.push(
      `or=(item_ref_id.ilike.${enc},item_ref_table.ilike.${enc},order_no.ilike.${enc},drawing_no.ilike.${enc})`,
    );
  }

  if (locationId && typeof locationId === 'string') {
    parts.push(`location_id=eq.${encodeURIComponent(locationId)}`);
  }
  if (typeof orderNo === 'string') {
    /* Prazan string je validna vrednost — označava "bez naloga" grupu. */
    parts.push(`order_no=eq.${encodeURIComponent(orderNo.trim())}`);
  }

  const q = `loc_item_placements?${parts.join('&')}`;
  if (wantCount) return sbReqWithCount(q);
  return sbReq(q);
}

/**
 * Iterativno povlači sve placements koje odgovaraju `search`/`locationId` (batch-ovi od `pageSize`).
 * Koristi Content-Range samo u prvom pozivu (radi performansi) da dobije ukupan broj.
 * `onProgress` se zove nakon svakog batch-a sa `{ loaded, total }`.
 *
 * Tvrdi safety cap od 50 000 zapisa da neko ne obori browser nenamerno.
 *
 * @param {{ search?: string, locationId?: string, orderNo?: string, pageSize?: number, onProgress?: (p:{loaded:number,total:number|null})=>void, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ rows: object[], total: number|null, truncated: boolean }>}
 */
export async function fetchAllPlacements({
  search = '',
  locationId = '',
  orderNo = undefined,
  pageSize = 500,
  onProgress = null,
  signal = null,
} = {}) {
  const size = Math.max(1, Math.min(Number(pageSize) || 500, 1000));
  const HARD_CAP = 50_000;
  const all = [];
  let offset = 0;
  let total = null;
  let truncated = false;

  /* eslint-disable no-constant-condition */
  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const wantCount = offset === 0;
    const res = await fetchPlacements({
      limit: size,
      offset,
      wantCount,
      search,
      locationId,
      orderNo,
    });
    const rows = wantCount ? (res && typeof res === 'object' ? res.rows : null) : res;
    if (wantCount && res && typeof res === 'object' && typeof res.total === 'number') {
      total = res.total;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (typeof onProgress === 'function') onProgress({ loaded: all.length, total });
    if (rows.length < size) break;
    if (total != null && all.length >= total) break;
    if (all.length >= HARD_CAP) {
      truncated = true;
      break;
    }
    offset += size;
  }

  return { rows: all, total, truncated };
}

/**
 * Trenutni placement-i za JEDNU stavku (item_ref_table + item_ref_id) preko svih
 * lokacija. Ako se prosledi `orderNo`, scope-uje se na taj konkretan radni nalog
 * — bitno jer isti broj crteža može biti poručen na više naloga i komadi iz
 * različitih naloga se NE smeju mešati.
 *
 * `orderNo === undefined` → vraća SVE naloge (i prazan bucket) za dati crtež,
 * korisno za generalni pregled (npr. Items tab history modal).
 * `orderNo === ''` ili neki string → striktno filtrira na taj bucket.
 *
 * Vraća rows sa {location_id, order_no, quantity, placement_status, updated_at}
 * sortirane po poslednjoj izmeni. Prazna lista znači da stavka nije smeštena.
 *
 * @param {string} itemRefTable
 * @param {string} itemRefId
 * @param {string} [orderNo]  trim-ovan — `''` je validna vrednost
 * @returns {Promise<object[]|null>}
 */
export async function fetchItemPlacements(itemRefTable, itemRefId, orderNo = undefined) {
  if (!itemRefTable || !itemRefId) return [];
  let q =
    `loc_item_placements?select=*` +
    `&item_ref_table=eq.${encodeURIComponent(itemRefTable)}` +
    `&item_ref_id=eq.${encodeURIComponent(itemRefId)}` +
    `&order=updated_at.desc`;
  if (typeof orderNo === 'string') {
    q += `&order_no=eq.${encodeURIComponent(orderNo.trim())}`;
  }
  return sbReq(q);
}

/**
 * "Pretraga po broju crteža" za mobilni `lookup` ekran i desktop items tab.
 *
 * Od v4 (add_loc_v4_drawing_no.sql) `drawing_no` je first-class TEXT kolona
 * u obe tabele (placements + movements), trigger-om i RPC-em popunjena. Zato
 * pretraga radi u JEDNOM upitu sa OR preko:
 *   a) `drawing_no ILIKE *X*`  — za sve moderne upise (RNZ i short),
 *   b) `item_ref_id ILIKE *X*` — fallback za legacy short-format placement-e
 *      koji možda nisu stigli do backfill-a (drawing_no == '').
 *
 * Dedup po `placement.id`. Red po `updated_at DESC`.
 *
 * @param {string} drawingNo  npr. "1130927" (ilike match, wildcard-ovan)
 * @returns {Promise<object[]>}
 */
export async function fetchPlacementsByDrawing(drawingNo) {
  const q = typeof drawingNo === 'string' ? drawingNo.trim() : '';
  if (!q) return [];

  const enc = encodeURIComponent(`*${q}*`);
  /* PostgREST `or=(a.ilike.X,b.ilike.X)` radi union. Limit 200 — ako neko
   * ima više od 200 istih crteža, pokažemo samo najskorije (updated_at DESC). */
  const rows = await sbReq(
    `loc_item_placements?select=*` +
      `&or=(drawing_no.ilike.${enc},item_ref_id.ilike.${enc})` +
      `&order=updated_at.desc&limit=200`,
  );
  if (!Array.isArray(rows)) return [];
  return rows;
}

/**
 * Pokušaj da izvučeš broj crteža iz placement-a. Redosled:
 *   1. `placement.drawing_no` (first-class, od v4 migracije).
 *   2. `item_ref_id` ako je u short formatu (sve su cifre, dužina 5-8).
 *   3. `notes` placement-a ('Crtež:NNN' prefix — legacy).
 *   4. Poslednji movement na placement.last_movement_id (prefix 'Crtež:NNN')
 *      kao fallback za legacy redove koji nisu stigli do backfill-a.
 *
 * Vraća `null` ako nema nijednog.
 *
 * @param {object} placement
 * @returns {Promise<string|null>}
 */
export async function resolveDrawingNoForPlacement(placement) {
  if (!placement) return null;
  /* 1) First-class kolona (od v4). */
  const direct = String(placement.drawing_no || '').trim();
  if (direct) return direct;
  /* 2) Short format: item_ref_id izgleda kao crtež. */
  const refId = String(placement.item_ref_id || '').trim();
  if (/^\d{5,8}$/.test(refId)) return refId;
  /* 3) Placement.notes — legacy. */
  const notes = String(placement.notes || '');
  const m1 = notes.match(/Crte[žz]:([^\s|]+)/);
  if (m1) return m1[1];
  /* 4) Fallback: pročitaj movement.note za last_movement_id. */
  if (placement.last_movement_id) {
    const rows = await sbReq(
      `loc_location_movements?select=note,drawing_no&id=eq.${encodeURIComponent(placement.last_movement_id)}&limit=1`,
    );
    const mv = rows?.[0];
    if (mv?.drawing_no) return String(mv.drawing_no);
    const note = String(mv?.note || '');
    const m2 = note.match(/Crte[žz]:([^\s|]+)/);
    if (m2) return m2[1];
  }
  return null;
}

/**
 * @returns {Promise<object[]|null>}
 */
export async function fetchRecentMovements(limit = 50) {
  return sbReq(
    `loc_location_movements?select=*&order=moved_at.desc&limit=${encodeURIComponent(String(limit))}`,
  );
}

/**
 * Istorija premeštanja sa filterima (paginated).
 *
 * @param {{
 *   limit?: number,
 *   offset?: number,
 *   wantCount?: boolean,
 *   search?: string,         // ilike nad item_ref_id ILI order_no
 *   userId?: string,         // moved_by eq
 *   locationId?: string,     // from OR to eq (bilo gde u tom pokretu)
 *   movementType?: string,   // eq
 *   orderNo?: string,        // striktna jednakost order_no=eq
 *   dateFrom?: string,       // ISO 'YYYY-MM-DD' — moved_at >= taj dan 00:00
 *   dateTo?: string,         // ISO 'YYYY-MM-DD' — moved_at < sledeći dan 00:00
 * }} [params]
 * @returns {Promise<object[]|{rows:object[], total:number}|null>}
 */
export async function fetchMovementsHistory({
  limit = 100,
  offset = 0,
  wantCount = false,
  search = '',
  userId = '',
  locationId = '',
  movementType = '',
  orderNo = '',
  dateFrom = '',
  dateTo = '',
} = {}) {
  const l = Math.max(1, Math.min(Number(limit) || 100, 500));
  const o = Math.max(0, Number(offset) || 0);
  const parts = [`select=*`, `order=moved_at.desc`, `limit=${l}`, `offset=${o}`];

  const s = typeof search === 'string' ? search.trim() : '';
  if (s) {
    /* Pretraga po crtežu ili nalogu — oba su TEXT i indexable. */
    const enc = encodeURIComponent(`*${s}*`);
    parts.push(`or=(item_ref_id.ilike.${enc},order_no.ilike.${enc})`);
  }
  if (userId) parts.push(`moved_by=eq.${encodeURIComponent(userId)}`);
  if (orderNo) parts.push(`order_no=eq.${encodeURIComponent(String(orderNo).trim())}`);
  if (locationId) {
    const enc = encodeURIComponent(locationId);
    parts.push(`or=(from_location_id.eq.${enc},to_location_id.eq.${enc})`);
  }
  if (movementType) parts.push(`movement_type=eq.${encodeURIComponent(movementType)}`);
  if (dateFrom) {
    const fromIso = `${dateFrom}T00:00:00`;
    parts.push(`moved_at=gte.${encodeURIComponent(fromIso)}`);
  }
  if (dateTo) {
    /* `dateTo` je inkluzivan kalendarski dan — šaljemo < (sledeći dan). */
    const d = new Date(`${dateTo}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const nextIso = d.toISOString().slice(0, 19);
    parts.push(`moved_at=lt.${encodeURIComponent(nextIso)}`);
  }

  const q = `loc_location_movements?${parts.join('&')}`;
  if (wantCount) return sbReqWithCount(q);
  return sbReq(q);
}

/**
 * Fetchuj SVE redove koji odgovaraju filterima (za CSV export). Zaustavlja
 * se na `HARD_CAP` iz sigurnosnih razloga.
 *
 * @param {Parameters<typeof fetchMovementsHistory>[0] & { pageSize?: number, onProgress?: (p: {loaded: number, total: number|null}) => void }} params
 */
export async function fetchAllMovements({
  pageSize = 500,
  onProgress = null,
  ...filters
} = {}) {
  const size = Math.max(1, Math.min(Number(pageSize) || 500, 1000));
  const HARD_CAP = 50_000;
  const all = [];
  let offset = 0;
  let total = null;
  let truncated = false;

  while (true) {
    const wantCount = offset === 0;
    const res = await fetchMovementsHistory({
      ...filters,
      limit: size,
      offset,
      wantCount,
    });
    const rows = wantCount ? (res && typeof res === 'object' ? res.rows : null) : res;
    if (wantCount && res && typeof res === 'object' && typeof res.total === 'number') {
      total = res.total;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (typeof onProgress === 'function') onProgress({ loaded: all.length, total });
    if (rows.length < size) break;
    if (total != null && all.length >= total) break;
    if (all.length >= HARD_CAP) {
      truncated = true;
      break;
    }
    offset += size;
  }

  return { rows: all, total, truncated };
}

/**
 * Istorija definisanja i izmena master lokacija (`loc_locations`).
 * Čita se kroz SECURITY DEFINER RPC zato što generički `audit_log` sadrži i
 * osetljive tabele, pa RLS ostaje admin-only za direktan pristup.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]|null>}
 */
export async function fetchLocationDefinitionsAudit({ limit = 100 } = {}) {
  const l = Math.max(1, Math.min(Number(limit) || 100, 300));
  return sbReq('rpc/loc_locations_audit', 'POST', { p_limit: l }, { upsert: false });
}

/**
 * Sva premeštanja za jednu stavku (istorija, najnovija prva). Ako je `orderNo`
 * string (uklj. prazan `''`), scope-uje se na taj nalog — inače se vraća sve
 * po svim nalozima datog crteža.
 *
 * @param {string} itemRefTable
 * @param {string} itemRefId
 * @param {number} [limit=100]
 * @param {string} [orderNo]
 * @returns {Promise<object[]|null>}
 */
export async function fetchItemMovements(itemRefTable, itemRefId, limit = 100, orderNo = undefined) {
  let q =
    `loc_location_movements?select=*` +
    `&item_ref_table=eq.${encodeURIComponent(itemRefTable)}` +
    `&item_ref_id=eq.${encodeURIComponent(itemRefId)}` +
    `&order=moved_at.desc&limit=${encodeURIComponent(String(limit))}`;
  if (typeof orderNo === 'string') {
    q += `&order_no=eq.${encodeURIComponent(orderNo.trim())}`;
  }
  return sbReq(q);
}

/**
 * Samo admin (RLS) — inače null.
 * @returns {Promise<object[]|null>}
 */
export async function fetchSyncOutboundEvents(limit = 80) {
  return sbReq(
    `loc_sync_outbound_events?select=*&order=created_at.desc&limit=${encodeURIComponent(String(limit))}`,
  );
}

/**
 * @param {object} payload — item_ref_table, item_ref_id, to_location_id, movement_type, opciono from_location_id, note, movement_reason
 * @returns {Promise<{ ok?: boolean, id?: string, error?: string }|null>}
 */
export async function locCreateMovement(payload) {
  const row = await sbReq('rpc/loc_create_movement', 'POST', { payload: payload || {} });
  if (!row || typeof row !== 'object') return null;
  return row;
}

const LOC_REPORT_SORT_WHITELIST = new Set([
  'updated_at',
  'drawing_no',
  'order_no',
  'location_code',
  'qty_on_location',
  'customer_name',
  'project_code',
  'item_ref_id',
  'rok_izrade',
]);

/**
 * Pregled delova po lokacijama — RPC `loc_report_parts_by_locations`.
 * Migracija: `sql/migrations/add_loc_report_by_locations_rpc.sql`.
 *
 * @param {{
 *   drawingNo?: string,
 *   orderNo?: string,
 *   tpNo?: string,
 *   projectSearch?: string,
 *   locationId?: string,
 *   locationQ?: string,
 *   sort?: string,
 *   desc?: boolean,
 *   limit?: number,
 *   offset?: number,
 * }} [params]
 * @returns {Promise<{ total: number, rows: object[] }|null>}
 */
export async function fetchLocReportPartsByLocations(params = {}) {
  const body = {};
  const d = params.drawingNo;
  if (d != null && String(d).trim() !== '') body.p_drawing_no = String(d).trim();
  const o = params.orderNo;
  if (o != null && String(o).trim() !== '') body.p_order_no = String(o).trim();
  const t = params.tpNo;
  if (t != null && String(t).trim() !== '') body.p_tp_no = String(t).trim();
  const ps = params.projectSearch;
  if (ps != null && String(ps).trim() !== '') body.p_project_search = String(ps).trim();
  if (params.locationId && typeof params.locationId === 'string') {
    const u = params.locationId.trim().toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(u)) {
      body.p_location_id = u;
    }
  }
  const lq = params.locationQ;
  if (lq != null && String(lq).trim() !== '') body.p_location_q = String(lq).trim();

  const sortRaw = typeof params.sort === 'string' ? params.sort.trim().toLowerCase() : 'updated_at';
  body.p_sort = LOC_REPORT_SORT_WHITELIST.has(sortRaw) ? sortRaw : 'updated_at';
  body.p_desc = params.desc !== false;

  const lim = Math.max(1, Math.min(Number(params.limit) || 50, 500));
  const off = Math.max(0, Number(params.offset) || 0);
  body.p_limit = lim;
  body.p_offset = off;

  const res = await sbReq('rpc/loc_report_parts_by_locations', 'POST', body, { upsert: false });
  if (!res || typeof res !== 'object') return null;
  const total = typeof res.total === 'number' ? res.total : Number(res.total) || 0;
  const rows = Array.isArray(res.rows) ? res.rows : [];
  return { total, rows };
}

/**
 * @param {Parameters<typeof fetchLocReportPartsByLocations>[0]} filters
 * @param {{ pageSize?: number, onProgress?: (p: { loaded: number, total: number|null }) => void, signal?: AbortSignal }} [opts]
 */
export async function fetchAllLocReportPartsByLocations(filters = {}, opts = {}) {
  const size = Math.max(1, Math.min(Number(opts.pageSize) || 500, 500));
  const HARD_CAP = 50_000;
  const all = [];
  let offset = 0;
  let total = null;
  let truncated = false;
  const { onProgress, signal } = opts;

  while (true) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await fetchLocReportPartsByLocations({
      ...filters,
      limit: size,
      offset,
    });
    if (!res) break;
    if (typeof res.total === 'number') total = res.total;
    const chunk = res.rows || [];
    if (!chunk.length) break;
    all.push(...chunk);
    if (typeof onProgress === 'function') onProgress({ loaded: all.length, total });
    if (chunk.length < size) break;
    if (total != null && all.length >= total) break;
    if (all.length >= HARD_CAP) {
      truncated = true;
      break;
    }
    offset += size;
  }

  return { rows: all, total, truncated };
}

/**
 * BigTehn lookup helper — pretraga aktivnih radnih naloga po broju
 * crteža/RN/nazivu.
 * Čita `v_active_bigtehn_work_orders`, tj. ručnu MES listu aktivnih RN-ova.
 *
 * @param {string} q  bilo koji od: deo broja crteža, ident_broj, naziv dela
 * @param {number} [limit=50]
 * @returns {Promise<object[]>}
 */
export async function searchBigtehnWorkOrders(q, limit = 50) {
  const s = typeof q === 'string' ? q.trim() : '';
  if (!s) return [];
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const enc = encodeURIComponent(`*${s}*`);
  const sel =
    'id,ident_broj,broj_crteza,naziv_dela,materijal,dimenzija_materijala,komada,tezina_obr,status_rn,revizija,rok_izrade,customer_id,is_mes_active';
  const path =
    `v_active_bigtehn_work_orders?select=${sel}` +
    `&or=(broj_crteza.ilike.${enc},ident_broj.ilike.${enc},naziv_dela.ilike.${enc})` +
    `&order=modified_at.desc&limit=${lim}`;
  const rows = await sbReq(path);
  return Array.isArray(rows) ? rows : [];
}

/**
 * BigTehn lookup helper — pretraga predmeta (`bigtehn_items_cache`).
 *
 * Po default-u vraća samo aktuelne, nezatvorene predmete
 * (`status='U TOKU' AND datum_zakljucenja IS NULL`) — usklađeno sa
 * dropdown-om „Predmet" u modulu Lokacije. Pretraga ide po broju predmeta,
 * nazivu, ugovoru i narudžbenici.
 *
 * Komitent (`customer_name`) se DOVLAČI POSEBNIM UPITOM nad
 * `bigtehn_customers_cache` jer u Supabase šemi NE postoji FK constraint
 * između `bigtehn_items_cache.customer_id` i `bigtehn_customers_cache.id`,
 * pa PostgREST embedded select (`customer:bigtehn_customers_cache(...)`)
 * vraća 400 i sve pretrage padaju. Posebnim upitom je sigurno i brzo.
 *
 * @param {string} q  deo broja predmeta ili naziva (može biti '' za prvih `limit` aktuelnih)
 * @param {number} [limit=50]
 * @param {{ onlyActive?: boolean }} [opts]
 *   - `onlyActive` (default `true`) — filter `status='U TOKU' AND datum_zakljucenja IS NULL`
 * @returns {Promise<object[]>}
 *   Svaki red: `{ id, broj_predmeta, naziv_predmeta, opis, status, broj_ugovora,
 *   broj_narudzbenice, rok_zavrsetka, modified_at, customer_id, customer_name }`.
 */
export async function searchBigtehnItems(q, limit = 50, { onlyActive = true } = {}) {
  const s = typeof q === 'string' ? q.trim() : '';
  const lim = Math.max(1, Math.min(Number(limit) || 50, 200));
  const sel =
    'id,broj_predmeta,naziv_predmeta,opis,status,department_code,broj_ugovora,broj_narudzbenice,' +
    'rok_zavrsetka,modified_at,datum_zakljucenja,customer_id';
  const parts = [`select=${sel}`, `order=modified_at.desc.nullslast`, `limit=${lim}`];
  if (s) {
    const enc = encodeURIComponent(`*${s}*`);
    parts.push(
      `or=(broj_predmeta.ilike.${enc},naziv_predmeta.ilike.${enc},broj_ugovora.ilike.${enc},broj_narudzbenice.ilike.${enc})`,
    );
  }
  if (onlyActive) {
    parts.push(`status=eq.U TOKU`);
    parts.push(`datum_zakljucenja=is.null`);
  }
  const path = `bigtehn_items_cache?${parts.join('&')}`;
  const rows = await sbReq(path);
  if (!Array.isArray(rows)) return [];

  /* Dovuci samo komitente koje stvarno trebamo (deduped). Tihi fallback ako
   * tabela nije dostupna — ime komitenta je kozmetički (UI svejedno radi). */
  const custIds = Array.from(
    new Set(rows.map(r => r.customer_id).filter(v => v != null)),
  );
  let custMap = new Map();
  if (custIds.length) {
    try {
      const idList = custIds.join(',');
      const custRows = await sbReq(
        `bigtehn_customers_cache?select=id,name,short_name&id=in.(${idList})&limit=${custIds.length}`,
      );
      if (Array.isArray(custRows)) {
        custMap = new Map(custRows.map(c => [c.id, c]));
      }
    } catch {
      /* ignore — komitent je opcionalno polje za prikaz */
    }
  }

  return rows.map(r => {
    const c = r.customer_id != null ? custMap.get(r.customer_id) : null;
    return {
      ...r,
      customer_name: c?.short_name || c?.name || '',
    };
  });
}

/**
 * Lista DISTINCT TP-ova (radnih naloga) za jedan Predmet, direktno iz
 * `v_active_bigtehn_work_orders` — bez placement-a, namenjen pickerima
 * (npr. modal za štampu nalepnica). Uvek prikazuje samo ručno aktivne
 * RN-ove; `onlyOpen` je zadržan samo radi backward-compat poziva.
 *
 * @param {number|string} itemId  bigtehn_items_cache.id
 * @param {{ onlyOpen?: boolean, search?: string, limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function searchBigtehnWorkOrdersForItem(itemId, opts = {}) {
  const idNum = Number(itemId);
  if (!Number.isFinite(idNum) || idNum <= 0) return [];
  const lim = Math.max(1, Math.min(Number(opts.limit) || 200, 1000));
  const sel =
    'id,ident_broj,broj_crteza,naziv_dela,materijal,dimenzija_materijala,jedinica_mere,komada,tezina_obr,status_rn,revizija,rok_izrade,is_mes_active';
  const parts = [
    `select=${sel}`,
    `item_id=eq.${idNum}`,
    `order=ident_broj.asc`,
    `limit=${lim}`,
  ];
  if (opts.search && String(opts.search).trim()) {
    const enc = encodeURIComponent(`*${String(opts.search).trim()}*`);
    parts.push(
      `or=(ident_broj.ilike.${enc},broj_crteza.ilike.${enc},naziv_dela.ilike.${enc})`,
    );
  }
  const rows = await sbReq(`v_active_bigtehn_work_orders?${parts.join('&')}`);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Učitaj sve aktivne TP-ove (radne naloge) za jedan Predmet sa pridruženim
 * placement-ima. Wrapper oko RPC `loc_tps_for_predmet` (v2).
 *
 * Migracija: `sql/migrations/add_loc_tps_for_predmet_rpc_v2.sql`.
 *
 * Vraća jedan red po (TP × placement). Ako TP nema placement → 1 red sa
 * praznim location_*. Ako TP ima više placement-a (na više polica) → više
 * redova. Po default-u skriva TP-ove čiji su SVI placement-i na lokaciji
 * tipa `ASSEMBLY`/`SCRAPPED` (ugrađeno/otpisano) jer ti više nisu u radu.
 *
 * Server-side filteri (v2):
 *   - `tpNo`           → ILIKE na drugi deo `ident_broj`-a (npr. "1088")
 *   - `drawingNo`      → ILIKE na `wo_broj_crteza`
 *   - `locationFilter` → 'with' = samo TP sa placement-om, 'without' = bez,
 *                        'all'/undefined = svi
 *
 * @param {number|string} itemId  bigtehn_items_cache.id
 * @param {{
 *   onlyOpen?: boolean, // legacy: RPC sada uvek koristi ručnu MES aktivnost
 *   includeAssembled?: boolean,
 *   tpNo?: string,
 *   drawingNo?: string,
 *   locationFilter?: 'all'|'with'|'without',
 *   limit?: number,
 *   offset?: number,
 * }} [opts]
 * @returns {Promise<{ total: number, rows: object[] }|null>}
 */
export async function fetchTpsForPredmet(itemId, opts = {}) {
  const idNum = Number(itemId);
  if (!Number.isFinite(idNum) || idNum <= 0) return { total: 0, rows: [] };
  const tp = typeof opts.tpNo === 'string' ? opts.tpNo.trim() : '';
  const dr = typeof opts.drawingNo === 'string' ? opts.drawingNo.trim() : '';
  const lf = typeof opts.locationFilter === 'string'
    ? opts.locationFilter.toLowerCase()
    : 'all';
  const body = {
    p_item_id: idNum,
    p_only_open: true,
    p_include_assembled: !!opts.includeAssembled,
    p_tp_no: tp ? tp : null,
    p_drawing_no: dr ? dr : null,
    p_location_filter: ['with', 'without', 'all'].includes(lf) ? lf : 'all',
    p_limit: Math.max(1, Math.min(Number(opts.limit) || 100, 1000)),
    p_offset: Math.max(0, Number(opts.offset) || 0),
  };
  const res = await sbReq('rpc/loc_tps_for_predmet', 'POST', body, { upsert: false });
  if (!res || typeof res !== 'object') return null;
  const total = typeof res.total === 'number' ? res.total : Number(res.total) || 0;
  const rows = Array.isArray(res.rows) ? res.rows : [];
  return { total, rows };
}

/**
 * Vraća `last_finished` po BRIDGE sync job-u — koristi se za banner upozorenja
 * (npr. „bigtehn_drawings_cache je star X dana”). Read-only nad `bridge_sync_log`,
 * koji je dostupan svim ulogovanim korisnicima.
 *
 * @returns {Promise<Array<{ sync_job: string, last_finished: string, status: string }>>}
 */
export async function fetchBridgeSyncStatus() {
  /* PostgREST nema GROUP BY direktno — uzimamo poslednjih 200 redova i agregiramo
   * na klijentu. Bridge job-ovi se ponavljaju često (svakih 15 min), 200 je
   * pokriva za svih 16 job-ova. */
  const rows = await sbReq(
    `bridge_sync_log?select=sync_job,finished_at,status&order=finished_at.desc&limit=200`,
  );
  if (!Array.isArray(rows)) return [];
  const seen = new Map();
  for (const r of rows) {
    if (!r || !r.sync_job) continue;
    if (!seen.has(r.sync_job)) {
      seen.set(r.sync_job, {
        sync_job: r.sync_job,
        last_finished: r.finished_at,
        status: r.status,
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Nova master lokacija (RLS: admin / leadpm / pm / menadzment).
 * @param {{ location_code: string, name: string, location_type: string, parent_id?: string|null, capacity_note?: string|null, notes?: string|null }} row
 * @returns {Promise<object|null>}
 */
export async function createLocation(row) {
  const data = await sbReq(
    'loc_locations',
    'POST',
    {
      location_code: row.location_code,
      name: row.name,
      location_type: row.location_type,
      parent_id: row.parent_id || null,
      capacity_note: row.capacity_note || null,
      notes: row.notes || null,
      is_active: true,
    },
    { upsert: false },
  );
  if (Array.isArray(data) && data.length) return data[0];
  return data && typeof data === 'object' ? data : null;
}
