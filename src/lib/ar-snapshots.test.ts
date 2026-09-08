import { describe, it, expect } from 'vitest';
import { buildArSnapshotRows } from './ar-snapshots';
import type { OpenArInvoice } from './financials-data';

const inv = (over: Partial<OpenArInvoice>): OpenArInvoice => ({
  id: '1', tranid: 'INV-1', date: null, dueDate: null, po: null,
  customer: 'Acme', entityId: '100', total: 500, unpaid: 500,
  daysPastDue: 0, bucket: 'current', nsUrl: '', ...over,
});

describe('buildArSnapshotRows — nightly A/R snapshot rows', () => {
  it('writes the total, every bucket, and per-customer rows', () => {
    const rows = buildArSnapshotRows([
      inv({ id: '1', unpaid: 500 }),
      inv({ id: '2', unpaid: 250, daysPastDue: 45, bucket: 'd31_60' }),
    ], '2026-09-08');

    const total = rows.find(r => r.scope === 'total')!;
    expect(total.value).toBe(750);
    expect(total.meta).toMatchObject({ openCount: 2, pastDue: 250 });

    const buckets = Object.fromEntries(rows.filter(r => r.scope === 'bucket').map(r => [r.key, r.value]));
    expect(buckets).toEqual({ current: 500, d1_30: 0, d31_60: 250, d61_90: 0, d90plus: 0 });

    const cust = rows.filter(r => r.scope === 'customer');
    expect(cust).toHaveLength(1);
    expect(cust[0]).toMatchObject({ key: 'e:100', label: 'Acme', value: 750, meta: { pastDue: 250 } });
  });

  it('same-named customers with different entity ids never merge; unnamed keys by name', () => {
    const rows = buildArSnapshotRows([
      inv({ id: '1', entityId: '100', unpaid: 100 }),
      inv({ id: '2', entityId: '200', unpaid: 200 }),
      inv({ id: '3', entityId: null, customer: 'Walk-in', unpaid: 50 }),
    ], '2026-09-08');
    const keys = rows.filter(r => r.scope === 'customer').map(r => r.key).sort();
    expect(keys).toEqual(['e:100', 'e:200', 'n:Walk-in']);
  });

  it('keeps only the top 20 customers by total open balance, stably ordered', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      inv({ id: String(i), entityId: String(i), customer: `C${i}`, unpaid: 25 - i }));
    const rows = buildArSnapshotRows(many, '2026-09-08');
    const cust = rows.filter(r => r.scope === 'customer');
    expect(cust).toHaveLength(20);
    expect(cust[0].value).toBe(25);
    expect(cust[19].value).toBe(6);
  });

  it('empty A/R still writes total 0 and zero buckets (a real data point, not a gap)', () => {
    const rows = buildArSnapshotRows([], '2026-09-08');
    expect(rows.find(r => r.scope === 'total')!.value).toBe(0);
    expect(rows.filter(r => r.scope === 'bucket')).toHaveLength(5);
    expect(rows.filter(r => r.scope === 'customer')).toHaveLength(0);
  });
});
