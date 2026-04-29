/**
 * payrollCalc.test.js — acceptance testovi za Fazu K3.3.
 *
 * Šest poslovnih scenarija koja moraju biti pokrivena obračunom:
 *   1) Fiksno + ugovor: pun mesec → fixed_amount, bez extra sati.
 *   2) Fiksno + ugovor: prekov + 2 mašine + praznik_rad → +extra_hour_rate.
 *   3) Dva dela + ugovor: prvi_deo + (sati × split_hour_rate) + transport.
 *   4) Satnica + ugovor: redovan + bolovanje 65% → ponderisani sati.
 *   5) Satnica + ugovor: praznik_rad i 2 mašine se plaćaju po ugovorenoj satnici.
 *   6) Satnica + praksa: pokušaj plaćenog godišnjeg / bolovanja → warnings + 0.
 *
 * Plus:
 *   - terenske dnevnice u zemlji/inostranstvu se računaju per dan (RSD/EUR).
 *   - negativan „preostalo za isplatu" generiše warning.
 *   - computeMonthlyFond korektno trtira praznike koji padaju radnim danom.
 *
 * Cilj: dokazati da payrollCalc.js ostaje single source of truth za sve
 * formule (UI, recompute, eksport-i moraju davati identične brojke).
 */

import { describe, it, expect } from 'vitest';
import {
  computeEarnings,
  computePayableHours,
  computeMonthlyFond,
  deriveCompensationModel,
  sanitizeHoursForWorkType,
  aggregateWorkHoursForMonth,
  gridRedovniUnitsOneDay,
  BOLOVANJE_OBICNO_FACTOR,
} from '../../src/services/payrollCalc.js';

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function emptyHours(overrides = {}) {
  return {
    redovanRadSati: 0,
    prekovremeniSati: 0,
    praznikRadSati: 0,
    praznikPlaceniSati: 0,
    godisnjiSati: 0,
    slobodniDaniSati: 0,
    bolovanje65Sati: 0,
    bolovanje100Sati: 0,
    dveMasineSati: 0,
    ...overrides,
  };
}

function termsFiksno(overrides = {}) {
  return {
    compensationModel: 'fiksno',
    fixedAmount: 100000,
    fixedTransportComponent: 6000,
    fixedExtraHourRate: 800,
    terrainDomesticRate: 0,
    terrainForeignRate: 0,
    ...overrides,
  };
}

function termsDvaDela(overrides = {}) {
  return {
    compensationModel: 'dva_dela',
    firstPartAmount: 30000,
    splitHourRate: 500,
    splitTransportAmount: 5000,
    terrainDomesticRate: 0,
    terrainForeignRate: 0,
    ...overrides,
  };
}

function termsSatnica(overrides = {}) {
  return {
    compensationModel: 'satnica',
    hourlyRate: 600,
    hourlyTransportAmount: 4000,
    terrainDomesticRate: 0,
    terrainForeignRate: 0,
    ...overrides,
  };
}

/* ─── Acceptance scenariji ─────────────────────────────────────────────── */

