// A purchase order's other lines (migration 515): the vendor PO sync keeps each PO's expense lines (freight, say)
// with the bills NetSuite shows each on, for the POs NetSuite changed and, a hundred a run, the copies never read.
// What NetSuite won't say is kept as not known, never as none. NetSuite and the database are stand-ins. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const refused = (what: string) => Object.assign(new Error(`SuiteQL: ${what}`), { status: 400 });
  const state = {
    headers: [] as Record<string, any>[],
    /** NetSuite's expense line rows, as SuiteQL gives them. */
    expenseRows: [] as Record<string, any>[],
    /** What the expense line read refuses: 'name' (the account's name), 'closed', 'all', or fails outright ('down'). */
    expenseRefuses: new Set<string>(),
    /** Link rows, as SuiteQL gives them (line_id dropped when not asked). */
    linkRows: [] as Record<string, any>[],
    /** Link reads refused: '<table>:<lines|po>'; 'down' fails outright. */
    linkRefuses: new Set<string>(),
    /** Copies whose other lines were never read, as the copy lists them, newest first. */
    unread: [] as Array<{ id: string; netsuite_id: string }>,
    unreadError: null as { message: string } | null,
    unreadLimit: 0,
    puts: [] as any[][],
    putError: null as { message: string } | null,
    /** Copies marked not read again. */
    marks: [] as string[][],
    markError: null as { message: string } | null,
  };
  const idsIn = (sql: string, col: string) => {
    const m = sql.match(new RegExp(`${col} IN \\(([^)]*)\\)`));
    return new Set((m?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  };
  const suiteql = vi.fn(async (sql: string) => {
    if (/tl\.expenseaccount AS account_id/.test(sql)) {
      if (state.expenseRefuses.has('down')) throw new Error('fetch failed');
      if (state.expenseRefuses.has('all')) throw refused('Invalid search query');
      if (state.expenseRefuses.has('name') && /BUILTIN\.DF/.test(sql)) throw refused('Invalid search query: BUILTIN.DF');
      if (state.expenseRefuses.has('closed') && /isclosed/.test(sql)) throw refused('Invalid search query: isclosed');
      const ids = idsIn(sql, 'tl.transaction');
      return state.expenseRows
        .filter((r) => ids.has(String(r.po_id)))
        .map((r) => {
          const row = { ...r };
          if (!/BUILTIN\.DF/.test(sql)) delete row.account_name;
          if (!/isclosed/.test(sql)) delete row.isclosed;
          return row;
        });
    }
    const link = sql.match(/FROM (nexttransactionlinelink|previoustransactionlinelink) l/);
    if (link) {
      const lines = /previousline/.test(sql);
      if (state.linkRefuses.has('down')) throw new Error('fetch failed');
      if (state.linkRefuses.has(`${link[1]}:${lines ? 'lines' : 'po'}`)) throw refused(`Invalid search query: ${link[1]}`);
      const ids = idsIn(sql, 'l.previousdoc');
      return state.linkRows
        .filter((r) => ids.has(String(r.po_id)))
        .map((r) => (lines ? { ...r } : { po_id: r.po_id, bill_id: r.bill_id }));
    }
    if (/tl\.subsidiary AS subsidiary_id/.test(sql)) return [];
    if (/FROM transactionline tl/.test(sql)) return [];
    if (/t\.type = 'PurchOrd'/.test(sql)) return state.headers;
    throw new Error(`stand-in can't answer ${sql}`);
  });
  const service: any = {
    from(table: string) {
      if (table === 'sync_state') {
        const q: any = { select: () => q, eq: () => q, single: async () => ({ data: { last_synced_at: '2026-11-02T20:00:00Z' }, error: null }) };
        return q;
      }
      if (table === 'netsuite_vendor_po_lines') {
        const q: any = {
          delete: () => q, eq: () => q,
          insert: async () => ({ error: null }),
          then: (done: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(done),
        };
        return q;
      }
      if (table !== 'netsuite_vendor_pos') throw new Error(`stand-in has no ${table}`);
      return {
        select() {
          const q: any = {
            is: (col: string, val: unknown) => {
              expect([col, val]).toEqual(['expense_lines_read_at', null]);
              return q;
            },
            order: () => q,
            limit: async (n: number) => {
              state.unreadLimit = n;
              return state.unreadError ? { data: null, error: state.unreadError } : { data: state.unread, error: null };
            },
          };
          return q;
        },
        update(patch: Record<string, unknown>) {
          expect(patch).toEqual({ expense_lines_read_at: null });
          return {
            in: async (col: string, ids: string[]) => {
              expect(col).toBe('id');
              if (!state.markError) state.marks.push(ids);
              return { error: state.markError };
            },
          };
        },
        upsert(row: Record<string, any>) {
          const q: any = { select: () => q, single: async () => ({ data: { id: `copy-${row.netsuite_id}` }, error: null }) };
          return q;
        },
      };
    },
    async rpc(fn: string, args: { p_pos: any[] }) {
      expect(fn).toBe('vendor_po_expense_lines_put');
      if (state.putError) return { data: null, error: state.putError };
      state.puts.push(args.p_pos);
      return { data: args.p_pos.reduce((n: number, p: any) => n + p.lines.length, 0), error: null };
    },
  };
  return { state, suiteql, service, heartbeat: vi.fn(async (..._args: unknown[]) => ({ ok: true })) };
});

vi.mock('@/lib/netsuite', () => ({
  suiteqlQueryAll: h.suiteql,
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
}));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: h.heartbeat }));

