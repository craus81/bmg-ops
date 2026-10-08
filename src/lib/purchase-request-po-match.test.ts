import { describe, it, expect, vi } from 'vitest';

vi.mock('./notify', () => ({ notifyMany: vi.fn() }));
import { planRequestMatches, sameVendor, normalizeVendorName, type MatchRequest, type MatchPo, type MatchLine } from './purchase-request-po-match';
import { trackingUrl } from './tracking-url';

const req = (over: Partial<MatchRequest>): MatchRequest => ({
  id: 'r1', item_number: 'ABC-1', quantity: 4, vendor_name: 'Ranger Design',
  vendor_netsuite_id: null, created_at: '2026-09-20T15:00:00Z', ...over,
});
const po = (over: Partial<MatchPo>): MatchPo => ({
  id: 'p1', tranid: 'PO100', vendor_name: 'Ranger Design, Inc.', vendor_netsuite_id: '55',
  trandate: '2026-09-21', status: 'B', ...over,
});
const line = (over: Partial<MatchLine>): MatchLine => ({ po_id: 'p1', item_number: 'ABC-1', quantity: 4, ...over });

describe('planRequestMatches', () => {
  it('marks a request ordered on a same-part, same-vendor PO dated after it', () => {
    const plans = planRequestMatches([req({})], [po({})], [line({})], new Map());
    expect(plans).toEqual([{ requestId: 'r1', allocations: [{ poId: 'p1', quantity: 4 }], remainder: 0 }]);
  });

  it('splits when the PO line only covers part of the request', () => {
    const plans = planRequestMatches([req({ quantity: 10 })], [po({})], [line({ quantity: 6 })], new Map());
    expect(plans[0]).toEqual({ requestId: 'r1', allocations: [{ poId: 'p1', quantity: 6 }], remainder: 4 });
  });

  it('never matches a different vendor, an older PO, or a request with no vendor', () => {
    expect(planRequestMatches([req({})], [po({ vendor_name: 'Masterack', vendor_netsuite_id: null })], [line({})], new Map())).toEqual([]);
    expect(planRequestMatches([req({})], [po({ trandate: '2026-09-19' })], [line({})], new Map())).toEqual([]);
    expect(planRequestMatches([req({ vendor_name: null })], [po({})], [line({})], new Map())).toEqual([]);
  });

  it('prefers NetSuite vendor ids over names when both sides have one', () => {
    expect(planRequestMatches([req({ vendor_netsuite_id: '99' })], [po({})], [line({})], new Map())).toEqual([]);
    expect(planRequestMatches([req({ vendor_name: 'x', vendor_netsuite_id: '55' })], [po({})], [line({})], new Map())).toHaveLength(1);
  });

  it('gives the line to the oldest request first and never over-books it', () => {
    const plans = planRequestMatches(
      [req({ id: 'new', created_at: '2026-09-20T18:00:00Z', quantity: 3 }), req({ id: 'old', quantity: 3 })],
      [po({})], [line({ quantity: 4 })], new Map(),
    );
    expect(plans).toEqual([
      { requestId: 'old', allocations: [{ poId: 'p1', quantity: 3 }], remainder: 0 },
      { requestId: 'new', allocations: [{ poId: 'p1', quantity: 1 }], remainder: 2 },
    ]);
  });

  it('counts quantity already held by ordered requests', () => {
    const plans = planRequestMatches([req({})], [po({})], [line({ quantity: 4 })], new Map([['p1|ABC-1', 4]]));
    expect(plans).toEqual([]);
  });

  it('skips blocked, rejected and closed POs', () => {
    expect(planRequestMatches([req({ auto_match_blocked_po_ids: ['p1'] })], [po({})], [line({})], new Map())).toEqual([]);
    expect(planRequestMatches([req({})], [po({ status: 'C' })], [line({})], new Map())).toEqual([]);
    expect(planRequestMatches([req({})], [po({ status: 'H' })], [line({})], new Map())).toEqual([]);
  });

  it('matches normalized sub-item part numbers and counts the request day on the shop calendar', () => {
    // 02:00Z on the 21st is still the 20th in Missouri.
    const plans = planRequestMatches(
      [req({ item_number: 'abc-1', created_at: '2026-09-21T02:00:00Z' })],
      [po({ trandate: '2026-09-20' })], [line({ item_number: 'RANGER : ABC-1' })], new Map(),
    );
    expect(plans).toHaveLength(1);
  });

  it('spreads a request over two POs, earliest first', () => {
    const plans = planRequestMatches(
      [req({ quantity: 5 })],
      [po({ id: 'p2', tranid: 'PO101', trandate: '2026-09-25' }), po({})],
      [line({ quantity: 2 }), line({ po_id: 'p2', quantity: 10 })], new Map(),
    );
    expect(plans[0]).toEqual({ requestId: 'r1', allocations: [{ poId: 'p1', quantity: 2 }, { poId: 'p2', quantity: 3 }], remainder: 0 });
  });
});

describe('vendor names', () => {
  it('ignores case, punctuation and company suffixes', () => {
    expect(normalizeVendorName('Ranger Design, Inc.')).toBe('rangerdesign');
    expect(sameVendor({ vendor_name: 'RANGER DESIGN', vendor_netsuite_id: null }, { vendor_name: 'Ranger Design LLC', vendor_netsuite_id: '1' })).toBe(true);
  });
});

