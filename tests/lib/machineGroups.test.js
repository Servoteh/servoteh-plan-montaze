import { describe, expect, it } from 'vitest';
import {
  MACHINE_GROUPS,
  countMachinesPerGroup,
  filterMachinesByGroup,
  getMachineGroup,
  machineGroupLabel,
  sortMachinesByGroupOrder,
} from '../../src/lib/machineGroups.js';

/* Realistic uzorak iz bigtehn_machines_cache (skratio sam name-ove). */
const MACHINES = [
  { rj_code: '0.0',   name: 'Opšti nalog',      department_id: '00' },
  { rj_code: '1.10',  name: 'Sečenje testera',  department_id: '01' },
  { rj_code: '1.50',  name: 'Plazma',           department_id: '01' },
  { rj_code: '1.71',  name: 'Apkant Hammerle 4100', department_id: '15' },
  { rj_code: '1.72',  name: 'Apkant Hammerle 3100', department_id: '15' },
  { rj_code: '2.1',   name: 'Strug Prvomajska',  department_id: '02' },
  { rj_code: '2.5',   name: 'CNC Strug Gildemeister', department_id: '02' },
  { rj_code: '3.10',  name: 'CNC Glodanje DMU 50T TNC1', department_id: '03' },
  { rj_code: '3.11',  name: 'CNC Glodanje DMU 50T TNC2', department_id: '03' },
  { rj_code: '3.21',  name: 'CNC-GLODANJE TOS WHN 13 MEFI', department_id: '03' },
  { rj_code: '3.22',  name: 'CNC-GLODANJE TOS WHN 13 Heid', department_id: '03' },
  { rj_code: '4.1',   name: 'Bravari-Savijanje', department_id: '04' },
  { rj_code: '4.11',  name: 'Manuelno bušenje', department_id: '04' },
  { rj_code: '4.12',  name: 'Radijalna bušilica', department_id: '04' },
  { rj_code: '4.2',   name: 'Zavarivanje MIG/MAG', department_id: '04' },
  { rj_code: '4.3',   name: 'Zavarivanje REL',  department_id: '04' },
  { rj_code: '4.4',   name: 'Zavarivanje TIG',  department_id: '04' },
  { rj_code: '5.1',   name: 'Farbanje',         department_id: '05' },
  { rj_code: '5.4',   name: 'Niklovanje',       department_id: '05' },
  { rj_code: '5.11',  name: 'Površinska zaštita', department_id: '09' },
  { rj_code: '6.1.1', name: 'Brušenje Studer',  department_id: '06' },
  { rj_code: '7.3',   name: 'Kalenje',          department_id: '07' },
  { rj_code: '8.1',   name: 'Montaža',          department_id: '08' },
  { rj_code: '9.0',   name: 'Kooperacija',      department_id: '09' },
  { rj_code: '9.1',   name: 'Nabavka',          department_id: '09' },
  { rj_code: '10.1',  name: 'Žičano erodiranje', department_id: '10' },
  { rj_code: '10.5',  name: 'Probijačica',      department_id: '10' },
  { rj_code: '17.0',  name: 'CAM glodanje',     department_id: '17', no_procedure: true },
  { rj_code: '17.1',  name: 'CAM struganje',    department_id: '17', no_procedure: true },
  { rj_code: '21.1',  name: '3D Štampanje Sindoh', department_id: '21' },
];

