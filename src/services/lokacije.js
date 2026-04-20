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
 * PATCH nad `loc_locations` (RLS: admin / leadpm / pm).
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
    /* PostgREST `or=(cond,cond)` — item_ref_id/item_ref_table/order_no su TEXT.
     * Wildcards * postaju % na server-u. URI-encode radi zbog , : . koji su PostgREST separatori. */
    const needle = `*${s}*`;
    const enc = encodeURIComponent(needle);
    parts.push(`or=(item_ref_id.ilike.${enc},item_ref_table.ilike.${enc},order_no.ilike.${enc})`);
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

/**
 * Nova master lokacija (RLS: admin / leadpm / pm).
 * @param {{ location_code: string, name: string, location_type: string, parent_id?: string|null }} row
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
      is_active: true,
    },
    { upsert: false },
  );
  if (Array.isArray(data) && data.length) return data[0];
  return data && typeof data === 'object' ? data : null;
}
