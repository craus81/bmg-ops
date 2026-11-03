import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { workOutMonth, type ChartAccount, type InvoiceMonthData, type LineFactsRead } from './invoice-check';
import { entryLines } from './invoice-posting';
import type { OwnCreditLineData, OwnCreditMemoCheck, OwnCreditMemoData, OwnCreditPairsData, OwnCreditStatus } from './own-credit-memo-check';
import {
  CREDIT_MEMO_WORDS, OWN_CREDIT_MEMO_RULE, ownCreditEntry, ownCreditPick, readOwnCreditCopies, readOwnCreditSince, type OwnCreditCopy,
} from './own-credit-memo-posting';
import type { OwnMonth } from './own-invoice-posting';

// Made-up books: '120' receivable, '400' income, '410' discounts given, '220' sales tax payable; '221' is 1084's sales tax.
const CHART: ChartAccount[] = [
  { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
  { netsuite_account_id: '400', number: '4000', name: 'Sales', account_type: 'income', company: null, active: true, is_summary: false },
  { netsuite_account_id: '410', number: '4100', name: 'Discounts Given', account_type: 'income', company: null, active: true, is_summary: false },
  { netsuite_account_id: '220', number: '2200', name: 'Sales Tax', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
  { netsuite_account_id: '221', number: '2210', name: '1084 Sales Tax', account_type: 'other_current_liability', company: '1084', active: true, is_summary: false },
];
const ITEMS: InvoiceMonthData['items'] = [
  { kind: 'item', netsuite_id: '11', name: 'PART-A', item_type: 'InvtPart', income_account: '400', asset_account: '130' },
  { kind: 'item', netsuite_id: '13', name: 'INSTALL LABOR', item_type: 'Service', income_account: '400', asset_account: null },
  { kind: 'item', netsuite_id: '14', name: 'GRAPHICS INSTALL LABOR', item_type: 'Service', income_account: '400', asset_account: null },
  { kind: 'item', netsuite_id: '15', name: 'DISCOUNT', item_type: 'Discount', income_account: '410', asset_account: null },
  { kind: 'tax_code', netsuite_id: '900', name: 'Some County', item_type: null, income_account: null, asset_account: null },
];
const TAX = [{ tax_code_id: '900', account_id: '220', lines: 40 }];
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
const OTHER_CUSTOMER = '0b6d3c1e-5f2a-4c7d-8e9f-1a2b3c4d5e6f';

type Invoice = InvoiceMonthData['invoices'][number];

// CM105 gives back a part and labor with the part's tax, as NetSuite posts it: the receivable credited, the rest debited.
const memo = (fields: Partial<Invoice> = {}): Invoice => ({
  id: 'id-105', doc_type: 'credit_memo', netsuite_id: '105', number: 'CM105', date: '2026-10-20', total: '162.00', voided: false,
  customer: 'A Customer', customer_id: CUSTOMER, lines_copied: true, companies: ['BMG'],
  lines: [
    { line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '100.00', netamount: '100' },
    { line_id: '2', line_no: 2, kind: 'item', item_id: '13', item_number: 'INSTALL LABOR', amount: '50.00', netamount: '50' },
    { line_id: '3', line_no: 3, kind: 'tax', item_id: '900', item_number: null, amount: '12.00', netamount: '12' },
  ],
  netsuite: [
    { line_id: '0', account: '120', debit: '0.00', credit: '162.00' },
    { line_id: '1', account: '400', debit: '100.00', credit: '0.00' },
    { line_id: '2', account: '400', debit: '50.00', credit: '0.00' },
    { line_id: '3', account: '220', debit: '12.00', credit: '0.00' },
  ],
  ...fields,
});

const FACTS: LineFactsRead = { lines: new Map(), missing: [] };
const month = (inv: Invoice = memo(), opts: { taxAccounts?: typeof TAX | null } = {}) =>
  workOutMonth({ invoices: [inv], items: ITEMS }, {
    company: 'BMG', chart: CHART, taxAccounts: opts.taxAccounts === undefined ? TAX : opts.taxAccounts, facts: FACTS,
  });

/** What ownCreditPick is given for the month: what it was worked out with, and the sales tax account. */
const ownMonth = (worked: ReturnType<typeof month>, salesTax: string | null = '220', company = 'BMG'): OwnMonth => ({
  company, accounts: worked.accounts, names: worked.names, salesTax,
});

const ownLine = (over: Partial<OwnCreditLineData> = {}): OwnCreditLineData => ({
  line_no: 1, invoice_line: 1, item_id: '11', item_number: 'PART-A', description: null, quantity: '1.0000', rate: '100.0000',
  amount: '100.00', taxable: true, tax: '12.00', back_to_stock: true, on_credit_item: false, ...over,
});
const LABOR = ownLine({
  line_no: 2, invoice_line: 2, item_id: '13', item_number: 'INSTALL LABOR', rate: '50.0000', amount: '50.00', taxable: false, tax: '0.00',
  back_to_stock: false,
});

// Books' own copy of CM105, giving back what NetSuite's does.
const own = (over: Partial<OwnCreditMemoData> = {}): OwnCreditMemoData => ({
  netsuite_id: '105', number: 'CM105', invoice_id: '101', invoice_number: 'INV101', made_from_id: null,
  customer_netsuite_id: '9001', customer_id: CUSTOMER, date: '2026-10-20', location_id: '1', reason: 'Returned',
  tax_rule: 'credit_tax@1', tax_rate: '0.120000', tax_rate_from: 'invoice', subtotal: '150.00', tax: '12.00', total: '162.00',
  made_at: '2026-10-20T15:00:00Z', lines: [ownLine(), LABOR], ...over,
});

/** A copy as the check left it: only its status matters here. */
const copy = (status: OwnCreditStatus = 'matches', over: Partial<OwnCreditMemoData> = {}): OwnCreditCopy => ({
  own: own(over), check: { status } as OwnCreditMemoCheck,
});

/** What the books post for CM105 as it is now, given its copy. */
const pick = (c: OwnCreditCopy | undefined, inv: Invoice = memo(), salesTax: string | null = '220', company = 'BMG') => {
  const worked = month(inv);
  const w = worked.invoices[0];
  return ownCreditPick(w, entryLines(w), c, ownMonth(worked, salesTax, company));
};

const ENTRY = [
  { account: '120', cents: -16200, lineId: '0', itemNumber: null, division: null },
  { account: '400', cents: 10000, lineId: 'own:1', itemNumber: 'PART-A', division: 'upfit' },
  { account: '400', cents: 5000, lineId: 'own:2', itemNumber: 'INSTALL LABOR', division: 'upfit' },
  { account: '220', cents: 1200, lineId: 'own:tax', itemNumber: null, division: null },
];

describe("the own credit memo's entry", () => {
  const accounts = month().accounts;

  it('is the credit memo rule on its lines: each backed out of its income account, its sales tax out of the sales tax account and the receivable credited', () => {
    expect(OWN_CREDIT_MEMO_RULE).toBe('own_credit_memo@1');
    expect(ownCreditEntry(own(), accounts, '220')).toEqual({ lines: ENTRY, problems: [] });
  });

  it('credits a discount the invoice gave back the other way, to its own account', () => {
    const discount = ownLine({
      line_no: 3, invoice_line: 4, item_id: '15', item_number: 'DISCOUNT', quantity: null, rate: null, amount: '-10.00', taxable: false,
      tax: '0.00', back_to_stock: false,
    });
    const entry = ownCreditEntry(own({ subtotal: '140.00', total: '152.00', lines: [ownLine(), LABOR, discount] }), accounts, '220');
    expect(entry.problems).toEqual([]);
    expect(entry.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([
      ['0', '120', -15200], ['own:1', '400', 10000], ['own:2', '400', 5000], ['own:3', '410', -1000], ['own:tax', '220', 1200],
    ]);
  });

  it('has no tax line when the copy gives back none, and needs no sales tax account then', () => {
    const untaxed = ownCreditEntry(own({ tax: '0.00', total: '150.00', tax_rate_from: 'untaxed', lines: [ownLine({ tax: '0.00', taxable: false }), LABOR] }), accounts, null);
    expect(untaxed.problems).toEqual([]);
    expect(untaxed.lines.map((l) => [l.lineId, l.cents])).toEqual([['0', -15000], ['own:1', 10000], ['own:2', 5000]]);
  });

  it("can't be worked out without a sales tax account for its tax, or with an item the lists don't have", () => {
    expect(ownCreditEntry(own(), accounts, null)).toEqual({ lines: [], problems: [{ kind: 'no_tax_account', lineId: 'own:tax', taxCode: '' }] });
    expect(ownCreditEntry(own({ lines: [ownLine({ item_id: '77', item_number: 'NEW-PART' }), LABOR] }), accounts, '220').problems)
      .toEqual([{ kind: 'not_copied', lineId: 'own:1', itemId: '77', itemNumber: 'NEW-PART' }]);
  });
});

describe('what the books post for a credit memo Books has its own copy of', () => {
  it("posts the copy's entry when it matches NetSuite's credit memo and makes the same entry", () => {
    expect(pick(copy())).toEqual({ entry: { lines: ENTRY, date: '2026-10-20', customerId: CUSTOMER }, why: null });
    // Lines split another way that come to the same in each account and division move nothing, so the copy still posts.
    const split = copy('matches', { lines: [ownLine({ amount: '90.00', rate: '90.0000' }), { ...LABOR, amount: '60.00', rate: '60.0000' }] });
    expect(pick(split)?.entry?.lines.map((l) => l.cents)).toEqual([-16200, 9000, 6000, 1200]);
  });

  it("dates the entry in the month NetSuite booked the credit memo into, as NetSuite's is", () => {
    const booked = memo({ date: '2026-09-30', posting_month: '2026-10-01' });
    expect(pick(copy('matches', { date: '2026-09-30' }), booked)?.entry?.date).toBe('2026-10-01');
  });

  it("has no say without a copy, or for an invoice, another company's credit memo or one posted to both", () => {
    expect(pick(undefined)).toBeNull();
    expect(pick(copy(), memo({ doc_type: 'invoice' }))).toBeNull();
    expect(pick(copy(), memo({ companies: ['1084'] }), '220', '1084')).toBeNull();
    expect(pick(copy(), memo({ companies: ['BMG', '1084'] }))).toBeNull();
  });

  it("posts NetSuite's while the copy differs or waits, and says why in a credit memo's words", () => {
    expect(CREDIT_MEMO_WORDS).toEqual({ theirs: "NetSuite's credit memo", done: 'credited' });
    expect(pick(copy('differs'))).toEqual({
      entry: null,
      why: "FleetSuite's own copy differs from NetSuite's credit memo, so the books post NetSuite's, since that's what the customer was credited.",
    });
    expect(pick(copy('waiting'))).toEqual({
      entry: null, why: "FleetSuite's own copy is waiting for NetSuite's credit memo to be copied, so the books post NetSuite's for now.",
    });
    expect(pick(copy('voided'))).toEqual({ entry: null, why: null });
  });

  it("leaves it to the credit memo rule when NetSuite's credit memo can't be worked out yet or isn't copied whole", () => {
    const unworkable = month(memo(), { taxAccounts: null });
    const w = unworkable.invoices[0];
    expect(w.checked.status).toBe('unworkable');
    expect(ownCreditPick(w, entryLines(w), copy(), ownMonth(unworkable))).toEqual({ entry: null, why: null });
    expect(pick(copy(), memo({ lines_copied: false }))).toEqual({ entry: null, why: null });
  });

  it("posts NetSuite's when the copy's entry can't be worked out, and says why", () => {
    expect(pick(copy(), memo(), null)).toEqual({
      entry: null,
      why: "FleetSuite's own copy matches NetSuite's credit memo, but its entry can't be worked out, so the books post NetSuite's. "
        + "FleetSuite doesn't know which account its sales tax goes to yet: it takes the one NetSuite's sales tax has posted to most "
        + 'since January 2025, as of the last copy of the NetSuite lists.',
    });
  });

  it("posts NetSuite's when the copy's entry would move the books, naming the accounts, the customer or the date", () => {
    const lead = "FleetSuite's own copy matches NetSuite's credit memo, but its entry doesn't match NetSuite's, so the books post NetSuite's: ";
    // Its sales tax back out of another account.
    expect(pick(copy(), memo(), '221')).toEqual({ entry: null, why: `${lead}it posts differently to 2200 Sales Tax and 2210 1084 Sales Tax.` });
    // Labor given back as graphics labor: the same account, another division.
    const graphics = copy('matches', { lines: [ownLine(), { ...LABOR, item_id: '14', item_number: 'GRAPHICS INSTALL LABOR' }] });
    expect(pick(graphics)?.why).toBe(`${lead}it posts differently to 4000 Sales (Graphics) and 4000 Sales (Upfit).`);
    expect(pick(copy('matches', { customer_id: OTHER_CUSTOMER }))?.why).toBe(`${lead}its receivable is for another FleetSuite customer.`);
    expect(pick(copy('matches', { date: '2026-10-21' }))?.why).toBe(`${lead}it's dated Oct 21, 2026, and NetSuite's Oct 20, 2026.`);
  });
});

describe('reading the copies', () => {
  const pairs: OwnCreditPairsData = {
    credit_memos: [{
      own: own(),
      netsuite: {
        number: 'CM105', date: '2026-10-20', total: '162.00', customer_netsuite_id: '9001', customer_name: 'A Customer', memo: null,
        status: 'Fully Applied', voided: false, deleted: false, lines_copied: true, changed_at: null, copied_at: null,
        lines: [
          { line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', description: null, quantity: '1.00', rate: '100', amount: '100.00', netamount: '100.00', cost: false },
          { line_id: '2', line_no: 2, kind: 'item', item_id: '13', item_number: 'INSTALL LABOR', description: null, quantity: '1.00', rate: '50', amount: '50.00', netamount: '50.00', cost: false },
          { line_id: '3', line_no: 3, kind: 'tax', item_id: '900', item_number: null, description: null, quantity: null, rate: null, amount: '12.00', netamount: '12.00', cost: false },
        ],
      },
      netsuite_gl: { location_id: '1' },
      customer_name: 'A Customer',
    }],
    items: { 11: { number: 'PART-A', type: 'InvtPart' }, 13: { number: 'INSTALL LABOR', type: 'Service' } },
    tax_codes: { 900: { name: 'Some County', rate: '12%' } },
    locations: { 1: "O'Fallon" },
  };
  const service = (result: { data: unknown; error: { message: string } | null }, calls: unknown[] = []) =>
    ({ rpc: async (fn: string, args?: unknown) => { calls.push(args === undefined ? [fn] : [fn, args]); return result; } }) as unknown as SupabaseClient;

  it("checks each copy of the days asked for against NetSuite's credit memo, by NetSuite's id", async () => {
    const calls: unknown[] = [];
    const copies = await readOwnCreditCopies(service({ data: pairs, error: null }, calls), '2026-10-01', '2026-10-31');
    expect(calls).toEqual([['gl_own_credit_memo_pairs', { p_from: '2026-10-01', p_to: '2026-10-31', p_netsuite_id: null }]]);
    expect([...copies.keys()]).toEqual(['105']);
    expect(copies.get('105')?.check).toMatchObject({ status: 'matches', summary: "Matches NetSuite's credit memo.", differing: 0 });
    expect(copies.get('105')?.own.total).toBe('162.00');
  });

  it("says why when they can't be read, and finds none in an empty answer", async () => {
    await expect(readOwnCreditCopies(service({ data: null, error: { message: 'canceling statement due to statement timeout' } }), '2026-10-01', '2026-10-31'))
      .rejects.toThrow('canceling statement due to statement timeout');
    expect((await readOwnCreditCopies(service({ data: null, error: null }), '2026-10-01', '2026-10-31')).size).toBe(0);
    expect((await readOwnCreditCopies(service({ data: { credit_memos: null }, error: null }), '2026-10-01', '2026-10-31')).size).toBe(0);
  });

  it('finds the first month Books has an own credit memo in, or none', async () => {
    const calls: unknown[] = [];
    const months = [{ month: '2026-10-01', credit_memos: 3 }, { month: '2026-08-01', credit_memos: 1 }, { month: '2026-09-01', credit_memos: 2 }];
    expect(await readOwnCreditSince(service({ data: months, error: null }, calls))).toBe('2026-08-01');
    expect(calls).toEqual([['gl_own_credit_memo_months']]);
    expect(await readOwnCreditSince(service({ data: [], error: null }))).toBeNull();
    expect(await readOwnCreditSince(service({ data: null, error: null }))).toBeNull();
    await expect(readOwnCreditSince(service({ data: null, error: { message: 'permission denied for function gl_own_credit_memo_months' } })))
      .rejects.toThrow('permission denied for function gl_own_credit_memo_months');
  });
});
