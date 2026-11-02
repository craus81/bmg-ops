// Books → Change history's words (src/lib/books/money-changes.ts): each
// table's records named, each value in the page's words, a locked column
// never shown, how a change was made in a line, a row's key from a link, and
// what the daily check reads of the changes made outside FleetSuite. The
// history itself, its route and its reads are in money-changes-sql.test.ts.
// Made-up data.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BACKUP_TABLES } from './backups';
import {
  AREAS, OWNER_AREA, OWNER_TABLES, TABLES, centralTime, columnWords, howWords, isOutside, lookAtOutsideChanges, markOutsideChangesTold,
  parseRowKey, peopleIn, readCompanyCodes, rowWords, shownChange, shownValue, tablesIn, type ChangeRecord, type WordsContext,
} from './money-changes';

const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';
const JESSIE = '5d0c3a2e-8b1f-4c6d-a7e9-2f4b6c8d0e13';
const STRANGER = '9e8d7c6b-5a49-4382-9172-6a5b4c3d2e1f';
const BMG_ID = 'c1000000-0000-4000-8000-000000000001';

const ctx: WordsContext = {
  names: new Map([[CRAIG, 'Craig George'], [JESSIE, 'Jessie Jones']]),
  companies: new Map([[BMG_ID, 'BMG']]),
};

const change = (over: Partial<ChangeRecord> = {}): ChangeRecord => ({
  id: 41, at: '2026-11-02T22:00:00.000Z', table_name: 'books_switches', op: 'update', row_key: { piece: 'credit_memos' },
  row_name: { piece: 'credit_memos' }, changed: { is_on: { from: true, to: false } }, via: 'server', actor: CRAIG, db_login: 'authenticator',
  db_app: null, migration: null, tx: 9001, told_at: null, ...over,
});

describe('the tables the history covers', () => {
  it("is every table of the books the backups copy but the history itself, each in one of the page's kinds", () => {
    expect(Object.keys(TABLES).sort()).toEqual(BACKUP_TABLES.filter((t) => t !== 'books_money_changes').sort());
    const areas = AREAS.map((a) => a.key);
    for (const [table, info] of Object.entries(TABLES)) expect(areas, table).toContain(info.area);
    // Every kind holds something, and the kinds together hold every table once.
    for (const area of areas) expect(tablesIn(area).length, area).toBeGreaterThan(0);
    expect(areas.flatMap((a) => tablesIn(a)).sort()).toEqual(Object.keys(TABLES).sort());
  });

  it("keeps the vendors' bank numbers and the ACH setups and files apart, for super admins", () => {
    expect(OWNER_AREA).toBe('bank');
    expect([...OWNER_TABLES].sort()).toEqual(['vendor_ach_file_payments', 'vendor_ach_files', 'vendor_ach_setups', 'vendor_bank_accounts']);
  });

  it('says a change made straight in the database or from a browser was made outside FleetSuite', () => {
    expect(isOutside('database')).toBe(true);
    expect(isOutside('screen')).toBe(true);
    expect(isOutside('server')).toBe(false);
    expect(isOutside('migration')).toBe(false);
  });
});

describe('columnWords', () => {
  it("names an ACH setup's columns as the Pay vendors page does, and the locked ones by what they hold", () => {
    expect(columnWords('vendor_ach_setups', 'entry_description')).toBe('The description vendors see');
    expect(columnWords('vendor_ach_setups', 'destination')).toBe("First Bank's routing number");
    expect(columnWords('vendor_ach_setups', 'offset_locked')).toBe("BMG's account number");
    expect(columnWords('vendor_ach_setups', 'offset_last4')).toBe("BMG's account ends");
    expect(columnWords('vendor_bank_accounts', 'account_locked')).toBe('Account number');
    expect(columnWords('vendor_bank_accounts', 'confirm_seal')).toBe('Record of the call-back');
    expect(columnWords('vendor_ach_files', 'file_locked')).toBe('The file');
  });

  it("reads any other column's name plainly, its _cents left off", () => {
    expect(columnWords('books_switches', 'is_on')).toBe('On');
    expect(columnWords('vendor_payment_runs', 'total_cents')).toBe('Total');
    expect(columnWords('received_payments', 'netsuite_payment_id')).toBe('NetSuite payment ID');
    expect(columnWords('vendor_checks', 'po_number')).toBe('PO number');
    expect(columnWords('gl_companies', 'books_live_from')).toBe('Books live from');
    expect(columnWords('gl_periods', 'company_id')).toBe('Company');
    // Not an ACH setup: its words are only for that table's columns.
    expect(columnWords('vendor_payment_runs', 'destination')).toBe('Destination');
  });
});

