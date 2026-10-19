import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));

import {
  addDays,
  chicagoDate,
  isGeorgia,
  lineTax,
  readOwnInvoiceFacts,
  readSalesOrderCopy,
  ruleLocation,
  saveOwnInvoice,
  savePayload,
  signedAmount,
  workOutOwnInvoice,
  type OwnInvoiceFacts,
  type OwnInvoiceInput,
} from './own-invoices';

const ACME = 'c0000000-0000-4000-8000-00000000000a';
const LOCATIONS = new Map([['1', "O'Fallon"], ['2', 'Wentzville'], ['3', 'Kansas City'], ['5', 'Social Circle']]);

const facts = (over: Partial<OwnInvoiceFacts> = {}): OwnInvoiceFacts => ({
  items: new Map([
    ['55', { number: 'SHELF-1', type: 'InvtPart', taxableOverride: null }],
    ['56', { number: 'LABOR', type: 'Service', taxableOverride: null }],
    ['57', { number: 'KIT-1', type: 'Service', taxableOverride: true }],
    ['59', { number: 'DECAL-1', type: 'NonInvtPart', taxableOverride: false }],
    ['58', { number: 'DISCOUNT', type: 'Discount', taxableOverride: null }],
    ['60', { number: 'SUBTOTAL', type: 'Subtotal', taxableOverride: null }],
  ]),
  customer: { id: ACME, taxExempt: false },
  customerListed: true,
  terms: { id: '4', name: 'Net 30', days: 30 },
  rate: 0.1,
  locations: LOCATIONS,
  ...over,
});

const input = (over: Partial<OwnInvoiceInput> = {}): OwnInvoiceInput => ({
  netsuiteId: '5001',
  netsuiteNumber: 'INV2401',
  madeFrom: 'po',
  madeFromId: 'po-1',
  salesOrderId: null,
  customerNetsuiteId: '9001',
  locationId: '1',
  locationFrom: 'sent',
  poNumber: 'PO-77',
  memo: null,
  vin: null,
  invoiceDate: '2026-10-20',
  lines: [{ itemId: '55', quantity: 2, rate: 125.5 }],
  linesFrom: 'sent',
  madeBy: null,
  ...over,
});

const amounts = (own: ReturnType<typeof workOutOwnInvoice>) => own.lines.map((l) => [l.itemNumber, l.cents, l.taxable, l.taxCents]);

