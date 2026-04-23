import { describe, expect, it } from 'vitest';
import {
  DEPARTMENTS,
  DEPARTMENTS_ROW_1,
  DEPARTMENTS_ROW_2,
  filterMachinesForDept,
  findDeptForMachineCode,
  getDepartment,
  machineFallsIntoOstalo,
  machineMatchesDept,
  operationFallsIntoOstalo,
} from '../../../src/ui/planProizvodnje/departments.js';

/* Realistic uzorak iz bigtehn_machines_cache. */
const MACHINES = [
  { rj_code: '0.0',   name: 'Opšti nalog',              department_id: '00' },
  { rj_code: '1.10',  name: 'Sečenje testera',          department_id: '01' },
  { rj_code: '1.50',  name: 'Plazma',                    department_id: '01' },
  { rj_code: '1.71',  name: 'Apkant Hammerle 4100',      department_id: '15' },
  { rj_code: '1.72',  name: 'Apkant Hammerle 3100',      department_id: '15' },
  { rj_code: '2.1',   name: 'Strug Prvomajska',          department_id: '02' },
  { rj_code: '2.5',   name: 'CNC Strug Gildemeister',    department_id: '02' },
  { rj_code: '3.10',  name: 'CNC Glodanje DMU 50T TNC1', department_id: '03' },
  { rj_code: '3.21',  name: 'CNC-GLODANJE TOS WHN 13',   department_id: '03' },
  { rj_code: '3.22',  name: 'CNC-GLODANJE TOS WHN 13 H', department_id: '03' },
  { rj_code: '3.50',  name: 'Štos',                       department_id: '03' },
  { rj_code: '4.1',   name: 'Bravari-Savijanje',         department_id: '04' },
  { rj_code: '4.11',  name: 'Manuelno bušenje',           department_id: '04' },
  { rj_code: '4.12',  name: 'Radijalna bušilica',         department_id: '04' },
  { rj_code: '4.2',   name: 'Zavarivanje MIG/MAG',        department_id: '04' },
  { rj_code: '4.3',   name: 'Zavarivanje REL',           department_id: '04' },
  { rj_code: '4.4',   name: 'Zavarivanje TIG',           department_id: '04' },
  { rj_code: '5.1',   name: 'Farbanje',                   department_id: '05' },
  { rj_code: '5.4',   name: 'Niklovanje',                 department_id: '05' },
  { rj_code: '5.9',   name: 'Graviranje',                 department_id: '13' },
  { rj_code: '5.11',  name: 'Površinska zaštita',         department_id: '09' },
  { rj_code: '6.1.1', name: 'Brušenje Studer',            department_id: '06' },
  { rj_code: '6.8',   name: 'Laser-Graviranje',           department_id: '13' },
  { rj_code: '7.3',   name: 'Kalenje',                    department_id: '07' },
  { rj_code: '7.5',   name: 'Ispravljanje',               department_id: '14' },
  { rj_code: '8.1',   name: 'Montaža',                    department_id: '08' },
  { rj_code: '8.2',   name: 'Ručni radovi-Ažistiranje',   department_id: '08' },
  { rj_code: '8.3',   name: 'Završna Kontrola',           department_id: '08' },
  { rj_code: '8.4',   name: 'Međufazna Kontrola',         department_id: '08' },
  { rj_code: '9.0',   name: 'Kooperacija',                department_id: '09' },
  { rj_code: '9.1',   name: 'Nabavka',                    department_id: '09' },
  { rj_code: '10.1',  name: 'Žičano erodiranje',          department_id: '10' },
  { rj_code: '10.5',  name: 'Probijačica',                department_id: '10' },
  { rj_code: '17.0',  name: 'CAM glodanje',               department_id: '17', no_procedure: true },
  { rj_code: '17.1',  name: 'CAM struganje',              department_id: '17', no_procedure: true },
  { rj_code: '21.1',  name: '3D Štampanje Sindoh',        department_id: '21' },
];

describe('DEPARTMENTS konfiguracija', () => {
  it('Red 1 ima tačno 6 tabova po dogovorenom redosledu', () => {
    expect(DEPARTMENTS_ROW_1.map(d => d.slug)).toEqual([
      'sve', 'glodanje', 'struganje', 'brusenje', 'erodiranje', 'azistiranje',
    ]);
  });

  it('Red 2 ima tačno 5 tabova po dogovorenom redosledu', () => {
    expect(DEPARTMENTS_ROW_2.map(d => d.slug)).toEqual([
      'secenje', 'bravarsko', 'farbanje', 'cam', 'ostalo',
    ]);
  });

  it('svaki tab ima row 1 ili 2', () => {
    for (const d of DEPARTMENTS) {
      expect([1, 2]).toContain(d.row);
    }
  });

  it('SVI specifični tabovi su sad kind:"machines" (nema više direct-operations)', () => {
    /* Korisnik je 22.04.2026 izrečno tražio: za svaku grupu prvo lista
       mašina, pa drill-down. Bravarsko/Sečenje/Farbanje/CAM/Ažistiranje
       su u v1 bili `kind:'operations'` — refaktor ih svih pretvara u
       `'machines'`. Ostaju samo 'sve' i 'ostalo' kao 'all'. */
    const specific = DEPARTMENTS.filter(d => d.slug !== 'sve' && d.slug !== 'ostalo');
    for (const d of specific) {
      expect(d.kind).toBe('machines');
    }
  });
});