describe('trackingUrl', () => {
  it('picks the carrier from the text or number shape', () => {
    expect(trackingUrl('1Z999AA10123456784')).toContain('ups.com');
    expect(trackingUrl('123456789012', 'FedEx Ground')).toContain('fedex.com');
    expect(trackingUrl('ABC')).toContain('google.com');
  });
});

// ── Mark ordered by hand (migration 349) ──────────────────────────────────

/** Tiny in-memory stand-in for the Supabase query builder: enough filters
 *  (eq / in / is / not-is) and verbs (select / update / upsert) for the
 *  mark-ordered paths. */
function fakeDb(tables: Record<string, any[]>) {
  const from = (table: string) => {
    const rows = (tables[table] ||= []);
    const filters: ((r: any) => boolean)[] = [];
    let patch: any = null;
    let single = false;
    let limit = Infinity;
    const q: any = {
      select: () => q, order: () => q,
      limit: (n: number) => { limit = n; return q; },
      eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q; },
      in: (c: string, vs: any[]) => { filters.push(r => vs.includes(r[c])); return q; },
      is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return q; },
      not: (c: string, _op: string, v: any) => { filters.push(r => (r[c] ?? null) !== v); return q; },
      update: (p: any) => { patch = p; return q; },
      upsert: () => q,
      maybeSingle: () => { single = true; return q; },
      then: (resolve: any) => {
        const hit = rows.filter(r => filters.every(f => f(r))).slice(0, limit);
        if (patch) hit.forEach(r => Object.assign(r, patch));
        resolve({ data: single ? hit[0] ?? null : hit, error: null });
      },
    };
    return q;
  };
  return { from } as any;
}

describe('mark ordered by hand', () => {
  it('reads a typed PO number with or without the PO prefix', async () => {
    const { poNumberCandidates } = await import('./purchase-request-po-match');
    expect(poNumberCandidates(' po 1234 ')).toEqual(['PO1234', '1234']);
    expect(poNumberCandidates('#1234')).toEqual(['1234', 'PO1234']);
    expect(poNumberCandidates('  ')).toEqual([]);
  });

  it('links to a mirrored PO, takes its vendor and flags parts not on it', async () => {
    const { markRequestsOrdered } = await import('./purchase-request-po-match');
    const tables: Record<string, any[]> = {
      purchase_requests: [
        { id: 'a', status: 'pending', ordered_by: null, item_number: 'ABC-1', quantity: 2 },
        { id: 'b', status: 'pending', ordered_by: null, item_number: 'XYZ-9', quantity: 1 },
      ],
      netsuite_vendor_pos: [{ id: 'p1', netsuite_id: '900', tranid: 'PO1234', vendor_name: 'Ranger Design', vendor_netsuite_id: '55', trandate: '2026-10-06', status: 'B' }],
      netsuite_vendor_po_lines: [{ po_id: 'p1', item_number: 'ABC-1' }],
    };
    const db = fakeDb(tables);
    const res = await markRequestsOrdered(db, { ids: ['a', 'b'], poNumber: '1234', userId: 'u1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.marked).toBe(2);
    expect(res.result.notOnPo).toEqual(['XYZ-9']);
    expect(tables.purchase_requests[0]).toMatchObject({
      status: 'ordered', ordered_match: 'manual', ordered_po_id: 'p1', ordered_po_number: 'PO1234', vendor_netsuite_id: '55',
    });
  });

  it('keeps the typed number when the PO has not synced, then links it on the next sync', async () => {
    const { markRequestsOrdered, linkManualOrders } = await import('./purchase-request-po-match');
    const tables: Record<string, any[]> = {
      purchase_requests: [{ id: 'a', status: 'pending', ordered_by: null, item_number: 'ABC-1', quantity: 2 }],
      netsuite_vendor_pos: [],
      netsuite_vendor_po_lines: [],
    };
    const db = fakeDb(tables);
    const res = await markRequestsOrdered(db, { ids: ['a'], poNumber: 'po5555', userId: 'u1' });
    expect(res.ok && res.result.po).toBeNull();
    expect(tables.purchase_requests[0]).toMatchObject({
      status: 'ordered', ordered_match: 'manual', ordered_po_number: 'PO5555', ordered_po_id: null, ordered_by: 'u1',
    });

    tables.netsuite_vendor_pos.push({ id: 'p9', netsuite_id: '901', tranid: 'PO5555', vendor_name: 'Masterack', vendor_netsuite_id: '7', trandate: '2026-10-07', status: 'B' });
    expect(await linkManualOrders(db)).toBe(1);
    expect(tables.purchase_requests[0]).toMatchObject({ ordered_po_id: 'p9', vendor_name: 'Masterack' });
  });

  it('refuses a request that is no longer pending, and Undo puts a hand mark back', async () => {
    const { markRequestsOrdered, unmatchPurchaseRequest } = await import('./purchase-request-po-match');
    const tables: Record<string, any[]> = {
      purchase_requests: [{ id: 'a', status: 'ordered', ordered_match: 'manual', ordered_by: 'u1', ordered_po_number: 'PO1', ordered_po_id: null, item_number: 'ABC-1', quantity: 2 }],
      netsuite_vendor_pos: [],
    };
    const db = fakeDb(tables);
    const refused = await markRequestsOrdered(db, { ids: ['a'], poNumber: 'PO2', userId: 'u1' });
    expect(refused.ok).toBe(false);
    expect(await unmatchPurchaseRequest(db, 'a')).toEqual({ ok: true });
    expect(tables.purchase_requests[0]).toMatchObject({ status: 'pending', ordered_by: null, ordered_po_number: null, ordered_match: null });
  });
});
