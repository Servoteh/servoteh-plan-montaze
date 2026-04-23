/**
 * Plan Proizvodnje — grupisanje mašina po proizvodnoj tehnologiji.
 *
 * Source of truth: `bigtehn_machines_cache` (rj_code, name, department_id,
 * no_procedure). Bridge sync (BigTehn → Supabase) puni tu tabelu, a ovde u
 * čisto klijentskoj mapi tih ~100 mašina grupišemo u proizvodne kategorije
 * koje šef mašinske obrade prepoznaje (Glodanje, Borverci, Struganje…).
 *
 * Zašto klijentska mapa, a ne nova SQL tabela:
 *   - Zero-touch baza: ne diramo BigTehn šemu niti novu app-tabelu — sve
 *     već postoji u poljima `department_id` i `rj_code`.
 *   - Brz feedback loop: promena grupe = jedan commit + Vite HMR, bez
 *     migracije.
 *   - Mali broj grupa (16 + Ostalo) — overkill je raditi DB CRUD UI za to.
 *   - Lako za testiranje (čista funkcija + statičan input iz baze).
 *
 * Pravila grupisanja:
 *   - Grupišemo prevashodno po `department_id` (npr. '02' = Struganje).
 *   - Tri izuzetka su rečnik koji menadžment koristi a ne stoji čisto u
 *     odeljenju:
 *       1. „Borverci"   — po `rj_code` (TOS WHN 13: '3.21' i '3.22'),
 *          inače bi se izgubili u 22 mašine glodanja.
 *       2. „Zavarivanje" — `rj_code` koji počinje sa '4.2' / '4.3' / '4.4'
 *          (MIG-MAG, REL, TIG); odeljenje 04 inače meša bravarske i
 *          bušilice.
 *       3. „Bušenje"    — `rj_code` '4.1' (Savijanje), '4.11', '4.12'
 *          (manuelno + radijalna bušilica).
 *
 *   - Sve što ne uđe ni u jednu grupu hvata fallback „Ostalo" da nijedna
 *     mašina nikad ne bude nevidljiva.
 *
 * Redosled u UI je proizvodno-tehnološki tok od najčešćih operacija
 * (glodanje) do najređih (kooperacija). „Sve" je default.
 *
 * Public API:
 *   MACHINE_GROUPS                 — niz konfigova {id, label, match}
 *   getMachineGroup(machine)       — vrati id grupe za jednu mašinu
 *   filterMachinesByGroup(machines, groupId)   — filtriraj listu
 *   countMachinesPerGroup(machines)            — Map<groupId, broj>
 *   sortMachinesByGroupOrder(machines)         — sort po redosledu grupa
 */

/** rj_code-ovi koji se tretiraju kao Borverci (subset glodanja). */
const BORVER_RJ_CODES = new Set(['3.21', '3.22']);

/** rj_code-ovi za Bušenje (i Bravari/Savijanje koji idu uz njih). */
const BUSENJE_RJ_CODES = new Set(['4.1', '4.11', '4.12']);

/** rj_code prefiks za Zavarivanje (MIG-MAG, REL, TIG). */
function isZavarivanjeRj(rj) {
  return /^4\.(2|3|4)(\D|$)/.test(rj || '');
}

/**
 * Konfiguracija grupa. Redosled u nizu = redosled u UI chip-bar-u.
 * `match(machine)` mora biti čista funkcija nad poljima `rj_code` i
 * `department_id`. Prva grupa koja vrati true uzima mašinu — zato je redosled
 * bitan: specifične grupe (Borverci) idu pre širih (Glodanje).
 */