describe('working out FleetSuite\'s own invoice', () => {
  it('taxes each line on its own at the Settings rate, rounded half to even the way NetSuite does', () => {
    const own = workOutOwnInvoice(input({
      lines: [{ itemId: '55', quantity: 1, rate: 0.5 }, { itemId: '55', quantity: 1, rate: 0.5 }],
    }), facts({ rate: 0.05 }));
    // 2.5¢ rounds to 2¢ on each line; worked out on the whole 1.00, the tax would be 5¢.
    expect(amounts(own)).toEqual([['SHELF-1', 50, true, 2], ['SHELF-1', 50, true, 2]]);
    expect(own).toMatchObject({ taxBasis: 'rate', taxRate: 0.05, subtotalCents: 100, taxCents: 4, totalCents: 104, unknowns: [] });
    // And 3.5¢ rounds up to 4¢.
    expect(workOutOwnInvoice(input({ lines: [{ itemId: '55', quantity: 1, rate: 0.7 }] }), facts({ rate: 0.05 })).taxCents).toBe(4);
  });

  it('leaves service items untaxed, lets an admin\'s override win either way, and taxes an item it doesn\'t know', () => {
    const own = workOutOwnInvoice(input({
      lines: [
        { itemId: '56', quantity: 2, rate: 50 },
        { itemId: '57', quantity: 1, rate: 40 },
        { itemId: '59', quantity: 1, rate: 30 },
        { itemId: '99', itemNumber: 'NEW-1', quantity: 1, rate: 20 },
      ],
    }), facts());
    expect(amounts(own)).toEqual([['LABOR', 10000, false, 0], ['KIT-1', 4000, true, 400], ['DECAL-1', 3000, false, 0], ['NEW-1', 2000, true, 200]]);
    expect(own).toMatchObject({ subtotalCents: 19000, taxCents: 600, totalCents: 19600 });
  });

  it('taxes a discount as the line above it, the one it takes money off', () => {
    const own = workOutOwnInvoice(input({
      lines: [
        { itemId: '56', quantity: 1, rate: 100 },
        { itemId: '58', quantity: null, rate: null, cents: -1000 },
        { itemId: '55', quantity: 1, rate: 50 },
        { itemId: '58', quantity: null, rate: null, cents: -500 },
      ],
    }), facts());
    expect(amounts(own)).toEqual([['LABOR', 10000, false, 0], ['DISCOUNT', -1000, false, 0], ['SHELF-1', 5000, true, 500], ['DISCOUNT', -500, true, -50]]);
    expect(own).toMatchObject({ subtotalCents: 13500, taxCents: 450, totalCents: 13950, unknowns: [] });
  });

  it('charges no tax to a customer marked tax-exempt, nor for work at Social Circle, Georgia', () => {
    const exempt = workOutOwnInvoice(input(), facts({ customer: { id: ACME, taxExempt: true } }));
    expect(exempt).toMatchObject({ taxBasis: 'exempt_customer', taxRate: 0, taxCents: 0, totalCents: 25100 });
    expect(exempt.lines[0]).toMatchObject({ taxable: true, taxCents: 0 });

    const georgia = workOutOwnInvoice(input({ locationId: '5' }), facts({ customer: { id: ACME, taxExempt: true } }));
    expect(georgia).toMatchObject({ taxBasis: 'georgia', taxRate: 0, taxCents: 0 });
  });

  it('works out the amount from the quantity and price, to the cent half to even, unless the amount is known', () => {
    const own = workOutOwnInvoice(input({
      lines: [
        { itemId: '55', quantity: 1, rate: 0.125 },
        { itemId: '55', quantity: 3, rate: 0.125 },
        { itemId: '55', quantity: 3, rate: 33.333, cents: 9999 },
      ],
    }), facts({ rate: 0 }));
    expect(own.lines.map((l) => l.cents)).toEqual([12, 38, 9999]);
  });

  it('dates it due by the customer\'s terms in NetSuite, the day it\'s billed when there are none', () => {
    expect(workOutOwnInvoice(input(), facts())).toMatchObject({ termsId: '4', termsName: 'Net 30', termsDays: 30, dueDate: '2026-11-19' });
    expect(workOutOwnInvoice(input({ invoiceDate: '2026-12-15' }), facts())).toMatchObject({ dueDate: '2027-01-14' });
    expect(workOutOwnInvoice(input(), facts({ terms: null }))).toMatchObject({ termsId: null, termsDays: 0, dueDate: '2026-10-20', unknowns: [] });
  });

  it('says when it can\'t work out the due date: a customer NetSuite\'s list doesn\'t have, or terms due on a day of the month', () => {
    expect(workOutOwnInvoice(input(), facts({ customerListed: false, terms: null }))).toMatchObject({
      termsId: null, termsName: null, termsDays: null, dueDate: null, unknowns: ['terms'],
    });
    expect(workOutOwnInvoice(input(), facts({ terms: { id: '9', name: 'Due 10th of month', days: null } }))).toMatchObject({
      termsId: '9', termsName: 'Due 10th of month', termsDays: null, dueDate: null, unknowns: ['terms'],
    });
  });

  it('says what else it didn\'t know rather than guess: the lines, the customer, the location, a price NetSuite set', () => {
    const none = workOutOwnInvoice(input({ lines: null, customerNetsuiteId: null, locationId: null, locationFrom: null }), facts());
    expect(none).toMatchObject({ lines: [], subtotalCents: 0, taxCents: 0, totalCents: 0 });
    expect(none.unknowns).toEqual(['lines', 'customer', 'location']);

    const unpriced = workOutOwnInvoice(input({ lines: [{ itemId: '55', quantity: 2, rate: null }, { itemId: '55', quantity: 1, rate: 10 }] }), facts());
    expect(unpriced.unknowns).toEqual(['prices']);
    expect(unpriced.lines[0]).toMatchObject({ priced: false, cents: 0, taxable: false, taxCents: 0, quantity: 2, rate: null });
    expect(unpriced).toMatchObject({ subtotalCents: 1000, taxCents: 100 });
  });

  it('leaves out the lines that never post and the lines of nothing, numbering the rest in order', () => {
    const own = workOutOwnInvoice(input({
      lines: [
        { itemId: '55', quantity: 1, rate: 10 },
        { itemId: '-2', quantity: null, rate: null, cents: 1000 },
        { itemId: '60', quantity: null, rate: null, cents: 1000 },
        { itemId: '56', quantity: 1, rate: 0 },
        { itemId: '56', quantity: 2, rate: 5, description: 'Install', salesOrderLineId: '7' },
      ],
    }), facts());
    expect(own.lines.map((l) => [l.lineNo, l.itemNumber, l.cents, l.description, l.salesOrderLineId])).toEqual([
      [1, 'SHELF-1', 1000, null, null],
      [2, 'LABOR', 1000, 'Install', '7'],
    ]);
  });

  it('keeps what the invoice was made from as it was given', () => {
    const own = workOutOwnInvoice(input({ madeFrom: 'graphics', madeFromId: 'job-1', vin: '1FTBW3XG0LKA00001', madeBy: 'u-1', memo: 'Wrap' }), facts());
    expect(own).toMatchObject({
      netsuiteId: '5001', netsuiteNumber: 'INV2401', madeFrom: 'graphics', madeFromId: 'job-1', customerId: ACME,
      vin: '1FTBW3XG0LKA00001', madeBy: 'u-1', memo: 'Wrap', poNumber: 'PO-77', locationFrom: 'sent', linesFrom: 'sent',
    });
  });
});

