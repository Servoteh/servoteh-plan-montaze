/**
 * Plan Proizvodnje — definicija odeljenja (tabovi „Po mašini"-ja).
 *
 * Single source of truth za TAB → filter mapiranje. Filter je
 * **kod-based** (rj_code mašine / effective_machine_code operacije).
 *
 * Tipovi tabova:
 *   - kind:'machines'   — prikazuje LISTU mašina (sortirano numerički po
 *                         rj_code), klik na mašinu → drill-down na operacije
 *                         te mašine. Filter može biti `machinePrefixes`
 *                         (svi rj_code-ovi koji počinju datim prefiksom)
 *                         ILI `machineCodes` (eksplicitna lista rj_code-ova),
 *                         ili oba (union).
 *   - kind:'all'        — „Sve" (lista svih mašina + drill-down) ili
 *                         „Ostalo" (mašine koje ne upadaju nigde drugde).
 *
 * Korisnik je 22.04.2026 eksplicitno tražio:
 *   „Hoću isto kao za Brušenje — najpre lista mašina (npr. 4.1, 4.11, 4.12),
 *    pa kad kliknem 4.1 ulazim u listu operacija."
 * Zato su sve grupe sad `kind:'machines'` (nema više direktnog prikaza
 * operacija po imenu / opisu rada).
 *
 * Red 1 chip-bar-a: Sve, Glodanje, Struganje, Brušenje, Erodiranje, Ažistiranje
 * Red 2 chip-bar-a: Sečenje i savijanje, Bravarsko, Farbanje i površinska
 *                   zaštita, CAM programiranje, Ostalo
 *
 * Polje `row` (1 ili 2) usmerava UI da render-uje tab u određenom redu
 * chip-bar-a (sprečava da se layout ulije u 1 dugačak red).
 *
 * Vidi `docs/Planiranje_proizvodnje_modul.md` → „Tabovi (UI)".
 */

export const DEPARTMENTS = [
  /* ── Red 1 ─────────────────────────────────────────────────────────── */
  {
    slug: 'sve',
    label: 'Sve',
    row: 1,
    kind: 'all',
  },
  {
    slug: 'glodanje',
    label: 'Glodanje',
    row: 1,
    kind: 'machines',
    /* dept '03': cela klasa (3.10–3.60, 3.9.1, 3.21/3.22 borveri, 3.50 Štos) */
    machinePrefixes: ['3'],
  },
  {
    slug: 'struganje',
    label: 'Struganje',
    row: 1,
    kind: 'machines',
    /* dept '02' — samo „2.x", NE 21.x (3D štampa) */
    machinePrefixes: ['2'],
    excludeMachineCodes: ['21.1', '21.2'],
  },
  {
    slug: 'brusenje',
    label: 'Brušenje',
    row: 1,
    kind: 'machines',
    machinePrefixes: ['6'],
    /* '6.8 Laser-Graviranje' je u dept 13, ne brusenje — isključi po kodu */
    excludeMachineCodes: ['6.8'],
  },
  {
    slug: 'erodiranje',
    label: 'Erodiranje',
    row: 1,
    kind: 'machines',
    /* dept '10' — eksplicitno samo 10.x (5 mašina) */
    machineCodes: ['10.1', '10.2', '10.3', '10.4', '10.5'],
  },
  {
    slug: 'azistiranje',
    label: 'Ažistiranje',
    row: 1,
    kind: 'machines',
    /* SAMO 8.2 Ručni radovi-Ažistiranje (NE cela dept 08 — montaža/kontrola
       idu u Ostalo). Korisnik je eksplicitno potvrdio. */
    machineCodes: ['8.2'],
  },

  /* ── Red 2 ─────────────────────────────────────────────────────────── */
  {
    slug: 'secenje',
    label: 'Sečenje i savijanje',
    row: 2,
    kind: 'machines',
    /* dept 01 (sečenje: testera, makaze, gas, voda, plazma, laser) +
       dept 15 (Apkant Hammerle 1.71/1.72). Sve mašine pripadaju 1.x. */
    machineCodes: [
      '1.10', '1.2', '1.30', '1.40', '1.50', '1.60', '1.71', '1.72',
    ],
  },
  {
    slug: 'bravarsko',
    label: 'Bravarsko',
    row: 2,
    kind: 'machines',
    /* 4.1 Savijanje + 4.11/4.12 Bušilice + 4.2/4.3/4.4 Zavarivanje
       (MIG-MAG, REL, TIG). Korisnik je eksplicitno potvrdio. */
    machineCodes: ['4.1', '4.11', '4.12', '4.2', '4.3', '4.4'],
  },
  {
    slug: 'farbanje',
    label: 'Farbanje i površinska zaštita',
    row: 2,
    kind: 'machines',
    /* Cela dept '05' (5.1 Farbanje – 5.8 Eloksiranje) + 5.11 Površinska
       zaštita (koja je u dept 09 ali pripada ovde tematski).
       NE uključuje 5.9 Graviranje (dept 13) — ono ide u Ostalo. */
    machineCodes: [
      '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', '5.11',
    ],
  },
  {
    slug: 'cam',
    label: 'CAM programiranje',
    row: 2,
    kind: 'machines',
    /* dept '17': 17.0 CAM glodanje, 17.1 CAM struganje */
    machineCodes: ['17.0', '17.1'],
  },
  {
    slug: 'ostalo',
    label: 'Ostalo',
    row: 2,
    kind: 'all',
    isFallback: true,
  },
];