describe('machineMatchesDept', () => {
  it('Glodanje (prefiks "3"): prima sve 3.x uključujući borvere i Štos', () => {
    const dept = getDepartment('glodanje');
    expect(machineMatchesDept({ rj_code: '3.10' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '3.21' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '3.22' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '3.50' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '3.9.1' }, dept)).toBe(true);
  });

  it('Struganje (prefiks "2", excludes 21.x): NE prima 3D štampu', () => {
    const dept = getDepartment('struganje');
    expect(machineMatchesDept({ rj_code: '2.1' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '21.1' }, dept)).toBe(false);
    expect(machineMatchesDept({ rj_code: '21.2' }, dept)).toBe(false);
  });

  it('Brušenje (prefiks "6", excludes 6.8): NE prima Laser-Graviranje', () => {
    const dept = getDepartment('brusenje');
    expect(machineMatchesDept({ rj_code: '6.1.1' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '6.7.1' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '6.8' }, dept)).toBe(false);
  });

  it('Ažistiranje (machineCodes=["8.2"]): SAMO 8.2', () => {
    const dept = getDepartment('azistiranje');
    expect(machineMatchesDept({ rj_code: '8.2' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '8.1' }, dept)).toBe(false);
    expect(machineMatchesDept({ rj_code: '8.3' }, dept)).toBe(false);
    expect(machineMatchesDept({ rj_code: '8.4' }, dept)).toBe(false);
  });

  it('Sečenje i savijanje (machineCodes): dept 01 + dept 15 (Apkant)', () => {
    const dept = getDepartment('secenje');
    expect(machineMatchesDept({ rj_code: '1.10' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '1.50' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '1.71' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '1.72' }, dept)).toBe(true);
  });

  it('Bravarsko (machineCodes): 4.1, 4.11, 4.12 + zavarivanje 4.2/4.3/4.4', () => {
    const dept = getDepartment('bravarsko');
    expect(machineMatchesDept({ rj_code: '4.1' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '4.11' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '4.12' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '4.2' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '4.3' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '4.4' }, dept)).toBe(true);
  });

  it('Farbanje (machineCodes): cela dept 05 + 5.11, NE 5.9 Graviranje', () => {
    const dept = getDepartment('farbanje');
    expect(machineMatchesDept({ rj_code: '5.1' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '5.4' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '5.11' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '5.9' }, dept)).toBe(false); /* Graviranje ide u Ostalo */
  });

  it('CAM programiranje (machineCodes): 17.0 + 17.1', () => {
    const dept = getDepartment('cam');
    expect(machineMatchesDept({ rj_code: '17.0' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '17.1' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '17.2' }, dept)).toBe(false); /* nepostojeće */
  });

  it('Erodiranje (machineCodes): 10.1–10.5', () => {
    const dept = getDepartment('erodiranje');
    expect(machineMatchesDept({ rj_code: '10.1' }, dept)).toBe(true);
    expect(machineMatchesDept({ rj_code: '10.5' }, dept)).toBe(true);
  });
});

describe('filterMachinesForDept', () => {
  it('Glodanje obuhvata 4 mašine iz uzorka (3.x, uključujući borvere i Štos)', () => {
    const r = filterMachinesForDept(MACHINES, getDepartment('glodanje'));
    expect(r.map(m => m.rj_code).sort()).toEqual(['3.10', '3.21', '3.22', '3.50']);
  });

  it('Bravarsko obuhvata 6 mašina (4.1, 4.11, 4.12, 4.2, 4.3, 4.4)', () => {
    const r = filterMachinesForDept(MACHINES, getDepartment('bravarsko'));
    expect(r.map(m => m.rj_code).sort()).toEqual(['4.1', '4.11', '4.12', '4.2', '4.3', '4.4']);
  });

  it('Sečenje i savijanje obuhvata sečenje (dept 01) + Apkant (dept 15)', () => {
    const r = filterMachinesForDept(MACHINES, getDepartment('secenje'));
    expect(r.map(m => m.rj_code).sort()).toEqual(['1.10', '1.50', '1.71', '1.72']);
  });

  it('Farbanje obuhvata 5.1, 5.4, 5.11; ne 5.9 Graviranje', () => {
    const r = filterMachinesForDept(MACHINES, getDepartment('farbanje'));
    expect(r.map(m => m.rj_code).sort()).toEqual(['5.1', '5.11', '5.4']);
  });

  it('CAM obuhvata 17.0 i 17.1', () => {
    const r = filterMachinesForDept(MACHINES, getDepartment('cam'));
    expect(r.map(m => m.rj_code).sort()).toEqual(['17.0', '17.1']);
  });

  it('Ažistiranje obuhvata SAMO 8.2', () => {
    const r = filterMachinesForDept(MACHINES, getDepartment('azistiranje'));
    expect(r.map(m => m.rj_code)).toEqual(['8.2']);
  });

  it('Erodiranje obuhvata 10.1 i 10.5', () => {
    const r = filterMachinesForDept(MACHINES, getDepartment('erodiranje'));
    expect(r.map(m => m.rj_code).sort()).toEqual(['10.1', '10.5']);
  });
});

