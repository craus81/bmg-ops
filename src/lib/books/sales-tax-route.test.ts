// Books → Sales tax (src/app/api/admin/books/sales-tax and its download):
// a month's Missouri sales tax worksheet for made-up documents, last month
// when none is asked for; the month's return typed in, corrected and removed
// by the bookkeeper and super admins, refused when someone else saved it
// first; each location's dated rates, added and removed by super admins
// only; and the Excel file with every document (src/lib/books/sales-tax-worksheet.ts,
// migration 496). Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import ExcelJS from 'exceljs';
import type { SalesTaxMonthData } from './sales-tax-worksheet';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const BOOKKEEPER = 'a0000000-0000-4000-8000-000000000002';
const [AR, SALES, INSTALLS, MO_TAX, GA_TAX] = ['120', '400', '410', '250', '251'];

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const state = {
    roles: ['super_admin'] as string[],
    me: 'a0000000-0000-4000-8000-000000000001',
    tables: {} as Record<string, Row[]>,
    read: null as null | ((month: string) => unknown),
    rpcs: [] as Array<[string, Record<string, any>]>,
    /** A table or function that fails, as the database would. */
    failing: null as string | null,
    clock: 0,
  };
  const rows = (table: string) => (state.tables[table] ??= []);
  /** Each save's time, a second after the last. */
  const stamp = () => new Date(Date.UTC(2026, 9, 25, 15, 0, 0) + 1000 * ++state.clock).toISOString();

  // An in-memory stand-in for the tables the routes read and write.
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const sorts: string[] = [];
    let cap: number | null = null;
    let op: { kind: 'select' } | { kind: 'insert'; row: Row } | { kind: 'delete' } = { kind: 'select' };
    const run = () => {
      if (state.failing === table) return { data: null, error: { message: `Couldn't read ${table}` } };
      if (op.kind === 'insert') {
        const row = op.row;
        if (table === 'sales_tax_rates' && rows(table).some((r) => r.location_id === row.location_id && r.starts_on === row.starts_on)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "sales_tax_rates_pkey"' } };
        }
        rows(table).push({ ...row, entered_at: stamp() });
        return { data: null, error: null };
      }
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      if (op.kind === 'delete') {
        state.tables[table] = rows(table).filter((r) => !matched.includes(r));
        return { data: matched.map((r) => structuredClone(r)), error: null };
      }
      const sorted = [...matched].sort((a, b) => {
        for (const c of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]));
          if (d !== 0) return d;
        }
        return 0;
      });
      return { data: (cap === null ? sorted : sorted.slice(0, cap)).map((r) => structuredClone(r)), error: null };
    };
    const builder: any = {
      select: () => builder,
      insert: (row: Row) => { op = { kind: 'insert', row }; return builder; },
      delete: () => { op = { kind: 'delete' }; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return builder; },
      order: (c: string) => { sorts.push(c); return builder; },
      limit: (n: number) => { cap = n; return builder; },
      maybeSingle: async () => {
        const { data, error } = run();
        return { data: (data as Row[] | null)?.[0] ?? null, error };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // Migration 496's functions as they have it, on the in-memory tables.
  const ok = (data: unknown) => ({ data, error: null });
  const FIELDS = ['filed_on', 'gross_cents', 'adjustments_cents', 'taxable_cents', 'tax_cents', 'allowance_cents', 'paid_cents', 'note'];
  const rpcs: Record<string, (args: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    gl_sales_tax_month: (args) => ok(state.read!(args.p_month)),
    sales_tax_return_save: ({ p }) => {
      const row = rows('sales_tax_returns').find((r) => r.company === p.company && r.month === p.month);
      const note = String(p.note ?? '').trim() || null;
      const kept = Object.fromEntries(FIELDS.map((f) => [f, f === 'note' ? note : p[f]]));
      if (!row) {
        if (p.seen !== null && p.seen !== undefined) return ok({ state: 'changed' });
        const at = stamp();
        rows('sales_tax_returns').push({
          company: p.company, month: p.month, ...kept, entered_by: p.by, entered_at: at, updated_by: p.by, updated_at: at,
        });
        return ok({ state: 'saved', updated_at: at });
      }
      if (row.updated_at !== p.seen) return ok({ state: 'changed' });
      if (FIELDS.every((f) => row[f] === kept[f])) return ok({ state: 'saved', updated_at: row.updated_at, unchanged: true });
      Object.assign(row, kept, { updated_by: p.by, updated_at: stamp() });
      return ok({ state: 'saved', updated_at: row.updated_at });
    },
    sales_tax_return_remove: ({ p }) => {
      const row = rows('sales_tax_returns').find((r) => r.company === p.company && r.month === p.month);
      if (!row) return ok({ state: 'gone' });
      if (row.updated_at !== p.seen) return ok({ state: 'changed' });
      state.tables.sales_tax_returns = rows('sales_tax_returns').filter((r) => r !== row);
      return ok({ state: 'removed' });
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, structuredClone(args)]);
      if (state.failing === fn) return { data: null, error: { message: 'boom' } };
      return rpcs[fn] ? rpcs[fn](args) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, service };
});

vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever state.roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => h.state.roles.includes(r));
      return booksAllows(access, need)
        ? { user: { id: h.state.me, email: 'someone@example.com' }, profile: { full_name: 'Someone', roles: h.state.roles }, access }
        : { error: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

const { state } = h;

import { logAudit } from '@/lib/audit';
import { GET, POST } from '../../app/api/admin/books/sales-tax/route';
import { GET as download } from '../../app/api/admin/books/sales-tax/download/route';
import { XLSX_TYPE } from './report-workbook';

const TYPES: Record<string, string> = { [AR]: 'accounts_receivable', [SALES]: 'income', [INSTALLS]: 'income', [MO_TAX]: 'other_current_liability', [GA_TAX]: 'other_current_liability', 100: 'bank' };
const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
/** A document: GL lines [line, account, cents debit positive, location, customer]; mirror lines [line, kind, item]. */
function doc(id: string, type: string, date: string, gl: Array<[string, string, number, string, string?]>, lines: Array<[string, string, string]> | null) {
  return {
    id, type, number: `${type === 'CashSale' ? 'CS' : 'INV'}${id}`, date, copied: lines !== null,
    gl: gl.map(([line_id, account, cents, location_id, entity_id]) => ({
      line_id, account, account_type: TYPES[account] ?? null, debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00',
      location_id, entity_id: entity_id ?? null,
    })),
    lines: (lines ?? []).map(([line_id, kind, item_id], i) => ({ line_id, line_no: i + 1, kind, item_id, item_number: null, netamount: null })),
  };
}
const others = (list: SalesTaxMonthData['account']['others']['list']) => ({
  list, count: list.length, total: (list.reduce((t, o) => t + Math.round(Number(o.amount) * 100), 0) / 100).toFixed(2),
});

/**
 * September 2026, made up: a shelf and an install at O'Fallon taxed as FleetSuite would; another where NetSuite
 * taxed the install too; a school's exempt order at Wentzville whose certificate ran out in June; and a cash sale
 * at Social Circle, Georgia. The August return was paid in September and September's in October.
 */
const SEPTEMBER = (): SalesTaxMonthData => ({
  documents: [
    doc('8101', 'CustInvc', '2026-09-08', [['0', AR, 55730, '1', '9001'], ['1', SALES, -25100, '1'], ['2', INSTALLS, -28500, '1'], ['3', MO_TAX, -2130, '1']],
      [['1', 'item', '55'], ['2', 'item', '56'], ['3', 'tax', '77']]),
    doc('8102', 'CustInvc', '2026-09-15', [['0', AR, 21698, '1', '9001'], ['1', SALES, -10000, '1'], ['2', INSTALLS, -10000, '1'], ['3', MO_TAX, -1698, '1']],
      [['1', 'item', '55'], ['2', 'item', '56'], ['3', 'tax', '77']]),
    doc('8104', 'CustInvc', '2026-09-18', [['0', AR, 40000, '2', '9002'], ['1', SALES, -40000, '2']], [['1', 'item', '55']]),
    doc('8107', 'CashSale', '2026-09-25', [['0', '100', 16200, '5', '9003'], ['1', INSTALLS, -15000, '5'], ['2', GA_TAX, -1200, '5']], null),
  ],
  items: { 55: { number: 'SHELF-1', type: 'InvtPart' }, 56: { number: 'LABOR', type: 'Service' } },
  parts: {},
  tax_codes: { 77: { name: 'MO St Charles', rate: '8.488%' } },
  locations: { 1: "O'Fallon", 2: 'Wentzville', 3: 'Kansas City', 5: 'Social Circle', 12: 'Columbia Warehouse' },
  customers: {
    9001: { name: 'Acme Fleet', rows: 1, exempt: 0, cert_number: null, cert_expires: null, cert_files: 0, netsuite_taxable: 'T' },
    9002: { name: 'Bluebird Schools', rows: 1, exempt: 1, cert_number: 'EX-4471', cert_expires: '2026-06-30', cert_files: 1, netsuite_taxable: 'F' },
    9003: { name: 'Cardinal Plumbing', rows: 1, exempt: 0, cert_number: null, cert_expires: null, cert_files: 0, netsuite_taxable: 'T' },
  },
  account: {
    opening: '1000.00',
    before: '-970.00',
    moves: [{ type: 'CashSale', documents: 1, amount: '12.00' }, { type: 'CustInvc', documents: 2, amount: '38.28' }, { type: 'TaxPymt', documents: 1, amount: '-30.00' }],
    others: others([{ id: '8190', type: 'TaxPymt', number: 'TP-9', date: '2026-09-19', memo: 'August return', name: 'Missouri Department of Revenue', amount: '-30.00' }]),
    next: others([{ id: '8290', type: 'TaxPymt', number: 'TP-10', date: '2026-10-19', memo: 'September return', name: 'Missouri Department of Revenue', amount: '-29.79' }]),
    books: '50.28',
  },
});

const SEEDED = { starts_on: '2025-01-01', rate_pct: '8.488', note: 'From Settings → Sales Tax, the rate quotes use', entered_by: null, entered_at: '2026-11-01T12:00:00Z' };
// September's return as it was filed, as PostgREST can give a bigint: as text.
const FILED = {
  company: 'BMG', month: '2026-09-01', filed_on: '2026-10-19', gross_cents: '113600', adjustments_cents: '-78500', taxable_cents: '35100',
  tax_cents: '2979', allowance_cents: '60', paid_cents: '2919', note: 'Filed online', entered_by: BOOKKEEPER, entered_at: '2026-10-19T16:00:00.000Z',
  updated_by: BOOKKEEPER, updated_at: '2026-10-19T16:00:00.000Z',
};
const RETURN = {
  action: 'return', month: '2026-09', seen: null, filedOn: '2026-10-19', grossCents: 113600, adjustmentsCents: -78500, taxableCents: 35100,
  taxCents: 2979, allowanceCents: 60, paidCents: 2919, note: ' Filed online ',
};

const URL = 'https://go.bmgfleet.com/api/admin/books/sales-tax';
const get = async (query = '') => {
  const res = await GET(new NextRequest(`${URL}${query}`));
  return { status: res.status, body: await res.json() };
};
const post = async (body: unknown) => {
  const res = await POST(new NextRequest(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const audits = () => vi.mocked(logAudit).mock.calls.map(([, e]) => e);
const filedRow = () => state.tables.sales_tax_returns.find((r) => r.company === 'BMG' && r.month === '2026-09-01');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // October 25, 2026, mid-morning in Central time.
  vi.setSystemTime(new Date('2026-10-25T15:00:00Z'));
  state.roles = ['super_admin'];
  state.me = CRAIG;
  state.failing = null;
  state.clock = 0;
  state.rpcs.length = 0;
  state.read = () => SEPTEMBER();
  state.tables = {
    sync_state: [{ sync_type: 'books_netsuite_lists', last_result: { taxAccounts: [{ tax_code_id: '79', account_id: GA_TAX, lines: 2 }, { tax_code_id: '77', account_id: MO_TAX, lines: 9 }, { tax_code_id: '80', account_id: MO_TAX, lines: 1 }] } }],
    gl_companies: [{ code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC' }, { code: '1084', name: '1084 Cool Springs', legal_name: null }],
    sales_tax_rates: [
      { location_id: '1', ...SEEDED }, { location_id: '2', ...SEEDED }, { location_id: '3', ...SEEDED },
      { location_id: '1', starts_on: '2026-10-01', rate_pct: '8.738', note: "Quarter's new rate", entered_by: CRAIG, entered_at: '2026-10-02T14:00:00Z' },
    ],
    sales_tax_returns: [],
    gl_accounts: [
      { netsuite_account_id: GA_TAX, number: '2210', name: 'Georgia Sales Tax Payable' },
      { netsuite_account_id: MO_TAX, number: '2200', name: 'Sales Tax Payable' },
      { netsuite_account_id: SALES, number: '4000', name: 'Sales' },
    ],
    gl_netsuite_lists: [
      { kind: 'location', netsuite_id: '1', name: "O'Fallon", gone_at: null },
      { kind: 'location', netsuite_id: '12', name: 'Columbia Warehouse', gone_at: null },
      { kind: 'location', netsuite_id: '2', name: 'Wentzville', gone_at: null },
      { kind: 'location', netsuite_id: '3', name: 'Kansas City', gone_at: null },
      { kind: 'location', netsuite_id: '5', name: 'Social Circle', gone_at: null },
      { kind: 'location', netsuite_id: '9', name: 'Denver', gone_at: '2026-01-01T00:00:00Z' },
      { kind: 'department', netsuite_id: '4', name: 'Installs', gone_at: null },
    ],
    quote_settings: [{ id: 1, sales_tax_rate_pct: '8.488' }],
    profiles: [{ id: CRAIG, full_name: 'Craig George' }, { id: BOOKKEEPER, full_name: 'Pat Ledger' }],
  };
  vi.mocked(logAudit).mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('Sales tax', () => {
  it("works out last month's return when none is asked for, location by location, from the documents NetSuite posted", async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    // Where NetSuite posts sales tax, each account once; the first hundred of the other moves on them.
    expect(state.rpcs).toEqual([['gl_sales_tax_month', { p_company: 'BMG', p_month: '2026-09-01', p_tax_accounts: [MO_TAX, GA_TAX], p_limit: 100 }]]);
    expect(body).toMatchObject({
      month: '2026-09-01', due: '2026-10-20', first: '2025-01-01', through: '2026-10-01',
      company: { code: 'BMG', name: 'BMG', legal_name: 'Example Fleet Upfitters LLC' },
      settingsPct: '8.488%', filed: null, held: null, can: { keep: true, owner: true },
    });
    const w = body.worksheet;
    expect(w.lines.map((l: Row) => [l.location, l.rate?.pct, l.documents, l.gross, l.adjustments, l.taxable, l.tax, l.charged])).toEqual([
      ["O'Fallon", '8.488%', 2, 73600, -38500, 35100, 2979, 3828],
      ['Wentzville', '8.488%', 1, 40000, -40000, 0, 0, 0],
      ['Kansas City', '8.488%', 0, 0, 0, 0, 0, 0],
    ]);
    expect(w.figures).toEqual({ gross: 113600, adjustments: -78500, taxable: 35100, tax: 2979, allowance: 60, pay: 2919, charged: 3828 });
    expect(w.apart).toEqual([{ state: 'GA', locationId: '5', location: 'Social Circle', documents: 1, gross: 15000, charged: 1200 }]);
    expect(w.counts).toEqual({ sales: 4, returns: 0 });
    expect(w.exempt).toEqual([expect.objectContaining({ customer: 'Bluebird Schools', gross: 40000, warning: 'Certificate expired Jun 30, 2026, before the sale.' })]);
    expect(w.accounts).toMatchObject({ start: 3000, charged: 5028, end: 5028, books: 5028, next: { count: 1, total: -2979 } });
    expect(w.problems).toEqual([]);
  });

  it("lists only the documents whose tax NetSuite worked out differently, without their lines, each opening its check", async () => {
    const { body } = await get();
    // NetSuite taxed an install at O'Fallon, and charged Georgia's tax at Social Circle.
    expect(body.worksheet.documents).toEqual([
      expect.objectContaining({
        id: '8102', number: 'INV8102', charged: 1698, owed: 849, note: "NetSuite also taxed LABOR ($100.00), which FleetSuite doesn't tax.",
        check: { kind: 'invoice', month: '2026-09-01' },
      }),
      expect.objectContaining({
        id: '8107', number: 'CS8107', basis: 'georgia', charged: 1200, owed: 0, note: expect.stringContaining('$12.00'), check: null,
      }),
    ]);
    for (const d of body.worksheet.documents) expect(d).not.toHaveProperty('lines');
    // The payments to the state are NetSuite's own kind, which Invoices vs NetSuite doesn't check.
    expect([...body.worksheet.accounts.others.list, ...body.worksheet.accounts.next.list].map((o: Row) => [o.number, o.check])).toEqual([
      ['TP-9', null], ['TP-10', null],
    ]);

    // A journal entry is, under the month NetSuite posted it to.
    const journal = (id: string, date: string) => ({ id, type: 'Journal', number: `JE${id}`, date, memo: 'Tax fix', name: null, amount: '-1.00' });
    const september = SEPTEMBER();
    state.read = () => ({
      ...september,
      account: { ...september.account, others: others([journal('8191', '2026-09-30')]), next: others([journal('8291', '2026-10-02')]) },
    });
    const { body: again } = await get();
    expect([...again.worksheet.accounts.others.list, ...again.worksheet.accounts.next.list].map((o: Row) => [o.number, o.check])).toEqual([
      ['JE8191', { kind: 'journal_entry', month: '2026-09-01' }], ['JE8291', { kind: 'journal_entry', month: '2026-10-01' }],
    ]);
  });

  it("gives each location's rates with who added them, the locations a rate can be added for, and the tax accounts by name", async () => {
    // One added by someone with no name, and one by someone whose profile is gone.
    const [NAMELESS, GONE] = ['a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000004'];
    state.tables.profiles.push({ id: NAMELESS, full_name: null });
    state.tables.sales_tax_rates.push(
      { location_id: '2', starts_on: '2026-10-01', rate_pct: '8.738', note: null, entered_by: NAMELESS, entered_at: '2026-10-03T14:00:00Z' },
      { location_id: '3', starts_on: '2026-10-01', rate_pct: '8.85', note: null, entered_by: GONE, entered_at: '2026-10-03T15:00:00Z' },
    );
    const { body } = await get();
    expect(body.rates.map((r: Row) => [r.locationId, r.startsOn, r.pct, r.note, r.enteredBy])).toEqual([
      ['1', '2025-01-01', '8.488%', 'From Settings → Sales Tax, the rate quotes use', null],
      ['1', '2026-10-01', '8.738%', "Quarter's new rate", 'Craig George'],
      ['2', '2025-01-01', '8.488%', 'From Settings → Sales Tax, the rate quotes use', null],
      ['2', '2026-10-01', '8.738%', null, 'Someone'],
      ['3', '2025-01-01', '8.488%', 'From Settings → Sales Tax, the rate quotes use', null],
      ['3', '2026-10-01', '8.85%', null, 'Someone'],
    ]);
    // Not Social Circle, Georgia, nor one NetSuite has let go of.
    expect(body.locations).toEqual([
      { id: '1', name: "O'Fallon", state: 'MO' }, { id: '2', name: 'Wentzville', state: 'MO' }, { id: '3', name: 'Kansas City', state: 'MO' },
      { id: '12', name: 'Columbia Warehouse', state: '—' },
    ]);
    expect(body.taxAccounts).toEqual([
      { id: MO_TAX, number: '2200', name: 'Sales Tax Payable' }, { id: GA_TAX, number: '2210', name: 'Georgia Sales Tax Payable' },
    ]);
  });

  it('reads the month asked for from January 2025 through this one, and last month for any other', async () => {
    for (const [asked, month] of [['2026-03', '2026-03-01'], ['2025-01', '2025-01-01'], ['2026-10', '2026-10-01'], ['2024-12', '2026-09-01'], ['2026-11', '2026-09-01'], ['Sept', '2026-09-01']]) {
      state.rpcs.length = 0;
      const { body } = await get(`?month=${asked}`);
      expect([asked, body.month, state.rpcs[0][1].p_month]).toEqual([asked, month, month]);
    }
  });

  it("holds the month's return as filed against the worksheet, with who typed it in", async () => {
    state.tables.sales_tax_returns.push({ ...FILED, updated_by: CRAIG });
    const { body } = await get();
    expect(body.filed).toEqual({
      company: 'BMG', month: '2026-09-01', filedOn: '2026-10-19', gross: 113600, adjustments: -78500, taxable: 35100, tax: 2979, allowance: 60,
      paid: 2919, note: 'Filed online', enteredBy: 'Pat Ledger', enteredAt: FILED.entered_at, updatedBy: 'Craig George', updatedAt: FILED.updated_at,
    });
    expect(body.held).toMatchObject({ filedOn: '2026-10-19', due: '2026-10-20', late: false, clearedNext: 2979, notes: [] });
    // Typed in a dollar short on the tax.
    filedRow()!.tax_cents = '2879';
    expect((await get()).body.held.notes).toEqual([
      "Tax on the return is $1.00 less than the worksheet's.",
      'The timely payment allowance is 2% of the return\'s tax, $0.58, and the return took $0.60.',
      'What was paid is $1.00 more than the tax less the allowance, as penalties or interest would be.',
      "NetSuite's sales tax account came down $29.79 in October 2026, and the return's tax is $28.79.",
    ]);
  });

  it("says where NetSuite posts sales tax hasn't been read, and reads no account for it", async () => {
    state.tables.sync_state = [{ sync_type: 'books_netsuite_lists', last_result: { read: 3 } }];
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(state.rpcs[0][1].p_tax_accounts).toEqual([]);
    expect(body.taxAccounts).toEqual([]);
    expect(body.worksheet.accounts).toBeNull();
    expect(body.worksheet.problems[0]).toMatch(/^Where NetSuite posts sales tax hasn't been read yet/);
  });

  it('says when a read fails', async () => {
    for (const [table, what] of [
      ['gl_companies', 'the company'], ['sales_tax_rates', 'the rates'], ['sales_tax_returns', "the month's return"],
      ['gl_accounts', 'the sales tax accounts'], ['gl_netsuite_lists', "NetSuite's locations"], ['gl_sales_tax_month', "the month's documents"],
    ]) {
      state.failing = table;
      const { status, body } = await get();
      expect([table, status, body.error]).toEqual([table, 500, `Couldn't read ${what}: ${table === 'gl_sales_tax_month' ? 'boom' : `Couldn't read ${table}`}`]);
    }
    state.failing = 'sync_state';
    expect((await get()).body).toEqual({ error: "Couldn't read where NetSuite posts sales tax: Couldn't read sync_state" });
  });
});

describe('Who sees it and who changes it', () => {
  it('is for whoever opens the books; the CPA reads it, the bookkeeper types in returns, a super admin changes rates', async () => {
    state.roles = ['admin'];
    expect((await get()).status).toBe(403);
    expect((await post(RETURN)).status).toBe(403);
    expect((await download(new NextRequest(`${URL}/download`))).status).toBe(403);
    expect(state.rpcs).toEqual([]);

    state.roles = ['cpa'];
    const cpa = await get();
    expect([cpa.status, cpa.body.can]).toEqual([200, { keep: false, owner: false }]);
    expect((await download(new NextRequest(`${URL}/download`))).status).toBe(200);
    expect((await post(RETURN)).status).toBe(403);

    state.roles = ['bookkeeper'];
    state.me = BOOKKEEPER;
    expect((await get()).body.can).toEqual({ keep: true, owner: false });
    expect(await post(RETURN)).toEqual({ status: 200, body: { saved: true, updatedAt: expect.any(String) } });
    for (const body of [
      { action: 'add_rate', locationId: '12', startsOn: '2026-10-01', pct: '7.5', note: null },
      { action: 'remove_rate', locationId: '1', startsOn: '2026-10-01' },
    ]) {
      expect(await post(body)).toEqual({ status: 403, body: { error: "Only a super admin can change a location's sales tax rate." } });
    }
    expect(state.tables.sales_tax_rates).toHaveLength(4);
  });
});

describe("Typing in the month's return", () => {
  it('saves it as filed, its note trimmed, and records who typed it in without the amounts', async () => {
    state.me = BOOKKEEPER;
    const saved = await post(RETURN);
    expect(saved).toEqual({ status: 200, body: { saved: true, updatedAt: expect.any(String) } });
    expect(state.rpcs.at(-1)).toEqual(['sales_tax_return_save', {
      p: {
        company: 'BMG', month: '2026-09-01', seen: null, filed_on: '2026-10-19', gross_cents: 113600, adjustments_cents: -78500, taxable_cents: 35100,
        tax_cents: 2979, allowance_cents: 60, paid_cents: 2919, note: 'Filed online', by: BOOKKEEPER,
      },
    }]);
    expect(audits()).toEqual([{
      actorId: BOOKKEEPER, table: 'sales_tax_returns', recordId: 'BMG 2026-09', action: 'typed in',
      detail: { month: '2026-09-01', filed_on: '2026-10-19', note: true },
    }]);

    // Saved again as it is: nothing to record. Corrected: recorded as corrected.
    expect((await post({ ...RETURN, seen: saved.body.updatedAt })).status).toBe(200);
    expect(audits()).toHaveLength(1);
    const corrected = await post({ ...RETURN, seen: saved.body.updatedAt, taxCents: 2980, note: '  ' });
    expect(corrected.status).toBe(200);
    expect(filedRow()).toMatchObject({ tax_cents: 2980, note: null, entered_by: BOOKKEEPER });
    expect(audits().at(-1)).toMatchObject({ action: 'corrected', detail: { month: '2026-09-01', filed_on: '2026-10-19', note: false } });

    // From a page opened before the correction, or one that saw none typed in yet.
    for (const seen of [saved.body.updatedAt, null]) {
      expect(await post({ ...RETURN, seen })).toEqual({
        status: 409, body: { error: "September 2026's return was changed by someone else since you opened it: look at it again." },
      });
    }
    expect(filedRow()!.tax_cents).toBe(2980);
  });

  it("refuses one filed before the month was over, on a day that hasn't come, or for a month before January 2025", async () => {
    for (const [body, error] of [
      [{ ...RETURN, filedOn: '2026-09-30' }, "September 2026's return is filed once the month is over: on Oct 1, 2026 or after."],
      [{ ...RETURN, month: '2026-10', filedOn: '2026-10-25' }, "October 2026's return is filed once the month is over: on Nov 1, 2026 or after."],
      [{ ...RETURN, filedOn: '2026-10-26' }, "Oct 26, 2026 hasn't come yet: type the day the return was filed."],
      [{ ...RETURN, month: '2024-12', filedOn: '2025-01-20' }, "Returns are kept from January 2025, when FleetSuite's copy of NetSuite starts."],
    ] as const) {
      expect(await post(body)).toEqual({ status: 400, body: { error } });
    }
    for (const bad of [
      { ...RETURN, allowanceCents: -1 }, { ...RETURN, taxCents: 29.79 }, { ...RETURN, month: '2026-9' }, { ...RETURN, filedOn: '10/19/2026' },
      { ...RETURN, grossCents: 10_000_000_001 }, { ...RETURN, note: 'x'.repeat(301) }, { ...RETURN, seen: undefined },
    ]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(state.rpcs).toEqual([]);
    expect(state.tables.sales_tax_returns).toEqual([]);
  });

  it('removes it only as the page saw it', async () => {
    state.tables.sales_tax_returns.push({ ...FILED });
    expect(await post({ action: 'remove_return', month: '2026-09', seen: '2026-10-19T15:00:00.000Z' })).toEqual({
      status: 409, body: { error: "September 2026's return was changed by someone else since you opened it: look at it again." },
    });
    expect(await post({ action: 'remove_return', month: '2026-09', seen: FILED.updated_at })).toEqual({ status: 200, body: { removed: true } });
    expect(state.tables.sales_tax_returns).toEqual([]);
    expect(audits()).toEqual([{ actorId: CRAIG, table: 'sales_tax_returns', recordId: 'BMG 2026-09', action: 'removed', detail: { month: '2026-09-01' } }]);
    expect(await post({ action: 'remove_return', month: '2026-09', seen: FILED.updated_at })).toEqual({
      status: 409, body: { error: "September 2026's return was removed already: look at it again." },
    });
  });

  it('says when the books refuse it', async () => {
    state.failing = 'sales_tax_return_save';
    expect(await post(RETURN)).toEqual({ status: 500, body: { error: "Couldn't save September 2026's return: boom" } });
    expect(audits()).toEqual([]);
  });
});

describe("Each location's rates", () => {
  it('adds one from the day it starts, as typed, for any location but Georgia', async () => {
    expect(await post({ action: 'add_rate', locationId: '12', startsOn: '2026-10-01', pct: ' 7.725 ', note: ' Columbia ' })).toEqual({ status: 200, body: { added: true } });
    expect(state.tables.sales_tax_rates.at(-1)).toMatchObject({ location_id: '12', starts_on: '2026-10-01', rate_pct: '7.725', note: 'Columbia', entered_by: CRAIG });
    expect(audits()).toEqual([{
      actorId: CRAIG, table: 'sales_tax_rates', recordId: '12 2026-10-01', action: 'added', detail: { location_id: '12', starts_on: '2026-10-01', rate_pct: 7.725 },
    }]);
    // With a rate, Columbia Warehouse is in Missouri, and on its return, each location at the rate it has at the month's end.
    expect((await get()).body.locations).toContainEqual({ id: '12', name: 'Columbia Warehouse', state: 'MO' });
    state.read = () => ({ ...SEPTEMBER(), documents: [] });
    expect((await get('?month=2026-10')).body.worksheet.lines.map((l: Row) => [l.location, l.rate?.pct])).toEqual([
      ["O'Fallon", '8.738%'], ['Wentzville', '8.488%'], ['Kansas City', '8.488%'], ['Columbia Warehouse', '7.725%'],
    ]);

    for (const [body, status, error] of [
      [{ locationId: '1', startsOn: '2026-10-01', pct: '8.9' }, 409, "O'Fallon has a rate from Oct 1, 2026 already: remove it first to change it."],
      [{ locationId: '5', startsOn: '2026-10-01', pct: '8' }, 400, "Social Circle is in Georgia, where FleetSuite doesn't tax work, so it isn't on Missouri's return."],
      [{ locationId: '9', startsOn: '2026-10-01', pct: '8' }, 400, "Location 9 isn't one of NetSuite's locations: Sync now on the NetSuite lists page reads them."],
      [{ locationId: '4', startsOn: '2026-10-01', pct: '8' }, 400, "Location 4 isn't one of NetSuite's locations: Sync now on the NetSuite lists page reads them."],
      [{ locationId: '12', startsOn: '2024-12-31', pct: '8' }, 400, "Rates start from Jan 1, 2025, when FleetSuite's copy of NetSuite starts."],
    ] as const) {
      expect(await post({ action: 'add_rate', note: null, ...body })).toEqual({ status, body: { error } });
    }
    for (const pct of ['8.4888', '100', '0', '0.000', '-1', '8%', '', 'eight']) {
      expect([pct, (await post({ action: 'add_rate', locationId: '12', startsOn: '2026-11-01', pct, note: null })).status]).toEqual([pct, 400]);
    }
    expect(state.tables.sales_tax_rates).toHaveLength(5);
    expect(audits()).toHaveLength(1);
  });

  it('removes one, once', async () => {
    expect(await post({ action: 'remove_rate', locationId: '1', startsOn: '2026-10-01' })).toEqual({ status: 200, body: { removed: true } });
    expect(state.tables.sales_tax_rates.map((r) => [r.location_id, r.starts_on])).toEqual([['1', '2025-01-01'], ['2', '2025-01-01'], ['3', '2025-01-01']]);
    expect(audits()).toEqual([{
      actorId: CRAIG, table: 'sales_tax_rates', recordId: '1 2026-10-01', action: 'removed', detail: { location_id: '1', starts_on: '2026-10-01', rate_pct: 8.738 },
    }]);
    expect(await post({ action: 'remove_rate', locationId: '1', startsOn: '2026-10-01' })).toEqual({
      status: 409, body: { error: 'That rate was removed already: look at it again.' },
    });
    // Without one for its day, O'Fallon's sales have to wait for one.
    state.tables.sales_tax_rates = state.tables.sales_tax_rates.filter((r) => r.location_id !== '1');
    const { body } = await get();
    expect(body.worksheet.figures.tax).toBeNull();
    expect(body.worksheet.problems).toEqual(["No sales tax rate for O'Fallon covers 2 documents this month: add one below."]);
  });
});

async function sheets(res: Response): Promise<ExcelJS.Worksheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as any);
  return wb.worksheets;
}
const values = (ws: ExcelJS.Worksheet) => Array.from({ length: ws.rowCount }, (_, r) => {
  const row = ws.getRow(r + 1);
  return Array.from({ length: row.cellCount }, (_, c) => {
    const v = row.getCell(c + 1).value;
    return v instanceof Date ? v.toISOString().slice(0, 10) : v ?? null;
  });
});
const rowOf = (ws: ExcelJS.Worksheet, first: string) => values(ws).find((r) => r[0] === first);
/** A cell's font color on the first row whose cell `key` holds `value`; undefined when it has none. */
function colorOf(ws: ExcelJS.Worksheet, value: string, col: number, key = 1): string | undefined {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((row) => { if (!found && row.getCell(key).value === value) found = row; });
  if (!found) throw new Error(`No row with ${value}`);
  return found.getCell(col).font?.color?.argb;
}
const RED = 'FFC00000';

describe("Sales tax's Excel download", () => {
  it("is last month's worksheet as an .xlsx file: what to file, every document and line, exempt sales and the account", async () => {
    const res = await download(new NextRequest(`${URL}/download`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(XLSX_TYPE);
    expect(res.headers.get('content-disposition'))
      .toBe(`attachment; filename="BMG Sales tax 2026-09.xlsx"; filename*=UTF-8''BMG%20Sales%20tax%202026-09.xlsx`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const [ret, docs, lines, exempt, account, ...rest] = await sheets(res);
    expect([ret.name, docs.name, lines.name, exempt.name, account.name, rest.length]).toEqual(['Return', 'Documents', 'Lines', 'Exempt sales', 'Sales tax account', 0]);

    expect(values(ret).slice(0, 3).map((r) => r[0])).toEqual(['Example Fleet Upfitters LLC', 'Missouri sales tax return', 'September 1, 2026 to September 30, 2026']);
    expect(rowOf(ret, "O'Fallon")).toEqual(["O'Fallon", '8.488%', 2, 736, -385, 351, 29.79, 38.28]);
    expect(rowOf(ret, 'Total')).toEqual(['Total', null, 3, 1136, -785, 351, 29.79, 38.28]);
    expect(rowOf(ret, 'Less the timely payment allowance, 2% when filed and paid by October 20, 2026')?.[6]).toBe(-0.6);
    expect(rowOf(ret, 'To pay')?.[6]).toBe(29.19);
    expect(rowOf(ret, 'Social Circle')).toEqual(['Social Circle', 'Georgia', 1, 150, null, null, null, 12]);

    expect(values(docs).filter((r) => typeof r[2] === 'string' && /^(INV|CS)\d/.test(r[2] as string)).map((r) => [r[2], r[5], r[7], r[8], r[10], r[11], r[12]])).toEqual([
      ['INV8101', "At its location's rate", 536, 251, null, 21.3, 21.3],
      ['INV8102', "At its location's rate", 200, 100, null, 16.98, 8.49],
      ['INV8104', 'Exempt customer', 400, 0, null, 0, 0],
      ['CS8107', 'Georgia, not taxed', 150, 0, null, 12, 0],
    ]);
    // FleetSuite's tax in red where NetSuite's differs.
    expect([colorOf(docs, 'INV8101', 13, 3), colorOf(docs, 'INV8102', 13, 3)]).toEqual([undefined, RED]);
    expect(values(lines).filter((r) => r[2] === 'INV8102').map((r) => [r[4], r[5], r[6], r[7]])).toEqual([['SHELF-1', 100, 'Yes', 'Yes'], ['LABOR', 100, 'No', 'Yes']]);
    // A cash sale's line, which FleetSuite's copy doesn't have.
    expect(values(lines).filter((r) => r[2] === 'CS8107').map((r) => [r[4], r[5], r[6], r[7]])).toEqual([['Line 1', 150, 'No', 'No']]);
    expect(rowOf(exempt, 'Bluebird Schools')).toEqual(['Bluebird Schools', 1, 400, 'EX-4471', '2026-06-30', 1, 'Certificate expired Jun 30, 2026, before the sale.']);
    expect(colorOf(exempt, 'Bluebird Schools', 7)).toBe(RED);
    expect(values(account).some((r) => String(r[0]).startsWith("2200 Sales Tax Payable, 2210 Georgia Sales Tax Payable in NetSuite's ledger"))).toBe(true);
    expect(rowOf(account, 'At the end of August 2026')?.[5]).toBe(30);
    expect(rowOf(account, 'At the end of September 2026')?.[5]).toBe(50.28);
    expect(values(account).find((r) => r[2] === 'TP-10')).toEqual(['Sales Tax Payment', '2026-10-19', 'TP-10', 'Missouri Department of Revenue', 'September return', -29.79]);
  });

  it('holds the return as filed on a sheet of its own, and writes what has to be fixed at the top in red', async () => {
    state.tables.sales_tax_returns.push({ ...FILED, gross_cents: '113500', tax_cents: '2879' });
    state.tables.sales_tax_rates = state.tables.sales_tax_rates.filter((r) => r.location_id !== '1');
    // A sale at Columbia Warehouse, which has no rate; three payments to the state, one listed; FleetSuite's books $10.28 short.
    const september = SEPTEMBER();
    state.read = () => ({
      ...september,
      documents: [...september.documents, doc('8108', 'CustInvc', '2026-09-28', [['0', AR, 5000, '12', '9001'], ['1', SALES, -5000, '12']], [['1', 'item', '55']])],
      account: { ...september.account, others: { ...september.account.others, count: 3 }, books: '40.00' },
    });
    const names = (await sheets(await download(new NextRequest(`${URL}/download?month=2026-09`)))).map((s) => s.name);
    expect(names).toEqual(['Return', 'As filed', 'Documents', 'Lines', 'Exempt sales', 'Sales tax account']);
    const [ret, filed, , , , account] = await sheets(await download(new NextRequest(`${URL}/download?month=2026-09`)));
    const problem = ret.getRow(6);
    expect(problem.getCell(1).value).toBe("No sales tax rate for O'Fallon covers 2 documents this month: add one below.");
    expect(problem.getCell(1).font?.color?.argb).toBe(RED);
    expect(rowOf(ret, "O'Fallon")?.slice(0, 3)).toEqual(["O'Fallon", 'No rate', 2]);
    expect(rowOf(ret, 'Columbia Warehouse')).toEqual(['Columbia Warehouse', 'Neither state', 1, 50, null, null, null, 0]);
    expect([colorOf(ret, "O'Fallon", 2), colorOf(ret, 'Columbia Warehouse', 2), colorOf(ret, 'Social Circle', 2)]).toEqual([RED, RED, undefined]);
    expect(rowOf(filed, 'Tax')).toEqual(['Tax', 28.79, null, null]);
    // A dollar short on the return's gross receipts.
    expect(rowOf(filed, 'Gross receipts')).toEqual(['Gross receipts', 1135, 1136, -1]);
    expect([colorOf(filed, 'Gross receipts', 4), colorOf(filed, 'Adjustments', 4)]).toEqual([RED, undefined]);
    expect(rowOf(filed, 'Note: Filed online')).toBeTruthy();
    expect(rowOf(account, '2 more documents not listed')).toBeTruthy();
    expect(rowOf(account, "FleetSuite's books at the end of September 2026")?.[5]).toBe(40);
  });

  it('says when its read fails', async () => {
    state.failing = 'gl_sales_tax_month';
    const res = await download(new NextRequest(`${URL}/download`));
    expect([res.status, await res.json()]).toEqual([500, { error: "Couldn't read the month's documents: boom" }]);
  });
});
