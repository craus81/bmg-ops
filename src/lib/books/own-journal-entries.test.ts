import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workOutCardEntry, type CardCharge, type CardEntryFacts } from '@/lib/card-charges';
import { workOutTypedEntry, type TypedEntryFacts } from '@/lib/typed-journal-entries';
import {
  ownCardEntryPayload, ownTypedEntryPayload, saveOwnCardEntry, saveOwnTypedEntry, type MadeCardEntry, type MadeTypedEntry,
} from './own-journal-entries';

// A made-up month of card charges: a purchase and money back from the same merchant.
const FACTS: CardEntryFacts = {
  company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' },
  cardAccount: { id: '900', number: '2100', name: 'Company card', type: 'credit_card', companies: ['BMG'] },
  accounts: new Map([['610', { id: '610', number: '5100', name: 'Shop supplies', type: 'expense', companies: ['BMG'] }]]),
};
const CHARGES: CardCharge[] = [
  { id: 'c0000000-0000-4000-8000-000000000001', date: '2027-01-03', description: 'ACME HARDWARE #1234', card: '1234', cents: 12550, accountId: '610', memo: null },
  { id: 'c0000000-0000-4000-8000-000000000002', date: '2027-01-07', description: 'ACME HARDWARE #5678', card: null, cents: -2000, accountId: '610', memo: 'Bracket back' },
];

const made = (over: Partial<MadeCardEntry> = {}): MadeCardEntry => ({
  netsuiteId: '7002',
  netsuiteNumber: 'JE-501',
  company: 'BMG',
  worked: workOutCardEntry(CHARGES, FACTS),
  madeFromId: 's0000000-0000-4000-8000-000000000001',
  madeBy: 'p0000000-0000-4000-8000-000000000001',
  ...over,
});

