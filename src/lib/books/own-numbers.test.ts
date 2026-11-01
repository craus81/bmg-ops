import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MAX_NEXT, OWN_NUMBER_KINDS, OWN_NUMBER_TYPES, isOwnNumberType, keptOurs, lettersTakenBy, lookAtOwnNumbers, markOwnNumbersTold, numberView, outsideSince,
  outsideView, ownNumberFor, readNumbers, readOutside, readOwnNumbersSwitch, readSeries, seriesChange, seriesView, setNumberKeeper, standingOf,
  type NumberEnd, type NumberRow, type OwnNumber,
} from './own-numbers';

// FleetSuite's own numbers (migration 497): how a send takes its number and
// says what became of it, and what Books → Own numbers and the daily check
// make of the numbers kept. The database is a stand-in. Made-up data.

afterEach(() => {
  setNumberKeeper(undefined);
  vi.restoreAllMocks();
});

function keeper(opts: { off?: boolean; fails?: boolean; settleFails?: boolean } = {}) {
  const ends: Array<[string, NumberEnd]> = [];
  setNumberKeeper({
    reserve: async (type) => {
      if (opts.fails) throw new Error('could not reach the database');
      return opts.off ? null : { id: 'num-1', number: `${type === 'invoice' ? 'INV' : 'SO'}10001` };
    },
    settle: async (id, end) => {
      if (opts.settleFails) throw new Error('could not reach the database');
      ends.push([id, end]);
    },
  });
  return ends;
}

async function taken(): Promise<OwnNumber> {
  const own = await ownNumberFor('invoice');
  if (!own.ok) throw new Error(own.error);
  return own;
}

describe('the kinds', () => {
  it('names each kind FleetSuite numbers, and only those', () => {
    expect(OWN_NUMBER_TYPES).toEqual(['sales_order', 'purchase_order', 'invoice', 'credit_memo']);
    expect(Object.keys(OWN_NUMBER_KINDS)).toEqual([...OWN_NUMBER_TYPES]);
    expect(OWN_NUMBER_KINDS.purchase_order).toEqual({ one: 'PO', a: 'a PO', many: 'POs', netsuite: 'Purchase Order', record: 'purchaseOrder' });
    expect(OWN_NUMBER_KINDS.invoice.a).toBe('an invoice');
    expect(OWN_NUMBER_KINDS.credit_memo.netsuite).toBe('Credit Memo');
    expect(isOwnNumberType('invoice')).toBe(true);
    expect(isOwnNumberType('bill')).toBe(false);
    expect(isOwnNumberType('toString')).toBe(false);
    expect(isOwnNumberType(null)).toBe(false);
  });
});

