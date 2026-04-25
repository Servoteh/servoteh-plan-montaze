import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sbReqMock } = vi.hoisted(() => ({ sbReqMock: vi.fn() }));

vi.mock('../../src/services/supabase.js', () => ({
  sbReq: sbReqMock,
  getSupabaseUrl: () => 'https://example.supabase.co',
  getSupabaseAnonKey: () => 'anon-key',
}));

vi.mock('../../src/state/auth.js', () => ({
  canEditPlanProizvodnje: () => true,
  getCurrentUser: () => ({ email: 'g2@example.com' }),
  getIsOnline: () => true,
}));

vi.mock('../../src/services/drawings.js', () => ({
  BIGTEHN_DRAWINGS_BUCKET: 'bigtehn-drawings',
  getBigtehnDrawingSignedUrl: vi.fn(),
  parseSupabaseStorageSignResponse: vi.fn(),
  absolutizeSupabaseStorageSignedPath: vi.fn(),
}));

describe('G2 sortProductionOperations', () => {
  it('sorts unpinned rows by bucket, deadline and BigTehn priority', async () => {
    const { sortProductionOperations } = await import('../../src/services/planProizvodnje.js');
    const rows = [
      { id: 'late', auto_sort_bucket: 5, rok_izrade: '2026-04-30', prioritet_bigtehn: 20, rn_ident_broj: 'RN3', operacija: 30 },
      { id: 'urgent', auto_sort_bucket: 2, rok_izrade: '2026-05-02', prioritet_bigtehn: 30, rn_ident_broj: 'RN2', operacija: 20 },
      { id: 'same-bucket-earlier', auto_sort_bucket: 5, rok_izrade: '2026-04-29', prioritet_bigtehn: 10, rn_ident_broj: 'RN1', operacija: 10 },
    ];

    expect(sortProductionOperations(rows).map(r => r.id)).toEqual([
      'urgent',
      'same-bucket-earlier',
      'late',
    ]);
  });

  it('keeps one pinned row before auto-sorted rows', async () => {
    const { sortProductionOperations } = await import('../../src/services/planProizvodnje.js');
    const rows = [
      { id: 'auto-best', auto_sort_bucket: 1, rok_izrade: '2026-04-29', prioritet_bigtehn: 10 },
      { id: 'pinned', shift_sort_order: 10, auto_sort_bucket: 8, rok_izrade: '2026-05-10', prioritet_bigtehn: 99 },
      { id: 'auto-next', auto_sort_bucket: 2, rok_izrade: '2026-04-30', prioritet_bigtehn: 20 },
    ];

    expect(sortProductionOperations(rows).map(r => r.id)).toEqual([
      'pinned',
      'auto-best',
      'auto-next',
    ]);
  });

  it('sorts two pinned rows by shift_sort_order before auto rows', async () => {
    const { sortProductionOperations } = await import('../../src/services/planProizvodnje.js');
    const rows = [
      { id: 'pinned-second', shift_sort_order: 2, auto_sort_bucket: 1 },
      { id: 'auto', auto_sort_bucket: 1 },
      { id: 'pinned-first', shift_sort_order: 1, auto_sort_bucket: 9 },
    ];

    expect(sortProductionOperations(rows).map(r => r.id)).toEqual([
      'pinned-first',
      'pinned-second',
      'auto',
    ]);
  });
});

describe('G2 writers', () => {
  beforeEach(() => {
    sbReqMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T10:15:30.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('upserts urgent metadata for a work order', async () => {
    const { setUrgent } = await import('../../src/services/planProizvodnje.js');
    sbReqMock.mockResolvedValue([{ work_order_id: 101 }]);

    await setUrgent(101, 'Kupac traži prioritet');

    expect(sbReqMock).toHaveBeenCalledWith(
      'production_urgency_overrides?on_conflict=work_order_id',
      'POST',
      {
        work_order_id: 101,
        is_urgent: true,
        reason: 'Kupac traži prioritet',
        set_by: 'g2@example.com',
        set_at: '2026-04-25T10:15:30.000Z',
        cleared_at: null,
        cleared_by: null,
      },
    );
  });

  it('clears urgent metadata for a work order', async () => {
    const { clearUrgent } = await import('../../src/services/planProizvodnje.js');
    sbReqMock.mockResolvedValue([{ work_order_id: 101 }]);

    await clearUrgent(101);

    expect(sbReqMock).toHaveBeenCalledWith(
      'production_urgency_overrides?on_conflict=work_order_id',
      'POST',
      {
        work_order_id: 101,
        is_urgent: false,
        cleared_at: '2026-04-25T10:15:30.000Z',
        cleared_by: 'g2@example.com',
      },
    );
  });

  it('pins an operation above existing manual order', async () => {
    const { pinToTop } = await import('../../src/services/planProizvodnje.js');
    sbReqMock.mockResolvedValue([{ id: 1 }]);

    await pinToTop(
      { work_order_id: 101, line_id: 202 },
      [{ shift_sort_order: 5 }, { shift_sort_order: 9 }, { shift_sort_order: null }],
    );

    expect(sbReqMock).toHaveBeenCalledWith(
      'production_overlays?on_conflict=work_order_id,line_id',
      'POST',
      expect.objectContaining({
        work_order_id: 101,
        line_id: 202,
        shift_sort_order: 4,
        updated_by: 'g2@example.com',
        created_by: 'g2@example.com',
      }),
    );
  });

  it('unpins an operation by clearing shift_sort_order', async () => {
    const { unpin } = await import('../../src/services/planProizvodnje.js');
    sbReqMock.mockResolvedValue([{ id: 1 }]);

    await unpin({ work_order_id: 101, line_id: 202 });

    expect(sbReqMock).toHaveBeenCalledWith(
      'production_overlays?on_conflict=work_order_id,line_id',
      'POST',
      expect.objectContaining({
        work_order_id: 101,
        line_id: 202,
        shift_sort_order: null,
      }),
    );
  });
});
