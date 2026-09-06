import { describe, it, expect } from 'vitest';
import { isOpenSalesOrderStatus, isStockableItemType, CLOSED_SO_STATUS_CODES, describeSoMirrorHealth } from './parts-demand';

// The demand list is only as right as its "is this job still open" gate.
// NetSuite reuses the same status letters across transaction types with
// different meanings, so pin the SalesOrd set: borrowing the PurchOrd
// helper (F/G/H closed) would drop Pending Billing orders that are still
// real work waiting on parts.
describe('isOpenSalesOrderStatus', () => {
  it('treats cancelled, billed and closed as done', () => {
    for (const code of CLOSED_SO_STATUS_CODES) {
      expect(isOpenSalesOrderStatus(code)).toBe(false);
    }
  });

  it('keeps every in-flight status open', () => {
    // A = Pending Approval, B = Pending Fulfillment, D = Partially
    // Fulfilled, E = Pending Billing/Partially Fulfilled, F = Pending
    // Billing. F is the one the PurchOrd helper would wrongly close.
    for (const code of ['A', 'B', 'D', 'E', 'F']) {
      expect(isOpenSalesOrderStatus(code)).toBe(true);
    }
  });

  it('is case-insensitive on the code', () => {
    expect(isOpenSalesOrderStatus('h')).toBe(false);
    expect(isOpenSalesOrderStatus('b')).toBe(true);
  });

  it('closes on an unambiguous label even when the code is unfamiliar', () => {
    expect(isOpenSalesOrderStatus('Z', 'Closed')).toBe(false);
    expect(isOpenSalesOrderStatus('Z', 'Cancelled')).toBe(false);
    expect(isOpenSalesOrderStatus('Z', 'Billed')).toBe(false);
  });

  it('does not let the label gate close a Pending Billing order', () => {
    // Whole-string match on purpose: a substring test on "billed"/"closed"
    // would swallow "Pending Billing", the most common open status of all.
    expect(isOpenSalesOrderStatus('F', 'Pending Billing')).toBe(true);
    expect(isOpenSalesOrderStatus('E', 'Pending Billing/Partially Fulfilled')).toBe(true);
  });

  it('an unknown or missing status stays open — never silently dropped', () => {
    expect(isOpenSalesOrderStatus(null)).toBe(true);
    expect(isOpenSalesOrderStatus(undefined)).toBe(true);
    expect(isOpenSalesOrderStatus('')).toBe(true);
  });
});

// Conversion pushes labor as a real item line, so without this filter every
// converted job would report "we need N LABOR" and put it on a vendor PO.
describe('isStockableItemType', () => {
  it('accepts the physical item types', () => {
    for (const t of ['InvtPart', 'NonInvtPart', 'Assembly', 'Kit']) {
      expect(isStockableItemType(t)).toBe(true);
    }
  });

  it('rejects service and other-charge items', () => {
    for (const t of ['Service', 'OthCharge', 'Discount', 'Payment']) {
      expect(isStockableItemType(t)).toBe(false);
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(isStockableItemType(' invtpart ')).toBe(true);
    expect(isStockableItemType('KIT')).toBe(true);
  });

  it('treats a missing type as not stockable', () => {
    // Only reached for items that ARE in the catalog with a blank type;
    // items missing from the catalog entirely are kept by the caller.
    expect(isStockableItemType(null)).toBe(false);
    expect(isStockableItemType('')).toBe(false);
  });
});

// "0 open sales orders" is only meaningful if the mirror behind it is
// healthy — the first sync never finished and the page showed a confident
// zero for weeks. The note must name the actual condition.
describe('describeSoMirrorHealth', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  const row = (over: Partial<{ updated_at: string; last_result: any }>) => ({
    sync_type: 'netsuite_sales_orders',
    last_synced_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T11:30:00Z',
    last_result: { modified: 12, synced: 12 },
    ...over,
  });

  it('never ran', () => {
    expect(describeSoMirrorHealth(null, 0, now)).toMatchObject({ status: 'never', mirrorRows: 0, lastRunAt: null });
  });

  it('backfill in progress, with how far it got', () => {
    const h = describeSoMirrorHealth(row({ last_result: { partial: true, synced: 200, resume: { beforeId: '251', processed: 200 } } }), 200, now);
    expect(h.status).toBe('partial');
    expect(h.problem).toContain('200 sales orders');
  });

  it('last run failed', () => {
    const h = describeSoMirrorHealth(row({ last_result: { error: 'NetSuite SuiteQL error (401): bad token' } }), 0, now);
    expect(h.status).toBe('error');
    expect(h.problem).toContain('401');
  });

  it('overdue', () => {
    const h = describeSoMirrorHealth(row({ updated_at: '2026-09-02T01:00:00Z' }), 40, now);
    expect(h.status).toBe('stale');
    expect(h.mirrorRows).toBe(40);
  });

  it('healthy', () => {
    expect(describeSoMirrorHealth(row({}), 40, now)).toMatchObject({ status: 'ok', problem: null, lastRunAt: '2026-09-02T11:30:00Z' });
  });
});
