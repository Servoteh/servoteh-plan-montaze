import { describe, it, expect } from 'vitest';
import { DEPARTMENTS, resolveDepartmentSlug } from '../../../src/ui/planProizvodnje/departments.js';

describe('DEPARTMENTS konstanta', () => {
  it('ima tačno 10 stavki u zadatom redosledu', () => {
    expect(DEPARTMENTS.map(d => d.slug)).toEqual([
      'sve',
      'glodanje',
      'struganje',
      'borverci',
      'azistiranje',
      'secenje',
      'bravarsko',
      'farbanje',
      'povrsinska',
      'ostalo',
    ]);
  });

  it('„sve" i „ostalo" nemaju matchPatterns', () => {
    const sve = DEPARTMENTS.find(d => d.slug === 'sve');
    const ostalo = DEPARTMENTS.find(d => d.slug === 'ostalo');
    expect(sve.matchPatterns).toBeNull();
    expect(ostalo.matchPatterns).toBeNull();
  });
});

describe('resolveDepartmentSlug', () => {
  it('matchuje BigTehn nazive odeljenja iz baze (case + dijakritike insensitive)', () => {
    expect(resolveDepartmentSlug('Glodanje')).toBe('glodanje');
    expect(resolveDepartmentSlug('GLODANJE - CNC')).toBe('glodanje');
    expect(resolveDepartmentSlug('CNC Glodanje (HAAS)')).toBe('glodanje');
    expect(resolveDepartmentSlug('Struganje')).toBe('struganje');
    expect(resolveDepartmentSlug('Sečenje')).toBe('secenje');
    expect(resolveDepartmentSlug('SECENJE')).toBe('secenje');
    expect(resolveDepartmentSlug('Bravari')).toBe('bravarsko');
    expect(resolveDepartmentSlug('Farbanje')).toBe('farbanje');
    expect(resolveDepartmentSlug('Površinska zaštita')).toBe('povrsinska');
    expect(resolveDepartmentSlug('Povrsinska zastita')).toBe('povrsinska');
    expect(resolveDepartmentSlug('Borverci')).toBe('borverci');
    expect(resolveDepartmentSlug('Borverc 1')).toBe('borverci');
    expect(resolveDepartmentSlug('Ažistiranje')).toBe('azistiranje');
    expect(resolveDepartmentSlug('Azistiranje - rucno')).toBe('azistiranje');
  });

  it('vraća „ostalo" za null / undefined / prazne stringove', () => {
    expect(resolveDepartmentSlug(null)).toBe('ostalo');
    expect(resolveDepartmentSlug(undefined)).toBe('ostalo');
    expect(resolveDepartmentSlug('')).toBe('ostalo');
    expect(resolveDepartmentSlug('   ')).toBe('ostalo');
  });

  it('vraća „ostalo" za odeljenja koja ne mapiraju ni na jedan tab', () => {
    expect(resolveDepartmentSlug('Kontrola')).toBe('ostalo');
    expect(resolveDepartmentSlug('Kooperacija')).toBe('ostalo');
    expect(resolveDepartmentSlug('NN')).toBe('ostalo');
    expect(resolveDepartmentSlug('Montaža')).toBe('ostalo');
    expect(resolveDepartmentSlug('Brušenje')).toBe('ostalo');
    expect(resolveDepartmentSlug('Erodiranje')).toBe('ostalo');
    expect(resolveDepartmentSlug('Laser')).toBe('ostalo');
    expect(resolveDepartmentSlug('Savijanje')).toBe('ostalo');
    expect(resolveDepartmentSlug('CAM programiranje')).toBe('ostalo');
    expect(resolveDepartmentSlug('Poboljšanje')).toBe('ostalo');
    expect(resolveDepartmentSlug('3D Stampanje')).toBe('ostalo');
  });

  it('„Površinska zaštita" prepoznaje i kroz „zastit"/„povrsinsk" pattern (BigTehn varijacije)', () => {
    expect(resolveDepartmentSlug('Površinska Zaštita')).toBe('povrsinska');
    expect(resolveDepartmentSlug('zastita povrsina')).toBe('povrsinska');
  });
});