export const DEPARTMENTS_ROW_1 = DEPARTMENTS.filter((d) => d.row === 1);
export const DEPARTMENTS_ROW_2 = DEPARTMENTS.filter((d) => d.row === 2);

/* ── Helpers ── */

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
 *
 * Pravila (po redosledu):
 *   1) `excludeMachineCodes` — ako rj_code mašine je u toj listi, mašina
 *      NIJE u tom odeljenju (čak i ako ima poklapanje po prefiksu).
 *   2) `machineCodes` — eksplicitna whitelist rj_code-ova.
 *   3) `machinePrefixes` — prefiks pre prve tačke (npr. „3" hvata sve „3.x").
 *   4) Inače — false.
 *
 * `machineCodes` i `machinePrefixes` su OR-ovani: ako bilo koji da hit, true.
 */
export function machineMatchesDept(machine, dept) {
  if (!dept) return false;
  if (dept.kind === 'all' && !dept.isFallback) return true;

  const code = String(machine?.rj_code || '');
  if (!code) return false;

  if (
    Array.isArray(dept.excludeMachineCodes) &&
    dept.excludeMachineCodes.includes(code)
  ) {
    return false;
  }

  if (
    Array.isArray(dept.machineCodes) &&
    dept.machineCodes.includes(code)
  ) {
    return true;
  }

  if (Array.isArray(dept.machinePrefixes)) {
    const prefix = codePrefix(code);
    if (dept.machinePrefixes.includes(prefix)) return true;
  }

  return false;
}

/**
 * Mašina koja ne pripada NIJEDNOM specifičnom `machines` departmentu (osim
 * 'sve' i 'ostalo' koji su 'all') → ide u „Ostalo".
 */
export function machineFallsIntoOstalo(machine) {
  const machineDepts = DEPARTMENTS.filter(d => d.kind === 'machines');
  return !machineDepts.some(d => machineMatchesDept(machine, d));
}

/**
 * Operacija (red iz v_production_operations) ide u „Ostalo" ako njen
 * `effective_machine_code` ne pripada nijednom mašinskom tabu. Koristi se
 * u `renderOstaloView` za prikaz „operacija bez kategorije".
 */
export function operationFallsIntoOstalo(op) {
  const code = String(op?.effective_machine_code || '');
  if (!code) return true;
  const fakeMachine = { rj_code: code };
  return machineFallsIntoOstalo(fakeMachine);
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
