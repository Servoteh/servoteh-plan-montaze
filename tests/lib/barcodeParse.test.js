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

describe('parseBigTehnBarcode — RNZ format (current production)', () => {
  it('parsira realan RNZ barkod iz magacina', () => {
    expect(parseBigTehnBarcode('RNZ:8693:7351/1088:0:39757')).toEqual({
      orderNo: '7351',
      itemRefId: '1088',
      drawingNo: '',
      format: 'rnz',
      raw: 'RNZ:8693:7351/1088:0:39757',
    });
  });

  it('ignoriše interne brojeve (8693, 0, 39757)', () => {
    /* 8693 = neki interni ID, 0 = flag, 39757 = drugi ID — nas ne zanima. */
    const a = parseBigTehnBarcode('RNZ:1:5000/100:0:99999');
    expect(a?.orderNo).toBe('5000');
    expect(a?.itemRefId).toBe('100');
    expect(a?.format).toBe('rnz');
  });

  it('toleriše razmake između segmenata', () => {
    expect(parseBigTehnBarcode('RNZ : 8693 : 7351/1088 : 0 : 39757')?.orderNo).toBe('7351');
  });

  it('toleriše | umesto : (kao Code39 escape)', () => {
    expect(parseBigTehnBarcode('RNZ|8693|7351/1088|0|39757')?.itemRefId).toBe('1088');
  });

  it('case-insensitive prefix', () => {
    expect(parseBigTehnBarcode('rnz:1:5000/100:0:1')?.format).toBe('rnz');
    expect(parseBigTehnBarcode('Rnz:1:5000/100:0:1')?.format).toBe('rnz');
  });

  it('odbija RNZ sa premalo segmenata', () => {
    expect(parseBigTehnBarcode('RNZ:8693:7351/1088')).toBeNull();
    expect(parseBigTehnBarcode('RNZ:7351/1088')).toBeNull();
  });
});

describe('parseBigTehnBarcode — legacy short format', () => {
  it('parsira stari NALOG/CRTEŽ', () => {
    expect(parseBigTehnBarcode('9000/1091063')).toEqual({
      orderNo: '9000',
      itemRefId: '1091063',
      drawingNo: '1091063',
      format: 'short',
      raw: '9000/1091063',
    });
  });

  it('parsira kraće varijante sa manjim brojem crteža', () => {
    expect(parseBigTehnBarcode('9000/260')?.itemRefId).toBe('260');
  });

  it('toleriše razmake oko razdvajača', () => {
    expect(parseBigTehnBarcode('9000 / 1091063')?.drawingNo).toBe('1091063');
  });

  it('toleriše alternativne razdvajače (backslash/dash/underscore)', () => {
    expect(parseBigTehnBarcode('9000\\1091063')?.drawingNo).toBe('1091063');
    expect(parseBigTehnBarcode('9000-1091063')?.drawingNo).toBe('1091063');
    expect(parseBigTehnBarcode('9000_1091063')?.drawingNo).toBe('1091063');
    expect(parseBigTehnBarcode('9000 1091063')?.drawingNo).toBe('1091063');
  });

  it('skida Code39 `*` pre parsiranja', () => {
    expect(parseBigTehnBarcode('*9000/1091063*')?.orderNo).toBe('9000');
  });
});

describe('parseBigTehnBarcode — invalid input', () => {
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