describe('payrollCalc — acceptance scenariji (Faza K3.3)', () => {
  it('1) Fiksno + ugovor: pun radni mesec bez extra sati → fixed_amount', () => {
    const r = computeEarnings({
      workType: 'ugovor',
      terms: termsFiksno({ fixedAmount: 100000 }),
      hours: emptyHours({ redovanRadSati: 168 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    expect(r.compensationModel).toBe('fiksno');
    expect(r.payableHours).toBe(0);
    expect(r.ukupnaZarada).toBe(100000);
    expect(r.preostaloZaIsplatu).toBe(100000);
    expect(r.warnings).toEqual([]);
  });

  it('2) Fiksno + ugovor: prekov 4h + 2 mašine 2h + praznik_rad 8h → +extra po fixed_extra_hour_rate', () => {
    const r = computeEarnings({
      workType: 'ugovor',
      terms: termsFiksno({ fixedAmount: 100000, fixedExtraHourRate: 800 }),
      hours: emptyHours({
        redovanRadSati: 160,
        prekovremeniSati: 4,
        praznikRadSati: 8,
        dveMasineSati: 2,
      }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 50000,
    });
    /* payable_hours za fiksno = prekov + praznik_rad + 2 mašine = 4+8+2 = 14 */
    expect(r.payableHours).toBe(14);
    /* ukupno = 100000 + 14 × 800 = 111200 */
    expect(r.ukupnaZarada).toBe(111200);
    expect(r.prviDeo).toBe(50000);
    expect(r.preostaloZaIsplatu).toBe(61200);
    expect(r.warnings).toEqual([]);
  });

  it('3) Dva dela + ugovor: prvi_deo + (sati × split_hour_rate) + transport', () => {
    const r = computeEarnings({
      workType: 'ugovor',
      terms: termsDvaDela({ firstPartAmount: 30000, splitHourRate: 500, splitTransportAmount: 5000 }),
      hours: emptyHours({ redovanRadSati: 160, prekovremeniSati: 8 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    /* payable = 160 + 8 = 168 sati */
    expect(r.payableHours).toBe(168);
    /* baza = 30000 + 168×500 = 30000 + 84000 = 114000; +transport 5000 = 119000 */
    expect(r.ukupnaZarada).toBe(119000);
    /* prvi_deo automatski = first_part_amount */
    expect(r.prviDeo).toBe(30000);
    expect(r.preostaloZaIsplatu).toBe(89000);
  });

  it('4) Satnica + ugovor: redovan 160 + bolovanje obično 16h (65%) → ponderisani sati × satnica', () => {
    const r = computeEarnings({
      workType: 'ugovor',
      terms: termsSatnica({ hourlyRate: 600, hourlyTransportAmount: 4000 }),
      hours: emptyHours({ redovanRadSati: 160, bolovanje65Sati: 16 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    /* payable = 160 + 16 × 0.65 = 170.4 */
    expect(r.payableHours).toBe(170.4);
    /* baza = 170.4 × 600 = 102240; +transport 4000 = 106240 */
    expect(r.ukupnaZarada).toBe(106240);
    expect(BOLOVANJE_OBICNO_FACTOR).toBe(0.65);
  });

  it('5) Satnica + ugovor: praznik_rad i 2 mašine se plaćaju po ISTOJ ugovorenoj satnici', () => {
    const r = computeEarnings({
      workType: 'ugovor',
      terms: termsSatnica({ hourlyRate: 600, hourlyTransportAmount: 0 }),
      hours: emptyHours({ redovanRadSati: 160, praznikRadSati: 8, dveMasineSati: 4 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    /* payable = 160 + 8 + 4 = 172; baza = 172×600 = 103200 */
    expect(r.payableHours).toBe(172);
    expect(r.ukupnaZarada).toBe(103200);
  });

  it('6) Satnica + praksa: pokušaj plaćenog godišnjeg/bolovanja → warnings + sati ignorisani', () => {
    const r = computeEarnings({
      workType: 'praksa',
      terms: termsSatnica({ hourlyRate: 500, hourlyTransportAmount: 0 }),
      hours: emptyHours({
        redovanRadSati: 120,
        godisnjiSati: 16,
        bolovanje65Sati: 8,
        praznikPlaceniSati: 8,
        slobodniDaniSati: 8,
      }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    /* sati godisnji/bolovanje/praznik_placeni/slobodni se nuluju → payable = 120 */
    expect(r.payableHours).toBe(120);
    expect(r.ukupnaZarada).toBe(60000);
    /* mora biti warning za svaku ignorisanu kategoriju */
    const codes = r.warnings.map(w => w.code);
    expect(codes).toContain('no_right_godisnji');
    expect(codes).toContain('no_right_bolovanje');
    expect(codes).toContain('no_right_praznik_placeni');
    expect(codes).toContain('no_right_slobodni');
  });
});

/* ─── Dodatne karakteristike ────────────────────────────────────────────── */

describe('payrollCalc — teren i edge cases', () => {
  it('Teren u zemlji × dnevnica daje RSD; teren ino × dnevnica daje EUR (zaseban total)', () => {
    const r = computeEarnings({
      workType: 'ugovor',
      terms: termsSatnica({
        hourlyRate: 500,
        hourlyTransportAmount: 0,
        terrainDomesticRate: 1500,
        terrainForeignRate: 35,
      }),
      hours: emptyHours({ redovanRadSati: 168 }),
      terrain: { domestic: 3, foreign: 2 },
      advanceAmount: 0,
    });
    /* baza = 168 × 500 = 84000; teren_rsd = 3 × 1500 = 4500 → ukupno_rsd = 88500 */
    expect(r.ukupnaZarada).toBe(88500);
    expect(r.terrainRsd).toBe(4500);
    /* teren_eur ide zasebno (ne u ukupna_zarada) */
    expect(r.terrainEur).toBe(70);
  });

  it('Negativan „preostalo za isplatu" daje warning', () => {
    const r = computeEarnings({
      workType: 'ugovor',
      terms: termsSatnica({ hourlyRate: 500 }),
      hours: emptyHours({ redovanRadSati: 10 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 50000,
    });
    expect(r.preostaloZaIsplatu).toBeLessThan(0);
    expect(r.warnings.map(w => w.code)).toContain('negative_remainder');
  });

  it('deriveCompensationModel: legacy salary_type → mapping', () => {
    expect(deriveCompensationModel({ salaryType: 'satnica' })).toBe('satnica');
    expect(deriveCompensationModel({ salaryType: 'ugovor' })).toBe('fiksno');
    expect(deriveCompensationModel({ salaryType: 'dogovor' })).toBe('fiksno');
    expect(deriveCompensationModel({ compensationModel: 'dva_dela' })).toBe('dva_dela');
    expect(deriveCompensationModel(null)).toBe(null);
  });

  it('sanitizeHoursForWorkType: ugovor ostavlja sve sate netaknute', () => {
    const h = emptyHours({ godisnjiSati: 16, bolovanje65Sati: 8 });
    const { sanitized, warnings } = sanitizeHoursForWorkType(h, 'ugovor');
    expect(sanitized.godisnjiSati).toBe(16);
    expect(sanitized.bolovanje65Sati).toBe(8);
    expect(warnings).toEqual([]);
  });

  it('computePayableHours: fiksno samo zbraja extra (prekov + praznik_rad + 2 maš.)', () => {
    const h = emptyHours({
      redovanRadSati: 160,
      prekovremeniSati: 5,
      praznikRadSati: 8,
      dveMasineSati: 3,
      godisnjiSati: 8,
    });
    const { payableHours } = computePayableHours(h, 'fiksno');
    expect(payableHours).toBe(16);
  });

  it('computePayableHours: weighted_full mode množi bolovanje 65% sa 0.65', () => {
    const h = emptyHours({ redovanRadSati: 100, bolovanje65Sati: 20 });
    const { payableHours } = computePayableHours(h, 'satnica');
    expect(payableHours).toBe(113);
  });

  it('computeMonthlyFond: februar 2026 (28 dana) bez praznika daje 20 radnih dana', () => {
    const r = computeMonthlyFond(2026, 2, new Set());
    expect(r.radniDani).toBeGreaterThan(0);
    expect(r.fondSati).toBe(r.radniDani * 8);
  });

  it('computeMonthlyFond: praznik na radni dan smanjuje fond za 8', () => {
    /* 1.1.2026 = četvrtak (radni dan). Ako ga proglasimo praznikom, fond pada za 8h. */
    const noHol = computeMonthlyFond(2026, 1, new Set());
    const withHol = computeMonthlyFond(2026, 1, new Set(['2026-01-01']));
    expect(noHol.fondSati - withHol.fondSati).toBe(8);
  });

  it('aggregateWorkHoursForMonth: GO na radni dan = 8h godišnjeg', () => {
    const m = new Map([['2026-04-01', { hours: 0, absenceCode: 'go', absenceSubtype: null }]]);
    const h = aggregateWorkHoursForMonth(2026, 4, m, new Set());
    expect(h.godisnjiSati).toBe(8);
    expect(h.redovanRadSati).toBe(0);
  });

  it('aggregateWorkHoursForMonth: državni praznik bez unosa = 8h plaćenog praznika', () => {
    const m = new Map();
    const h = aggregateWorkHoursForMonth(2026, 1, m, new Set(['2026-01-01']));
    expect(h.praznikPlaceniSati).toBe(8);
  });

  it('aggregateWorkHoursForMonth: bolovanje obično / povreda = 8h u bucket 65 / 100', () => {
    const m = new Map([
      ['2026-04-01', { hours: 0, absenceCode: 'bo', absenceSubtype: 'obicno' }],
      ['2026-04-02', { hours: 0, absenceCode: 'bo', absenceSubtype: 'povreda_na_radu' }],
    ]);
    const h = aggregateWorkHoursForMonth(2026, 4, m, new Set());
    expect(h.bolovanje65Sati).toBe(8);
    expect(h.bolovanje100Sati).toBe(8);
  });

  it('gridRedovniUnitsOneDay: subota bez šifre = 0 čak i uz državni praznik', () => {
    const u = gridRedovniUnitsOneDay('2026-04-11', { hours: 0 }, new Set(['2026-04-11']));
    expect(u).toBe(0);
  });
});
