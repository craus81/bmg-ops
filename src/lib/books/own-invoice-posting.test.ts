import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workOutMonth, type ChartAccount, type InvoiceMonthData, type LineFactsRead } from './invoice-check';
import { entryLines } from './invoice-posting';
import type { OwnCheckStatus, OwnInvoiceCheck, OwnInvoiceData, OwnLineData, OwnPairsData } from './own-invoice-check';
import { ownBooks, ownCopyDays, ownEntry, ownPick, readOwnCopies, salesTaxAccount, type OwnCopy, type OwnMonth } from './own-invoice-posting';

// Made-up books: '120' receivable, '400' income, '220' sales tax payable; '221' is 1084's sales tax, '229' a summary.
const CHART: ChartAccount[] = [
  { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
  { netsuite_account_id: '400', number: '4000', name: 'Sales', account_type: 'income', company: null, active: true, is_summary: false },
  { netsuite_account_id: '220', number: '2200', name: 'Sales Tax', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
  { netsuite_account_id: '221', number: '2210', name: '1084 Sales Tax', account_type: 'other_current_liability', company: '1084', active: true, is_summary: false },
  { netsuite_account_id: '229', number: '2290', name: 'Taxes', account_type: 'other_current_liability', company: null, active: true, is_summary: true },
];
const ITEMS: InvoiceMonthData['items'] = [
  { kind: 'item', netsuite_id: '11', name: 'PART-A', item_type: 'InvtPart', income_account: '400', asset_account: '130' },
  { kind: 'item', netsuite_id: '13', name: 'INSTALL LABOR', item_type: 'Service', income_account: '400', asset_account: null },
  { kind: 'item', netsuite_id: '14', name: 'GRAPHICS INSTALL LABOR', item_type: 'Service', income_account: '400', asset_account: null },
  { kind: 'tax_code', netsuite_id: '900', name: 'Some County', item_type: null, income_account: null, asset_account: null },
];
const TAX = [{ tax_code_id: '900', account_id: '220', lines: 40 }];
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
const OTHER_CUSTOMER = '0b6d3c1e-5f2a-4c7d-8e9f-1a2b3c4d5e6f';

type Invoice = InvoiceMonthData['invoices'][number];

// A part and labor plus tax, as NetSuite posts it.
const invoice = (fields: Partial<Invoice> = {}): Invoice => ({
  id: 'id-101', doc_type: 'invoice', netsuite_id: '101', number: 'INV101', date: '2026-10-15', total: '162.00', voided: false,
  customer: 'A Customer', customer_id: CUSTOMER, lines_copied: true, companies: ['BMG'],
  lines: [
    { line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '100.00', netamount: '-100' },
    { line_id: '2', line_no: 2, kind: 'item', item_id: '13', item_number: 'INSTALL LABOR', amount: '50.00', netamount: '-50' },
    { line_id: '3', line_no: 3, kind: 'tax', item_id: '900', item_number: null, amount: '12.00', netamount: '-12' },
  ],
  netsuite: [
    { line_id: '0', account: '120', debit: '162.00', credit: '0.00' },
    { line_id: '1', account: '400', debit: '0.00', credit: '100.00' },
    { line_id: '2', account: '400', debit: '0.00', credit: '50.00' },
    { line_id: '3', account: '220', debit: '0.00', credit: '12.00' },
  ],
  ...fields,
});

const FACTS: LineFactsRead = { lines: new Map(), missing: [] };
const month = (inv: Invoice = invoice(), opts: { taxAccounts?: typeof TAX | null; company?: string } = {}) =>
  workOutMonth({ invoices: [inv], items: ITEMS }, {
    company: opts.company ?? 'BMG', chart: CHART, taxAccounts: opts.taxAccounts === undefined ? TAX : opts.taxAccounts, facts: FACTS,
  });

/** What ownPick is given for the month: what it was worked out with, and the sales tax account. */
const ownMonth = (worked: ReturnType<typeof month>, salesTax: string | null = '220', company = 'BMG'): OwnMonth => ({
  company, accounts: worked.accounts, names: worked.names, salesTax,
});

const ownLine = (over: Partial<OwnLineData> = {}): OwnLineData => ({
  line_no: 1, item_id: '11', item_number: 'PART-A', description: null, quantity: '1', rate: '100', amount: '100.00',
  priced: true, taxable: true, tax: '12.00', sales_order_line_id: null, ...over,
});
const LABOR = ownLine({ line_no: 2, item_id: '13', item_number: 'INSTALL LABOR', rate: '50', amount: '50.00', taxable: false, tax: '0.00' });

// FleetSuite's own copy of INV101, billing what NetSuite's does.
const own = (over: Partial<OwnInvoiceData> = {}): OwnInvoiceData => ({
  netsuite_id: '101', number: 'INV101', made_from: 'po', made_from_id: 'po-1', sales_order_id: null,
  customer_netsuite_id: '9001', customer_id: CUSTOMER, date: '2026-10-15', location_id: '1', location_from: 'sent',
  po_number: null, memo: null, vin: null, terms_id: '4', terms_name: 'Net 30', terms_days: 30, due_date: '2026-11-14',
  tax_rule: 'tax@1', tax_basis: 'rate', tax_rate: '0.080000', subtotal: '150.00', tax: '12.00', total: '162.00',
  lines_from: 'sent', unknowns: [], made_at: '2026-10-15T15:00:00Z', lines: [ownLine(), LABOR], ...over,
});

/** A copy as the check left it: only its status and what it didn't know matter here. */
const copy = (status: OwnCheckStatus = 'matches', over: Partial<OwnInvoiceData> = {}, unknowns: string[] = []): OwnCopy => ({
  own: own(over), check: { status, unknowns } as OwnInvoiceCheck,
});

/** What the books post for INV101 as it is now, given its copy. */
const pick = (c: OwnCopy | undefined, inv: Invoice = invoice(), salesTax: string | null = '220', company = 'BMG') => {
  const worked = month(inv);
  const w = worked.invoices[0];
  return ownPick(w, entryLines(w), c, ownMonth(worked, salesTax, company));
};

describe('the sales tax account', () => {
  it('is the account NetSuite\'s sales tax posted to most, across its tax codes, of those the company can use', () => {
    const counts = [
      { tax_code_id: '900', account_id: '220', lines: 10 },
      { tax_code_id: '901', account_id: '220', lines: 15 },
      { tax_code_id: '902', account_id: '221', lines: 20 },
    ];
    expect(salesTaxAccount(counts, CHART, 'BMG')).toBe('220');
    // 1084's own account is one BMG can't use.
    expect(salesTaxAccount([{ tax_code_id: '902', account_id: '221', lines: 90 }, ...counts], CHART, 'BMG')).toBe('220');
    expect(salesTaxAccount([{ tax_code_id: '902', account_id: '221', lines: 90 }, ...counts], CHART, '1084')).toBe('221');
  });

  it('leaves out summaries and accounts the chart doesn\'t have, and takes the lower id of two that tie', () => {
    expect(salesTaxAccount([{ tax_code_id: '900', account_id: '229', lines: 90 }, { tax_code_id: '901', account_id: '999', lines: 80 }], CHART, 'BMG')).toBeNull();
    const twoAccounts: ChartAccount[] = [...CHART, { ...CHART[2], netsuite_account_id: '219', number: '2190' }];
    expect(salesTaxAccount([{ tax_code_id: '900', account_id: '220', lines: 5 }, { tax_code_id: '901', account_id: '219', lines: 5 }], twoAccounts, 'BMG')).toBe('219');
  });

  it('isn\'t known before the lists copy has counted them', () => {
    expect(salesTaxAccount(null, CHART, 'BMG')).toBeNull();
    expect(salesTaxAccount([], CHART, 'BMG')).toBeNull();
  });
});

describe('the own copy\'s entry', () => {
  const accounts = month().accounts;

  it('is the invoice rule on its lines, its sales tax to the sales tax account and the receivable its total', () => {
    expect(ownEntry(own(), accounts, '220')).toEqual({
      lines: [
        { account: '120', cents: 16200, lineId: '0', itemNumber: null, division: null },
        { account: '400', cents: -10000, lineId: 'own:1', itemNumber: 'PART-A', division: 'upfit' },
        { account: '400', cents: -5000, lineId: 'own:2', itemNumber: 'INSTALL LABOR', division: 'upfit' },
        { account: '220', cents: -1200, lineId: 'own:tax', itemNumber: null, division: null },
      ],
      problems: [],
    });
  });

  it('has no tax line when the copy charged none, and needs no sales tax account then', () => {
    const untaxed = ownEntry(own({ tax: '0.00', total: '150.00', lines: [ownLine({ tax: '0.00', taxable: false }), LABOR] }), accounts, null);
    expect(untaxed.problems).toEqual([]);
    expect(untaxed.lines.map((l) => [l.lineId, l.cents])).toEqual([['0', 15000], ['own:1', -10000], ['own:2', -5000]]);
  });

  it('can\'t be worked out without a sales tax account for its tax, or with an item the lists don\'t have', () => {
    expect(ownEntry(own(), accounts, null)).toEqual({ lines: [], problems: [{ kind: 'no_tax_account', lineId: 'own:tax', taxCode: '' }] });
    expect(ownEntry(own({ lines: [ownLine({ item_id: '77', item_number: 'NEW-PART' }), LABOR] }), accounts, '220').problems)
      .toEqual([{ kind: 'not_copied', lineId: 'own:1', itemId: '77', itemNumber: 'NEW-PART' }]);
  });
});

describe('what the books post for an invoice FleetSuite has its own copy of', () => {
  it('posts the copy\'s entry when it matches NetSuite\'s invoice and makes the same entry', () => {
    const p = pick(copy());
    expect(p).toEqual({
      entry: {
        lines: [
          { account: '120', cents: 16200, lineId: '0', itemNumber: null, division: null },
          { account: '400', cents: -10000, lineId: 'own:1', itemNumber: 'PART-A', division: 'upfit' },
          { account: '400', cents: -5000, lineId: 'own:2', itemNumber: 'INSTALL LABOR', division: 'upfit' },
          { account: '220', cents: -1200, lineId: 'own:tax', itemNumber: null, division: null },
        ],
        date: '2026-10-15',
        customerId: CUSTOMER,
      },
      why: null,
    });
    // Lines split another way that come to the same in each account and division move nothing, so the copy still posts.
    const split = copy('matches', { lines: [ownLine({ amount: '90.00', rate: '90' }), { ...LABOR, amount: '60.00', rate: '60' }] });
    expect(pick(split)?.entry?.lines.map((l) => l.cents)).toEqual([16200, -9000, -6000, -1200]);
  });

  it('dates the entry in the month NetSuite booked the invoice into, as NetSuite\'s is', () => {
    const booked = invoice({ date: '2026-09-30', posting_month: '2026-10-01' });
    const p = pick(copy('matches', { date: '2026-09-30' }), booked);
    expect(p?.entry?.date).toBe('2026-10-01');
  });

  it('has no say without a copy, or for a credit memo, another company\'s invoice or one posted to both', () => {
    expect(pick(undefined)).toBeNull();
    expect(pick(copy(), invoice({ doc_type: 'credit_memo' }))).toBeNull();
    expect(pick(copy(), invoice({ companies: ['1084'] }), '220', '1084')).toBeNull();
    expect(pick(copy(), invoice({ companies: ['BMG', '1084'] }))).toBeNull();
  });

  it('posts NetSuite\'s while the copy differs, is incomplete or waits, and says why', () => {
    expect(pick(copy('differs'))).toEqual({
      entry: null,
      why: "FleetSuite's own copy differs from NetSuite's invoice, so the books post NetSuite's, since that's what the customer was billed.",
    });
    expect(pick(copy('incomplete', {}, ["the customer's terms", 'which location it books to']))).toEqual({
      entry: null,
      why: "FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's invoice: "
        + "FleetSuite didn't know the customer's terms and which location it books to.",
    });
    expect(pick(copy('waiting'))).toEqual({
      entry: null, why: "FleetSuite's own copy is waiting for NetSuite's invoice to be copied, so the books post NetSuite's for now.",
    });
    expect(pick(copy('voided'))).toEqual({ entry: null, why: null });
  });

  it('leaves it to the invoice rule when NetSuite\'s invoice can\'t be worked out yet or isn\'t copied whole', () => {
    const unworkable = month(invoice(), { taxAccounts: null });
    const w = unworkable.invoices[0];
    expect(w.checked.status).toBe('unworkable');
    expect(ownPick(w, entryLines(w), copy(), ownMonth(unworkable))).toEqual({ entry: null, why: null });
    expect(pick(copy(), invoice({ lines_copied: false }))).toEqual({ entry: null, why: null });
  });

  it('posts NetSuite\'s when the copy\'s entry can\'t be worked out, and says why', () => {
    expect(pick(copy(), invoice(), null)).toEqual({
      entry: null,
      why: "FleetSuite's own copy matches NetSuite's invoice, but its entry can't be worked out, so the books post NetSuite's. "
        + "FleetSuite doesn't know which account its sales tax goes to yet: it takes the one NetSuite's sales tax has posted to most "
        + 'since January 2025, as of the last copy of the NetSuite lists.',
    });
    const unknownItem = pick(copy('matches', { lines: [ownLine({ item_id: '77', item_number: 'NEW-PART' }), LABOR] }));
    expect(unknownItem?.entry).toBeNull();
    expect(unknownItem?.why).toMatch(/^FleetSuite's own copy matches NetSuite's invoice, but its entry can't be worked out, so the books post NetSuite's\. \S/);
  });

  it('posts NetSuite\'s when the copy\'s entry would move the books, naming the accounts, the customer or the date', () => {
    const lead = "FleetSuite's own copy matches NetSuite's invoice, but its entry doesn't match NetSuite's, so the books post NetSuite's: ";
    // Its sales tax to another account.
    expect(pick(copy(), invoice(), '221')).toEqual({ entry: null, why: `${lead}it posts differently to 2200 Sales Tax and 2210 1084 Sales Tax.` });
    // Labor billed as graphics labor: the same account, another division.
    const graphics = copy('matches', { lines: [ownLine(), { ...LABOR, item_id: '14', item_number: 'GRAPHICS INSTALL LABOR' }] });
    expect(pick(graphics)).toEqual({ entry: null, why: `${lead}it posts differently to 4000 Sales (Graphics) and 4000 Sales (Upfit).` });
    // More tax: the receivable and the sales tax both differ.
    expect(pick(copy('matches', { tax: '13.00', total: '163.00' }))?.why).toBe(`${lead}it posts differently to 1200 Receivables and 2200 Sales Tax.`);
    expect(pick(copy('matches', { customer_id: OTHER_CUSTOMER }))?.why).toBe(`${lead}its receivable is for another FleetSuite customer.`);
    expect(pick(copy('matches', { customer_id: null }))?.why).toBe(`${lead}its receivable is for no FleetSuite customer.`);
    expect(pick(copy('matches', { date: '2026-10-16' }))?.why).toBe(`${lead}it's dated Oct 16, 2026, and NetSuite's Oct 15, 2026.`);
    expect(pick(copy('matches', { date: '2026-10-16', customer_id: null }))?.why)
      .toBe(`${lead}it's dated Oct 16, 2026, and NetSuite's Oct 15, 2026; its receivable is for no FleetSuite customer.`);
  });
});

describe('the days a month\'s copies are made on', () => {
  const dates = [{ date: '2026-10-03' }, { date: '2026-10-20' }, { date: '2026-10-11' }];

  it('are the days its invoices are dated across, none before FleetSuite could have one', () => {
    expect(ownCopyDays(dates)).toEqual({ from: '2026-10-03', to: '2026-10-20' });
    expect(ownCopyDays(dates, '2026-10-01')).toEqual({ from: '2026-10-03', to: '2026-10-20' });
    expect(ownCopyDays(dates, '2026-10-15')).toEqual({ from: '2026-10-15', to: '2026-10-20' });
    expect(ownCopyDays(dates, '2026-10-20')).toEqual({ from: '2026-10-20', to: '2026-10-20' });
  });

  it('are none for a month with no invoices, or one ending before FleetSuite made any', () => {
    expect(ownCopyDays([])).toBeNull();
    expect(ownCopyDays(dates, '2026-10-21')).toBeNull();
  });
});

describe('what the books hold for each invoice', () => {
  it('is the entry that stands and the copy its rule says it was made from, by NetSuite\'s id', () => {
    const current = (entry_no: number, posting_rule?: string) => ({ id: `e${entry_no}`, entry_no, entry_date: '2026-10-15', posting_rule });
    const books = ownBooks([
      { source_type: 'invoice', source_id: '101', current: current(7, 'own_invoice@1') },
      { source_type: 'invoice', source_id: '102', current: current(8, 'invoice@1') },
      { source_type: 'invoice', source_id: '103', current: current(9) },
      { source_type: 'invoice', source_id: '104', current: null },
      { source_type: 'credit_memo', source_id: '105', current: current(10, 'credit_memo@1') },
    ]);
    expect([...books]).toEqual([
      ['101', { entryNo: 7, date: '2026-10-15', from: 'fleetsuite' }],
      ['102', { entryNo: 8, date: '2026-10-15', from: 'netsuite' }],
      ['103', { entryNo: 9, date: '2026-10-15', from: 'netsuite' }],
    ]);
  });
});

describe('reading the copies', () => {
  const pairs: OwnPairsData = {
    invoices: [{
      own: own(),
      netsuite: {
        number: 'INV101', date: '2026-10-15', due_date: '2026-11-14', total: '162.00', customer_netsuite_id: '9001',
        customer_name: 'A Customer', po_number: null, memo: null, status: 'Open', voided: false, deleted: false,
        lines_copied: true, changed_at: null, copied_at: null,
        lines: [
          { line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', description: null, quantity: '1', rate: '100', amount: '100.00', netamount: '-100.00' },
          { line_id: '2', line_no: 2, kind: 'item', item_id: '13', item_number: 'INSTALL LABOR', description: null, quantity: '1', rate: '50', amount: '50.00', netamount: '-50.00' },
          { line_id: '3', line_no: 3, kind: 'tax', item_id: '900', item_number: null, description: null, quantity: null, rate: null, amount: '12.00', netamount: '-12.00' },
        ],
      },
      netsuite_gl: { location_id: '1' },
      customer_name: 'A Customer',
      customer_list: { terms_id: '4', taxable: 'T' },
    }],
    items: { 11: { number: 'PART-A', type: 'InvtPart' }, 13: { number: 'INSTALL LABOR', type: 'Service' } },
    tax_codes: { 900: { name: 'Some County', rate: '8%' } },
    locations: { 1: "O'Fallon" },
    terms: { 4: { name: 'Net 30', days: 30 } },
  };
  const service = (result: { data: unknown; error: { message: string } | null }, calls: unknown[] = []) =>
    ({ rpc: async (fn: string, args: unknown) => { calls.push([fn, args]); return result; } }) as unknown as SupabaseClient;

  it('checks each copy of the days asked for against NetSuite\'s invoice, by NetSuite\'s id', async () => {
    const calls: unknown[] = [];
    const copies = await readOwnCopies(service({ data: pairs, error: null }, calls), '2026-10-01', '2026-10-31');
    expect(calls).toEqual([['gl_own_invoice_pairs', { p_from: '2026-10-01', p_to: '2026-10-31', p_netsuite_id: null }]]);
    expect([...copies.keys()]).toEqual(['101']);
    expect(copies.get('101')?.check.status).toBe('matches');
    expect(copies.get('101')?.own.total).toBe('162.00');
  });

  it('says why when they can\'t be read, and finds none in an empty answer', async () => {
    await expect(readOwnCopies(service({ data: null, error: { message: 'canceling statement due to statement timeout' } }), '2026-10-01', '2026-10-31'))
      .rejects.toThrow('canceling statement due to statement timeout');
    expect((await readOwnCopies(service({ data: null, error: null }), '2026-10-01', '2026-10-31')).size).toBe(0);
  });
});