describe('ownNumberFor', () => {
  it("takes none while there's no keeper or FleetSuite's own numbers is off, and saying what became of it does nothing", async () => {
    setNumberKeeper(null);
    const none = await taken();
    expect(none.number).toBeNull();
    await expect(none.made('9001', 'INV2702')).resolves.toBeUndefined();
    await expect(none.failed(400, 'nope')).resolves.toBeUndefined();
    setNumberKeeper(undefined); // the test runner has no keeper of its own
    expect((await taken()).number).toBeNull();
    const ends = keeper({ off: true });
    const off = await taken();
    expect(off.number).toBeNull();
    await off.made('9001', 'INV2702');
    expect(ends).toEqual([]);
  });

  it("says why when a number can't be taken, and nothing is sent", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    keeper({ fails: true });
    expect(await ownNumberFor('credit_memo')).toEqual({
      ok: false,
      error: "FleetSuite couldn't give this credit memo its number, so nothing was sent to NetSuite. Try again in a moment.",
    });
    expect(await ownNumberFor('sales_order')).toMatchObject({ error: expect.stringContaining('give this sales order its number') });
    expect(log).toHaveBeenCalledWith("[own-numbers] couldn't take a credit_memo number:", 'could not reach the database');
  });

  it('keeps what NetSuite made, trimmed, and only the first saying', async () => {
    const ends = keeper();
    const own = await taken();
    expect(own.number).toBe('INV10001');
    await own.made(' 9001 ', ' INV10001 ');
    await own.refused('too late');
    await own.lost(new Error('too late'));
    expect(ends).toEqual([['num-1', { status: 'made', netsuiteId: '9001', netsuiteNumber: 'INV10001' }]]);
    const blank = await taken();
    await blank.made('', '  ');
    await blank.made(undefined, null);
    expect(ends[1]).toEqual(['num-1', { status: 'made', netsuiteId: null, netsuiteNumber: null }]);
    expect(ends).toHaveLength(2);
  });

  it("tells a refusal from an answer that doesn't say", async () => {
    const ends = keeper();
    await (await taken()).failed(400, JSON.stringify({ title: 'Bad Request', 'o:errorDetails': [{ detail: 'Invalid customer.' }] }));
    await (await taken()).failed(404, null);
    await (await taken()).failed(499, '');
    await (await taken()).failed(500, null);
    await (await taken()).failed(502, '<html><body>Bad gateway</body></html>');
    await (await taken()).failed(302, null);
    expect(ends.map(([, e]) => e)).toEqual([
      { status: 'refused', note: 'Invalid customer.' },
      { status: 'refused', note: 'NetSuite refused it (404).' },
      { status: 'refused', note: 'NetSuite refused it (499).' },
      { status: 'unsure', note: "NetSuite answered 500, which doesn't say whether it made it." },
      { status: 'unsure', note: 'Bad gateway' },
      { status: 'unsure', note: "NetSuite answered 302, which doesn't say whether it made it." },
    ]);
  });

  it('keeps why, without long runs of digits, and says something when there is no why', async () => {
    const ends = keeper();
    await (await taken()).refused('Account 123456789012 is closed.');
    await (await taken()).refused('  ');
    await (await taken()).unsure('');
    await (await taken()).lost(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }));
    await (await taken()).lost(new Error('socket hang up'));
    expect(ends.map(([, e]) => e)).toEqual([
      { status: 'refused', note: 'Account ••• is closed.' },
      { status: 'refused', note: 'NetSuite refused it.' },
      { status: 'unsure', note: "FleetSuite couldn't tell whether NetSuite made it." },
      { status: 'unsure', note: "NetSuite didn't answer in time." },
      { status: 'unsure', note: 'FleetSuite lost touch with NetSuite before it answered: socket hang up' },
    ]);
  });

  it("doesn't let a number it can't keep stop the document", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keeper({ settleFails: true });
    const own = await taken();
    await expect(own.made('9001', 'INV10001')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[own-numbers] couldn't keep what became of INV10001:", 'could not reach the database');
  });
});

describe('keptOurs', () => {
  it("knows FleetSuite's number but for case, or with a PO's ending", () => {
    expect(keptOurs('INV10001', 'INV10001')).toBe(true);
    expect(keptOurs('INV10001', ' inv10001 ')).toBe(true);
    expect(keptOurs('inv10001', 'INV10001')).toBe(true);
    expect(keptOurs('PO10001', 'PO10001-ACME')).toBe(true);
    expect(keptOurs('PO10001', 'PO100012')).toBe(false);
    expect(keptOurs('PO10001', 'XPO10001')).toBe(false);
    expect(keptOurs('INV10001', 'INV2702')).toBe(false);
    expect(keptOurs('INV10001', null)).toBe(false);
    expect(keptOurs('INV10001', '')).toBe(false);
  });
});

