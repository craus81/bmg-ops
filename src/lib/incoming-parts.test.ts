import { describe, it, expect } from 'vitest';
import { assembleIncomingParts, isOpenPoStatus, normalizeItemNumber, compareEta, type RawPoLine } from './incoming-parts';

// A synced open PO line for `item`, `qty` still to receive, optional ETA.
const line = (item: string, qty: number, opts: Partial<RawPoLine['netsuite_vendor_pos']> & { received?: number } = {}): RawPoLine => ({
  item_number: item,
  quantity: qty,
  quantity_received: opts.received ?? 0,
  netsuite_vendor_pos: {
    tranid: opts.tranid ?? 'PO100',
    vendor_name: opts.vendor_name ?? 'Ranger Design',
    status: opts.status ?? 'B', // open
    eta_date: opts.eta_date ?? null,
    tracking_number: opts.tracking_number ?? null,
    carrier: opts.carrier ?? null,
    trandate: opts.trandate ?? '2026-07-01',
  },
});

describe('normalizeItemNumber / isOpenPoStatus', () => {
  it('keys on the last ":" segment, uppercased', () => {
    expect(normalizeItemNumber('Parent : child-1')).toBe('CHILD-1');
    expect(normalizeItemNumber('SHELF9')).toBe('SHELF9');
    expect(normalizeItemNumber(null)).toBe('');
  });
  it('treats Fully Billed / Closed / Cancelled as not open', () => {
    expect(isOpenPoStatus('B')).toBe(true);   // Pending Receipt
    expect(isOpenPoStatus('F')).toBe(false);  // Fully Billed
    expect(isOpenPoStatus('h')).toBe(false);  // Closed (case-insensitive)
    expect(isOpenPoStatus(null)).toBe(true);
  });
});

describe('compareEta', () => {
  it('orders real dates ascending and pushes nulls last', () => {
    const sorted = ['2026-08-01', null, '2026-07-15'].sort(compareEta);
    expect(sorted).toEqual(['2026-07-15', '2026-08-01', null]);
  });
});

