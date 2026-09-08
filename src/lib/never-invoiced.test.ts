import { describe, it, expect } from 'vitest';
import { classifyRecovery, BUCKET_LABEL, BUCKET_HELP, type RecoverySalesOrder } from './never-invoiced';

const so = (over: Partial<RecoverySalesOrder> = {}): RecoverySalesOrder => ({
  netsuiteId: '1001', number: 'SO1001', total: 5000, invoiced: false, invoiceNumber: null, ...over,
});

describe('classifyRecovery', () => {
  it('routes an uninvoiced sales order to the one-click bucket', () => {
    const r = classifyRecovery({ salesOrders: [so()], estimates: [] });
    expect(r.bucket).toBe('has_so');
    expect(r.expectedAmount).toBe(5000);
    expect(r.amountSource).toBe('sales_order');
    expect(r.amountPartial).toBe(false);
  });

  it('sums only the OPEN sales orders — a billed one is not owed again', () => {
    const r = classifyRecovery({
      salesOrders: [
        so({ netsuiteId: '1', total: 5000, invoiced: true, invoiceNumber: 'INV1' }),
        so({ netsuiteId: '2', total: 1200 }),
      ],
      estimates: [],
    });
    expect(r.expectedAmount).toBe(1200);
  });

  it('prefers the sales order even when an estimate is also linked', () => {
    const r = classifyRecovery({
      salesOrders: [so()],
      estimates: [{ id: 'e1', number: 'EST-1', status: 'accepted', total: 9999 }],
    });
    // Routing this vehicle to "convert the estimate" would send someone to
    // redo work already done — the SO is the billable document.
    expect(r.bucket).toBe('has_so');
    expect(r.expectedAmount).toBe(5000);
  });

  it('reports an unknown SO total as null, never as zero', () => {
    const r = classifyRecovery({ salesOrders: [so({ total: null })], estimates: [] });
    expect(r.bucket).toBe('has_so');
    expect(r.expectedAmount).toBeNull();
    expect(r.amountSource).toBeNull();
  });

  it('flags a partial sum when only some open SOs carried a total', () => {
    const r = classifyRecovery({
      salesOrders: [so({ netsuiteId: '1', total: 400 }), so({ netsuiteId: '2', total: null })],
      estimates: [],
    });
    expect(r.expectedAmount).toBe(400);
    expect(r.amountPartial).toBe(true);
  });

  it('does not flag partial when every open SO carried a total', () => {
    const r = classifyRecovery({
      salesOrders: [so({ netsuiteId: '1', total: 400 }), so({ netsuiteId: '2', total: 600 })],
      estimates: [],
    });
    expect(r.expectedAmount).toBe(1000);
    expect(r.amountPartial).toBe(false);
  });

  it('routes an estimate with no sales order to the conversion bucket', () => {
    const r = classifyRecovery({
      salesOrders: [],
      estimates: [{ id: 'e1', number: 'EST-1', status: 'accepted', total: 3200 }],
    });
    expect(r.bucket).toBe('estimate_only');
    expect(r.expectedAmount).toBe(3200);
    expect(r.amountSource).toBe('estimate');
  });

  it('takes the LARGEST linked estimate, not their sum — revisions are alternatives', () => {
    const r = classifyRecovery({
      salesOrders: [],
      estimates: [
        { id: 'e1', number: 'EST-1', status: 'rejected', total: 3200 },
        { id: 'e2', number: 'EST-1-R1', status: 'accepted', total: 4100 },
      ],
    });
    expect(r.expectedAmount).toBe(4100);
  });

  it('treats a zero-total estimate as no figure at all (a draft with no lines)', () => {
    const r = classifyRecovery({
      salesOrders: [],
      estimates: [{ id: 'e1', number: 'EST-1', status: 'draft', total: 0 }],
    });
    expect(r.bucket).toBe('estimate_only');
    expect(r.expectedAmount).toBeNull();
  });

  it('routes a vehicle with no paperwork to the human bucket with no amount', () => {
    const r = classifyRecovery({ salesOrders: [], estimates: [] });
    expect(r.bucket).toBe('no_paperwork');
    expect(r.expectedAmount).toBeNull();
    expect(r.amountSource).toBeNull();
  });

  it('a fully-billed set of SOs still falls through to the estimate/no-paperwork read', () => {
    // The queue loader routes these to partiallyInvoiced/out entirely, but the
    // classifier must not claim an amount is owed on a billed SO.
    const r = classifyRecovery({
      salesOrders: [so({ invoiced: true, invoiceNumber: 'INV1' })],
      estimates: [],
    });
    expect(r.bucket).toBe('no_paperwork');
    expect(r.expectedAmount).toBeNull();
  });

  it('every bucket has a label and an instruction naming the next action', () => {
    for (const key of ['has_so', 'estimate_only', 'no_paperwork'] as const) {
      expect(BUCKET_LABEL[key].length).toBeGreaterThan(0);
      expect(BUCKET_HELP[key].length).toBeGreaterThan(0);
    }
  });
});
