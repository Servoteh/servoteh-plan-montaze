import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLokacijeUiState,
  setLokacijeActiveTab,
  setBrowseFilter,
  setItemsFilter,
  setItemsPage,
  setItemsPageSize,
  setHistoryFilters,
  resetHistoryFilters,
  setHistoryPage,
  setHistoryPageSize,
} from '../../src/state/lokacije.js';

/* storage.js je fail-safe (try/catch na localStorage), pa testovi rade
 * u Node-u (bez jsdom-a) — lsSetJSON-i samo catch-uju grešku. */

describe('state/lokacije — normalizeTab', () => {
  beforeEach(() => {
    setLokacijeActiveTab('dashboard');
  });

  it('postavlja validan tab', () => {
    setLokacijeActiveTab('items');
    expect(getLokacijeUiState().activeTab).toBe('items');
  });

  it('odbija nevalidan tab i fallback-uje na dashboard', () => {
    setLokacijeActiveTab('zlonamerno');
    expect(getLokacijeUiState().activeTab).toBe('dashboard');
  });

  it('odbija ne-string vrednosti', () => {
    setLokacijeActiveTab(null);
    expect(getLokacijeUiState().activeTab).toBe('dashboard');
    setLokacijeActiveTab(42);
    expect(getLokacijeUiState().activeTab).toBe('dashboard');
  });
});

describe('state/lokacije — filter normalizacija', () => {
  it('browseFilter strip-uje kontrol znakove i trim-uje dužinu', () => {
    setBrowseFilter('abc\x00def');
    expect(getLokacijeUiState().browseFilter).toBe('abcdef');
  });

  it('browseFilter ograničava na 120 znakova', () => {
    setBrowseFilter('x'.repeat(200));
    expect(getLokacijeUiState().browseFilter).toHaveLength(120);
  });

  it('itemsFilter resetuje paginaciju na 0', () => {
    setItemsPage(3);
    setItemsFilter('xyz');
    expect(getLokacijeUiState().itemsPage).toBe(0);
  });

  it('non-string filter → ""', () => {
    setBrowseFilter(null);
    expect(getLokacijeUiState().browseFilter).toBe('');
    setBrowseFilter(undefined);
    expect(getLokacijeUiState().browseFilter).toBe('');
  });
});

describe('state/lokacije — paginacija', () => {
  it('setItemsPage ne prihvata negativne vrednosti', () => {
    setItemsPage(-5);
    expect(getLokacijeUiState().itemsPage).toBe(0);
  });

  it('setItemsPageSize fallback na 50 za nevalidne vrednosti', () => {
    setItemsPageSize(7);
    expect(getLokacijeUiState().itemsPageSize).toBe(50);
    setItemsPageSize('abc');
    expect(getLokacijeUiState().itemsPageSize).toBe(50);
  });

  it('setItemsPageSize prihvata whitelist vrednosti', () => {
    for (const n of [25, 50, 100, 250]) {
      setItemsPageSize(n);
      expect(getLokacijeUiState().itemsPageSize).toBe(n);
    }
  });

  it('setItemsPageSize resetuje page na 0', () => {
    setItemsPage(5);
    setItemsPageSize(100);
    expect(getLokacijeUiState().itemsPage).toBe(0);
  });
});

describe('state/lokacije — history filteri', () => {
  beforeEach(() => {
    resetHistoryFilters();
  });

  it('početno stanje je prazno', () => {
    const f = getLokacijeUiState().historyFilters;
    expect(f).toEqual({
      search: '',
      userId: '',
      locationId: '',
      movementType: '',
      dateFrom: '',
      dateTo: '',
    });
    expect(getLokacijeUiState().historyPage).toBe(0);
  });

  it('setHistoryFilters patch-uje samo prosleđena polja', () => {
    setHistoryFilters({ search: 'abc' });
    expect(getLokacijeUiState().historyFilters.search).toBe('abc');
    setHistoryFilters({ movementType: 'TRANSFER' });
    const f = getLokacijeUiState().historyFilters;
    expect(f.search).toBe('abc');
    expect(f.movementType).toBe('TRANSFER');
  });

  it('odbija nevažeći UUID za userId / locationId', () => {
    setHistoryFilters({ userId: 'not-a-uuid', locationId: '' });
    expect(getLokacijeUiState().historyFilters.userId).toBe('');
    setHistoryFilters({
      userId: 'AB123456-7890-4bcd-8ef0-1234567890ab',
      locationId: 'AB123456-7890-4bcd-8ef0-1234567890ab',
    });
    expect(getLokacijeUiState().historyFilters.userId).toBe('ab123456-7890-4bcd-8ef0-1234567890ab');
  });

  it('odbija nepoznat movement_type', () => {
    setHistoryFilters({ movementType: 'EVIL_DROP' });
    expect(getLokacijeUiState().historyFilters.movementType).toBe('');
  });

  it('samo ISO date format za from/to', () => {
    setHistoryFilters({ dateFrom: '2025-13-45', dateTo: 'xxx' });
    const f = getLokacijeUiState().historyFilters;
    expect(f.dateFrom).toBe('2025-13-45');
    /* regex samo formatno; invalidni meseci/dani se vide u RPC-u, a ovde samo struktura */
    setHistoryFilters({ dateFrom: 'bad', dateTo: '2025-01-01' });
    expect(getLokacijeUiState().historyFilters.dateFrom).toBe('');
    expect(getLokacijeUiState().historyFilters.dateTo).toBe('2025-01-01');
  });

  it('bilo koji patch resetuje paginaciju na 0', () => {
    setHistoryPage(4);
    setHistoryFilters({ search: 'xyz' });
    expect(getLokacijeUiState().historyPage).toBe(0);
  });

  it('setHistoryPageSize whitelist + reset page', () => {
    setHistoryPage(2);
    setHistoryPageSize(7);
    expect(getLokacijeUiState().historyPageSize).toBe(50);
    setHistoryPageSize(250);
    expect(getLokacijeUiState().historyPageSize).toBe(250);
    expect(getLokacijeUiState().historyPage).toBe(0);
  });
});
