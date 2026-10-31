// Going live (src/lib/books/going-live.ts): the tap's refusals, why an
// opening entry waits, and the posting run's step that posts it, against a
// made-up company's books and a stand-in for the database.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import {
  GO_LIVE_FROM, goLiveRefusal, openingMonth, openingWait, postOpeningEntries, readLastCopy, readOpeningEntries, withCompanies,
  type LastCopy,
} from './going-live';
import type { OpeningEntry, OpeningPartyData } from './opening-balances';

const ACME = 'c0000000-0000-4000-8000-00000000ac3e';
const BOLT = 'c0000000-0000-4000-8000-00000000b017';
const CASH = 'a0000000-0000-4000-8000-000000000010';
const RECEIVABLE = 'a0000000-0000-4000-8000-000000000012';
const RETAINED = 'a0000000-0000-4000-8000-000000000030';
const SALES = 'a0000000-0000-4000-8000-000000000040';

const chartRow = (id: string, ns: string, number: string, name: string, type: string) => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: type === 'income' ? 'income_statement' : 'balance_sheet', is_summary: false, company_id: null,
});
const CHART = [
  chartRow(CASH, '10', '1000', 'Cash', 'bank'),
  chartRow(RECEIVABLE, '12', '1200', 'Accounts Receivable', 'accounts_receivable'),
  chartRow(RETAINED, '30', '3900', 'Retained Earnings', 'equity'),
  chartRow(SALES, '40', '4000', 'Sales', 'income'),
];

const amount = (acct: string, debit: string, credit: string, month?: string) => ({ netsuite_account_id: acct, debit, credit, ...(month ? { month } : {}) });
/**
 * Made-up books: 1,000.00 of cash and retained earnings before 2025, and a
 * 300.00 invoice in December 2026, which NetSuite has as Acme's and
 * FleetSuite's journal as Bolt's.
 */
const OPENING = [amount('10', '1000.00', '0.00'), amount('30', '0.00', '1000.00')];
const DECEMBER = [amount('12', '300.00', '0.00', '2026-12-01'), amount('40', '0.00', '300.00', '2026-12-01')];
const JOURNAL = DECEMBER.map((m) => ({ account: m.netsuite_account_id, month: m.month!, debit: m.debit, credit: m.credit }));
const SWAPPED: OpeningPartyData[] = [
  { account: '12', kind: 'customer', party: ACME, name: 'Acme Fleet', netsuite: '300.00', fleetsuite: '0.00' },
  { account: '12', kind: 'customer', party: BOLT, name: 'Bolt Leasing', netsuite: '0.00', fleetsuite: '300.00' },
];

let copy: { last_result: unknown; last_synced_at: string | null; updated_at: string } | null;
let parties: Record<string, OpeningPartyData[]>;
let posted: Record<string, Array<Record<string, unknown>>>;
let errors: Record<string, { message: string }>;
let alreadyPosted: boolean;
const calls: Array<[string, Record<string, unknown>]> = [];