describe('machineFallsIntoOstalo', () => {
  it('Termička, 3D, Kooperacija, Graviranje, Ispravljanje, Montaža, Kontrola, Opšti nalog idu u Ostalo', () => {
    expect(machineFallsIntoOstalo({ rj_code: '0.0' })).toBe(true);
    expect(machineFallsIntoOstalo({ rj_code: '5.9' })).toBe(true); /* Graviranje */
    expect(machineFallsIntoOstalo({ rj_code: '6.8' })).toBe(true); /* Laser-Graviranje */
    expect(machineFallsIntoOstalo({ rj_code: '7.3' })).toBe(true); /* Termička */
    expect(machineFallsIntoOstalo({ rj_code: '7.5' })).toBe(true); /* Ispravljanje */
    expect(machineFallsIntoOstalo({ rj_code: '8.1' })).toBe(true); /* Montaža */
    expect(machineFallsIntoOstalo({ rj_code: '8.3' })).toBe(true); /* Završna kontrola */
    expect(machineFallsIntoOstalo({ rj_code: '8.4' })).toBe(true); /* Međufazna kontrola */
    expect(machineFallsIntoOstalo({ rj_code: '9.0' })).toBe(true); /* Kooperacija */
    expect(machineFallsIntoOstalo({ rj_code: '9.1' })).toBe(true); /* Nabavka */
    expect(machineFallsIntoOstalo({ rj_code: '21.1' })).toBe(true); /* 3D štampa */
  });

  it('Mašine iz Glodanja, Brušenja, ... NE idu u Ostalo', () => {
    expect(machineFallsIntoOstalo({ rj_code: '3.10' })).toBe(false);
    expect(machineFallsIntoOstalo({ rj_code: '6.1.1' })).toBe(false);
    expect(machineFallsIntoOstalo({ rj_code: '4.2' })).toBe(false); /* zavarivanje */
    expect(machineFallsIntoOstalo({ rj_code: '8.2' })).toBe(false); /* ažistiranje */
  });
});

describe('findDeptForMachineCode', () => {
  it('Vraća pravilan slug taba za poznate kodove', () => {
    expect(findDeptForMachineCode('3.10')).toBe('glodanje');
    expect(findDeptForMachineCode('2.1')).toBe('struganje');
    expect(findDeptForMachineCode('6.1.1')).toBe('brusenje');
    expect(findDeptForMachineCode('4.1')).toBe('bravarsko');
    expect(findDeptForMachineCode('4.2')).toBe('bravarsko');
    expect(findDeptForMachineCode('5.1')).toBe('farbanje');
    expect(findDeptForMachineCode('17.0')).toBe('cam');
    expect(findDeptForMachineCode('8.2')).toBe('azistiranje');
    expect(findDeptForMachineCode('1.10')).toBe('secenje');
    expect(findDeptForMachineCode('1.71')).toBe('secenje');
    expect(findDeptForMachineCode('10.1')).toBe('erodiranje');
  });

  it('Nepoznata mašina → "ostalo"', () => {
    expect(findDeptForMachineCode('99.9')).toBe('ostalo');
    expect(findDeptForMachineCode('0.0')).toBe('ostalo'); /* Opšti nalog */
    expect(findDeptForMachineCode('21.1')).toBe('ostalo'); /* 3D */
    expect(findDeptForMachineCode('5.9')).toBe('ostalo'); /* Graviranje */
  });
});

describe('operationFallsIntoOstalo', () => {
  it('Operacija na mašini bez kategorije → Ostalo', () => {
    expect(operationFallsIntoOstalo({ effective_machine_code: '7.3' })).toBe(true);
    expect(operationFallsIntoOstalo({ effective_machine_code: '21.1' })).toBe(true);
    expect(operationFallsIntoOstalo({ effective_machine_code: '8.1' })).toBe(true);
  });

  it('Operacija na mašini sa kategorijom → NIJE Ostalo', () => {
    expect(operationFallsIntoOstalo({ effective_machine_code: '3.10' })).toBe(false);
    expect(operationFallsIntoOstalo({ effective_machine_code: '4.2' })).toBe(false);
    expect(operationFallsIntoOstalo({ effective_machine_code: '5.1' })).toBe(false);
  });

  it('Prazan / null effective_machine_code → Ostalo', () => {
    expect(operationFallsIntoOstalo({ effective_machine_code: '' })).toBe(true);
    expect(operationFallsIntoOstalo({})).toBe(true);
    expect(operationFallsIntoOstalo(null)).toBe(true);
  });
});