describe('standingOf', () => {
  const NOW = new Date('2027-04-02T15:00:00Z');
  const row = (over: Partial<NumberRow>): NumberRow => ({
    id: 'num-1', doc_type: 'invoice', number: 'INV10007', reserved_at: '2027-04-02T14:58:00Z', reserved_by: null, status: 'reserved',
    settled_at: null, netsuite_id: null, netsuite_number: null, note: null, kept_own: null, ...over,
  });

  it('says what became of each number', () => {
    expect(standingOf(row({ status: 'made', netsuite_id: '9001', netsuite_number: 'INV10007' }), NOW))
      .toEqual({ standing: 'made', text: 'Made in NetSuite.' });
    expect(standingOf(row({ doc_type: 'purchase_order', number: 'PO10002', status: 'made', netsuite_number: 'PO10002-ACME' }), NOW).standing).toBe('made');
    expect(standingOf(row({ status: 'made', netsuite_id: '9001' }), NOW))
      .toEqual({ standing: 'made', text: "Made in NetSuite, which didn't say what number it kept." });
    expect(standingOf(row({ status: 'made', netsuite_id: '9001', netsuite_number: 'INV2703' }), NOW)).toEqual({
      standing: 'kept_own',
      text: 'NetSuite made it but kept its own number, INV2703. Tick Allow Override for Invoice in NetSuite.',
    });
    expect(standingOf(row({ doc_type: 'sales_order', number: 'SO10001', status: 'made', netsuite_number: 'SO4415' }), NOW).text)
      .toBe('NetSuite made it but kept its own number, SO4415. Tick Allow Override for Sales Order in NetSuite.');
    expect(standingOf(row({ status: 'refused', note: 'Invalid customer.' }), NOW))
      .toEqual({ standing: 'refused', text: 'NetSuite refused it, so nothing has this number: Invalid customer.' });
    expect(standingOf(row({ status: 'refused' }), NOW).text).toBe('NetSuite refused it, so nothing has this number: no reason given.');
    expect(standingOf(row({ status: 'unsure', note: "NetSuite didn't answer in time." }), NOW)).toEqual({
      standing: 'unsure',
      text: "Not sure NetSuite made it: NetSuite didn't answer in time. Look for INV10007 in NetSuite.",
    });
    expect(standingOf(row({ status: 'unsure' }), NOW).text).toBe('Not sure NetSuite made it: no answer. Look for INV10007 in NetSuite.');
  });

  it('gives a number on its way five minutes before saying FleetSuite never heard back', () => {
    expect(standingOf(row({ reserved_at: '2027-04-02T14:55:00Z' }), NOW)).toEqual({ standing: 'sending', text: 'On its way to NetSuite.' });
    expect(standingOf(row({ reserved_at: '2027-04-02T14:54:59Z' }), NOW)).toEqual({
      standing: 'no_answer',
      text: 'FleetSuite never heard back from NetSuite. Look for INV10007 in NetSuite.',
    });
  });
});

describe('seriesChange', () => {
  it("takes one to six letters and a whole number up to the series' end", () => {
    expect(seriesChange(' inv ', '10001')).toEqual({ prefix: 'INV', next: 10001 });
    expect(seriesChange('SO', 1)).toEqual({ prefix: 'SO', next: 1 });
    expect(seriesChange('ABCDEF', ` ${MAX_NEXT} `)).toEqual({ prefix: 'ABCDEF', next: 999_999_999 });
    const letters = 'The letters are one to six letters, A to Z, like INV.';
    for (const bad of ['', 'IN1', 'ABCDEFG', 'IN-V', 'ÉTÉ', null, 5]) expect(seriesChange(bad, 1)).toEqual({ error: letters });
    const next = 'The next number is a whole number from 1 to 999,999,999.';
    for (const bad of [0, -1, 1.5, MAX_NEXT + 1, '1e3', '12a', '', ' ', null, Number.NaN, '1000000000']) expect(seriesChange('INV', bad)).toEqual({ error: next });
  });
});

describe('lettersTakenBy', () => {
  const rows = [
    { doc_type: 'sales_order' as const, prefix: 'SO', next_seq: 10001, changed_by: null, changed_at: null },
    { doc_type: 'invoice' as const, prefix: 'INV', next_seq: 10001, changed_by: null, changed_at: null },
  ];
  it('names the other kind that has the letters already, and none for its own', () => {
    expect(lettersTakenBy(rows, 'credit_memo', 'SO')).toBe('Sales orders');
    expect(lettersTakenBy(rows, 'credit_memo', 'inv')).toBe('Invoices');
    expect(lettersTakenBy(rows, 'invoice', 'INV')).toBeNull();
    expect(lettersTakenBy(rows, 'credit_memo', 'CM')).toBeNull();
  });
});

