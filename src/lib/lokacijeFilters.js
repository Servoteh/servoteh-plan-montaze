/**
 * Pure helperi za pretragu/filtere u modulu Lokacije — bez DOM-a, lako se testiraju.
 *
 * Sve funkcije su case-insensitive i trimuju upit.
 */

/**
 * Normalizuje upit: trim + lowercase. Vraća prazan string ako je vrednost nevalidna.
 * @param {unknown} q
 * @returns {string}
 */
export function normalizeQuery(q) {
  if (q == null) return '';
  return String(q).trim().toLowerCase();
}

/**
 * Da li lokacija odgovara upitu (šifra / naziv / path_cached).
 * @param {{ location_code?: string, name?: string, path_cached?: string }} loc
 * @param {string} q  već normalizovan upit (lowercase)
 */
export function locationMatches(loc, q) {
  if (!q) return true;
  if (!loc || typeof loc !== 'object') return false;
  const code = (loc.location_code || '').toLowerCase();
  const name = (loc.name || '').toLowerCase();
  const path = (loc.path_cached || '').toLowerCase();
  return code.includes(q) || name.includes(q) || path.includes(q);
}

/**
 * Filtrira flat listu lokacija i VRAĆA JOŠ sve pretke match-ova (da hijerarhija ne "raspadne").
 * Dobijena lista čuva originalni redosled.
 *
 * @param {Array<{ id: string, parent_id?: string|null }>} locs flat lista sortirana po path_cached
 * @param {string} query sirovi upit iz inputa
 */
export function filterLocationsHierarchical(locs, query) {
  const q = normalizeQuery(query);
  if (!q) return Array.isArray(locs) ? locs.slice() : [];
  if (!Array.isArray(locs) || locs.length === 0) return [];

  const byId = new Map(locs.map(l => [l.id, l]));
  const keep = new Set();

  for (const loc of locs) {
    if (!locationMatches(loc, q)) continue;
    /* Uključi i sve pretke, da stablo/tabela zadrže kontekst putanje. */
    let cur = loc;
    while (cur && !keep.has(cur.id)) {
      keep.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
  }

  return locs.filter(l => keep.has(l.id));
}

const LOC_SORTS = new Set(['code_asc', 'code_desc', 'name_asc', 'name_desc', 'kind_asc', 'kind_desc']);

function collate(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'sr', {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Sortira lokacije client-side, bez mutiranja ulaznog niza.
 * @param {Array<{ location_code?: string, name?: string, location_type?: string, path_cached?: string }>} locs
 * @param {string} sortKey
 */
export function sortLocations(locs, sortKey = 'code_asc') {
  if (!Array.isArray(locs)) return [];
  const key = LOC_SORTS.has(sortKey) ? sortKey : 'code_asc';
  const rows = locs.slice();
  rows.sort((a, b) => {
    if (key === 'code_desc') return collate(b?.location_code, a?.location_code);
    if (key === 'name_asc') return collate(a?.name, b?.name) || collate(a?.location_code, b?.location_code);
    if (key === 'name_desc') return collate(b?.name, a?.name) || collate(a?.location_code, b?.location_code);
    if (key === 'kind_desc') {
      return collate(b?.location_type, a?.location_type)
        || collate(a?.location_code, b?.location_code);
    }
    if (key === 'kind_asc') {
      return collate(a?.location_type, b?.location_type)
        || collate(a?.location_code, b?.location_code);
    }
    return collate(a?.location_code, b?.location_code);
  });
  return rows;
}

/**
 * Da li placement (sa pridruženim location/code) odgovara upitu.
 *
 * @param {{ item_ref_table?: string, item_ref_id?: string, placement_status?: string, location_id?: string }} p
 * @param {Map<string, { location_code?: string, name?: string }>} locIdx
 * @param {string} q  već normalizovan upit
 */
export function placementMatches(p, locIdx, q) {
  if (!q) return true;
  if (!p || typeof p !== 'object') return false;
  const tbl = (p.item_ref_table || '').toLowerCase();
  const iid = (p.item_ref_id || '').toLowerCase();
  const st = (p.placement_status || '').toLowerCase();
  if (tbl.includes(q) || iid.includes(q) || st.includes(q)) return true;
  const loc = locIdx && p.location_id ? locIdx.get(p.location_id) : null;
  if (!loc) return false;
  const code = (loc.location_code || '').toLowerCase();
  const name = (loc.name || '').toLowerCase();
  return code.includes(q) || name.includes(q);
}

/**
 * Filtrira listu placements-a koristeći pridruženi mapirani locIdx.
 *
 * @param {Array<object>} placements
 * @param {Map<string, object>} locIdx
 * @param {string} query
 */
export function filterPlacements(placements, locIdx, query) {
  const q = normalizeQuery(query);
  if (!q) return Array.isArray(placements) ? placements.slice() : [];
  if (!Array.isArray(placements)) return [];
  return placements.filter(p => placementMatches(p, locIdx, q));
}
