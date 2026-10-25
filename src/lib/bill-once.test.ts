import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ findVendorBill: vi.fn() }));

import { madeOrFound, makeBillOnce, STALE_CLAIM_MS } from './bill-once';

const NOW = new Date('2026-10-25T15:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

interface Row { id: string; status: string; bill_claimed_at: string | null }

/**
 * Just enough of the service client for the claim: `update(..).eq(..).eq(..).or(..).select(..)` takes it,
 * `update(..).eq(..).eq(..)` lets it go. Filters are applied to the one row, as PostgREST would.
 */
function fakeService(row: Row, opts: { claimError?: { code?: string; message: string } } = {}) {
  const tables: string[] = [];
  const service: any = {
    from(table: string) {
      tables.push(table);
      return {
        update(patch: Partial<Row>) {
          const filters: Array<(r: Row) => boolean> = [];
          const apply = () => {
            const hit = filters.every((f) => f(row));
            if (hit) Object.assign(row, patch);
            return hit;
          };
          const q: any = {
            eq(col: keyof Row, val: unknown) { filters.push((r) => r[col] === val); return q; },
            or(expr: string) {
              const [isNull, lt] = expr.split(',');
              expect(isNull).toBe('bill_claimed_at.is.null');
              const cutoff = lt.replace('bill_claimed_at.lt.', '');
              filters.push((r) => r.bill_claimed_at === null || r.bill_claimed_at < cutoff);
              return q;
            },
            select: async () => (opts.claimError ? { data: null, error: opts.claimError } : { data: apply() ? [{ id: row.id }] : [], error: null }),
            then: (resolve: (v: unknown) => void) => { apply(); resolve({ error: null }); },
          };
          return q;
        },
      };
    },
  };
  return { service, tables };
}

const approved = (claimed: string | null = null): Row => ({ id: 'inv-1', status: 'approved', bill_claimed_at: claimed });
/** What making the bill in NetSuite answers. */
type Made = { success: boolean; billId?: string; billNumber?: string; error?: string };
const bill = (create: () => Promise<Made> = vi.fn(async (): Promise<Made> => ({ success: true, billId: '8801', billNumber: 'VI-1042' }))) =>
  ({ vendorId: '412', vendorName: 'Northside Install Co.', referenceNo: 'VI-1042', create });

describe('makeBillOnce', () => {
  it('claims the row, asks NetSuite, then makes the bill, and leaves the claim for the billed stamp to clear', async () => {
    const row = approved();
    const { service, tables } = fakeService(row);
    const find = vi.fn(async () => null);
    const b = bill();
    const made = await makeBillOnce(service, 'vendor_invoices', 'inv-1', b, find, NOW);
    expect(made).toEqual({ ok: true, billId: '8801', billNumber: 'VI-1042', claimedAt: NOW.toISOString() });
    expect(find).toHaveBeenCalledWith('412', 'VI-1042');
    expect(b.create).toHaveBeenCalledTimes(1);
    expect(row.bill_claimed_at).toBe(NOW.toISOString());
    expect(tables).toEqual(['vendor_invoices']);
  });

  it('turns away a second try while the first holds the claim, and makes nothing', async () => {
    const row = approved(minutesAgo(1));
    const { service } = fakeService(row);
    const b = bill();
    const made = await makeBillOnce(service, 'payouts', 'inv-1', b, vi.fn(async () => null), NOW);
    expect(made).toEqual({ ok: false, status: 409, error: 'A bill for this is already being made, or was just made. Wait a moment and refresh.' });
    expect(b.create).not.toHaveBeenCalled();
    expect(row.bill_claimed_at).toBe(minutesAgo(1));
  });

  it('takes over a claim left by a try that died, once it is older than the stale limit', async () => {
    expect(STALE_CLAIM_MS).toBe(15 * 60_000);
    const fresh = approved(minutesAgo(14));
    expect((await makeBillOnce(fakeService(fresh).service, 'payouts', 'inv-1', bill(), vi.fn(async () => null), NOW)).ok).toBe(false);
    const stale = approved(minutesAgo(16));
    const made = await makeBillOnce(fakeService(stale).service, 'payouts', 'inv-1', bill(), vi.fn(async () => null), NOW);
    expect(made.ok).toBe(true);
    expect(stale.bill_claimed_at).toBe(NOW.toISOString());
  });

  it("won't claim a row that isn't approved any more", async () => {
    const row = { ...approved(), status: 'billed' };
    const b = bill();
    const made = await makeBillOnce(fakeService(row).service, 'vendor_invoices', 'inv-1', b, vi.fn(async () => null), NOW);
    expect(made.ok).toBe(false);
    expect(b.create).not.toHaveBeenCalled();
    expect(row.bill_claimed_at).toBeNull();
  });

  it('turns a try away when NetSuite already has the bill, says which, and lets the claim go', async () => {
    const row = approved();
    const b = bill();
    const made = await makeBillOnce(fakeService(row).service, 'vendor_invoices', 'inv-1', b,
      vi.fn(async () => ({ billId: '8801', billNumber: 'VI-1042' })), NOW);
    expect(made).toEqual({
      ok: false,
      status: 409,
      error: "NetSuite already has bill VI-1042 from Northside Install Co., so FleetSuite didn't make another. If that's this one's bill, use Record Bill with VI-1042.",
    });
    expect(b.create).not.toHaveBeenCalled();
    expect(row.bill_claimed_at).toBeNull();
  });

  it("names NetSuite's id for a bill it found without a number", async () => {
    const made = await makeBillOnce(fakeService(approved()).service, 'payouts', 'inv-1', bill(),
      vi.fn(async () => ({ billId: '8801', billNumber: '' })), NOW);
    expect(made.ok === false && made.error).toContain('bill 8801 from');
  });

  it("makes nothing when NetSuite can't be asked, and lets the claim go", async () => {
    const row = approved();
    const b = bill();
    const made = await makeBillOnce(fakeService(row).service, 'vendor_invoices', 'inv-1', b,
      vi.fn(async () => { throw new Error('NetSuite SuiteQL error (503)'); }), NOW);
    expect(made).toEqual({
      ok: false,
      status: 502,
      error: "Couldn't ask NetSuite whether it already has bill VI-1042, so nothing was billed. Try again. (NetSuite SuiteQL error (503))",
    });
    expect(b.create).not.toHaveBeenCalled();
    expect(row.bill_claimed_at).toBeNull();
  });

  it('lets the claim go when NetSuite refuses the bill, and passes its words on', async () => {
    const row = approved();
    const made = await makeBillOnce(fakeService(row).service, 'payouts', 'inv-1',
      bill(vi.fn(async () => ({ success: false, error: 'NetSuite error (400): Invalid vendor' }))), vi.fn(async () => null), NOW);
    expect(made).toEqual({ ok: false, status: 502, error: 'NetSuite error (400): Invalid vendor' });
    expect(row.bill_claimed_at).toBeNull();
  });

  it('says so when NetSuite refuses the bill without a word', async () => {
    const made = await makeBillOnce(fakeService(approved()).service, 'payouts', 'inv-1',
      bill(vi.fn(async () => ({ success: false }))), vi.fn(async () => null), NOW);
    expect(made).toEqual({ ok: false, status: 502, error: 'Failed to create vendor bill' });
  });

  it('lets the claim go when making the bill throws', async () => {
    const row = approved();
    const made = await makeBillOnce(fakeService(row).service, 'payouts', 'inv-1',
      bill(vi.fn(async () => { throw new Error('socket hang up'); })), vi.fn(async () => null), NOW);
    expect(made).toEqual({ ok: false, status: 502, error: 'socket hang up' });
    expect(row.bill_claimed_at).toBeNull();
  });

  it('only lets go of its own claim, not one another try took over meanwhile', async () => {
    const row = approved();
    const other = minutesAgo(-1);
    const made = await makeBillOnce(fakeService(row).service, 'payouts', 'inv-1', bill(),
      vi.fn(async () => { row.bill_claimed_at = other; throw new Error('timed out'); }), NOW);
    expect(made.ok).toBe(false);
    expect(row.bill_claimed_at).toBe(other);
  });

  it('bills unclaimed, as before, while the column is missing from the schema cache', async () => {
    for (const claimError of [{ code: 'PGRST204', message: 'Could not find a column' }, { message: "column bill_claimed_at doesn't exist" }]) {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const b = bill();
      const made = await makeBillOnce(fakeService(approved(), { claimError }).service, 'vendor_invoices', 'inv-1', b, vi.fn(async () => null), NOW);
      expect(made).toEqual({ ok: true, billId: '8801', billNumber: 'VI-1042', claimedAt: null });
      expect(b.create).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    }
  });

  it("bills nothing when the claim can't be taken for another reason", async () => {
    const b = bill();
    const made = await makeBillOnce(fakeService(approved(), { claimError: { code: '57014', message: 'canceling statement due to statement timeout' } }).service,
      'vendor_invoices', 'inv-1', b, vi.fn(async () => null), NOW);
    expect(made).toEqual({ ok: false, status: 503, error: 'Could not hold this for billing, so nothing was billed. Try again.' });
    expect(b.create).not.toHaveBeenCalled();
  });

  it("claims a snapped bill while it's a draft, and not once it's sent or thrown away (Snap a bill, migration 436)", async () => {
    const draft: Row = { id: 'snap-1', status: 'draft', bill_claimed_at: null };
    const { service, tables } = fakeService(draft);
    const made = await makeBillOnce(service, 'gl_snapped_bills', 'snap-1', bill(), vi.fn(async () => null), NOW);
    expect(made.ok).toBe(true);
    expect(draft.bill_claimed_at).toBe(NOW.toISOString());
    expect(tables).toEqual(['gl_snapped_bills']);
    for (const status of ['sent', 'thrown_away', 'approved']) {
      const row: Row = { id: 'snap-1', status, bill_claimed_at: null };
      const b = bill();
      expect((await makeBillOnce(fakeService(row).service, 'gl_snapped_bills', 'snap-1', b, vi.fn(async () => null), NOW)).ok).toBe(false);
      expect(b.create).not.toHaveBeenCalled();
    }
  });

  it("doesn't offer Record Bill for a snapped bill NetSuite already has: Snap a bill has nothing to record", async () => {
    const made = await makeBillOnce(fakeService({ id: 'snap-1', status: 'draft', bill_claimed_at: null }).service, 'gl_snapped_bills', 'snap-1', bill(),
      vi.fn(async () => ({ billId: '8801', billNumber: 'VI-1042' })), NOW);
    expect(made).toEqual({ ok: false, status: 409, error: "NetSuite already has bill VI-1042 from Northside Install Co., so FleetSuite didn't make another." });
  });

  it('gives back empty strings for a bill NetSuite made without saying its id or number', async () => {
    const made = await makeBillOnce(fakeService(approved()).service, 'payouts', 'inv-1',
      bill(vi.fn(async () => ({ success: true }))), vi.fn(async () => null), NOW);
    expect(made).toEqual({ ok: true, billId: '', billNumber: '', claimedAt: NOW.toISOString() });
  });
});

describe('madeOrFound', () => {
  const KEPT = { billId: '8803', billNumber: '88213-10' };

  it("takes NetSuite's word when it says which bill it made, without asking again", async () => {
    const find = vi.fn(async () => KEPT);
    expect(await madeOrFound(async () => ({ success: true, billId: '8803', billNumber: '88213-10' }), find)).toEqual({ success: true, ...KEPT });
    expect(find).not.toHaveBeenCalled();
  });

  it('finds the bill NetSuite kept when the connection dropped, or when no id came back', async () => {
    const dropped = async () => ({ success: false, error: 'Failed to create vendor bill: fetch failed' });
    expect(await madeOrFound(dropped, async () => KEPT)).toEqual({ success: true, ...KEPT });
    expect(await madeOrFound(async () => ({ success: true, billId: '' }), async () => KEPT)).toEqual({ success: true, ...KEPT });
    expect(await madeOrFound(async () => { throw new Error('socket hang up'); }, async () => KEPT)).toEqual({ success: true, ...KEPT });
  });

  it("keeps NetSuite's refusal when it has no such bill, or can't be asked", async () => {
    const refused = { success: false, error: 'NetSuite error (400): Invalid account' };
    expect(await madeOrFound(async () => refused, async () => null)).toEqual(refused);
    expect(await madeOrFound(async () => refused, async () => { throw new Error('NetSuite is down'); })).toEqual(refused);
    expect(await madeOrFound(async () => { throw new Error('socket hang up'); }, async () => null)).toEqual({ success: false, error: 'socket hang up' });
    expect(await madeOrFound(async () => ({ success: true, billId: 'abc' }), async () => null)).toEqual({ success: true, billId: 'abc' });
  });
});