describe('assembleIncomingParts', () => {
  it('only parts with a remaining open-PO quantity become rows', () => {
    const { rows, summary } = assembleIncomingParts({
      poLines: [
        line('SHELF', 5),
        line('DONE', 4, { received: 4 }),        // fully received → not incoming
        line('CLOSED', 3, { status: 'F' }),       // closed PO → not incoming
      ],
      parts: [], allocations: [],
    });
    expect(rows.map(r => r.item_number)).toEqual(['SHELF']);
    expect(rows[0].incoming).toBe(5);
    expect(summary.parts).toBe(1);
    expect(summary.shipments).toBe(1);
  });

  it('nets stock and job reservations against what is coming', () => {
    const { rows } = assembleIncomingParts({
      poLines: [line('SHELF', 6, { eta_date: '2026-07-30' })],
      parts: [{ item_number: 'SHELF', display_name: 'Shelf Unit', quantity_on_hand: 10, quantity_available: 8 }],
      allocations: [
        { item_number: 'SHELF', quantity: 3, project_name: 'Anderson build' },
        { item_number: 'SHELF', quantity: 2, project_name: 'Baker build' },
      ],
    });
    const r = rows[0];
    expect(r.on_hand).toBe(10);
    expect(r.available).toBe(8);
    expect(r.allocated).toBe(5);
    expect(r.incoming).toBe(6);
    expect(r.free).toBe(3);          // 8 avail − 5 allocated
    expect(r.shortfall).toBe(0);     // 5 allocated ≤ 8 + 6
    expect(r.state).toBe('stocked'); // avail already covers reservations
    expect(r.allocations).toEqual([  // sorted by qty desc
      { project: 'Anderson build', qty: 3 },
      { project: 'Baker build', qty: 2 },
    ]);
  });

  it('flags a shortfall when stock + incoming still cannot cover reservations', () => {
    const { rows, summary } = assembleIncomingParts({
      poLines: [line('BRACKET', 4, { eta_date: '2026-08-05' })],
      parts: [{ item_number: 'BRACKET', display_name: null, quantity_on_hand: 2, quantity_available: 2 }],
      allocations: [{ item_number: 'BRACKET', quantity: 10, project_name: 'Big fleet' }],
    });
    const r = rows[0];
    expect(r.shortfall).toBe(4);     // 10 − 2 − 4
    expect(r.net_after).toBe(-4);
    expect(r.state).toBe('short');
    expect(summary.short).toBe(1);
  });

  it('marks a part covered only once the incoming shipment lands', () => {
    const { rows } = assembleIncomingParts({
      poLines: [line('PANEL', 5)],
      parts: [{ item_number: 'PANEL', display_name: null, quantity_on_hand: 1, quantity_available: 1 }],
      allocations: [{ item_number: 'PANEL', quantity: 4, project_name: 'Job A' }],
    });
    expect(rows[0].shortfall).toBe(0);           // 4 ≤ 1 + 5
    expect(rows[0].state).toBe('incoming_covers'); // but avail 1 < allocated 4
  });

  it('a part with no stock row reads as zero on hand', () => {
    const { rows } = assembleIncomingParts({
      poLines: [line('NEWPART', 3)],
      parts: [], allocations: [{ item_number: 'NEWPART', quantity: 5, project_name: 'Job Z' }],
    });
    expect(rows[0].on_hand).toBe(0);
    expect(rows[0].available).toBe(0);
    expect(rows[0].shortfall).toBe(2); // 5 − 0 − 3
    expect(rows[0].state).toBe('short');
  });

  it('sums multiple open POs for the same part and keeps the soonest ETA', () => {
    const { rows } = assembleIncomingParts({
      poLines: [
        line('SHELF', 2, { tranid: 'PO200', eta_date: '2026-08-20' }),
        line('SHELF', 3, { tranid: 'PO201', eta_date: '2026-07-28' }),
      ],
      parts: [], allocations: [],
    });
    expect(rows[0].incoming).toBe(5);
    expect(rows[0].soonest_eta).toBe('2026-07-28');
    expect(rows[0].shipments.map(s => s.tranid)).toEqual(['PO201', 'PO200']); // ETA-sorted
  });

  it('falls back to the PO line description when the catalog has no name', () => {
    const withMemo = { ...line('WIDGET', 2), description: 'Steel Widget, 3in' };
    const { rows } = assembleIncomingParts({
      poLines: [withMemo],
      parts: [],            // not in the catalog → no display_name
      allocations: [],
    });
    expect(rows[0].display_name).toBe('Steel Widget, 3in');
  });

  it('prefers the catalog display_name over the PO line description', () => {
    const withMemo = { ...line('WIDGET', 2), description: 'line memo' };
    const { rows } = assembleIncomingParts({
      poLines: [withMemo],
      parts: [{ item_number: 'WIDGET', display_name: 'Catalog Widget', quantity_on_hand: 1, quantity_available: 1 }],
      allocations: [],
    });
    expect(rows[0].display_name).toBe('Catalog Widget');
  });

  it('normalizes item numbers across PO lines, stock, and allocations', () => {
    const { rows } = assembleIncomingParts({
      poLines: [line('Assembly : SHELF', 4)],
      parts: [{ item_number: 'shelf', display_name: 'Shelf', quantity_on_hand: 1, quantity_available: 1 }],
      allocations: [{ item_number: 'Kit : Shelf', quantity: 2, project_name: 'Job' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].item_number).toBe('SHELF');
    expect(rows[0].available).toBe(1);
    expect(rows[0].allocated).toBe(2);
  });

  it('orders rows by soonest ETA, nulls last', () => {
    const { rows } = assembleIncomingParts({
      poLines: [
        line('LATER', 1, { eta_date: '2026-09-01' }),
        line('NOETA', 1),
        line('SOON', 1, { eta_date: '2026-07-25' }),
      ],
      parts: [], allocations: [],
    });
    expect(rows.map(r => r.item_number)).toEqual(['SOON', 'LATER', 'NOETA']);
  });
});