export const MACHINE_GROUPS = [
  {
    id: 'all',
    label: 'Sve',
    match: () => true,
  },
  {
    id: 'glodanje',
    label: 'Glodanje',
    match: (m) =>
      m?.department_id === '03' &&
      !BORVER_RJ_CODES.has(String(m?.rj_code || '')),
  },
  {
    id: 'borverci',
    label: 'Borverci',
    match: (m) => BORVER_RJ_CODES.has(String(m?.rj_code || '')),
  },
  {
    id: 'struganje',
    label: 'Struganje',
    match: (m) => m?.department_id === '02',
  },
  {
    id: 'erodiranje',
    label: 'Erodiranje',
    match: (m) => m?.department_id === '10',
  },
  {
    id: 'brusenje',
    label: 'Brušenje',
    match: (m) => m?.department_id === '06',
  },
  {
    id: 'secenje',
    label: 'Sečenje',
    match: (m) => m?.department_id === '01',
  },
  {
    id: 'apkant',
    label: 'Apkant presa',
    match: (m) => m?.department_id === '15',
  },
  {
    id: 'busenje',
    label: 'Bušenje / Bravari',
    match: (m) => BUSENJE_RJ_CODES.has(String(m?.rj_code || '')),
  },
  {
    id: 'zavarivanje',
    label: 'Zavarivanje',
    match: (m) => isZavarivanjeRj(String(m?.rj_code || '')),
  },
  {
    id: 'termicka',
    label: 'Termička obrada',
    match: (m) => m?.department_id === '07',
  },
  {
    id: 'farbanje',
    label: 'Farbanje / Površinska zaštita',
    match: (m) =>
      m?.department_id === '05' || String(m?.rj_code || '') === '5.11',
  },
  {
    id: 'montaza',
    label: 'Montaža / Kontrola',
    match: (m) => m?.department_id === '08',
  },
  {
    id: '3d',
    label: '3D štampanje',
    match: (m) => m?.department_id === '21',
  },
  {
    id: 'cam',
    label: 'CAM Programiranje',
    match: (m) => m?.department_id === '17',
  },
  {
    id: 'kooperacija',
    label: 'Kooperacija / Nabavka',
    match: (m) => {
      const rj = String(m?.rj_code || '');
      return rj === '9.0' || rj === '9.1';
    },
  },
  {
    id: 'ostalo',
    label: 'Ostalo',
    match: () => true,
  },
];

const GROUP_BY_ID = new Map(MACHINE_GROUPS.map((g) => [g.id, g]));
const GROUP_ORDER = new Map(MACHINE_GROUPS.map((g, i) => [g.id, i]));

/* Specifične grupe (sve osim 'all' i 'ostalo') po redosledu — koristimo
 * ih za rezolvuciju kojoj grupi mašina pripada. „Sve" hvata sve i ne sme
 * biti deo te rezolucije, „Ostalo" je fallback na kraju. */
const SPECIFIC_GROUPS = MACHINE_GROUPS.filter(
  (g) => g.id !== 'all' && g.id !== 'ostalo',
);

/**
 * Vrati id grupe kojoj mašina pripada (specifičnoj). Ako ni jedna ne uhvati
 * — `'ostalo'`. Nikad ne vraća `'all'` (to je virtuelna grupa „prikaži sve").
 *
 * @param {{rj_code?: string, department_id?: string|null}|null} machine
 * @returns {string} group id
 */
export function getMachineGroup(machine) {
  if (!machine) return 'ostalo';
  for (const g of SPECIFIC_GROUPS) {
    if (g.match(machine)) return g.id;
  }
  return 'ostalo';
}

/**
 * @param {Array<object>} machines
 * @param {string} groupId
 * @returns {Array<object>}
 */
export function filterMachinesByGroup(machines, groupId) {
  if (!Array.isArray(machines)) return [];
  if (!groupId || groupId === 'all') return machines.slice();
  const g = GROUP_BY_ID.get(groupId);
  if (!g) return machines.slice();
  if (groupId === 'ostalo') {
    return machines.filter((m) => getMachineGroup(m) === 'ostalo');
  }
  return machines.filter((m) => g.match(m));
}

/**
 * Broj mašina po grupi. Mašina ulazi u tačno jednu specifičnu grupu (ili
 * 'ostalo'). Grupa 'all' je ukupno (uvek = machines.length).
 *
 * @param {Array<object>} machines
 * @returns {Map<string, number>}
 */
export function countMachinesPerGroup(machines) {
  const counts = new Map(MACHINE_GROUPS.map((g) => [g.id, 0]));
  if (!Array.isArray(machines)) return counts;
  counts.set('all', machines.length);
  for (const m of machines) {
    const id = getMachineGroup(m);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/**
 * Sort mašina tako da se prvo prikazuju mašine iz „prirodne" tehnološke
 * grupe po redosledu definicije (Glodanje, Borverci, Struganje…), pa onda
 * po `rj_code` natural-sort unutar grupe.
 *
 * Ovo se koristi i za dropdown mašina i za listu chip-ova — da se vizuelno
 * poklapa redosled.
 *
 * @param {Array<object>} machines
 * @returns {Array<object>}
 */
export function sortMachinesByGroupOrder(machines) {
  if (!Array.isArray(machines)) return [];
  return machines.slice().sort((a, b) => {
    const ga = GROUP_ORDER.get(getMachineGroup(a)) ?? 9999;
    const gb = GROUP_ORDER.get(getMachineGroup(b)) ?? 9999;
    if (ga !== gb) return ga - gb;
    return String(a?.rj_code || '').localeCompare(
      String(b?.rj_code || ''),
      'sr',
      { numeric: true, sensitivity: 'base' },
    );
  });
}

/**
 * @param {string} groupId
 * @returns {string}
 */
export function machineGroupLabel(groupId) {
  return GROUP_BY_ID.get(groupId)?.label || 'Sve';
}