describe('shownValue', () => {
  it('shows empty, yes and no, and money in dollars, whole cents or not', () => {
    expect(shownValue('note', null, ctx)).toBe('(empty)');
    expect(shownValue('note', undefined, ctx)).toBe('(empty)');
    expect(shownValue('note', '', ctx)).toBe('(empty)');
    expect(shownValue('is_on', true, ctx)).toBe('Yes');
    expect(shownValue('is_on', false, ctx)).toBe('No');
    expect(shownValue('total_cents', 123456, ctx)).toBe('$1,234.56');
    expect(shownValue('amount_cents', -500, ctx)).toBe('-$5.00');
    expect(shownValue('total', 12.5, ctx)).toBe('$12.50');
    expect(shownValue('debit', 0.1 + 0.2, ctx)).toBe('$0.30');
    expect(shownValue('rate_pct', 8.475, ctx)).toBe('8.475%');
    expect(shownValue('next_seq', 50001, ctx)).toBe('50001');
  });

  it("names people by who they are, someone FleetSuite doesn't know as Someone, and a company by its code", () => {
    expect(shownValue('approved_by', CRAIG, ctx)).toBe('Craig George');
    expect(shownValue('changed_by', STRANGER, ctx)).toBe('Someone');
    expect(shownValue('actor_id', JESSIE, ctx)).toBe('Jessie Jones');
    expect(shownValue('user_id', JESSIE, ctx)).toBe('Jessie Jones');
    // An ID in a column that isn't a person's is only an ID.
    expect(shownValue('run_id', CRAIG, ctx)).toBe(CRAIG);
    expect(shownValue('company_id', BMG_ID, ctx)).toBe('BMG');
    expect(shownValue('company_id', STRANGER, ctx)).toBe(STRANGER);
  });

  it('shows a day, a month and a moment in words, the moment in Central time', () => {
    expect(shownValue('pay_date', '2026-11-06', ctx)).toBe('Nov 6, 2026');
    expect(shownValue('month', '2026-10-01', ctx)).toBe('October 2026');
    expect(shownValue('period_start', '2026-09-01', ctx)).toBe('September 2026');
    expect(shownValue('approved_at', '2026-11-02T22:00:00+00:00', ctx)).toBe('Nov 2, 2026, 4:00 PM Central');
    // Before the clocks went back on November 1, 2026.
    expect(shownValue('approved_at', '2026-10-30T22:00:00+00:00', ctx)).toBe('Oct 30, 2026, 5:00 PM Central');
    expect(centralTime('2026-11-02T22:00:00.000Z')).toBe('Nov 2, 2026, 4:00 PM Central');
    expect(shownValue('memo', '2026-11-02 is when', ctx)).toBe('2026-11-02 is when');
  });

  it('lists a few plain values, counts the rest, and cuts anything long', () => {
    expect(shownValue('bill_ids', ['7001', '7003'], ctx)).toBe('7001, 7003');
    expect(shownValue('bill_ids', [], ctx)).toBe('(none)');
    expect(shownValue('bill_ids', ['1', '2', '3', '4', '5', '6', '7'], ctx)).toBe('7 items');
    expect(shownValue('bills', [{ number: 'B-1', cents: 100 }], ctx)).toBe('1 item');
    expect(shownValue('outstanding', { checks: 2 }, ctx)).toBe('{"checks":2}');
    const long = shownValue('memo', 'x'.repeat(400), ctx);
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('rowWords', () => {
  it("names a record by its own columns, each in words", () => {
    expect(rowWords('books_switches', { piece: 'credit_memos' }, { piece: 'credit_memos' }, ctx)).toBe('Credit memos');
    expect(rowWords('own_number_series', { doc_type: 'sales_order' }, { doc_type: 'sales_order' }, ctx)).toBe('Sales orders');
    expect(rowWords('vendor_payment_run_payments', { id: 'x' }, { vendor_name: 'Gateway Steel', method: 'ach', total_cents: 245000 }, ctx))
      .toBe('Gateway Steel · By ACH · $2,450.00');
    expect(rowWords('vendor_bank_accounts', { id: 'x' }, { vendor_name: 'Acme Supply', routing_number: '081000210', account_last4: '6789' }, ctx))
      .toBe('Acme Supply · routing 081000210 · account ending 6789');
    expect(rowWords('gl_periods', { id: 'x' }, { company_id: BMG_ID, period_start: '2026-09-01' }, ctx)).toBe('BMG · September 2026');
    expect(rowWords('stock_counts', { id: 'x' }, { number: 12, location_name: "O'Fallon" }, ctx)).toBe("count 12 · O'Fallon");
    expect(rowWords('typed_journal_entries', { id: 'x' }, { company: 'BMG', journal: 'cpa_adjustments', tran_date: '2026-12-31', total_cents: 50000 }, ctx))
      .toBe('BMG · CPA adjustments · Dec 31, 2026 · $500.00');
    expect(rowWords('detail_changes', { id: 'x' }, { record_type: 'vendor', name: 'Acme Supply' }, ctx)).toBe('Vendor · Acme Supply');
    expect(rowWords('vendor_ach_setups', { bank_account_netsuite_id: '211' }, { company: 'BMG', bank_account_netsuite_id: '211' }, ctx))
      .toBe('BMG · bank account 211');
    expect(rowWords('gl_year_closes', { id: 'x' }, { company_id: BMG_ID, year: 2026 }, ctx)).toBe('BMG · 2026');
  });

  it('names a record by its key when it has nothing else, an ID cut short', () => {
    expect(rowWords('gl_lines', { id: 'a1b2c3d4-0000-4000-8000-000000000001' }, {}, ctx)).toBe('ID a1b2c3d4');
    expect(rowWords('gl_netsuite_stock_counts', { item_id: '9001', location_id: '11' }, {}, ctx)).toBe('Item ID 9001 · Location ID 11');
    // Its naming columns all empty.
    expect(rowWords('vendor_checks', { id: 7 }, { company: null, check_number: '' }, ctx)).toBe('ID 7');
    expect(rowWords('no_such_table', { id: 7 }, { name: 'Ignored' }, ctx)).toBe('ID 7');
  });
});

describe('howWords', () => {
  it('says how a change was made, and by whom when FleetSuite knows', () => {
    const row = { db_login: 'postgres', db_app: null, migration: null };
    expect(howWords({ ...row, via: 'server' }, 'Craig George')).toBe('In FleetSuite, by Craig George');
    expect(howWords({ ...row, via: 'server' }, null)).toBe('In FleetSuite');
    expect(howWords({ ...row, via: 'migration', migration: '508-books-money-changes.sql' }, null))
      .toBe('By the FleetSuite update 508-books-money-changes.sql');
    expect(howWords({ ...row, via: 'migration' }, null)).toBe('By the FleetSuite update that ran then');
    expect(howWords({ ...row, via: 'screen' }, 'Jessie Jones')).toBe("From a browser signed in as Jessie Jones, around FleetSuite's own screens");
    expect(howWords({ ...row, via: 'screen' }, null)).toBe("From a browser signed in to the database, around FleetSuite's own screens");
    expect(howWords({ ...row, via: 'database', db_app: 'Supabase Studio' }, null)).toBe('Straight in the database with Supabase Studio, signed in as postgres');
    expect(howWords({ ...row, via: 'database' }, null)).toBe('Straight in the database, signed in as postgres');
  });
});

describe('shownChange', () => {
  it('shows a change in words: which record, how and by whom, and each column from what to what, in order', () => {
    const shown = shownChange(change({
      changed: { is_on: { from: true, to: false }, changed_by: { from: JESSIE, to: CRAIG }, changed_at: { from: null, to: '2026-11-02T22:00:00+00:00' } },
    }), ctx);
    expect(shown).toEqual({
      id: 41, at: '2026-11-02T22:00:00.000Z', table: 'books_switches', what: 'Switch', key: { piece: 'credit_memos' }, name: 'Credit memos',
      op: 'update', via: 'server', outside: false, who: 'Craig George', how: 'In FleetSuite, by Craig George', toldAt: null,
      columns: [
        { column: 'changed_at', label: 'Changed at', from: '(empty)', to: 'Nov 2, 2026, 4:00 PM Central', hidden: false },
        { column: 'changed_by', label: 'Changed by', from: 'Jessie Jones', to: 'Craig George', hidden: false },
        { column: 'is_on', label: 'On', from: 'Yes', to: 'No', hidden: false },
      ],
    });
  });

  it('leaves out what a column was before a row was added and after one was taken away', () => {
    const added = shownChange(change({ op: 'insert', changed: { note: { to: 'Made-up rate' } } }), ctx);
    expect(added.columns).toEqual([{ column: 'note', label: 'Note', from: null, to: 'Made-up rate', hidden: false }]);
    const gone = shownChange(change({ op: 'delete', changed: { note: { from: 'Made-up rate' } } }), ctx);
    expect(gone.columns).toEqual([{ column: 'note', label: 'Note', from: 'Made-up rate', to: null, hidden: false }]);
  });

  it('says a locked column was set, changed or emptied, never what it holds', () => {
    const shown = shownChange(change({
      table_name: 'vendor_bank_accounts',
      changed: {
        account_locked: { hidden: true, from: null },
        confirm_seal: { hidden: true, to: null },
        offset_locked: { hidden: true },
        // Even were a value ever there, a hidden column shows none.
        file_locked: { hidden: true, from: 'v1.secret', to: 'v1.other' },
      },
    }), ctx);
    expect(shown.columns).toEqual([
      { column: 'account_locked', label: 'Account number', from: '(empty)', to: '(not shown)', hidden: true },
      { column: 'confirm_seal', label: 'Record of the call-back', from: '(not shown)', to: '(empty)', hidden: true },
      { column: 'file_locked', label: 'The file', from: '(not shown)', to: '(not shown)', hidden: true },
      { column: 'offset_locked', label: "BMG's account number", from: '(not shown)', to: '(not shown)', hidden: true },
    ]);
    const added = shownChange(change({ op: 'insert', table_name: 'vendor_bank_accounts', changed: { account_locked: { hidden: true } } }), ctx);
    expect(added.columns[0]).toMatchObject({ from: null, to: '(not shown)' });
    expect(JSON.stringify(shown)).not.toContain('secret');
  });

  it("says outside, and who, for a change made around FleetSuite, and someone FleetSuite doesn't know as Someone", () => {
    expect(shownChange(change({ via: 'screen', actor: STRANGER }), ctx)).toMatchObject({
      outside: true, who: 'Someone', how: "From a browser signed in as Someone, around FleetSuite's own screens",
    });
    expect(shownChange(change({ via: 'database', actor: null, db_login: 'postgres', told_at: '2026-11-03T09:58:00Z' }), ctx)).toMatchObject({
      outside: true, who: null, toldAt: '2026-11-03T09:58:00Z',
    });
    // A table FleetSuite has since dropped still shows, by its name.
    expect(shownChange(change({ table_name: 'old_table', row_key: { id: 3 }, row_name: {} }), ctx)).toMatchObject({ what: 'old_table', name: 'ID 3' });
  });
});

describe('peopleIn', () => {
  it('finds who made each change and the people its columns name, once each', () => {
    expect(peopleIn([
      change({ actor: CRAIG, changed: { approved_by: { from: null, to: JESSIE }, user_id: { to: STRANGER }, run_id: { to: BMG_ID } } }),
      change({ actor: null, changed: { changed_by: { from: CRAIG, to: 'not-an-id' } } }),
    ]).sort()).toEqual([CRAIG, JESSIE, STRANGER].sort());
  });
});

describe('parseRowKey', () => {
  it("takes a record's key as a link gives it", () => {
    expect(parseRowKey('{"piece":"credit_memos"}')).toEqual({ piece: 'credit_memos' });
    expect(parseRowKey('{"company":"1084","account":"1000","month":"2026-01-01"}')).toEqual({ company: '1084', account: '1000', month: '2026-01-01' });
    expect(parseRowKey('{"id":7,"live":true}')).toEqual({ id: 7, live: true });
  });

  it("takes nothing that isn't a few plain values under column names", () => {
    for (const text of [
      null, '', 'credit_memos', '[1]', '{}', '"x"', '{"piece":["a"]}', '{"piece":{"a":1}}', '{"piece":null}', '{"Piece":"x"}',
      '{"a b":"x"}', '{"a":1,"b":2,"c":3,"d":4,"e":5}', `{"note":"${'x'.repeat(500)}"}`,
    ]) {
      expect(parseRowKey(text), String(text)).toBeNull();
    }
  });
});

describe('what the daily check reads', () => {
  const answering = (data: unknown, error: { message: string } | null = null) => {
    const calls: Array<[string, unknown]> = [];
    const service = { rpc: async (fn: string, args?: unknown) => { calls.push([fn, args]); return { data, error }; } } as unknown as SupabaseClient;
    return { service, calls };
  };

  it('reads the changes made outside FleetSuite nobody has been told about, or none', async () => {
    const { service, calls } = answering({
      changes: 3, through: 812, snapshot: '940:942:940', first_at: '2026-11-02T20:00:00+00:00', last_at: '2026-11-02T21:30:00+00:00',
      tables: [{ table: 'gl_periods', changes: 2 }, { table: 'gl_lines', changes: 1 }],
      ways: [{ via: 'database', login: 'postgres', app: 'Supabase Studio', changes: 2 }, { via: 'screen', login: 'authenticator', changes: 1 }],
    });
    expect(await lookAtOutsideChanges(service)).toEqual({
      changes: 3, through: 812, snapshot: '940:942:940', firstAt: '2026-11-02T20:00:00+00:00', lastAt: '2026-11-02T21:30:00+00:00',
      tables: [{ table: 'gl_periods', changes: 2 }, { table: 'gl_lines', changes: 1 }],
      ways: [{ via: 'database', login: 'postgres', app: 'Supabase Studio', changes: 2 }, { via: 'screen', login: 'authenticator', app: null, changes: 1 }],
    });
    expect(calls).toEqual([['books_outside_changes', undefined]]);
    expect(await lookAtOutsideChanges(answering({ changes: 0, through: null, first_at: null, last_at: null, tables: [], ways: [] }).service)).toBeNull();
    expect(await lookAtOutsideChanges(answering(null).service)).toBeNull();
    expect(await lookAtOutsideChanges(answering({
      changes: 0, through: 812, snapshot: '940:942:940', first_at: '2026-11-02T20:00:00+00:00', last_at: '2026-11-02T21:30:00+00:00', tables: [], ways: [],
    }).service)).toBeNull();
  });

  it("says it couldn't read them, or couldn't note them told", async () => {
    await expect(lookAtOutsideChanges(answering(null, { message: 'timeout' }).service)).rejects.toThrow("couldn't read the change history (timeout)");
    const { service, calls } = answering({ told: 3 });
    expect(await markOutsideChangesTold(service, { through: 812, snapshot: '940:942:940' })).toBe(3);
    expect(calls).toEqual([['books_outside_changes_told', { p: { through: 812, snapshot: '940:942:940' } }]]);
    await expect(markOutsideChangesTold(answering(null, { message: 'timeout' }).service, { through: 812, snapshot: '940:942:940' }))
      .rejects.toThrow("couldn't note the changes told about (timeout)");
  });

  it("names a company by its ID when the companies can't be read", async () => {
    const service = { from: () => ({ select: async () => ({ data: null, error: { message: 'down' } }) }) } as unknown as SupabaseClient;
    expect(await readCompanyCodes(service)).toEqual(new Map());
  });
});