describe('the copy as the database takes it', () => {
  it('writes every amount as signed dollars and the rate to six places', () => {
    const p = savePayload(workOutOwnInvoice(input({
      lines: [{ itemId: '55', quantity: 1, rate: 50 }, { itemId: '58', quantity: null, rate: null, cents: -500 }],
    }), facts()));
    expect(p).toMatchObject({
      netsuite_id: '5001', company: 'BMG', made_from: 'po', customer_netsuite_id: '9001', customer_id: ACME,
      invoice_date: '2026-10-20', location_netsuite_id: '1', location_from: 'sent', terms_netsuite_id: '4', terms_days: 30,
      due_date: '2026-11-19', tax_rule: 'tax@1', tax_basis: 'rate', tax_rate: '0.100000',
      subtotal: '45.00', tax: '4.50', total: '49.50', lines_from: 'sent', unknowns: [],
    });
    expect(p.lines).toEqual([
      { line_no: 1, item_netsuite_id: '55', item_number: 'SHELF-1', description: null, quantity: 1, rate: 50, amount: '50.00', priced: true, taxable: true, tax: '5.00', sales_order_line_id: null },
      { line_no: 2, item_netsuite_id: '58', item_number: 'DISCOUNT', description: null, quantity: null, rate: null, amount: '-5.00', priced: true, taxable: true, tax: '-0.50', sales_order_line_id: null },
    ]);
  });

  it('spells cents the way the database reads them', () => {
    expect([0, 5, -5, -1250, 123456].map(signedAmount)).toEqual(['0.00', '0.05', '-0.05', '-12.50', '1234.56']);
    expect(lineTax(1000, 0)).toBe(0);
    expect(lineTax(-1000, 0.08488)).toBe(-85);
    expect(lineTax(-50, 0.05)).toBe(-2);
  });

  it('dates in Central time and counts days across months and years', () => {
    expect(chicagoDate(new Date('2026-10-20T03:30:00Z'))).toBe('2026-10-19');
    expect(chicagoDate(new Date('2026-10-20T05:30:00Z'))).toBe('2026-10-20');
    expect(addDays('2026-12-15', 30)).toBe('2027-01-14');
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-10-20', 0)).toBe('2026-10-20');
  });
});

