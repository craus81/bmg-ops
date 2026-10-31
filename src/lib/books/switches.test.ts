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
    expect(SWITCH_PIECES).toEqual([
      'credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes', 'bill_fixes',
      'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite',
    ]);
    expect(SWITCHES.credit_memos.where).toBe('Invoicing → Invoiced → Credit on an invoice');
    expect(SWITCHES.vendor_credits.where).toBe('More → Purchasing → Vendor Credits');
    expect(SWITCHES.card_charges.where).toBe('More → Money & Books → Card Charges');
    expect(SWITCHES.journal_entries.where).toBe('More → Money & Books → Journal Entries');
    expect(SWITCHES.inventory_transfers.where).toBe('More → Parts & Inventory → Inventory Transfers');
    expect(SWITCHES.invoice_fixes.where).toBe('Invoicing → Invoiced → Fix on an invoice');
    expect(SWITCHES.bill_fixes).toEqual({
      name: 'Fixing bills',
      what: "Admins with Parts Ordering fix a bill after it's made, its number, memo and due date, and while nothing on it is paid its date and lines, and FleetSuite makes the change in NetSuite and in its own copy for the books.",
      where: 'More → Purchasing → Fix a Bill, or Fix on Books → Own bills',
    });
    expect(SWITCHES.customer_vendor_details).toEqual({
      name: 'Customer and vendor details',
      what: "Anyone with Credit Applications changes a customer's terms and credit limit, and anyone with Payments a vendor's email, phone, terms, addresses and 1099 details, in FleetSuite, and FleetSuite makes the change in NetSuite.",
      where: 'More → Sales → Customer Terms, or Change on a customer; More → Money & Books → Vendor Details',
    });
    expect(SWITCHES.item_accounts).toEqual({
      name: 'Item accounts',
      what: "Anyone with Payments changes an item's income account, an inventory item's cost of goods sold and inventory asset accounts, and the expense account of one that's bought, in FleetSuite, and FleetSuite makes the change in NetSuite.",
      where: 'More → Money & Books → Item Accounts, or Change accounts on Books → Stock by item',
    });
    expect(SWITCHES.estimates_in_fleetsuite).toEqual({
      name: 'Estimates in FleetSuite only',
      what: "Estimates stay in FleetSuite: nobody pushes one to NetSuite any more, and NetSuite gets each job's sales order when it's made, as now. Until it's on, estimates push as they do today.",
      where: "An estimate's buttons, where Push to NetSuite as Estimate goes",
      turnOn: "Switch on Estimates in FleetSuite only? From now on nobody can push an estimate to NetSuite, and NetSuite gets each job's sales order when it's made.",
      turnOff: 'Switch off Estimates in FleetSuite only? Estimates can be pushed to NetSuite again, as before.',
    });
    // Only the piece that's the other way round asks in its own words.
    expect(SWITCH_PIECES.filter((p) => SWITCHES[p].turnOn !== undefined || SWITCHES[p].turnOff !== undefined)).toEqual(['estimates_in_fleetsuite']);
    expect(isSwitchPiece('credit_memos')).toBe(true);
    expect(isSwitchPiece('vendor_credits')).toBe(true);
    expect(isSwitchPiece('card_charges')).toBe(true);
    expect(isSwitchPiece('journal_entries')).toBe(true);
    expect(isSwitchPiece('inventory_transfers')).toBe(true);
    expect(isSwitchPiece('invoice_fixes')).toBe(true);
    expect(isSwitchPiece('bill_fixes')).toBe(true);
    expect(isSwitchPiece('customer_vendor_details')).toBe(true);
    expect(isSwitchPiece('item_accounts')).toBe(true);
    expect(isSwitchPiece('estimates_in_fleetsuite')).toBe(true);
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
      { piece: 'invoice_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'bill_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_vendor_details', on: false, changedBy: null, changedAt: null },
      { piece: 'item_accounts', on: false, changedBy: null, changedAt: null },
      { piece: 'estimates_in_fleetsuite', on: false, changedBy: null, changedAt: null },
    ]);
    expect(await readSwitches(fakeService().service)).toEqual([
      { piece: 'credit_memos', on: false, changedBy: null, changedAt: null },
      { piece: 'vendor_credits', on: false, changedBy: null, changedAt: null },
      { piece: 'card_charges', on: false, changedBy: null, changedAt: null },
      { piece: 'journal_entries', on: false, changedBy: null, changedAt: null },
      { piece: 'inventory_transfers', on: false, changedBy: null, changedAt: null },
      { piece: 'invoice_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'bill_fixes', on: false, changedBy: null, changedAt: null },
      { piece: 'customer_vendor_details', on: false, changedBy: null, changedAt: null },
      { piece: 'item_accounts', on: false, changedBy: null, changedAt: null },
      { piece: 'estimates_in_fleetsuite', on: false, changedBy: null, changedAt: null },
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