describe('MACHINE_GROUPS', () => {
  it('imaju jedinstvene id-ove', () => {
    const ids = MACHINE_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('„Sve” je prvi i „Ostalo” je poslednji', () => {
    expect(MACHINE_GROUPS[0].id).toBe('all');
    expect(MACHINE_GROUPS[MACHINE_GROUPS.length - 1].id).toBe('ostalo');
  });
});

describe('getMachineGroup', () => {
  it('borveri dobijaju "borverci" (ne "glodanje")', () => {
    expect(getMachineGroup({ rj_code: '3.21', department_id: '03' })).toBe('borverci');
    expect(getMachineGroup({ rj_code: '3.22', department_id: '03' })).toBe('borverci');
  });

  it('glodanje hvata dept 03 minus borveri', () => {
    expect(getMachineGroup({ rj_code: '3.10', department_id: '03' })).toBe('glodanje');
    expect(getMachineGroup({ rj_code: '3.50', department_id: '03' })).toBe('glodanje');
  });

  it('zavarivanje hvata 4.2/4.3/4.4 (ne 4.1, 4.11, 4.12)', () => {
    expect(getMachineGroup({ rj_code: '4.2', department_id: '04' })).toBe('zavarivanje');
    expect(getMachineGroup({ rj_code: '4.3', department_id: '04' })).toBe('zavarivanje');
    expect(getMachineGroup({ rj_code: '4.4', department_id: '04' })).toBe('zavarivanje');
  });

  it('bušenje/bravari hvata 4.1, 4.11, 4.12', () => {
    expect(getMachineGroup({ rj_code: '4.1', department_id: '04' })).toBe('busenje');
    expect(getMachineGroup({ rj_code: '4.11', department_id: '04' })).toBe('busenje');
    expect(getMachineGroup({ rj_code: '4.12', department_id: '04' })).toBe('busenje');
  });

  it('struganje/erodiranje/sečenje/brušenje po department_id', () => {
    expect(getMachineGroup({ rj_code: '2.1', department_id: '02' })).toBe('struganje');
    expect(getMachineGroup({ rj_code: '10.1', department_id: '10' })).toBe('erodiranje');
    expect(getMachineGroup({ rj_code: '1.10', department_id: '01' })).toBe('secenje');
    expect(getMachineGroup({ rj_code: '6.1.1', department_id: '06' })).toBe('brusenje');
  });

  it('farbanje hvata cela 05 + 5.11', () => {
    expect(getMachineGroup({ rj_code: '5.1', department_id: '05' })).toBe('farbanje');
    expect(getMachineGroup({ rj_code: '5.4', department_id: '05' })).toBe('farbanje');
    expect(getMachineGroup({ rj_code: '5.11', department_id: '09' })).toBe('farbanje');
  });

  it('apkant po department_id 15', () => {
    expect(getMachineGroup({ rj_code: '1.71', department_id: '15' })).toBe('apkant');
    expect(getMachineGroup({ rj_code: '1.72', department_id: '15' })).toBe('apkant');
  });

  it('kooperacija hvata 9.0 i 9.1', () => {
    expect(getMachineGroup({ rj_code: '9.0', department_id: '09' })).toBe('kooperacija');
    expect(getMachineGroup({ rj_code: '9.1', department_id: '09' })).toBe('kooperacija');
  });

  it('CAM, 3D, montaža, termička, opšti nalog', () => {
    expect(getMachineGroup({ rj_code: '17.0', department_id: '17' })).toBe('cam');
    expect(getMachineGroup({ rj_code: '21.1', department_id: '21' })).toBe('3d');
    expect(getMachineGroup({ rj_code: '8.1', department_id: '08' })).toBe('montaza');
    expect(getMachineGroup({ rj_code: '7.3', department_id: '07' })).toBe('termicka');
    expect(getMachineGroup({ rj_code: '0.0', department_id: '00' })).toBe('ostalo');
  });

  it('null/undefined → "ostalo" bez bacanja', () => {
    expect(getMachineGroup(null)).toBe('ostalo');
    expect(getMachineGroup(undefined)).toBe('ostalo');
    expect(getMachineGroup({})).toBe('ostalo');
  });
});

describe('filterMachinesByGroup', () => {
  it('"all" vraća sve', () => {
    expect(filterMachinesByGroup(MACHINES, 'all')).toHaveLength(MACHINES.length);
  });

  it('borverci → tačno 2', () => {
    const r = filterMachinesByGroup(MACHINES, 'borverci');
    expect(r.map((m) => m.rj_code).sort()).toEqual(['3.21', '3.22']);
  });

  it('glodanje ne sadrži borvere', () => {
    const r = filterMachinesByGroup(MACHINES, 'glodanje');
    expect(r.every((m) => !['3.21', '3.22'].includes(m.rj_code))).toBe(true);
    expect(r.map((m) => m.rj_code)).toContain('3.10');
  });

  it('zavarivanje ne sadrži bravari/bušenje', () => {
    const r = filterMachinesByGroup(MACHINES, 'zavarivanje');
    expect(r.map((m) => m.rj_code).sort()).toEqual(['4.2', '4.3', '4.4']);
  });

  it('ostalo hvata sve što ni jedna grupa nije', () => {
    const r = filterMachinesByGroup(MACHINES, 'ostalo');
    expect(r.map((m) => m.rj_code)).toEqual(['0.0']);
  });

  it('nepoznat groupId → fallback na sve', () => {
    expect(filterMachinesByGroup(MACHINES, 'xxx')).toHaveLength(MACHINES.length);
  });
});

describe('countMachinesPerGroup', () => {
  it('"all" je ukupan broj, „Ostalo” pokriva preostalo, suma se poklapa', () => {
    const counts = countMachinesPerGroup(MACHINES);
    expect(counts.get('all')).toBe(MACHINES.length);
    /* Sve specifične + ostalo = ukupno */
    let sum = 0;
    for (const g of MACHINE_GROUPS) {
      if (g.id === 'all') continue;
      sum += counts.get(g.id) || 0;
    }
    expect(sum).toBe(MACHINES.length);
  });

  it('borverci = 2, glodanje = 2 (3.10 + 3.11)', () => {
    const counts = countMachinesPerGroup(MACHINES);
    expect(counts.get('borverci')).toBe(2);
    expect(counts.get('glodanje')).toBe(2);
  });
});

describe('sortMachinesByGroupOrder', () => {
  it('mašine iz iste grupe ostaju zajedno, redom kako su grupe definisane', () => {
    const sorted = sortMachinesByGroupOrder(MACHINES);
    /* Svi rj_codes iz "glodanja" moraju biti pre "borveri" — jer u config-u
       je glodanje pre borveri. */
    const indices = sorted.map((m) => getMachineGroup(m));
    /* Provera: indeks svake grupe u sorted listi je nedopadajući. */
    let prevOrder = -1;
    const order = (id) => MACHINE_GROUPS.findIndex((g) => g.id === id);
    for (const id of indices) {
      const o = order(id);
      expect(o).toBeGreaterThanOrEqual(prevOrder);
      prevOrder = o;
    }
  });

  it('unutar grupe sortira po rj_code natural', () => {
    const sub = MACHINES.filter((m) => m.department_id === '03');
    const sorted = sortMachinesByGroupOrder(sub);
    /* glodanje (3.10, 3.11) pre borveri (3.21, 3.22) */
    expect(sorted.map((m) => m.rj_code)).toEqual(['3.10', '3.11', '3.21', '3.22']);
  });
});

describe('machineGroupLabel', () => {
  it('vraća label po id-u', () => {
    expect(machineGroupLabel('glodanje')).toBe('Glodanje');
    expect(machineGroupLabel('borverci')).toBe('Borverci');
    expect(machineGroupLabel('xxx')).toBe('Sve');
  });
});