describe('where an invoice books', () => {
  it('follows FleetSuite\'s invoice location rule by the customer\'s name, only when the rule is sure', () => {
    expect(ruleLocation('Sample Fleet Co', LOCATIONS)).toBe('1');
    expect(ruleLocation('Masterack - Wentzville', LOCATIONS)).toBe('2');
    expect(ruleLocation('Masterack LLC', LOCATIONS)).toBeNull();
    expect(ruleLocation(null, LOCATIONS)).toBeNull();
    expect(ruleLocation('  ', LOCATIONS)).toBeNull();
  });

  it('names the location by NetSuite\'s list, else by its known id', () => {
    expect(ruleLocation('Designs That Stick', new Map([['11', 'Kansas City']]))).toBe('11');
    expect(ruleLocation('Designs That Stick', new Map())).toBe('3');
  });

  it('knows Social Circle, Georgia by its name in the list, else by its known id', () => {
    expect(isGeorgia('5', LOCATIONS)).toBe(true);
    expect(isGeorgia('5', new Map())).toBe(true);
    expect(isGeorgia('12', new Map([['12', 'Social Circle']]))).toBe(true);
    expect(isGeorgia('5', new Map([['5', 'Wentzville']]))).toBe(false);
    expect(isGeorgia('1', LOCATIONS)).toBe(false);
    expect(isGeorgia(null, LOCATIONS)).toBe(false);
  });
});

// ── Reading what FleetSuite knows, against a fake database ────────────────

type Row = Record<string, unknown>;
type Filter = ['eq' | 'in' | 'is', string, unknown];
interface Query { table: string; filters: Filter[]; single: boolean }

/** Answers supabase-js reads from rows per table (or an error for the table), and records each read. */
function fakeService(tables: Record<string, Row[] | { error: string }>, rpcAnswer: { data?: unknown; error?: { message: string } } = { data: { saved: true, lines: 1 } }) {
  const queries: Query[] = [];
  const answer = (q: Query) => {
    const t = tables[q.table];
    if (t === undefined) throw new Error(`unexpected table ${q.table}`);
    if (!Array.isArray(t)) return { data: null, error: { message: t.error } };
    const rows = t.filter((row) => q.filters.every(([op, col, v]) => (
      op === 'eq' ? String(row[col]) === String(v)
        : op === 'in' ? (v as unknown[]).map(String).includes(String(row[col]))
          : (row[col] ?? null) === v
    )));
    return q.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  };
  const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: rpcAnswer.data ?? null, error: rpcAnswer.error ?? null }));
  const service = {
    from(table: string) {
      const q: Query = { table, filters: [], single: false };
      queries.push(q);
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => { q.filters.push(['eq', c, v]); return b; },
        in: (c: string, v: unknown[]) => { q.filters.push(['in', c, v]); return b; },
        is: (c: string, v: unknown) => { q.filters.push(['is', c, v]); return b; },
        maybeSingle: async () => { q.single = true; return answer(q); },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(() => answer(q)).then(res, rej),
      };
      return b;
    },
    rpc,
  };
  return { service: service as unknown as SupabaseClient, queries, rpc };
}

const SO_ID = 'a0000000-0000-4000-8000-000000000700';
const soLine = (line: string, item: string | null, quantity: number, billed: number, rate: number | null, amount: number | null) => ({
  so_id: SO_ID, line_id: line, item_netsuite_id: item, item_number: null, description: null, quantity, quantity_billed: billed, rate, amount,
});

const lists = (): Row[] => [
  { kind: 'item', netsuite_id: '55', name: 'SHELF-1', details: { item_type: 'InvtPart' }, gone_at: null },
  { kind: 'item', netsuite_id: '56', name: 'LABOR', details: { item_type: 'Service' }, gone_at: null },
  { kind: 'item', netsuite_id: '58', name: 'DISCOUNT', details: { item_type: 'Discount' }, gone_at: null },
  { kind: 'item', netsuite_id: '62', name: 'MARKUP', details: { item_type: 'Markup' }, gone_at: null },
  { kind: 'location', netsuite_id: '1', name: "O'Fallon", details: {}, gone_at: null },
  { kind: 'location', netsuite_id: '2', name: 'Wentzville', details: {}, gone_at: null },
  { kind: 'customer', netsuite_id: '9001', name: 'Sample Fleet Co', details: { terms_id: '4', taxable: 'T' }, gone_at: null },
  { kind: 'customer', netsuite_id: '9002', name: 'Pat Example', details: {}, gone_at: null },
  { kind: 'customer', netsuite_id: '9003', name: 'Gone Co', details: { terms_id: '4' }, gone_at: '2026-10-01T00:00:00Z' },
  { kind: 'term', netsuite_id: '4', name: 'Net 30', details: { days_until_net_due: 30 }, gone_at: null },
];

