import { describe, it, expect } from 'vitest';
import { pivotArSnapshots, computeSlowPayers } from './ar-trends';

describe('pivotArSnapshots', () => {
  it('folds total + bucket rows into one entry per day, oldest first', () => {
    const days = pivotArSnapshots([
      { day: '2026-09-09', scope: 'total', key: 'total', value: 900 },
      { day: '2026-09-08', scope: 'total', key: 'total', value: 1000 },
      { day: '2026-09-08', scope: 'bucket', key: 'current', value: 600 },
      { day: '2026-09-08', scope: 'bucket', key: 'd31_60', value: 400 },
      { day: '2026-09-08', scope: 'customer', key: 'e:1', value: 999 }, // ignored
    ]);
    expect(days.map(d => d.day)).toEqual(['2026-09-08', '2026-09-09']);
    expect(days[0].total).toBe(1000);
    expect(days[0].buckets).toMatchObject({ current: 600, d31_60: 400, d90plus: 0 });
  });
});

describe('computeSlowPayers — median days-to-pay per customer', () => {
  const row = (customer: string, invoice: string, invoiced: string, paid: string) =>
    ({ customer, invoice, invoiced, paid });

  it('one sample per distinct invoice, median per customer, slowest first', () => {
    const out = computeSlowPayers([
      row('Acme', 'I-1', '2026-08-01', '2026-08-31'), // 30
      row('Acme', 'I-1', '2026-08-01', '2026-08-31'), // dup invoice — ignored
      row('Acme', 'I-2', '2026-08-01', '2026-08-11'), // 10
      row('Beta', 'I-3', '2026-08-01', '2026-09-30'), // 60
      row('Beta', 'I-4', '2026-08-01', '2026-09-10'), // 40
    ], 2);
    expect(out[0]).toMatchObject({ customer: 'Beta', medianDays: 50, invoices: 2 });
    expect(out[1]).toMatchObject({ customer: 'Acme', medianDays: 20, invoices: 2 });
  });

  it('drops customers below the sample floor, negative spans, and blank fields', () => {
    const out = computeSlowPayers([
      row('One', 'I-1', '2026-08-01', '2026-08-05'),
      row('Neg', 'I-2', '2026-08-10', '2026-08-01'),
      row('Neg', 'I-3', '2026-08-10', '2026-08-01'),
      { customer: null, invoice: 'I-4', invoiced: '2026-08-01', paid: '2026-08-02' },
    ], 2);
    expect(out).toEqual([]);
  });

  it('paid_at timestamps (ISO with time) count as their calendar day', () => {
    const out = computeSlowPayers([
      row('Acme', 'I-1', '2026-08-01', '2026-08-15T14:22:09.000Z'),
      row('Acme', 'I-2', '2026-08-01', '2026-08-15T02:00:00.000Z'),
    ], 2);
    expect(out[0].medianDays).toBe(14);
  });
});