describe('outsideSince', () => {
  const NOW = new Date('2027-04-15T03:00:00Z'); // April 14 in Chicago

  it('lists from the day it went on, in Chicago', () => {
    expect(outsideSince({ on: true, changedAt: '2027-04-01T03:00:00Z' }, NOW)).toBe('2027-03-31');
    expect(outsideSince({ on: true, changedAt: '2027-04-01T15:00:00Z' }, NOW)).toBe('2027-04-01');
    expect(outsideSince({ on: true, changedAt: null }, NOW)).toBe('2027-04-14');
    expect(outsideSince({ on: true, changedAt: 'not a time' }, NOW)).toBe('2027-04-14');
  });

  it('looks back thirty days while it is off', () => {
    expect(outsideSince({ on: false, changedAt: '2027-04-01T15:00:00Z' }, NOW)).toBe('2027-03-15');
    expect(outsideSince({ on: false, changedAt: null }, new Date('2027-04-15T12:00:00Z'))).toBe('2027-03-16');
  });
});

// ── Reads, against a stand-in database ─────────────────────────────────────

interface Call { table?: string; fn?: string; args?: unknown; select?: string; eq: Array<[string, unknown]>; order: Array<[string, boolean]>; limit?: number }

function fakeService(answers: { rows?: unknown; rpc?: unknown; error?: string } = {}) {
  const calls: Call[] = [];
  const answer = () => ({ data: answers.error ? null : answers.rows ?? null, error: answers.error ? { message: answers.error } : null });
  const service = {
    from(table: string) {
      const call: Call = { table, eq: [], order: [] };
      calls.push(call);
      const builder: any = {
        select: (cols: string) => { call.select = cols; return builder; },
        eq: (c: string, v: unknown) => { call.eq.push([c, v]); return builder; },
        order: (c: string, o: { ascending: boolean }) => { call.order.push([c, o.ascending]); return builder; },
        limit: (n: number) => { call.limit = n; return builder; },
        maybeSingle: async () => answer(),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject),
      };
      return builder;
    },
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args, eq: [], order: [] });
      return { data: answers.error ? null : answers.rpc ?? null, error: answers.error ? { message: answers.error } : null };
    },
  };
  return { service: service as unknown as SupabaseClient, calls };
}

describe('the reads', () => {
  it("reads the switch, off where it's missing", async () => {
    const on = fakeService({ rows: { is_on: true, changed_at: '2027-04-01T15:00:00Z' } });
    expect(await readOwnNumbersSwitch(on.service)).toEqual({ on: true, changedAt: '2027-04-01T15:00:00Z' });
    expect(on.calls[0]).toMatchObject({ table: 'books_switches', select: 'is_on, changed_at', eq: [['piece', 'own_numbers']] });
    expect(await readOwnNumbersSwitch(fakeService().service)).toEqual({ on: false, changedAt: null });
    expect(await readOwnNumbersSwitch(fakeService({ rows: { is_on: null } }).service)).toEqual({ on: false, changedAt: null });
    await expect(readOwnNumbersSwitch(fakeService({ error: 'denied' }).service)).rejects.toThrow("Couldn't read the switch: denied");
  });

  it('reads each kind in order', async () => {
    const rows = [
      { doc_type: 'invoice', prefix: 'INV', next_seq: 10004 },
      { doc_type: 'sales_order', prefix: 'SO', next_seq: '10001' },
      { doc_type: 'bill', prefix: 'B', next_seq: 1 },
    ];
    expect((await readSeries(fakeService({ rows }).service)).map((r) => r.doc_type)).toEqual(['sales_order', 'invoice']);
    await expect(readSeries(fakeService({ error: 'denied' }).service)).rejects.toThrow("Couldn't read the numbers: denied");
  });

  it('reads the numbers taken newest first, of one kind or all', async () => {
    const all = fakeService({ rows: [{ id: 'n1' }] });
    expect(await readNumbers(all.service, null)).toEqual([{ id: 'n1' }]);
    expect(all.calls[0]).toMatchObject({
      table: 'own_numbers', eq: [], order: [['reserved_at', false], ['id', false]], limit: 100,
      select: 'id, doc_type, number, reserved_at, reserved_by, status, settled_at, netsuite_id, netsuite_number, note, kept_own',
    });
    const some = fakeService({ rows: [] });
    await readNumbers(some.service, 'credit_memo');
    expect(some.calls[0].eq).toEqual([['doc_type', 'credit_memo']]);
    await expect(readNumbers(fakeService({ error: 'denied' }).service, null)).rejects.toThrow("Couldn't read the numbers taken: denied");
  });

  it('reads what was made in NetSuite from a day', async () => {
    const f = fakeService({ rpc: [{ netsuite_id: '1001' }] });
    expect(await readOutside(f.service, '2027-04-01')).toEqual([{ netsuite_id: '1001' }]);
    expect(f.calls[0]).toMatchObject({ fn: 'own_numbers_made_outside', args: { p_since: '2027-04-01', p_limit: 200 } });
    expect(await readOutside(fakeService().service, '2027-04-01')).toEqual([]);
    await expect(readOutside(fakeService({ error: 'denied' }).service, '2027-04-01')).rejects.toThrow("Couldn't read what was made in NetSuite: denied");
  });
});