import {
  EXPENSE_BACKFILL, EXPENSE_BUDGET_MS, expenseLinesByPo, expenseLinesQuery, poBillLinksQuery, poBillsOf,
  syncPoExpenseLines, syncVendorPos, withBills, type ExpenseLineRow,
} from './vendor-po-sync';

const service = h.service;
const sqls = () => h.suiteql.mock.calls.map((c) => c[0] as string);
const expenseReads = () => sqls().filter((s) => /tl\.expenseaccount AS account_id/.test(s));
const linkReads = () => sqls().filter((s) => /transactionlinelink l/.test(s));
const target = (n: string) => ({ netsuiteId: n, copyId: `copy-${n}` });
const freight = (po: string, line: string, over: Record<string, any> = {}) => ({
  po_id: po, line_id: line, account_id: '612', account_name: '5100 Freight In', isclosed: 'F', memo: 'Freight', amount: '45.50', own_amount: '45.50', ...over,
});

beforeEach(() => {
  Object.assign(h.state, {
    headers: [], expenseRows: [], expenseRefuses: new Set(), linkRows: [], linkRefuses: new Set(), unread: [],
    unreadError: null, unreadLimit: 0, puts: [], putError: null, marks: [], markError: null,
  });
  h.suiteql.mockClear();
  h.heartbeat.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('expenseLinesQuery', () => {
  it("asks for each PO's lines, but the main and tax lines, with the item and the account always", () => {
    for (const level of [0, 1, 2] as const) {
      const sql = expenseLinesQuery(['7001', '7002'], level);
      expect(sql).toMatch(/tl\.transaction IN \(7001, 7002\)/);
      // The item lines come too, for which way round NetSuite signs the PO.
      expect(sql).toMatch(/tl\.item AS item_id/);
      expect(sql).not.toMatch(/tl\.item IS/);
      expect(sql).toMatch(/tl\.mainline = 'F'/);
      expect(sql).toMatch(/tl\.taxline = 'F'/);
      expect(sql).toMatch(/tl\.expenseaccount AS account_id/);
      expect(sql).toMatch(/tl\.foreignamount AS own_amount/);
      expect(sql).toMatch(/tl\.netamount AS amount/);
      expect(sql).toMatch(/ORDER BY tl\.transaction, tl\.id/);
    }
  });

  it("asks for the account's name and whether it's closed, then whether it's closed, then neither", () => {
    expect(expenseLinesQuery(['7001'], 0)).toMatch(/BUILTIN\.DF\(tl\.expenseaccount\) AS account_name, tl\.isclosed,/);
    expect(expenseLinesQuery(['7001'], 1)).not.toMatch(/BUILTIN\.DF/);
    expect(expenseLinesQuery(['7001'], 1)).toMatch(/tl\.isclosed,/);
    expect(expenseLinesQuery(['7001'], 2)).not.toMatch(/BUILTIN\.DF|isclosed/);
  });
});

describe('poBillLinksQuery', () => {
  it("asks a link table for the bills that came from the POs, and the PO line each is on only when asked", () => {
    const sql = poBillLinksQuery('previoustransactionlinelink', ['7001', '7002'], true);
    expect(sql).toMatch(/FROM previoustransactionlinelink l/);
    expect(sql).toMatch(/JOIN transaction t ON t\.id = l\.nextdoc/);
    expect(sql).toMatch(/l\.previousdoc IN \(7001, 7002\)/);
    expect(sql).toMatch(/t\.type = 'VendBill'/);
    expect(sql).toMatch(/l\.previousdoc AS po_id, l\.previousline AS line_id, l\.nextdoc AS bill_id/);
    expect(poBillLinksQuery('nexttransactionlinelink', ['7001'], false)).toMatch(/SELECT l\.previousdoc AS po_id, l\.nextdoc AS bill_id/);
    expect(poBillLinksQuery('nexttransactionlinelink', ['7001'], false)).not.toMatch(/previousline/);
  });
});

describe('expenseLinesByPo', () => {
  it("takes each PO's lines in line order, the PO's own amount over the net amount, with nothing known of their bills", () => {
    const got = expenseLinesByPo([
      freight('7001', '4', { account_id: '613', account_name: ' Fuel Surcharge ', memo: ' ', amount: '12', own_amount: null, isclosed: 'T' }),
      freight('7001', '3', { amount: '40.00', own_amount: '45.50' }),
      freight('7002', '2', { account_id: 'Freight', account_name: null, isclosed: true }),
    ]);
    expect([...got.keys()]).toEqual(['7001', '7002']);
    expect(got.get('7001')).toEqual([
      { line_id: '3', account_netsuite_id: '612', account_name: '5100 Freight In', memo: 'Freight', amount: '45.50', closed: false, billed_by: null },
      { line_id: '4', account_netsuite_id: '613', account_name: 'Fuel Surcharge', memo: null, amount: '12.00', closed: true, billed_by: null },
    ]);
    expect(got.get('7002')).toEqual([
      { line_id: '2', account_netsuite_id: null, account_name: null, memo: 'Freight', amount: '45.50', closed: true, billed_by: null },
    ]);
  });

  it("turns a PO's amounts the right way round together, whichever way NetSuite signs them", () => {
    const got = expenseLinesByPo([
      freight('7001', '3', { own_amount: '-45.50' }),
      freight('7001', '4', { own_amount: '10.00' }),
      freight('7002', '3', { own_amount: '45.50' }),
      freight('7002', '4', { own_amount: '-10' }),
      freight('7003', '1', { own_amount: '0', amount: '0' }),
    ]);
    expect(got.get('7001')!.map((l) => l.amount)).toEqual(['45.50', '-10.00']);
    expect(got.get('7002')!.map((l) => l.amount)).toEqual(['45.50', '-10.00']);
    expect(got.get('7003')!.map((l) => l.amount)).toEqual(['0.00']);
  });

  it("goes by the item lines too, so a discount on the Expenses tab stays one, and keeps none of them", () => {
    const item = (po: string, line: string, amount: string) => ({ po_id: po, line_id: line, item_id: '5501', account_id: '130', memo: 'Rack', amount, own_amount: amount });
    const got = expenseLinesByPo([
      item('7001', '1', '250.00'),
      freight('7001', '2', { memo: 'Vendor discount', own_amount: '-10' }),
      item('7002', '1', '-250.00'),
      freight('7002', '2', { own_amount: '-45.50' }),
      item('7003', '1', '80'),
    ]);
    expect(got.get('7001')!.map((l) => [l.line_id, l.amount])).toEqual([['2', '-10.00']]);
    expect(got.get('7002')!.map((l) => [l.line_id, l.amount])).toEqual([['2', '45.50']]);
    // Item lines only: no other lines.
    expect(got.has('7003')).toBe(false);
  });

  it("keeps an amount it can't read as not known, and leaves out a row without ids it can read", () => {
    const got = expenseLinesByPo([
      freight('7001', '3', { own_amount: 'n/a', amount: '' }),
      freight('7001', null as any),
      freight('7001; DROP', '1'),
      null,
      freight('7001', '5', { isclosed: undefined }),
    ]);
    expect(got.get('7001')!.map((l) => [l.line_id, l.amount, l.closed])).toEqual([['3', null, false], ['5', '45.50', null]]);
    expect(got.size).toBe(1);
  });
});

describe('poBillsOf and withBills', () => {
  const lines: ExpenseLineRow[] = [
    { line_id: '3', account_netsuite_id: '612', account_name: null, memo: 'Freight', amount: '45.50', closed: false, billed_by: null },
    { line_id: '4', account_netsuite_id: '613', account_name: null, memo: 'Fuel', amount: '12.00', closed: false, billed_by: null },
  ];

  it("gives each line the bills linked to it, and none when no bill came from the PO", () => {
    const bills = poBillsOf([
      { po_id: '7001', line_id: '3', bill_id: '8802' },
      { po_id: '7001', line_id: '3', bill_id: '8801' },
      { po_id: '7001', line_id: '1', bill_id: '8801' },
      { po_id: '7001', line_id: '3', bill_id: '8801' },
      { po_id: '7009', line_id: 'x', bill_id: '8803' },
      { po_id: null, line_id: '3', bill_id: '8804' },
      { po_id: '7001', line_id: '4', bill_id: 'B-1' },
    ], true);
    expect(withBills('7001', lines, bills).map((l) => l.billed_by)).toEqual([['8801', '8802'], null]);
    expect(withBills('7002', lines, bills).map((l) => l.billed_by)).toEqual([[], []]);
    // The bill on a line it couldn't read still came from the PO.
    expect(withBills('7009', lines, bills).map((l) => l.billed_by)).toEqual([null, null]);
  });

  it("from bills by PO alone, knows only a PO no bill came from", () => {
    const bills = poBillsOf([{ po_id: '7001', bill_id: '8801' }], false);
    expect(bills.byLine).toBeNull();
    expect(withBills('7001', lines, bills).map((l) => l.billed_by)).toEqual([null, null]);
    expect(withBills('7002', lines, bills).map((l) => l.billed_by)).toEqual([[], []]);
  });

  it("knows nothing of the bills when NetSuite wouldn't say", () => {
    expect(withBills('7002', lines, null).map((l) => l.billed_by)).toEqual([null, null]);
  });
});

describe('syncPoExpenseLines', () => {
  it("reads the changed POs, then the copies never read, newest first, and keeps each PO's lines with its bills", async () => {
    h.state.unread = [{ id: 'copy-7001', netsuite_id: '7001' }, { id: 'copy-6990', netsuite_id: '6990' }, { id: 'copy-bad', netsuite_id: 'PO-1' }];
    h.state.expenseRows = [freight('7001', '3'), freight('6990', '2', { own_amount: '20' }), freight('7002', '5')];
    h.state.linkRows = [{ po_id: '6990', line_id: '2', bill_id: '8801' }, { po_id: '7002', line_id: '1', bill_id: '8802' }];
    const result = await syncPoExpenseLines(service, [target('7001'), target('7002')]);
    expect(result).toEqual({ pos: 3, lines: 3, unread: 0, billsUnknown: 0 });
    expect(h.state.unreadLimit).toBe(EXPENSE_BACKFILL + 2);
    expect(expenseReads()).toHaveLength(1);
    expect(expenseReads()[0]).toMatch(/IN \(7001, 7002, 6990\)/);
    // Only the POs with other lines are asked about bills, by line, in the first table.
    expect(linkReads()).toHaveLength(1);
    expect(linkReads()[0]).toMatch(/FROM nexttransactionlinelink l[\s\S]*previousdoc IN \(7001, 6990, 7002\)/);
    expect(h.state.puts).toEqual([[
      { po_id: 'copy-7001', lines: [{ line_id: '3', account_netsuite_id: '612', account_name: '5100 Freight In', memo: 'Freight', amount: '45.50', closed: false, billed_by: [] }] },
      // A bill came from 7002, but not on its line 5: not known.
      { po_id: 'copy-7002', lines: [{ line_id: '5', account_netsuite_id: '612', account_name: '5100 Freight In', memo: 'Freight', amount: '45.50', closed: false, billed_by: null }] },
      { po_id: 'copy-6990', lines: [{ line_id: '2', account_netsuite_id: '612', account_name: '5100 Freight In', memo: 'Freight', amount: '20.00', closed: false, billed_by: ['8801'] }] },
    ]]);
    expect(h.state.marks).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('reads a hundred copies never read a run, besides the changed POs, a chunk of fifty at a time', async () => {
    h.state.unread = Array.from({ length: EXPENSE_BACKFILL + 30 }, (_, i) => ({ id: `copy-${6000 + i}`, netsuite_id: String(6000 + i) }));
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(result.pos).toBe(EXPENSE_BACKFILL + 1);
    expect(h.state.puts.map((p) => p.length)).toEqual([50, 50, 1]);
    expect(h.state.puts.flat().map((p) => p.po_id).slice(0, 2)).toEqual(['copy-7001', 'copy-6000']);
    // No other lines anywhere: nothing to ask about bills.
    expect(linkReads()).toEqual([]);
  });

  it("asks without the account's name, then without whether a line is closed, and keeps asking that way", async () => {
    h.state.unread = Array.from({ length: 60 }, (_, i) => ({ id: `copy-${6000 + i}`, netsuite_id: String(6000 + i) }));
    h.state.expenseRefuses = new Set(['name', 'closed']);
    h.state.expenseRows = [freight('7001', '3'), freight('6059', '1')];
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(result.error).toBeUndefined();
    const reads = expenseReads();
    expect(reads.map((s) => [/BUILTIN/.test(s), /isclosed/.test(s)])).toEqual([[true, true], [false, true], [false, false], [false, false]]);
    expect(h.state.puts.flat().find((p) => p.po_id === 'copy-7001').lines[0]).toMatchObject({ account_name: null, closed: null, amount: '45.50' });
    expect(h.state.puts.flat().find((p) => p.po_id === 'copy-6059').lines[0]).toMatchObject({ account_name: null, closed: null });
  });

  it("when NetSuite won't give the other lines at all, keeps nothing, says why, and marks the changed POs not read", async () => {
    h.state.unread = [{ id: 'copy-6990', netsuite_id: '6990' }];
    h.state.expenseRefuses = new Set(['all']);
    const result = await syncPoExpenseLines(service, [target('7001'), target('7002')]);
    expect(result).toMatchObject({ pos: 0, lines: 0, unread: 2 });
    expect(result.error).toMatch(/couldn't read the POs' other lines: SuiteQL: Invalid search query/);
    expect(expenseReads()).toHaveLength(3);
    expect(h.state.puts).toEqual([]);
    // Only the changed ones: a copy never read stays not read anyway.
    expect(h.state.marks).toEqual([['copy-7001', 'copy-7002']]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/a PO's other lines: couldn't read/));
  });

  it("stops at the first chunk when NetSuite fails outright, without trying another way", async () => {
    h.state.expenseRefuses = new Set(['down']);
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(result.error).toMatch(/fetch failed/);
    expect(expenseReads()).toHaveLength(1);
    expect(result.unread).toBe(1);
  });

  it('takes the bills from whichever link table answers, and asks only it after', async () => {
    h.state.unread = Array.from({ length: 60 }, (_, i) => ({ id: `copy-${6000 + i}`, netsuite_id: String(6000 + i) }));
    h.state.expenseRows = [freight('7001', '3'), freight('6059', '1')];
    h.state.linkRefuses = new Set(['nexttransactionlinelink:lines']);
    h.state.linkRows = [{ po_id: '7001', line_id: '3', bill_id: '8801' }];
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(result).toMatchObject({ billsUnknown: 0 });
    expect(result.error).toBeUndefined();
    expect(linkReads().map((s) => [s.match(/FROM (\w+) l/)![1], /previousline/.test(s)])).toEqual([
      ['nexttransactionlinelink', true], ['previoustransactionlinelink', true], ['previoustransactionlinelink', true],
    ]);
    expect(h.state.puts.flat().find((p) => p.po_id === 'copy-7001').lines[0].billed_by).toEqual(['8801']);
    expect(h.state.puts.flat().find((p) => p.po_id === 'copy-6059').lines[0].billed_by).toEqual([]);
  });

  it('falls back to the bills by PO when no table says which line each is on', async () => {
    h.state.expenseRows = [freight('7001', '3'), freight('7002', '3')];
    h.state.linkRefuses = new Set(['nexttransactionlinelink:lines', 'previoustransactionlinelink:lines']);
    h.state.linkRows = [{ po_id: '7001', line_id: '3', bill_id: '8801' }];
    const result = await syncPoExpenseLines(service, [target('7001'), target('7002')]);
    expect(linkReads().map((s) => [s.match(/FROM (\w+) l/)![1], /previousline/.test(s)])).toEqual([
      ['nexttransactionlinelink', true], ['previoustransactionlinelink', true], ['nexttransactionlinelink', false],
    ]);
    expect(result.billsUnknown).toBe(0);
    expect(h.state.puts[0].map((p: any) => [p.po_id, p.lines[0].billed_by])).toEqual([['copy-7001', null], ['copy-7002', []]]);
  });

  it("keeps the lines with their bills not known when every link table refuses, says so, and doesn't ask again", async () => {
    h.state.unread = Array.from({ length: 60 }, (_, i) => ({ id: `copy-${6000 + i}`, netsuite_id: String(6000 + i) }));
    h.state.expenseRows = [freight('7001', '3'), freight('6059', '1')];
    h.state.linkRefuses = new Set(['nexttransactionlinelink:lines', 'previoustransactionlinelink:lines', 'nexttransactionlinelink:po', 'previoustransactionlinelink:po']);
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(linkReads()).toHaveLength(4);
    expect(result).toMatchObject({ pos: 61, lines: 2, unread: 0, billsUnknown: 2 });
    expect(result.error).toBe("couldn't read which bills have the POs' other lines: SuiteQL: Invalid search query: previoustransactionlinelink");
    expect(h.state.puts.flat().filter((p) => p.lines.length).map((p) => p.lines[0].billed_by)).toEqual([null, null]);
  });

  it("keeps the lines with their bills not known when the link read fails outright, and doesn't try another way", async () => {
    h.state.expenseRows = [freight('7001', '3')];
    h.state.linkRefuses = new Set(['down']);
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(linkReads()).toHaveLength(1);
    expect(result).toMatchObject({ pos: 1, billsUnknown: 1 });
    expect(result.error).toMatch(/which bills .*: fetch failed/);
    expect(h.state.puts[0][0].lines[0].billed_by).toBeNull();
  });

  it("asks only the table that answered once it has, and says so when it then fails", async () => {
    h.state.unread = Array.from({ length: 60 }, (_, i) => ({ id: `copy-${6000 + i}`, netsuite_id: String(6000 + i) }));
    h.state.expenseRows = [freight('7001', '3'), freight('6059', '1')];
    const realSuiteql = h.suiteql.getMockImplementation()!;
    let linkCalls = 0;
    h.suiteql.mockImplementation(async (sql: string) => {
      if (/transactionlinelink l/.test(sql) && ++linkCalls === 2) throw Object.assign(new Error('SuiteQL: Invalid search query'), { status: 400 });
      return realSuiteql(sql);
    });
    try {
      const result = await syncPoExpenseLines(service, [target('7001')]);
      expect(linkReads()).toHaveLength(2);
      expect(result.billsUnknown).toBe(1);
      expect(h.state.puts.flat().find((p) => p.po_id === 'copy-6059').lines[0].billed_by).toBeNull();
    } finally {
      h.suiteql.mockImplementation(realSuiteql);
    }
  });

  it("marks the changed POs not read when their lines can't be kept, and says why", async () => {
    h.state.expenseRows = [freight('7001', '3')];
    h.state.putError = { message: 'function vendor_po_expense_lines_put does not exist' };
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(result).toMatchObject({ pos: 0, lines: 0, unread: 1 });
    expect(result.error).toMatch(/couldn't keep the POs' other lines: function vendor_po_expense_lines_put does not exist/);
    expect(h.state.marks).toEqual([['copy-7001']]);
  });

  it('says so when the changed POs can\'t be marked not read either', async () => {
    h.state.expenseRefuses = new Set(['all']);
    h.state.markError = { message: 'permission denied' };
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(result.unread).toBe(0);
    expect(result.error).toMatch(/couldn't mark the POs not read: permission denied/);
  });

  it("starts no read after its share of the run but the first, and marks the changed POs it didn't reach not read", async () => {
    const changed = Array.from({ length: 120 }, (_, i) => target(String(7000 + i)));
    h.state.unread = [{ id: 'copy-6990', netsuite_id: '6990' }];
    let t = 1_000;
    const result = await syncPoExpenseLines(service, changed, () => {
      const at = t;
      t += EXPENSE_BUDGET_MS / 2 + 1;
      return at;
    });
    // The clock moves past half its share at each look: the second chunk
    // still starts, the third finds the share gone.
    expect(expenseReads()).toHaveLength(2);
    expect(result.pos).toBe(100);
    expect(h.state.marks).toEqual([changed.slice(100).map((c) => c.copyId)]);
    expect(result.unread).toBe(20);
  });

  it("marks the changed POs not read a hundred at a time", async () => {
    const changed = Array.from({ length: 150 }, (_, i) => target(String(7000 + i)));
    h.state.expenseRefuses = new Set(['down']);
    const result = await syncPoExpenseLines(service, changed);
    expect(h.state.marks.map((m) => m.length)).toEqual([100, 50]);
    expect(result.unread).toBe(150);
  });

  it("still reads the changed POs when it can't find the copies never read", async () => {
    h.state.unreadError = { message: 'column netsuite_vendor_pos.expense_lines_read_at does not exist' };
    h.state.expenseRows = [freight('7001', '3')];
    const result = await syncPoExpenseLines(service, [target('7001')]);
    expect(result).toMatchObject({ pos: 1, lines: 1, unread: 0 });
    expect(result.error).toMatch(/couldn't find the copies not read yet: column netsuite_vendor_pos\.expense_lines_read_at does not exist/);
  });

  it('does nothing when no PO changed and every copy has been read', async () => {
    const result = await syncPoExpenseLines(service, []);
    expect(result).toEqual({ pos: 0, lines: 0, unread: 0, billsUnknown: 0 });
    expect(h.suiteql).not.toHaveBeenCalled();
    expect(h.state.puts).toEqual([]);
  });
});

describe('the vendor PO sync and the other lines', () => {
  const header = (id: string, tranid: string) => ({
    id, tranid, trandate: '11/2/2026', status: 'B', status_label: 'Pending Receipt', memo: null, total: '458.00', vendor_id: '3001', vendor_name: 'Ranger Design',
  });

  it("reads the other lines of the POs it copied, and says how it went in the heartbeat", async () => {
    h.state.headers = [header('7001', 'PO2290')];
    h.state.expenseRows = [freight('7001', '3')];
    const result = await syncVendorPos(service);
    expect(result.expenses).toEqual({ pos: 1, lines: 1, unread: 0, billsUnknown: 0 });
    expect(h.state.puts[0][0]).toMatchObject({ po_id: 'copy-7001', lines: [{ line_id: '3', billed_by: [] }] });
    const beat = h.heartbeat.mock.calls[0][2] as Record<string, unknown>;
    expect(beat).toMatchObject({ expensePos: 1, expenseLines: 1 });
    expect(beat).not.toHaveProperty('expenseError');
    expect(beat).not.toHaveProperty('expenseUnread');
    expect(beat).not.toHaveProperty('expenseBillsUnknown');
  });

  it("goes on when the other lines can't be read, and says so in the heartbeat", async () => {
    h.state.headers = [header('7001', 'PO2290')];
    h.state.expenseRows = [freight('7001', '3')];
    h.state.linkRefuses = new Set(['down']);
    h.state.putError = { message: 'timed out' };
    const result = await syncVendorPos(service);
    expect(result).toMatchObject({ modified: 1, synced: 1 });
    const beat = h.heartbeat.mock.calls[0][2] as Record<string, unknown>;
    expect(beat).toMatchObject({ expensePos: 0, expenseLines: 0, expenseUnread: 1, expenseBillsUnknown: 1 });
    expect(beat.expenseError).toMatch(/timed out/);
  });
});