const database = (over: Record<string, Row[] | { error: string }> = {}) => ({
  gl_netsuite_lists: lists(),
  netsuite_parts: [],
  customers: [{ id: ACME, netsuite_id: '9001', tax_exempt: false }],
  quote_settings: [{ id: 1, sales_tax_rate_pct: 8.488 }],
  netsuite_sales_orders: [{ id: SO_ID, netsuite_id: '700', customer_netsuite_id: '9001', customer_name: 'Sample Fleet Co', otherrefnum: 'PO-77', memo: 'Upfit', vin: '1FTBW3XG0LKA00001' }],
  netsuite_sales_order_lines: [
    soLine('1', '55', 2, 0, 125.5, 251),
    soLine('2', '56', 3, 0, 95, 285),
    soLine('3', '58', 0, 0, null, 20),
  ],
  ...over,
});

describe('reading what FleetSuite knows', () => {
  it('reads the items\' types from the lists copy and an admin\'s tax override from the catalog', async () => {
    const { service } = fakeService(database({
      netsuite_parts: [
        { netsuite_id: '55', item_number: 'SHELF-1', item_type: 'InvtPart', taxable_override: true },
        { netsuite_id: '61', item_number: 'TOW-1', item_type: 'Service', taxable_override: null },
      ],
    }));
    const f = await readOwnInvoiceFacts(service, '9001', ['55', '61', '56', 'x']);
    expect([...f.items]).toEqual([
      ['55', { number: 'SHELF-1', type: 'InvtPart', taxableOverride: true }],
      ['56', { number: 'LABOR', type: 'Service', taxableOverride: null }],
      ['61', { number: 'TOW-1', type: 'Service', taxableOverride: null }],
    ]);
    expect(f).toMatchObject({ customer: { id: ACME, taxExempt: false }, customerListed: true, terms: { id: '4', name: 'Net 30', days: 30 } });
    expect(f.rate).toBeCloseTo(0.08488, 10);
    expect([...f.locations]).toEqual([['1', "O'Fallon"], ['2', 'Wentzville']]);
  });

  it('tells a customer with no terms from one NetSuite\'s list doesn\'t have, or no longer has', async () => {
    const { service } = fakeService(database());
    expect(await readOwnInvoiceFacts(service, '9002', [])).toMatchObject({ customerListed: true, terms: null, customer: null });
    expect(await readOwnInvoiceFacts(service, '9003', [])).toMatchObject({ customerListed: false, terms: null });
    expect(await readOwnInvoiceFacts(service, null, [])).toMatchObject({ customerListed: false, terms: null, customer: null });
  });

  it('names terms it has no copy of by their id, without a number of days', async () => {
    const db = database();
    (db.gl_netsuite_lists as Row[]).splice((db.gl_netsuite_lists as Row[]).findIndex((r) => r.kind === 'term'), 1);
    const { service } = fakeService(db);
    expect((await readOwnInvoiceFacts(service, '9001', [])).terms).toEqual({ id: '4', name: 'Terms 4', days: null });
  });

  it('counts a customer tax-exempt only when every FleetSuite record with its NetSuite id is', async () => {
    const two = (a: boolean | null, b: boolean | null) => fakeService(database({
      customers: [{ id: ACME, netsuite_id: '9001', tax_exempt: a }, { id: 'c-2', netsuite_id: '9001', tax_exempt: b }],
    })).service;
    expect((await readOwnInvoiceFacts(two(true, true), '9001', [])).customer).toEqual({ id: null, taxExempt: true });
    expect((await readOwnInvoiceFacts(two(true, null), '9001', [])).customer).toEqual({ id: null, taxExempt: false });
  });

  it('doesn\'t look up items when there are none, and fails whole when a read fails', async () => {
    const { service, queries } = fakeService(database());
    await readOwnInvoiceFacts(service, '9001', []);
    expect(queries.some((q) => q.table === 'netsuite_parts')).toBe(false);
    expect(queries.filter((q) => q.table === 'gl_netsuite_lists').some((q) => q.filters.some(([, , v]) => v === 'item'))).toBe(false);

    await expect(readOwnInvoiceFacts(fakeService(database({ customers: { error: 'timeout' } })).service, '9001', ['55'])).rejects.toThrow('timeout');
  });
});