describe('what Books → Own numbers shows', () => {
  const NAMES = new Map([['p-1', 'Pat Example']]);
  const UI = 'https://1234567_SB1.app.netsuite.com/app/accounting/transactions';

  it('shows each kind with its next number and who changed it last', () => {
    expect(seriesView({ doc_type: 'credit_memo', prefix: 'CM', next_seq: '10004', changed_by: 'p-1', changed_at: '2027-04-02T15:00:00Z' }, NAMES)).toEqual({
      type: 'credit_memo', many: 'Credit memos', prefix: 'CM', next: 10004, nextNumber: 'CM10004', changedAt: '2027-04-02T15:00:00Z', changedBy: 'Pat Example',
    });
    expect(seriesView({ doc_type: 'sales_order', prefix: 'SO', next_seq: 10001, changed_by: 'p-9', changed_at: null }, NAMES).changedBy).toBe('Someone');
    expect(seriesView({ doc_type: 'sales_order', prefix: 'SO', next_seq: 10001, changed_by: null, changed_at: null }, NAMES).changedBy).toBeNull();
  });

  it("shows each number taken with what became of it and NetSuite's page", () => {
    vi.stubEnv('NETSUITE_ACCOUNT_ID', '1234567-sb1');
    const row: NumberRow = {
      id: 'num-1', doc_type: 'invoice', number: 'INV10001', reserved_at: '2027-04-10T15:00:00Z', reserved_by: 'p-1', status: 'made',
      settled_at: '2027-04-10T15:00:02Z', netsuite_id: '9001', netsuite_number: 'INV10001', note: null, kept_own: false,
    };
    const now = new Date('2027-04-10T16:00:00Z');
    expect(numberView(row, now, NAMES)).toEqual({
      id: 'num-1', type: 'invoice', one: 'invoice', number: 'INV10001', at: '2027-04-10T15:00:00Z', by: 'Pat Example',
      standing: 'made', text: 'Made in NetSuite.', netsuiteNumber: 'INV10001', link: `${UI}/custinvc.nl?id=9001`,
    });
    const memo = numberView({ ...row, doc_type: 'credit_memo', number: 'CM10001', reserved_by: 'p-9', netsuite_id: '9002', netsuite_number: 'CM88' }, now, NAMES);
    expect(memo).toMatchObject({ one: 'credit memo', by: null, standing: 'kept_own', link: `${UI}/custcred.nl?id=9002` });
    expect(numberView({ ...row, status: 'refused', netsuite_id: null, netsuite_number: null, note: 'Invalid tranid.' }, now, NAMES))
      .toMatchObject({ standing: 'refused', link: null });
    vi.unstubAllEnvs();
  });

  it('shows a sales order or PO made in NetSuite instead, with its page', () => {
    vi.stubEnv('NETSUITE_ACCOUNT_ID', '1234567-sb1');
    expect(outsideView({
      netsuite_id: '2001', doc_type: 'purchase_order', tranid: 'PO2301', trandate: '2027-04-12T00:00:00.000Z', party: 'Ranger Design',
      created_by_name: 'Pat Example', told_at: '2027-04-13T11:00:00Z',
    })).toEqual({
      netsuiteId: '2001', type: 'purchase_order', one: 'PO', number: 'PO2301', date: '2027-04-12', party: 'Ranger Design', by: 'Pat Example',
      told: true, link: `${UI}/purchord.nl?id=2001`,
    });
    expect(outsideView({ netsuite_id: '1001', doc_type: 'sales_order', tranid: null, trandate: '2027-04-12', party: null, created_by_name: null }))
      .toMatchObject({ one: 'sales order', number: null, told: false, link: `${UI}/salesord.nl?id=1001` });
    vi.unstubAllEnvs();
  });
});

