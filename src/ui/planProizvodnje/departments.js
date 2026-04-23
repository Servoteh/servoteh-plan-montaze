/**
 * Plan Proizvodnje — definicija odeljenja (tabovi „Po mašini"-ja).
 *
 * Single source of truth za TAB → filter mapiranje. Filter je
 * **kod-based** (rj_code mašine / effective_machine_code operacije)
 * sa name-match fallback-om samo za Bravarsko.
 *
 * Dva tipa tabova:
 *   - kind:'machines'   — prikazuje LISTU mašina (sortirano numerički po
 *                         rj_code), klik na mašinu → drill-down na operacije
 *                         te mašine. Filter: prefiks rj_code-a.
 *   - kind:'operations' — direktno prikazuje listu operacija (nema mašine).
 *                         Filter: exact / prefiks effective_machine_code-a
 *                         ili pattern na opis_rada (Bravarsko).
 *   - kind:'all'        — „Sve" (dropdown + ops, kao do sada) ili „Ostalo"
 *                         (safety bucket — sve što ne mečuje nigde drugde).
 *
 * Vidi `docs/Planiranje_proizvodnje_modul.md` → „Tabovi (UI)".
 */

export const DEPARTMENTS = [
  {
    slug: 'sve',
    label: 'Sve',
    kind: 'all',
  },
  {
    slug: 'glodanje',
    label: 'Glodanje',
    kind: 'machines',
    machinePrefixes: ['3'],
  },
  {
    slug: 'struganje',
    label: 'Struganje',
    kind: 'machines',
    machinePrefixes: ['2'],
  },
  {
    slug: 'brusenje',
    label: 'Brušenje',
    kind: 'machines',
    machinePrefixes: ['6'],
  },
  {
    slug: 'erodiranje',
    label: 'Erodiranje',
    kind: 'machines',
    machinePrefixes: ['10'],
  },
  {
    slug: 'azistiranje',
    label: 'Ažistiranje',
    kind: 'operations',
    operationExact: ['8.2'],
  },
  {
    slug: 'secenje',
    label: 'Sečenje i savijanje',
    kind: 'operations',
    operationPrefixes: ['1', '4'],
  },
  {
    slug: 'bravarsko',
    label: 'Bravarsko',
    kind: 'operations',
    operationNamePatterns: ['bravar', 'zavariv'],
  },
  {
    slug: 'farbanje',
    label: 'Farbanje i površinska zaštita',
    kind: 'operations',
    operationPrefixes: ['5'],
  },
  {
    slug: 'cam',
    label: 'CAM programiranje',
    kind: 'operations',
    operationPrefixes: ['17'],
  },
  {
    slug: 'ostalo',
    label: 'Ostalo',
    kind: 'all',
    isFallback: true,
  },
];

/* ── Helpers ── */

const stripDiacritics = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/**
 * „3.21" → „3", „10" → „10", „" → null.
 * Vrati prefiks koda pre prve tačke (ili ceo kod ako nema tačku).
 */
export function codePrefix(code) {
  if (!code) return null;
  const s = String(code);
  const dot = s.indexOf('.');
  return dot < 0 ? s : s.slice(0, dot);
}

/**
 * Numeričko poređenje kodova „X.Y.Z" — segment-po-segment kao integeri.
 * Tako „3.2" dolazi PRE „3.11" (jer je 2 < 11), što je očekivani redosled
 * za numeračije RC-a (user explicitno tražio: „3.11, 3.12, … 3.21, 3.22").
 */
