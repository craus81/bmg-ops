import { describe, it, expect } from 'vitest';
import { matchScansToOpenPos } from './scan-match';

// The rule these lock down (field ask, 2026-09-21: "when matching PO's the
// location has to match"): the same part is ordered per plant, so an install
// done at one plant must never consume another plant's PO line. The verdict
// itself is unit-tested in plant-location.test.ts; what matters here is that
// the sweep acts on it — refusing the wrong PO and leaving the scan alone.

interface FakeDb {
  scan_logs: any[];
  purchase_orders: any[];
  po_line_items: any[];
  work_locations: any[];
}

/**
 * Minimum Supabase surface matchScansToOpenPos touches: select chains that
 * resolve to rows (and are awaited either directly or through fetchAllRows'
 * .range()), plus update().eq() writing back into the same arrays.
 */
function fakeService(db: FakeDb, opts: { failWorkLocations?: boolean } = {}) {
  const builder = (table: keyof FakeDb) => {
    // Copied, not aliased: a real select hands back detached rows, so the
    // matcher's own in-memory bookkeeping (it decrements a line's remaining
    // capacity as it goes) must not double up with the write it just issued.
    let rows = db[table].map(r => ({ ...r }));
    const chain: any = {
      select() { return chain; },
      eq(col: string, val: any) { rows = rows.filter(r => r[col] === val); return chain; },
      is(col: string, val: any) { rows = rows.filter(r => (r[col] ?? null) === val); return chain; },
      in(col: string, vals: any[]) { rows = rows.filter(r => vals.includes(r[col])); return chain; },
      not() { return chain; },
      order() { return chain; },
      range(from: number, to: number) {
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
      // Awaited without .range() (work_locations, the fulfilment status read).
      then(resolve: any, reject: any) {
        if (table === 'work_locations' && opts.failWorkLocations) {
          return Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve, reject);
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  };

  return {
    from(table: keyof FakeDb) {
      return {
        select: (..._a: any[]) => builder(table).select(),
        update: (patch: any) => ({
          eq: (col: string, val: any) => {
            for (const row of db[table]) if (row[col] === val) Object.assign(row, patch);
            return Promise.resolve({ data: null, error: null });
          },
          select: () => Promise.resolve({ data: null, error: null }),
        }),
      };
    },
  } as any;
}

const baseDb = (): FakeDb => ({
  work_locations: [
    { name: 'Masterack - Wentzville', city: 'Wentzville' },
    { name: 'Masterack - Kansas City', city: 'Kansas City' },
    { name: 'Masterack - Social Circle', city: 'Social Circle' },
    { name: 'National Fleet', city: null },
    { name: 'BMG Shop', city: null },
  ],
  scan_logs: [],
  purchase_orders: [],
  po_line_items: [],
});

describe('matchScansToOpenPos — location is a requirement', () => {
  it('leaves a scan unmatched rather than consuming another plant\'s PO', async () => {
    const db = baseDb();
    db.scan_logs = [
      { id: 's1', part_number: '06S646', location_name: 'Masterack - Kansas City', exported_at: null, po_id: null, archived_at: null },
    ];
    db.purchase_orders = [
      { id: 'po-w', po_number: 'PO-WENT', status: 'open', ship_to: { city: 'Wentzville' } },
    ];
    db.po_line_items = [{ id: 'l1', po_id: 'po-w', part_number: '06S646', quantity: 5, installed: 0 }];

    const res = await matchScansToOpenPos(fakeService(db));

    expect(res.matched).toBe(0);
    expect(res.skippedForLocation).toBe(1);
    expect(db.scan_logs[0].po_id).toBeNull();
    // The Wentzville PO must not have burned a unit on a Kansas City install.
    expect(db.po_line_items[0].installed).toBe(0);
  });

  it('picks this location\'s PO when both plants have one open', async () => {
    const db = baseDb();
    db.scan_logs = [
      { id: 's1', part_number: '06S646', location_name: 'Masterack - Kansas City', exported_at: null, po_id: null, archived_at: null },
    ];
    db.purchase_orders = [
      { id: 'po-w', po_number: 'PO-WENT', status: 'open', ship_to: { city: 'Wentzville' } },
      { id: 'po-kc', po_number: 'PO-KC', status: 'open', ship_to: { city: 'Kansas City' } },
    ];
    db.po_line_items = [
      { id: 'l-w', po_id: 'po-w', part_number: '06S646', quantity: 5, installed: 0 },
      { id: 'l-kc', po_id: 'po-kc', part_number: '06S646', quantity: 5, installed: 0 },
    ];

    const res = await matchScansToOpenPos(fakeService(db));

    expect(res.matched).toBe(1);
    expect(db.scan_logs[0].po_number).toBe('PO-KC');
    expect(db.po_line_items.find(l => l.id === 'l-w')!.installed).toBe(0);
    expect(db.po_line_items.find(l => l.id === 'l-kc')!.installed).toBe(1);
  });

  it('still matches a PO with no ship-to — unknown is not a conflict', async () => {
    const db = baseDb();
    db.scan_logs = [
      { id: 's1', part_number: '06S646', location_name: 'Masterack - Kansas City', exported_at: null, po_id: null, archived_at: null },
    ];
    db.purchase_orders = [{ id: 'po-x', po_number: 'PO-NOSHIP', status: 'open', ship_to: null }];
    db.po_line_items = [{ id: 'l1', po_id: 'po-x', part_number: '06S646', quantity: 5, installed: 0 }];

    const res = await matchScansToOpenPos(fakeService(db));

    expect(res.matched).toBe(1);
    expect(res.skippedForLocation).toBe(0);
    expect(db.scan_logs[0].po_number).toBe('PO-NOSHIP');
  });

  it('still matches a scan whose work location names no plant', async () => {
    const db = baseDb();
    db.scan_logs = [
      { id: 's1', part_number: '06S646', location_name: 'BMG Shop', exported_at: null, po_id: null, archived_at: null },
    ];
    db.purchase_orders = [{ id: 'po-w', po_number: 'PO-WENT', status: 'open', ship_to: { city: 'Wentzville' } }];
    db.po_line_items = [{ id: 'l1', po_id: 'po-w', part_number: '06S646', quantity: 5, installed: 0 }];

    const res = await matchScansToOpenPos(fakeService(db));

    expect(res.matched).toBe(1);
    expect(db.scan_logs[0].po_number).toBe('PO-WENT');
  });

  it('prefers a positively matching PO over one it cannot place', async () => {
    const db = baseDb();
    db.scan_logs = [
      { id: 's1', part_number: '06S646', location_name: 'Masterack - Kansas City', exported_at: null, po_id: null, archived_at: null },
    ];
    db.purchase_orders = [
      { id: 'po-x', po_number: 'PO-NOSHIP', status: 'open', ship_to: null },
      { id: 'po-kc', po_number: 'PO-KC', status: 'open', ship_to: { city: 'Kansas City' } },
    ];
    db.po_line_items = [
      { id: 'l-x', po_id: 'po-x', part_number: '06S646', quantity: 5, installed: 0 },
      { id: 'l-kc', po_id: 'po-kc', part_number: '06S646', quantity: 5, installed: 0 },
    ];

    const res = await matchScansToOpenPos(fakeService(db));

    expect(res.matched).toBe(1);
    expect(db.scan_logs[0].po_number).toBe('PO-KC');
  });

  it('decides nothing when the plant list cannot be read', async () => {
    const db = baseDb();
    db.scan_logs = [
      { id: 's1', part_number: '06S646', location_name: 'Masterack - Kansas City', exported_at: null, po_id: null, archived_at: null },
    ];
    db.purchase_orders = [{ id: 'po-w', po_number: 'PO-WENT', status: 'open', ship_to: { city: 'Wentzville' } }];
    db.po_line_items = [{ id: 'l1', po_id: 'po-w', part_number: '06S646', quantity: 5, installed: 0 }];

    const res = await matchScansToOpenPos(fakeService(db, { failWorkLocations: true }));

    expect(res.matched).toBe(0);
    expect(db.scan_logs[0].po_id).toBeNull();
    expect(db.po_line_items[0].installed).toBe(0);
  });

  it('two parts on one VIN each land on their own plant\'s PO', async () => {
    // The shape PR #973 introduced: one scan split into two part lines. Each
    // carries the vehicle's location, so each must find that plant's PO.
    const db = baseDb();
    db.scan_logs = [
      { id: 's1', part_number: '0602S029', location_name: 'Masterack - Kansas City', exported_at: null, po_id: null, archived_at: null },
      { id: 's2', part_number: '06S646', location_name: 'Masterack - Kansas City', exported_at: null, po_id: null, archived_at: null },
    ];
    db.purchase_orders = [
      { id: 'po-kc-a', po_number: 'PO-KC-A', status: 'open', ship_to: { city: 'Kansas City' } },
      { id: 'po-kc-b', po_number: 'PO-KC-B', status: 'open', ship_to: { city: 'Kansas City' } },
      { id: 'po-w', po_number: 'PO-WENT', status: 'open', ship_to: { city: 'Wentzville' } },
    ];
    db.po_line_items = [
      { id: 'l-a', po_id: 'po-kc-a', part_number: '0602S029', quantity: 5, installed: 0 },
      { id: 'l-b', po_id: 'po-kc-b', part_number: '06S646', quantity: 5, installed: 0 },
      { id: 'l-w', po_id: 'po-w', part_number: '06S646', quantity: 5, installed: 0 },
    ];

    const res = await matchScansToOpenPos(fakeService(db));

    expect(res.matched).toBe(2);
    expect(db.scan_logs.find(s => s.id === 's1')!.po_number).toBe('PO-KC-A');
    expect(db.scan_logs.find(s => s.id === 's2')!.po_number).toBe('PO-KC-B');
    expect(db.po_line_items.find(l => l.id === 'l-w')!.installed).toBe(0);
  });
});