describe('reading what a sales order still had to bill', () => {
  it('bills each open line, a whole line at the order\'s own amount and a part at its price, with the discount', async () => {
    const { service } = fakeService(database());
    const so = await readSalesOrderCopy(service, '700');
    expect(so).toMatchObject({ customerNetsuiteId: '9001', customerName: 'Sample Fleet Co', poNumber: 'PO-77', memo: 'Upfit', vin: '1FTBW3XG0LKA00001' });
    expect(so.lines).toEqual([
      { itemId: '55', itemNumber: null, description: null, quantity: 2, rate: 125.5, cents: 25100, salesOrderLineId: '1' },
      { itemId: '56', itemNumber: null, description: null, quantity: 3, rate: 95, cents: 28500, salesOrderLineId: '2' },
      { itemId: '58', itemNumber: null, description: null, quantity: null, rate: null, cents: -2000, salesOrderLineId: '3' },
    ]);
  });

  it('bills what\'s left of a part-billed order, without the discount and markup its first invoice took', async () => {
    const { service } = fakeService(database({
      netsuite_sales_order_lines: [
        soLine('10', '55', 3, 1, 125.5, 376.5),
        soLine('9', '56', 3, 3, 95, 285),
        soLine('11', '58', 0, 0, null, 20),
        soLine('12', '62', 0, 0, null, 15),
      ],
    }));
    expect((await readSalesOrderCopy(service, '700')).lines).toEqual([
      { itemId: '55', itemNumber: null, description: null, quantity: 2, rate: 125.5, cents: null, salesOrderLineId: '10' },
    ]);
  });

  it('keeps the lines in the order\'s order, a free line as nothing, and a markup as money added', async () => {
    const { service } = fakeService(database({
      netsuite_sales_order_lines: [
        soLine('10', '62', 0, 0, null, 15),
        soLine('9', '55', 1, 0, null, null),
        soLine('2', '56', 1, 0, 95, 95),
      ],
    }));
    expect((await readSalesOrderCopy(service, '700')).lines!.map((l) => [l.salesOrderLineId, l.rate, l.cents])).toEqual([
      ['2', 95, 9500],
      ['9', 0, 0],
      ['10', null, 1500],
    ]);
  });

  it('has no lines for an order FleetSuite hasn\'t copied yet, and doesn\'t look up items for an order without any', async () => {
    const { service, queries } = fakeService(database({ netsuite_sales_order_lines: [] }));
    expect(await readSalesOrderCopy(service, '701')).toEqual({ customerNetsuiteId: null, customerName: null, poNumber: null, memo: null, vin: null, lines: null });
    expect((await readSalesOrderCopy(service, '700')).lines).toEqual([]);
    expect(queries.filter((q) => q.table === 'gl_netsuite_lists')).toEqual([]);
  });
});