describe('the daily check', () => {
  const NOW = new Date('2027-04-15T12:00:00Z');
  const TO_TELL = {
    kept: [{ id: 'num-1', doc_type: 'invoice', number: 'INV10007', netsuite_id: '9001', netsuite_number: 'INV2703', reserved_at: '2027-04-10T15:00:00Z' }],
    outside: [{ netsuite_id: '1001', doc_type: 'sales_order', tranid: 'SO4412', trandate: '2027-04-12', party: 'Acme Plumbing', created_by_name: 'Pat Example' }],
  };

  /** books_switches answers `switchRow`, and the rpc `rpc`. */
  function service(switchRow: unknown, rpc?: unknown, rpcError?: string) {
    const calls: Array<[string, unknown]> = [];
    const s = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: switchRow, error: null }) }) }) }),
      rpc: async (fn: string, args: unknown) => {
        calls.push([fn, args]);
        return rpcError ? { data: null, error: { message: rpcError } } : { data: rpc ?? null, error: null };
      },
    };
    return { service: s as unknown as SupabaseClient, calls };
  }

  it("tells about nothing while FleetSuite's own numbers is off", async () => {
    const off = service({ is_on: false, changed_at: null }, TO_TELL);
    expect(await lookAtOwnNumbers(off.service, NOW)).toEqual([]);
    expect(off.calls).toEqual([]);
  });

  it("tells about numbers NetSuite didn't keep and what was made in NetSuite since it went on", async () => {
    const on = service({ is_on: true, changed_at: '2027-04-01T15:00:00Z' }, TO_TELL);
    expect(await lookAtOwnNumbers(on.service, NOW)).toEqual([
      { kind: 'kept', id: 'num-1', type: 'invoice', number: 'INV10007', netsuiteNumber: 'INV2703' },
      { kind: 'outside', netsuiteId: '1001', type: 'sales_order', tranid: 'SO4412', date: '2027-04-12', party: 'Acme Plumbing', by: 'Pat Example' },
    ]);
    expect(on.calls).toEqual([['own_numbers_to_tell', { p_since: '2027-04-01', p_limit: 200 }]]);
    expect(await lookAtOwnNumbers(service({ is_on: true }, null).service, NOW)).toEqual([]);
    await expect(lookAtOwnNumbers(service({ is_on: true }, null, 'denied').service, NOW))
      .rejects.toThrow("couldn't read the numbers to tell about (denied)");
  });

  it('marks what it told about', async () => {
    const s = service({ is_on: true });
    await markOwnNumbersTold(s.service, [
      { kind: 'kept', id: 'num-1', type: 'invoice', number: 'INV10007', netsuiteNumber: 'INV2703' },
      { kind: 'outside', netsuiteId: '1001', type: 'sales_order', tranid: 'SO4412', date: '2027-04-12', party: null, by: null },
      { kind: 'kept', id: 'num-2', type: 'credit_memo', number: 'CM10001', netsuiteNumber: 'CM88' },
    ]);
    expect(s.calls).toEqual([['own_numbers_mark_told', { p_number_ids: ['num-1', 'num-2'], p_outside_ids: ['1001'] }]]);
    await expect(markOwnNumbersTold(service({ is_on: true }, null, 'denied').service, []))
      .rejects.toThrow("couldn't mark the numbers told about (denied)");
  });
});
