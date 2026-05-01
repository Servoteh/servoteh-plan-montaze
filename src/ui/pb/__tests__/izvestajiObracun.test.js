import { describe, it, expect } from 'vitest';
import {
  filterWorkReportsByPeriod,
  sumHours,
  groupByEmployee,
} from '../izvestajiObracun.js';

describe('izvestajiObracun', () => {
  const reports = [
    { datum: '2026-03-05', sati: 2.5, employee_id: 'a', engineer_name: 'A' },
    { datum: '2026-03-10', sati: 1, employee_id: 'b', engineer_name: 'B' },
    { datum: '2026-03-15', sati: 3, employee_id: 'a', engineer_name: 'A' },
  ];

  it('filterWorkReportsByPeriod — inkluzivni opseg datuma', () => {
    const f = filterWorkReportsByPeriod(reports, '2026-03-06', '2026-03-15', null);
    expect(f).toHaveLength(2);
    expect(f.map(r => r.datum)).toEqual(['2026-03-10', '2026-03-15']);
  });

  it('filterWorkReportsByPeriod — employeeId', () => {
    const f = filterWorkReportsByPeriod(reports, '2026-03-01', '2026-03-31', 'a');
    expect(f).toHaveLength(2);
  });

  it('filterWorkReportsByPeriod — prazan rezultat', () => {
    expect(filterWorkReportsByPeriod(reports, '2027-01-01', '2027-01-02', null)).toHaveLength(0);
  });

  it('sumHours', () => {
    expect(sumHours(reports)).toBe(6.5);
    expect(sumHours([])).toBe(0);
  });

  it('groupByEmployee', () => {
    const g = groupByEmployee(reports);
    expect(g.a.count).toBe(2);
    expect(g.a.hours).toBe(5.5);
    expect(g.b.count).toBe(1);
    expect(g.b.hours).toBe(1);
  });
});