export function compareCodes(a, b) {
  const pa = String(a || '').split('.').map(s => parseInt(s, 10) || 0);
  const pb = String(b || '').split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Vrati definiciju odeljenja po slug-u, ili null ako ne postoji.
 */
export function getDepartment(slug) {
  return DEPARTMENTS.find(d => d.slug === slug) || null;
}

/**
 * Da li mašina (objekat sa `rj_code`) pripada datom odeljenju?
 * - „sve" → uvek true (ali 'sve' tab tipično ne koristi listu mašina).
 * - kind:'machines' → da ako prefiks `rj_code`-a matchuje `machinePrefixes`.
 * - inače → false (operacioni tab nema mašine; 'ostalo' fallback rešava
 *   se kroz `machineFallsIntoOstalo`).
 */
export function machineMatchesDept(machine, dept) {
  if (!dept) return false;
  if (dept.kind === 'all' && !dept.isFallback) return true;
  if (!Array.isArray(dept.machinePrefixes)) return false;
  const prefix = codePrefix(machine?.rj_code);
  return dept.machinePrefixes.includes(prefix);
}

/**
 * Da li operacija (objekat sa `effective_machine_code` i `opis_rada`)
 * pripada datom odeljenju?
 *
 * Redosled provere: exact → prefix → name-pattern (sve case-insensitive,
 * bez dijakritike za name-match).
 */
export function operationMatchesDept(op, dept) {
  if (!dept) return false;
  if (dept.kind === 'all' && !dept.isFallback) return true;

  if (
    Array.isArray(dept.operationExact) &&
    dept.operationExact.includes(op?.effective_machine_code)
  ) {
    return true;
  }

  if (Array.isArray(dept.operationPrefixes)) {
    const prefix = codePrefix(op?.effective_machine_code);
    if (dept.operationPrefixes.includes(prefix)) return true;
  }

  if (Array.isArray(dept.operationNamePatterns)) {
    const name = stripDiacritics(op?.opis_rada);
    if (dept.operationNamePatterns.some(p => name.includes(stripDiacritics(p)))) {
      return true;
    }
  }

  return false;
}

/**
 * Mašina koja ne pripada NIJEDNOM `machines` departmentu → ide u „Ostalo".
 * Operacioni tabovi se ne razmatraju — oni nemaju listu mašina.
 */
export function machineFallsIntoOstalo(machine) {
  const machineDepts = DEPARTMENTS.filter(d => d.kind === 'machines');
  return !machineDepts.some(d => machineMatchesDept(machine, d));
}

/**
 * Operacija koja ne pripada NIJEDNOM specifičnom tabu → ide u „Ostalo".
 *
 * Razmatra:
 *   - sve `operations` tabove (preko `operationMatchesDept`)
 *   - sve `machines` tabove (operacija „pripada" mašinskom tabu ako joj
 *     `effective_machine_code` ima prefiks tog odeljenja)
 */
export function operationFallsIntoOstalo(op) {
  const opPrefix = codePrefix(op?.effective_machine_code);
  const specific = DEPARTMENTS.filter(
    d => d.kind === 'operations' || d.kind === 'machines',
  );
  return !specific.some(d => {
    if (d.kind === 'operations') return operationMatchesDept(op, d);
    return Array.isArray(d.machinePrefixes) && d.machinePrefixes.includes(opPrefix);
  });
}

/**
 * Filtriraj listu mašina za dati odeljenje (čisto client-side).
 * - „sve" → vraća sve mašine (sortirane po nameu, kako stižu iz servisa).
 * - „ostalo" → mašine koje ne upadaju ni u jedan mašinski tab.
 * - kind:'machines' → match po prefiksu, sortirano numerički po rj_code.
 * - kind:'operations' → prazan niz (operacioni tabovi nemaju mašine).
 */
export function filterMachinesForDept(allMachines, dept) {
  if (!Array.isArray(allMachines)) return [];
  if (!dept) return [];
  if (dept.kind === 'all' && !dept.isFallback) return allMachines.slice();
  if (dept.isFallback) {
    return allMachines
      .filter(m => machineFallsIntoOstalo(m))
      .sort((a, b) => compareCodes(a.rj_code, b.rj_code));
  }
  if (dept.kind === 'machines') {
    return allMachines
      .filter(m => machineMatchesDept(m, dept))
      .sort((a, b) => compareCodes(a.rj_code, b.rj_code));
  }
  return [];
}

/**
 * Pronađi slug `machines` taba kome mašina pripada (po `rj_code` prefiksu).
 * Vraća slug taba ili `'ostalo'` ako mašina ne upada nigde.
 *
 * Korisi se npr. za skok iz „Zauzetost" / „Pregled svih" — kada user klikne
 * mašinu, treba znati koji tab da otvori u „Po mašini".
 */
export function findDeptForMachineCode(rjCode) {
  if (!rjCode) return 'sve';
  const m = { rj_code: rjCode };
  const hit = DEPARTMENTS.find(d => d.kind === 'machines' && machineMatchesDept(m, d));
  return hit?.slug || 'ostalo';
}
