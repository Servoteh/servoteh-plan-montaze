import { describe, it, expect } from 'vitest';
import { buildTspLabelProgram, buildTspShelfLabelProgram } from '../../src/lib/tspl2.js';

describe('buildTspLabelProgram', () => {
  const baseSpec = {
    fields: {
      brojPredmeta: '7351/1088',
      komitent: 'Jugoimport SDPR',
      nazivPredmeta: 'Perun – automatski punjač',
      nazivDela: 'PRIGUŠENJE 1 40/22 - KONUS',
      brojCrteza: '1130927',
      kolicina: '1/96',
      materijal: 'Č.4732 FI30X30',
      datum: '23-04-26',
    },
    barcodeValue: 'RNZ:0:7351/1088:0:0',
  };

  it('generates a valid TSPL2 program with only render commands (no SIZE/GAP/DENSITY)', () => {
    const out = buildTspLabelProgram(baseSpec);
    /* Po dogovoru sa proizvodnjom: štampač je već konfigurisan u web admin-u
     * za 80.34×40.30mm, slanje SIZE/GAP/DENSITY/SPEED/CODEPAGE komandi mu prepisuje
     * postavke i blokira ga. Šaljemo SAMO render komande. */
    expect(out).toContain('CLS');
    expect(out).toContain('PRINT 1,1');
    expect(out).toMatch(/^[\s\S]*BARCODE/);
    /* Ne sme da postoji NIJEDNA "format change" komanda: */
    expect(out).not.toContain('SIZE');
    expect(out).not.toContain('GAP');
    expect(out).not.toContain('DIRECTION');
    expect(out).not.toContain('DENSITY');
    expect(out).not.toContain('SPEED');
    expect(out).not.toContain('CODEPAGE');
    expect(out).not.toContain('REFERENCE');
    expect(out).not.toContain('OFFSET');
    expect(out).not.toContain('SET TEAR');
  });

  it('embeds the RNZ barcode value verbatim in BARCODE command', () => {
    const out = buildTspLabelProgram(baseSpec);
    expect(out).toMatch(/BARCODE [\d]+,[\d]+,"128M",[\d]+,0,0,2,4,"RNZ:0:7351\/1088:0:0"/);
  });

  it('transliterates Serbian diacritics to ASCII for TEXT fields', () => {
    const out = buildTspLabelProgram(baseSpec);
    /* Č → C, š → s, ž → z, ć → c, đ → dj */
    expect(out).toContain('"C.4732 FI30X30"');
    expect(out).toContain('"PRIGUSENJE 1 40/22 - KONUS"');
    expect(out).toMatch(/Perun (-|–)? ?automatski punjac/);
    /* Ne sme da ostane original sa dijakriticima */
    expect(out).not.toMatch(/Č\.4732/);
    expect(out).not.toMatch(/PRIGUŠENJE/);
    expect(out).not.toMatch(/punjač/);
  });

  it('honors copies parameter via PRINT command', () => {
    const out = buildTspLabelProgram({ ...baseSpec, copies: 5 });
    expect(out).toContain('PRINT 5,1');
  });

  it('throws if barcodeValue missing', () => {
    expect(() => buildTspLabelProgram({ fields: {}, barcodeValue: '' })).toThrow();
    expect(() => buildTspLabelProgram({ fields: {}, barcodeValue: null })).toThrow();
  });

  it('omits TEXT lines when corresponding field is missing', () => {
    const sparse = {
      fields: { brojPredmeta: '9000/522' },
      barcodeValue: 'RNZ:0:9000/522:0:0',
    };
    const out = buildTspLabelProgram(sparse);
    expect(out).toContain('"9000/522"');
    /* Sparse: nema komitenta, materijala, kolicine, datuma — pa NIJEDNOG TEXT-a sa tim sadržajem */
    expect(out).not.toMatch(/Mat:|Crtez:|Kol:/);
    /* Barkod uvek mora biti prisutan */
    expect(out).toContain('BARCODE');
  });

  it('escapes embedded double quotes by replacing with single quotes', () => {
    const out = buildTspLabelProgram({
      fields: { brojPredmeta: 'TEST"X' },
      barcodeValue: 'RNZ:0:1/1:0:0',
    });
    /* Posle escape-a, dupli navodnici postaju jednostruki da TSPL2 parser
     * ne prekine string parametra. */
    expect(out).toContain("\"TEST'X\"");
  });

  it('terminates each command with CRLF (TSC firmware requires it)', () => {
    const out = buildTspLabelProgram(baseSpec);
    expect(out.endsWith('\r\n')).toBe(true);
    expect(out).toContain('\r\n');
  });

  it('places barcode below 5-row text zona and inside physical 40.30mm height', () => {
    const out = buildTspLabelProgram(baseSpec);
    const m = out.match(/BARCODE \d+,(\d+),"128M",(\d+)/);
    expect(m).not.toBeNull();
    const yDots = Number(m[1]);
    const hDots = Number(m[2]);
    /* y mora biti ispod Reda 5 (~12mm + 2.5mm = 14.5mm * 11.81 ≈ 171 dots) */
    expect(yDots).toBeGreaterThanOrEqual(160);
    /* y + height MORA stati u fizičkih 40.30mm (476 dots) sa malo rezerve */
    expect(yDots + hDots).toBeLessThan(380); /* 32mm * 11.81 ≈ 378 — daje >8mm donje rezerve */
  });
});

describe('buildTspShelfLabelProgram', () => {
  it('generates valid program for shelf label without size-changing commands', () => {
    const out = buildTspShelfLabelProgram({ location_code: 'MAG-1.A.03', name: 'Polica A03' });
    expect(out).toContain('CLS');
    expect(out).toContain('"MAG-1.A.03"');
    expect(out).toContain('"Polica A03"');
    expect(out).toMatch(/BARCODE [\d]+,[\d]+,"128M"/);
    expect(out).toContain('PRINT 1,1');
    /* Ne sme menjati štampač konfiguraciju: */
    expect(out).not.toContain('SIZE');
    expect(out).not.toContain('GAP');
    expect(out).not.toContain('DENSITY');
  });

  it('throws if location_code missing', () => {
    expect(() => buildTspShelfLabelProgram({ location_code: '' })).toThrow();
  });

  it('handles empty name gracefully', () => {
    const out = buildTspShelfLabelProgram({ location_code: 'X1' });
    expect(out).toContain('"X1"');
  });

  it('honors copies parameter', () => {
    const out = buildTspShelfLabelProgram({ location_code: 'X1', copies: 3 });
    expect(out).toContain('PRINT 3,1');
  });
});
