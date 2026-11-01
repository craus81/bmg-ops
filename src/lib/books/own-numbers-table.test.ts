// The keeper FleetSuite takes its numbers from outside the tests (tableKeeper, src/lib/books/own-numbers.ts): it
// reads the switch first, takes the next number through own_number_reserve, and keeps what became of it through
// own_number_settle (migration 497). The database is a stand-in. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  switchRow: { is_on: true } as Record<string, unknown> | null,
  switchError: null as { message: string } | null,
  reserved: { data: [{ reserved_id: 'num-1', reserved_number: 'INV10001' }] as unknown, error: null as { message: string } | null },
  settleError: null as { message: string } | null,
  reads: [] as Array<[string, string, unknown]>,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
}));

vi.mock('../supabase-service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: (column: string, value: unknown) => { h.reads.push([table, column, value]); return q; },
        maybeSingle: async () => ({ data: h.switchError ? null : h.switchRow, error: h.switchError }),
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push([fn, args]);
      if (fn === 'own_number_reserve') return h.reserved;
      if (fn === 'own_number_settle') return { data: !h.settleError, error: h.settleError };
      return { data: null, error: { message: `no ${fn}` } };
    },
  }),
}));

import { ownNumberFor, setNumberKeeper, tableKeeper, type OwnNumber } from './own-numbers';

beforeEach(() => {
  setNumberKeeper(tableKeeper);
  h.switchRow = { is_on: true };
  h.switchError = null;
  h.reserved = { data: [{ reserved_id: 'num-1', reserved_number: 'INV10001' }], error: null };
  h.settleError = null;
  h.reads.length = 0;
  h.rpcs.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setNumberKeeper(undefined);
  vi.restoreAllMocks();
});

async function taken(): Promise<OwnNumber> {
  const own = await ownNumberFor('invoice');
  if (!own.ok) throw new Error(own.error);
  return own;
}

describe('the numbers table', () => {
  it('takes the next number while the switch is on, and keeps what NetSuite made of it', async () => {
    const own = await taken();
    expect(own.number).toBe('INV10001');
    expect(h.reads).toEqual([['books_switches', 'piece', 'own_numbers']]);
    expect(h.rpcs).toEqual([['own_number_reserve', { p_type: 'invoice', p_by: null }]]);
    await own.made(' 9001 ', 'INV10001');
    expect(h.rpcs[1]).toEqual(['own_number_settle', {
      p_id: 'num-1', p_status: 'made', p_netsuite_id: '9001', p_netsuite_number: 'INV10001', p_note: null,
    }]);
  });

  it("keeps NetSuite's reason when it refused one, and why FleetSuite isn't sure", async () => {
    await (await taken()).refused('Invalid value for the field entity.');
    expect(h.rpcs[1]).toEqual(['own_number_settle', {
      p_id: 'num-1', p_status: 'refused', p_netsuite_id: null, p_netsuite_number: null, p_note: 'Invalid value for the field entity.',
    }]);
    await (await taken()).unsure("NetSuite didn't answer in time.");
    expect(h.rpcs[3][1]).toMatchObject({ p_status: 'unsure', p_note: "NetSuite didn't answer in time." });
  });

  it("takes no number while the switch is off, missing or can't be read, and NetSuite numbers it", async () => {
    for (const [row, error] of [[{ is_on: false }, null], [null, null], [{ is_on: true }, { message: 'denied' }]] as const) {
      h.switchRow = row;
      h.switchError = error;
      expect(await ownNumberFor('sales_order')).toMatchObject({ ok: true, number: null });
    }
    expect(h.rpcs).toEqual([]);
  });

  it('takes a number given as one row too', async () => {
    h.reserved = { data: { reserved_id: 'num-7', reserved_number: 'PO10007' }, error: null };
    expect(await ownNumberFor('purchase_order')).toMatchObject({ ok: true, number: 'PO10007' });
  });

  it("sends nothing when the database gives no number or can't", async () => {
    for (const reserved of [
      { data: [], error: null },
      { data: [{ reserved_id: 'num-2' }], error: null },
      { data: [{ reserved_id: 2, reserved_number: 'PO10002' }], error: null },
      { data: null, error: { message: 'no numbers for purchase_order' } },
    ]) {
      h.reserved = reserved;
      expect(await ownNumberFor('purchase_order')).toEqual({
        ok: false, error: "FleetSuite couldn't give this PO its number, so nothing was sent to NetSuite. Try again in a moment.",
      });
    }
  });

  it("still says the document was made when what became of its number can't be kept", async () => {
    h.settleError = { message: 'deadlock detected' };
    await expect((await taken()).made('9001', 'INV10001')).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith("[own-numbers] couldn't keep what became of INV10001:", 'deadlock detected');
  });
});
