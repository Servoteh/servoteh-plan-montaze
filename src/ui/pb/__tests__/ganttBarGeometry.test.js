import { describe, it, expect } from 'vitest';
import { ganttBarGeometry } from '../ganttTab.js';

const DAY_W = 28;

describe('ganttBarGeometry', () => {
  const start = new Date('2026-03-01T12:00:00');

  it('task starting on view start, 5 calendar days → left 0, width 5 * dayWidth', () => {
    const task = {
      datum_pocetka_plan: '2026-03-01',
      datum_zavrsetka_plan: '2026-03-05',
    };
    const g = ganttBarGeometry(task, start, DAY_W);
    expect(g).not.toBeNull();
    expect(g.left).toBe(0);
    expect(g.width).toBe(5 * DAY_W);
  });

  it('task starting 3 days after view start → left 3 * dayWidth', () => {
    const task = {
      datum_pocetka_plan: '2026-03-04',
      datum_zavrsetka_plan: '2026-03-04',
    };
    const g = ganttBarGeometry(task, start, DAY_W);
    expect(g).not.toBeNull();
    expect(g.left).toBe(3 * DAY_W);
  });

  it('task starting before view start → left clamped to 0', () => {
    const task = {
      datum_pocetka_plan: '2026-02-25',
      datum_zavrsetka_plan: '2026-03-02',
    };
    const g = ganttBarGeometry(task, start, DAY_W);
    expect(g).not.toBeNull();
    expect(g.left).toBe(0);
  });

  it('missing dates → null', () => {
    expect(ganttBarGeometry({ datum_pocetka_plan: null, datum_zavrsetka_plan: '2026-03-01' }, start, DAY_W)).toBeNull();
    expect(ganttBarGeometry({ datum_pocetka_plan: '2026-03-01', datum_zavrsetka_plan: null }, start, DAY_W)).toBeNull();
  });

  it('single-day task → width at least 8px and one day worth at dayWidth 28', () => {
    const task = {
      datum_pocetka_plan: '2026-03-10',
      datum_zavrsetka_plan: '2026-03-10',
    };
    const g = ganttBarGeometry(task, start, DAY_W);
    expect(g).not.toBeNull();
    expect(g.width).toBe(Math.max(DAY_W, 8));
  });
});