describe('saving the copy', () => {
  const AT = new Date('2026-10-19T15:00:00Z');
  const payloadOf = (rpc: ReturnType<typeof fakeService>['rpc']) => (rpc.mock.calls[0][1] as { p: Record<string, any> }).p;
  afterEach(() => { vi.restoreAllMocks(); });

  it('saves what FleetSuite sent, at the location it gave, without reading a sales order', async () => {
    const { service, rpc, queries } = fakeService(database());
    const r = await saveOwnInvoice(service, {
      netsuiteId: '5001', netsuiteNumber: 'INV2401', madeFrom: 'po', madeFromId: 'po-1', madeBy: 'u-1',
      customerNetsuiteId: '9001', locationId: 2, poNumber: 'PO-9', memo: 'Invoice from BMG FleetSuite',
      billed: [{ itemId: '55', quantity: 1, rate: 100, description: 'Shelf' }],
    }, AT);
    expect(r).toEqual({ saved: true });
    expect(rpc).toHaveBeenCalledWith('gl_own_invoice_save', expect.anything());
    expect(payloadOf(rpc)).toMatchObject({
      netsuite_id: '5001', made_from: 'po', made_by: 'u-1', location_netsuite_id: '2', location_from: 'sent', lines_from: 'sent',
      sales_order_id: null, invoice_date: '2026-10-19', due_date: '2026-11-18', subtotal: '100.00', tax: '8.49', total: '108.49',
    });
    expect(queries.some((q) => q.table === 'netsuite_sales_orders')).toBe(false);
  });

  it('bills a vehicle\'s sales order whole from FleetSuite\'s copy of it, for the order\'s customer, where the rule books it', async () => {
    const { service, rpc } = fakeService(database());
    const r = await saveOwnInvoice(service, {
      netsuiteId: '5003', madeFrom: 'vehicle', madeFromId: 'checkin-1', salesOrderId: '700', customerNetsuiteId: '9999', vin: null,
    }, AT);
    expect(r).toEqual({ saved: true });
    const p = payloadOf(rpc);
    expect(p).toMatchObject({
      made_from: 'vehicle', sales_order_id: '700', customer_netsuite_id: '9001', customer_id: ACME,
      location_netsuite_id: '1', location_from: 'rule', lines_from: 'sales_order_copy',
      po_number: 'PO-77', memo: 'Upfit', vin: '1FTBW3XG0LKA00001',
      // The discount follows the labor above it, so it's untaxed.
      subtotal: '516.00', tax: '21.30', total: '537.30', unknowns: [],
    });
    expect(p.lines.map((l: Row) => [l.item_number, l.amount, l.tax])).toEqual([['SHELF-1', '251.00', '21.30'], ['LABOR', '285.00', '0.00'], ['DISCOUNT', '-20.00', '0.00']]);
  });

  it('says it doesn\'t know where a Masterack order books when the rule isn\'t sure', async () => {
    const db = database();
    (db.netsuite_sales_orders as Row[])[0].customer_name = 'Masterack LLC';
    const { service, rpc } = fakeService(db);
    await saveOwnInvoice(service, { netsuiteId: '5004', madeFrom: 'vehicle', salesOrderId: '700' }, AT);
    expect(payloadOf(rpc)).toMatchObject({ location_netsuite_id: null, location_from: null, unknowns: ['location'] });
  });

  it('bills a sales order\'s installed quantities as sent, for the order\'s customer', async () => {
    const { service, rpc } = fakeService(database());
    await saveOwnInvoice(service, {
      netsuiteId: '5005', madeFrom: 'sales_order', salesOrderId: '700', customerNetsuiteId: '9001', locationId: '1',
      billed: [{ itemId: '55', quantity: 1, rate: 125.5, salesOrderLineId: '1' }],
    }, AT);
    expect(payloadOf(rpc)).toMatchObject({ lines_from: 'sent', location_from: 'sent', subtotal: '125.50', sales_order_id: '700' });
  });

  it('never throws: an invoice with no id, a failed read or a refused save is only logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service, rpc, queries } = fakeService(database());
    expect(await saveOwnInvoice(service, { netsuiteId: undefined, madeFrom: 'po' })).toEqual({ saved: false, reason: "NetSuite didn't say which invoice it made" });
    expect(await saveOwnInvoice(service, { netsuiteId: 'INV1', madeFrom: 'po' })).toMatchObject({ saved: false });
    expect(queries).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();

    const failing = fakeService(database({ netsuite_sales_orders: { error: 'statement timeout' } }));
    expect(await saveOwnInvoice(failing.service, { netsuiteId: '5006', madeFrom: 'vehicle', salesOrderId: '700' }, AT))
      .toEqual({ saved: false, reason: 'statement timeout' });
    expect(failing.rpc).not.toHaveBeenCalled();

    const refused = fakeService(database(), { error: { message: "an own invoice's lines don't add up" } });
    expect(await saveOwnInvoice(refused.service, { netsuiteId: '5007', madeFrom: 'po', customerNetsuiteId: '9001', billed: [] }, AT))
      .toEqual({ saved: false, reason: "an own invoice's lines don't add up" });
    expect(error).toHaveBeenCalledWith("[books] own copy of NetSuite invoice 5007 not saved: an own invoice's lines don't add up");
  });

  it('says so when the invoice was already saved', async () => {
    const { service } = fakeService(database(), { data: { saved: false, lines: 0 } });
    expect(await saveOwnInvoice(service, { netsuiteId: '5001', madeFrom: 'po', billed: [] }, AT)).toEqual({ saved: false, reason: 'already saved' });
  });
});
