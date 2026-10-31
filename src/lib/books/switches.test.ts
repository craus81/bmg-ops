import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SWITCHES, SWITCH_PIECES, isSwitchPiece, readSwitches, setSwitch, switchIsOn } from './switches';

type Row = { piece: string; is_on: boolean | null; changed_by: string | null; changed_at: string | null };

/** books_switches as the server reads it: a list, one row, and an upsert. */
function fakeService(opts: { rows?: Row[]; error?: string; throws?: boolean; upsertError?: string } = {}) {
  const upserts: unknown[][] = [];
  const result = () => (opts.error ? { data: null, error: { message: opts.error } } : { data: opts.rows ?? [], error: null });
  const service = {
    from: (table: string) => {
      if (opts.throws) throw new Error('network down');
      expect(table).toBe('books_switches');
      return {
        select: () => Object.assign(Promise.resolve(result()), {
          eq: (_column: string, piece: string) => ({
            maybeSingle: async () => (opts.error
              ? { data: null, error: { message: opts.error } }
              : { data: (opts.rows ?? []).find((r) => r.piece === piece) ?? null, error: null }),
          }),
        }),
        upsert: async (row: unknown, options: unknown) => {
          upserts.push([row, options]);
          return { error: opts.upsertError ? { message: opts.upsertError } : null };
        },
      };
    },
  };
  return { service: service as unknown as SupabaseClient, upserts };
}

const ON: Row = { piece: 'credit_memos', is_on: true, changed_by: 'p1', changed_at: '2026-12-31T15:00:00Z' };

describe('switches', () => {
  it('names each piece, where people find it, and only those', () => {
    expect(SWITCH_PIECES).toEqual(['credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers']);
    expect(SWITCHES.credit_memos.where).toBe('Invoicing → Invoiced → Credit on an invoice');
    expect(SWITCHES.vendor_credits.where).toBe('More → Purchasing → Vendor Credits');
    expect(SWITCHES.card_charges.where).toBe('More → Money & Books → Card Charges');
    expect(SWITCHES.journal_entries.where).toBe('More → Money & Books → Journal Entries');
    expect(SWITCHES.inventory_transfers.where).toBe('More → Parts & Inventory → Inventory Transfers');
    expect(isSwitchPiece('credit_memos')).toBe(true);
    expect(isSwitchPiece('vendor_credits')).toBe(true);
    expect(isSwitchPiece('card_charges')).toBe(true);
    expect(isSwitchPiece('journal_entries')).toBe(true);
    expect(isSwitchPiece('inventory_transfers')).toBe(true);
    expect(isSwitchPiece('payroll')).toBe(false);
    expect(isSwitchPiece('toString')).toBe(false);
    expect(isSwitchPiece(null)).toBe(false);
  });

  it('reads every switch, off where its row is missing', async () => {
    expect(await readSwitches(fakeService({ rows: [ON] }).service)).toEqual([
      { piece: 'credit_memos', on: true, changedBy: 'p1', changedAt: '2026-12-31T15:00:00Z' },
      { piece: 'vendor_credits', on: false, changedBy: null, changedAt: null },
      { piece: 'card_charges', on: false, changedBy: null, changedAt: null },
      { piece: 'journal_entries', on: false, changedBy: null, changedAt: null },
      { piece: 'inventory_transfers', on: false, changedBy: null, changedAt: null },
    ]);
    expect(await readSwitches(fakeService().service)).toEqual([
      { piece: 'credit_memos', on: false, changedBy: null, changedAt: null },
      { piece: 'vendor_credits', on: false, changedBy: null, changedAt: null },
      { piece: 'card_charges', on: false, changedBy: null, changedAt: null },
      { piece: 'journal_entries', on: false, changedBy: null, changedAt: null },
      { piece: 'inventory_transfers', on: false, changedBy: null, changedAt: null },
    ]);
    await expect(readSwitches(fakeService({ error: 'denied' }).service)).rejects.toThrow('denied');
  });

  it("counts a switch it can't read as off", async () => {
    expect(await switchIsOn(fakeService({ rows: [ON] }).service, 'credit_memos')).toBe(true);
    expect(await switchIsOn(fakeService({ rows: [ON] }).service, 'vendor_credits')).toBe(false);
    expect(await switchIsOn(fakeService({ rows: [{ ...ON, is_on: null }] }).service, 'credit_memos')).toBe(false);
    expect(await switchIsOn(fakeService().service, 'credit_memos')).toBe(false);
    expect(await switchIsOn(fakeService({ rows: [ON], error: 'denied' }).service, 'credit_memos')).toBe(false);
    expect(await switchIsOn(fakeService({ throws: true }).service, 'credit_memos')).toBe(false);
  });

  it('turns a switch on or off, saying who and what it was before', async () => {
    const { service, upserts } = fakeService();
    expect(await setSwitch(service, 'credit_memos', true, 'p1')).toEqual({ was: false });
    expect(upserts).toEqual([[
      { piece: 'credit_memos', is_on: true, changed_by: 'p1', changed_at: expect.any(String) },
      { onConflict: 'piece' },
    ]]);
    expect(await setSwitch(fakeService({ rows: [ON] }).service, 'credit_memos', false, 'p1')).toEqual({ was: true });
    await expect(setSwitch(fakeService({ upsertError: 'denied' }).service, 'credit_memos', true, 'p1')).rejects.toThrow('denied');
  });
});
