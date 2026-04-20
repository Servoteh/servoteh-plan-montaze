import { describe, it, expect } from 'vitest';
import {
  normalizeBarcodeText,
  parseBigTehnBarcode,
} from '../../src/lib/barcodeParse.js';

describe('normalizeBarcodeText', () => {
  it('trimuje razmake, CR i LF', () => {
    expect(normalizeBarcodeText('  9000/260\r\n')).toBe('9000/260');
    expect(normalizeBarcodeText('\t1091063 ')).toBe('1091063');
  });

  it('skida Code39 *TEXT* delimitere', () => {
    expect(normalizeBarcodeText('*1084924*')).toBe('1084924');
    expect(normalizeBarcodeText('*9000/260*')).toBe('9000/260');
  });

  it('ne dira single-star strings', () => {
    expect(normalizeBarcodeText('*')).toBe('*');
    expect(normalizeBarcodeText('**')).toBe('**');
  });

  it('vraća "" za non-string input', () => {
    expect(normalizeBarcodeText(null)).toBe('');
    expect(normalizeBarcodeText(undefined)).toBe('');
    expect(normalizeBarcodeText(42)).toBe('');
  });
});

describe('parseBigTehnBarcode', () => {
  it('parsira realan BigTehn format NALOG/CRTEŽ', () => {
    expect(parseBigTehnBarcode('9000/1091063')).toEqual({
      orderNo: '9000',
      drawingNo: '1091063',
      raw: '9000/1091063',
    });
  });

  it('parsira krace varijante sa manjim brojem crteža', () => {
    expect(parseBigTehnBarcode('9000/260')).toEqual({
      orderNo: '9000',
      drawingNo: '260',
      raw: '9000/260',
    });
  });

  it('toleriše razmake oko razdvajača', () => {
    expect(parseBigTehnBarcode('9000 / 1091063')).toEqual({
      orderNo: '9000',
      drawingNo: '1091063',
      raw: '9000 / 1091063',
    });
  });

  it('toleriše alternativne razdvajače (backslash/dash/underscore)', () => {
    expect(parseBigTehnBarcode('9000\\1091063')?.drawingNo).toBe('1091063');
    expect(parseBigTehnBarcode('9000-1091063')?.drawingNo).toBe('1091063');
    expect(parseBigTehnBarcode('9000_1091063')?.drawingNo).toBe('1091063');
    expect(parseBigTehnBarcode('9000 1091063')?.drawingNo).toBe('1091063');
  });

  it('skida Code39 `*` pre parsiranja', () => {
    expect(parseBigTehnBarcode('*9000/1091063*')).toEqual({
      orderNo: '9000',
      drawingNo: '1091063',
      raw: '9000/1091063',
    });
  });

  it('vraća null za plain broj crteža (samo drawing no)', () => {
    expect(parseBigTehnBarcode('1091063')).toBeNull();
    expect(parseBigTehnBarcode('1084924')).toBeNull();
  });

  it('vraća null za prazan / neiksrni / ne-numerički input', () => {
    expect(parseBigTehnBarcode('')).toBeNull();
    expect(parseBigTehnBarcode(null)).toBeNull();
    expect(parseBigTehnBarcode('ABC/DEF')).toBeNull();
    expect(parseBigTehnBarcode('9000/ABC')).toBeNull();
    expect(parseBigTehnBarcode('9000//1091063')).toBeNull();
    expect(parseBigTehnBarcode('9000/1091063/extra')).toBeNull();
  });

  it('ne hvata prevelike brojeve (chaos safeguard)', () => {
    expect(parseBigTehnBarcode('999999999/1')).toBeNull(); // 9-cifreni nalog
    expect(parseBigTehnBarcode('1/12345678901')).toBeNull(); // 11-cifreni crtež
  });
});