function fakeService(rpc: { data?: unknown; error?: { message: string }; throws?: boolean } = {}) {
  const calls: unknown[][] = [];
  const service = {
    rpc: async (fn: string, args: unknown) => {
      calls.push([fn, args]);
      if (rpc.throws) throw new Error('fetch failed');
      return { data: 'data' in rpc ? rpc.data : { saved: true, lines: 4 }, error: rpc.error ?? null };
    },
  };
  return { service: service as unknown as SupabaseClient, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('ownCardEntryPayload', () => {
  it('keeps the journal entry as FleetSuite worked it out, each line with the charge it is for', () => {
    const m = made();
    expect(m.worked.problems).toEqual([]);
    const c1 = 'c0000000-0000-4000-8000-000000000001';
    const c2 = 'c0000000-0000-4000-8000-000000000002';
    expect(ownCardEntryPayload({ ...m, netsuiteId: '7002' })).toEqual({
      netsuite_id: '7002', company: 'BMG', source: 'card_charges', made_from_id: 's0000000-0000-4000-8000-000000000001',
      netsuite_number: 'JE-501', tran_date: '2027-01-07', memo: '2100 Company card charges, January 2027, from FleetSuite',
      rule: 'card_charges@1', total: '145.50', made_by: 'p0000000-0000-4000-8000-000000000001',
      lines: [
        { line_no: 1, account_netsuite_id: '610', debit: '125.50', credit: null, memo: 'ACME HARDWARE #1234 · Jan 3 · card 1234', card_charge_id: c1 },
        { line_no: 2, account_netsuite_id: '900', debit: null, credit: '125.50', memo: 'ACME HARDWARE #1234 · Jan 3 · card 1234', card_charge_id: c1 },
        { line_no: 3, account_netsuite_id: '610', debit: null, credit: '20.00', memo: 'ACME HARDWARE #5678 · Jan 7 · Bracket back', card_charge_id: c2 },
        { line_no: 4, account_netsuite_id: '900', debit: '20.00', credit: null, memo: 'ACME HARDWARE #5678 · Jan 7 · Bracket back', card_charge_id: c2 },
      ],
    });
  });
});

describe('saveOwnCardEntry', () => {
  it('saves the copy through gl_own_journal_entry_save', async () => {
    const { service, calls } = fakeService();
    expect(await saveOwnCardEntry(service, made({ netsuiteId: ' 7002 ' }))).toEqual({ saved: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('gl_own_journal_entry_save');
    expect((calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({ netsuite_id: '7002', total: '145.50', source: 'card_charges' });
  });

  it("says when it's already saved", async () => {
    const { service } = fakeService({ data: { saved: false, lines: 0 } });
    expect(await saveOwnCardEntry(service, made())).toEqual({ saved: false, reason: 'already saved' });
    expect(await saveOwnCardEntry(fakeService({ data: null }).service, made())).toEqual({ saved: false, reason: 'already saved' });
  });

  it('never throws: no NetSuite id, a refused save or a failed call is logged and left', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const netsuiteId of [null, undefined, '', 'JE7002']) {
      const none = fakeService();
      expect(await saveOwnCardEntry(none.service, made({ netsuiteId }))).toEqual({ saved: false, reason: "NetSuite didn't say which journal entry it made" });
      expect(none.calls).toEqual([]);
    }
    const refused = fakeService({ data: null, error: { message: "gl: own journal entry 7002's debits and credits don't match" } });
    expect(await saveOwnCardEntry(refused.service, made())).toEqual({ saved: false, reason: "gl: own journal entry 7002's debits and credits don't match" });
    const failed = fakeService({ throws: true });
    expect(await saveOwnCardEntry(failed.service, made())).toEqual({ saved: false, reason: 'fetch failed' });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toBe("[books] own copy of NetSuite journal entry 7002 not saved: gl: own journal entry 7002's debits and credits don't match");
  });
});

// A made-up accrual typed on the Journal entries page: wages owed at month end, split over two expense lines.
const TYPED_FACTS: TypedEntryFacts = {
  company: { code: 'BMG', name: 'BMG Fleet', subsidiaryId: '2' },
  accounts: new Map([
    ['610', { id: '610', number: '6100', name: 'Shop wages', type: 'expense', companies: ['BMG'] }],
    ['620', { id: '620', number: '6200', name: 'Office wages', type: 'expense', companies: ['BMG'] }],
    ['230', { id: '230', number: '2300', name: 'Accrued wages', type: 'other_current_liability', companies: ['BMG'] }],
  ]),
};
const typed = (over: Partial<MadeTypedEntry> = {}): MadeTypedEntry => ({
  netsuiteId: '7010',
  netsuiteNumber: 'JE-510',
  company: 'BMG',
  worked: workOutTypedEntry({
    date: '2027-01-31',
    memo: 'January wages accrued',
    lines: [
      { accountId: '610', debitCents: 180000, creditCents: 0, memo: 'Shop' },
      { accountId: '620', debitCents: 45025, creditCents: 0, memo: null },
      { accountId: '230', debitCents: 0, creditCents: 225025, memo: null },
    ],
  }, TYPED_FACTS),
  madeFromId: 'e0000000-0000-4000-8000-000000000001',
  madeBy: 'p0000000-0000-4000-8000-000000000002',
  ...over,
});

describe('ownTypedEntryPayload', () => {
  it('keeps the journal entry as typed, line by line, with no card charges', () => {
    const m = typed();
    expect(m.worked.problems).toEqual([]);
    expect(ownTypedEntryPayload({ ...m, netsuiteId: '7010' })).toEqual({
      netsuite_id: '7010', company: 'BMG', source: 'typed', made_from_id: 'e0000000-0000-4000-8000-000000000001',
      netsuite_number: 'JE-510', tran_date: '2027-01-31', memo: 'January wages accrued',
      rule: 'typed_journal_entry@1', total: '2250.25', made_by: 'p0000000-0000-4000-8000-000000000002',
      lines: [
        { line_no: 1, account_netsuite_id: '610', debit: '1800.00', credit: null, memo: 'Shop', card_charge_id: null },
        { line_no: 2, account_netsuite_id: '620', debit: '450.25', credit: null, memo: null, card_charge_id: null },
        { line_no: 3, account_netsuite_id: '230', debit: null, credit: '2250.25', memo: null, card_charge_id: null },
      ],
    });
  });
});

describe('saveOwnTypedEntry', () => {
  it('saves the copy through gl_own_journal_entry_save, as made from the typed entry', async () => {
    const { service, calls } = fakeService();
    expect(await saveOwnTypedEntry(service, typed({ netsuiteId: ' 7010 ' }))).toEqual({ saved: true });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('gl_own_journal_entry_save');
    expect((calls[0][1] as { p: Record<string, unknown> }).p).toMatchObject({
      netsuite_id: '7010', total: '2250.25', source: 'typed', rule: 'typed_journal_entry@1', made_from_id: 'e0000000-0000-4000-8000-000000000001',
    });
  });

  it('never throws, and says when it is already saved', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await saveOwnTypedEntry(fakeService({ data: { saved: false, lines: 0 } }).service, typed())).toEqual({ saved: false, reason: 'already saved' });
    const none = fakeService();
    expect(await saveOwnTypedEntry(none.service, typed({ netsuiteId: null }))).toEqual({ saved: false, reason: "NetSuite didn't say which journal entry it made" });
    expect(none.calls).toEqual([]);
    expect(await saveOwnTypedEntry(fakeService({ throws: true }).service, typed())).toEqual({ saved: false, reason: 'fetch failed' });
    expect(log.mock.calls[0][0]).toBe('[books] own copy of NetSuite journal entry 7010 not saved: fetch failed');
  });
});