/** Just enough of supabase-js for the readers and the journal. */
const service: any = {
  from: (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      range: async (from: number, to: number) => (errors[table] ? { data: null, error: errors[table] } : { data: CHART.slice(from, to + 1), error: null }),
      maybeSingle: async () => (errors[table] ? { data: null, error: errors[table] } : { data: copy, error: null }),
    };
    return q;
  },
  rpc: async (name: string, args: Record<string, unknown>) => {
    calls.push([name, args]);
    const company = String(args.p_company ?? '');
    const error = errors[name] ?? errors[`${name}:${company}`];
    if (error) return { data: null, error };
    if (name === 'gl_netsuite_totals') return { data: { opening: OPENING, netsuite: DECEMBER, copied: DECEMBER }, error: null };
    if (name === 'gl_books_totals') return { data: JOURNAL, error: null };
    if (name === 'gl_opening_parties') return { data: { parties: parties[company] ?? [] }, error: null };
    if (name === 'gl_opening_entries') return { data: { entries: posted[company] ?? [] }, error: null };
    if (name === 'gl_post_entry') return { data: { id: 'e9', entry_no: 9, already_posted: alreadyPosted }, error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const LIVE = [{ code: 'BMG' as const, liveFrom: '2027-01-01' }];
const codeOf = new Map<string, string>();
const run = (today: string, live = LIVE) => postOpeningEntries(service, { today, live, codeOf });
const postings = () => calls.filter(([name]) => name === 'gl_post_entry').map(([, args]) => args.p as Record<string, any>);

beforeEach(() => {
  copy = { last_result: { swept: ['2026-12-01'] }, last_synced_at: '2027-01-01T07:00:00Z', updated_at: '2027-01-01T07:00:00Z' };
  parties = { BMG: SWAPPED };
  posted = {};
  errors = {};
  alreadyPosted = false;
  calls.length = 0;
});

describe('goLiveRefusal', () => {
  const bmg = { code: 'BMG', name: 'BMG Fleet', books_live_from: null };

  it('offers going live from December 1, 2026', () => {
    expect(GO_LIVE_FROM).toBe('2026-12-01');
    expect(goLiveRefusal(bmg, 'BMG', '2026-11-30')).toEqual({ status: 400, message: "BMG Fleet's books can go live from December 1, 2026." });
    expect(goLiveRefusal(bmg, 'BMG', '2026-12-01')).toBeNull();
    expect(goLiveRefusal(bmg, 'BMG', '2027-02-10')).toBeNull();
  });

  it("takes the company's code typed out, whatever its case", () => {
    expect(goLiveRefusal(bmg, ' bmg ', '2026-12-28')).toBeNull();
    for (const typed of ['', 'BM', 'BMG!', '1084', 'yes']) {
      expect(goLiveRefusal(bmg, typed, '2026-12-28')).toEqual({ status: 400, message: 'Type BMG to go live.' });
    }
  });

  it('goes live once', () => {
    expect(goLiveRefusal({ ...bmg, books_live_from: '2027-01-01' }, 'BMG', '2026-12-28'))
      .toEqual({ status: 409, message: "BMG Fleet's books already went live on January 1, 2027." });
  });
});

describe('openingWait', () => {
  const entry = (more: Partial<OpeningEntry> = {}): OpeningEntry => ({
    company: 'BMG', month: '2026-12-01', date: '2026-12-31', liveFrom: '2027-01-01', debit: 100, credit: 100, problems: [],
    lines: [{ netsuiteAccountId: '10', accountId: CASH, number: '1000', name: 'Cash', fleetsuite: 0, netsuite: 100, cents: 100 }],
    ...more,
  });
  const copied = (syncedAt: string | null, error: string | null = null): LastCopy => ({ at: '2027-01-02T07:00:00Z', syncedAt, error });

  it('names the month before the live date', () => {
    expect(openingMonth('2027-01-01')).toBe('2026-12-01');
    expect(openingMonth('2026-07-01')).toBe('2026-06-01');
  });

  it("waits for a whole copy of NetSuite's ledger made since the day ended in Central time", () => {
    expect(openingWait(entry(), copied('2027-01-01T06:00:00Z'))).toBeNull();
    // 11:59 PM on December 31 in O'Fallon.
    expect(openingWait(entry(), copied('2027-01-01T05:59:00Z')))
      .toBe("No whole copy of NetSuite's ledger has been made since December 31, 2026 ended.");
    expect(openingWait(entry(), copied(null))).toBe("No whole copy of NetSuite's ledger has been made since December 31, 2026 ended.");
    expect(openingWait(entry(), null)).toBe("No whole copy of NetSuite's ledger has been made since December 31, 2026 ended.");
  });

  it("waits while the last copy failed, and first for what would stop it", () => {
    expect(openingWait(entry(), copied('2027-01-02T07:00:00Z', 'NetSuite said no'))).toBe("The last copy of NetSuite's ledger failed: NetSuite said no.");
    expect(openingWait(entry(), copied('2027-01-02T07:00:00Z', 'Timed out.'))).toBe("The last copy of NetSuite's ledger failed: Timed out.");
    expect(openingWait(entry({ problems: ['First thing.', 'Second thing.'] }), copied(null, 'NetSuite said no'))).toBe('First thing.');
  });

  it('has nothing to wait for with nothing to post', () => {
    expect(openingWait(entry({ lines: [] }), null)).toBeNull();
    expect(openingWait(entry({ lines: [] }), copied(null, 'NetSuite said no'))).toBeNull();
  });
});

describe('postOpeningEntries', () => {
  it("does nothing until the books' first day", async () => {
    expect(await run('2026-12-31')).toEqual({ posted: 0, notes: [] });
    expect(await run('2027-03-01', [])).toEqual({ posted: 0, notes: [] });
    expect(calls).toEqual([]);
  });

  it('posts the opening entry, customer by customer, once the day is over and copied', async () => {
    expect(await run('2027-01-01')).toEqual({ posted: 1, notes: [] });
    expect(calls.map(([name, args]) => [name, args])).toEqual([
      ['gl_netsuite_totals', { p_company: 'BMG' }],
      ['gl_books_totals', { p_company: 'BMG' }],
      ['gl_opening_parties', { p_company: 'BMG', p_through: '2026-12-31' }],
      ['gl_opening_entries', { p_company: 'BMG' }],
      ['gl_post_entry', expect.anything()],
    ]);
    expect(postings()).toEqual([expect.objectContaining({
      company: 'BMG',
      entry_date: '2026-12-31',
      source_type: 'opening_balance',
      source_id: null,
      posting_rule: 'opening_balance@1',
      idempotency_key: 'opening_balance:BMG:2027-01-01:1',
      memo: "Opening balances: NetSuite's on December 31, 2026",
    })]);
    expect(postings()[0].lines.map((l: any) => [l.account_id, l.debit, l.credit, l.memo, l.customer_id])).toEqual([
      [RECEIVABLE, '300.00', null, 'Acme Fleet', ACME],
      [RECEIVABLE, null, '300.00', 'Bolt Leasing', BOLT],
    ]);
  });

  it('trues the books up as the next one when NetSuite has changed the day since', async () => {
    posted = { BMG: [{ id: 'e1', entry_no: 1, entry_date: '2026-12-31', memo: 'Opening balances', posted_at: '2027-01-01T08:00:00Z', debit: '50.00', lines: 2, reversed_by: null }] };
    expect(await run('2027-02-14')).toEqual({ posted: 1, notes: [] });
    expect(postings()[0]).toMatchObject({
      idempotency_key: 'opening_balance:BMG:2027-01-01:2', memo: "Opening balances trued up: NetSuite's on December 31, 2026",
    });
  });

  it('posts nothing when the books already match, and counts nothing the journal already had', async () => {
    parties = {};
    expect(await run('2027-01-05')).toEqual({ posted: 0, notes: [] });
    expect(postings()).toEqual([]);
    parties = { BMG: SWAPPED };
    alreadyPosted = true;
    expect(await run('2027-01-05')).toEqual({ posted: 0, notes: [] });
    expect(postings()).toHaveLength(1);
  });

  it("waits for a whole copy of NetSuite's ledger since the day ended, saying so", async () => {
    copy = { last_result: {}, last_synced_at: '2026-12-31T22:00:00Z', updated_at: '2027-01-01T03:00:00Z' };
    expect(await run('2027-01-01')).toEqual({
      posted: 0,
      notes: ["BMG's opening entry for December 31, 2026 is waiting: No whole copy of NetSuite's ledger has been made since December 31, 2026 ended. Going live shows it."],
    });
    copy = { last_result: { error: 'NetSuite said no' }, last_synced_at: '2027-01-01T07:00:00Z', updated_at: '2027-01-02T07:00:00Z' };
    expect((await run('2027-01-02')).notes).toEqual([
      "BMG's opening entry for December 31, 2026 is waiting: The last copy of NetSuite's ledger failed: NetSuite said no. Going live shows it.",
    ]);
    copy = null;
    expect((await run('2027-01-02')).notes[0]).toContain('No whole copy');
    expect(postings()).toEqual([]);
  });

  it('waits for what would stop it', async () => {
    parties = { BMG: SWAPPED.slice(0, 1) };
    const { posted: count, notes } = await run('2027-01-02');
    expect(count).toBe(0);
    expect(notes).toEqual([
      "BMG's opening entry for December 31, 2026 is waiting: 1200 Accounts Receivable takes nothing, but its customers' lines come to a debit "
        + "of $300.00, so it can't go customer by customer: copy NetSuite's ledger again (Trial balance vs NetSuite → Copy now). Going live shows it.",
    ]);
  });

  it('says what failed, company by company, and carries on', async () => {
    const both = [...LIVE, { code: '1084' as const, liveFrom: '2027-01-01' }];
    parties = { BMG: SWAPPED, 1084: SWAPPED };
    errors = { 'gl_netsuite_totals:BMG': { message: 'totals are down' } };
    expect(await run('2027-01-02', both)).toEqual({ posted: 1, notes: ["BMG's opening entry for December 31, 2026 couldn't post: totals are down"] });
    expect(postings().map((p) => p.idempotency_key)).toEqual(['opening_balance:1084:2027-01-01:1']);

    calls.length = 0;
    errors = { gl_post_entry: { message: 'gl: 2026-12 is closed for BMG' } };
    expect(await run('2027-01-02')).toEqual({ posted: 0, notes: ["BMG's opening entry for December 31, 2026 couldn't post: 2026-12 is closed for BMG"] });
  });

  it("says so when the copy or the chart can't be read", async () => {
    errors = { sync_state: { message: 'sync state is down' } };
    expect(await run('2027-01-02')).toEqual({ posted: 0, notes: ["The opening entries couldn't be worked out this time: sync state is down"] });
    errors = { gl_accounts: { message: 'chart is down' } };
    expect(await run('2027-01-02')).toEqual({ posted: 0, notes: ["The opening entries couldn't be worked out this time: chart is down"] });
    expect(calls).toEqual([]);
  });
});

describe('the readers', () => {
  it("say how the last copy of NetSuite's ledger went", async () => {
    copy = { last_result: { error: 'NetSuite said no' }, last_synced_at: '2027-01-01T07:00:00Z', updated_at: '2027-01-02T07:00:00Z' };
    expect(await readLastCopy(service)).toEqual({ at: '2027-01-02T07:00:00Z', syncedAt: '2027-01-01T07:00:00Z', error: 'NetSuite said no' });
    copy = { last_result: null, last_synced_at: null, updated_at: '2027-01-02T07:00:00Z' };
    expect(await readLastCopy(service)).toEqual({ at: '2027-01-02T07:00:00Z', syncedAt: null, error: null });
    copy = null;
    expect(await readLastCopy(service)).toBeNull();
    errors = { sync_state: { message: 'down' } };
    await expect(readLastCopy(service)).rejects.toThrow('down');
  });

  it('list the opening entries posted, amounts in cents', async () => {
    posted = {
      BMG: [
        { id: 'e1', entry_no: 41, entry_date: '2026-12-31', memo: 'Opening balances', posted_at: '2027-01-01T08:00:00Z', debit: '1234.50', lines: 12, reversed_by: null },
        { id: 'e2', entry_no: '57', entry_date: '2026-12-31', memo: null, posted_at: '2027-02-01T08:00:00Z', debit: '0.25', lines: '2', reversed_by: '60' },
      ],
    };
    expect(await readOpeningEntries(service, 'BMG')).toEqual([
      { id: 'e1', entryNo: 41, date: '2026-12-31', memo: 'Opening balances', postedAt: '2027-01-01T08:00:00Z', debit: 123450, lines: 12, reversedBy: null },
      { id: 'e2', entryNo: 57, date: '2026-12-31', memo: null, postedAt: '2027-02-01T08:00:00Z', debit: 25, lines: 2, reversedBy: 60 },
    ]);
    expect(await readOpeningEntries(service, '1084')).toEqual([]);
  });

  it("name each account's company by its code", () => {
    const rows = [{ ...CHART[0], company_id: 'c1' }, { ...CHART[1], company_id: 'c9' }, CHART[2]];
    expect(withCompanies(rows, new Map([['c1', '1084']])).map((a) => [a.number, a.company])).toEqual([['1000', '1084'], ['1200', null], ['3900', null]]);
    expect(withCompanies(rows, new Map())[0]).not.toHaveProperty('company_id');
  });
});
