// FleetSuite AI on FleetSuite's books (docs/books.md "The AI assistant"):
// the reads it can ask, the months a profit and loss read covers, the rows it
// gets back, what it's told about when the books are as of, and its prompt.
// Made-up customers, vendors and amounts.
import { describe, it, expect } from 'vitest';
import type { OpenArInvoice, OpenVendorBill } from '@/lib/financials-data';
import { BUCKETS } from './aging-buckets';
import type { Agings } from './agings';
import {
  accountRows, billRows, BOOKS_INSTEAD, BOOKS_OFF, BOOKS_PROMPT, BOOKS_READS, booksNote, invoiceRows, monthRows, monthsAsked,
  parseBooksAsk, partyRows, pnlRow, summaryRow, withBooks, type BooksAsk,
} from './assistant-books';
import type { BooksAccountGroups, BooksFinancials } from './money-screens';
import type { ReportData } from './reports';

describe('the reads the assistant can ask', () => {
  it('takes only the reads the books answer, naming them otherwise', () => {
    const error = "FleetSuite's books answer these reads: summary, receivables, open_invoices, payables, open_bills, accounts, profit_and_loss, months.";
    for (const read of ['balances', 'SUMMARY', '', undefined, null, 42, ['summary']]) {
      expect(parseBooksAsk(read, {}), String(read)).toEqual({ error });
    }
    for (const read of BOOKS_READS) expect(parseBooksAsk(read, undefined)).toEqual({ read });
  });

  it("takes part of a customer's name for what customers owe, and a vendor's for what BMG owes", () => {
    expect(parseBooksAsk('receivables', { customer: '  Acme  ' })).toEqual({ read: 'receivables', name: 'Acme' });
    expect(parseBooksAsk('open_invoices', { customer: 'Bravo' })).toEqual({ read: 'open_invoices', name: 'Bravo' });
    expect(parseBooksAsk('payables', { vendor: 'Parts Co' })).toEqual({ read: 'payables', name: 'Parts Co' });
    expect(parseBooksAsk('open_bills', { vendor: 'Steel' })).toEqual({ read: 'open_bills', name: 'Steel' });
    // The other side's name, a blank one, or one that isn't words, is no name.
    expect(parseBooksAsk('receivables', { vendor: 'Parts Co' })).toEqual({ read: 'receivables' });
    expect(parseBooksAsk('open_bills', { customer: 'Acme' })).toEqual({ read: 'open_bills' });
    expect(parseBooksAsk('open_invoices', { customer: '   ' })).toEqual({ read: 'open_invoices' });
    expect(parseBooksAsk('payables', { vendor: 42 })).toEqual({ read: 'payables' });
    // A long one is cut to 80 characters.
    expect(parseBooksAsk('receivables', { customer: `${'x'.repeat(79)}yz` })).toEqual({ read: 'receivables', name: `${'x'.repeat(79)}y` });
  });

  it('reads params that are not an object as none', () => {
    for (const params of [null, 'acme', ['acme'], 7]) {
      expect(parseBooksAsk('receivables', params)).toEqual({ read: 'receivables' });
      expect(parseBooksAsk('months', params)).toEqual({ read: 'months' });
    }
    // The reads that take nothing ignore what they're given.
    expect(parseBooksAsk('summary', { customer: 'Acme', from: '2026-01' })).toEqual({ read: 'summary' });
    expect(parseBooksAsk('accounts', { from: 'last year' })).toEqual({ read: 'accounts' });
  });

  it('takes months written YYYY-MM for the profit and loss, "from" no later than "to"', () => {
    expect(parseBooksAsk('profit_and_loss', { from: '2026-01', to: '2026-10' })).toEqual({ read: 'profit_and_loss', from: '2026-01', to: '2026-10' });
    expect(parseBooksAsk('months', { from: ' 2025-12 ' })).toEqual({ read: 'months', from: '2025-12' });
    expect(parseBooksAsk('profit_and_loss', { from: '2026-10', to: '2026-10' })).toEqual({ read: 'profit_and_loss', from: '2026-10', to: '2026-10' });
    expect(parseBooksAsk('profit_and_loss', { from: null, to: '' })).toEqual({ read: 'profit_and_loss' });
    for (const from of ['2026-13', '2026-00', '2026-1', '2026-10-01', 'October', 202610, true]) {
      expect(parseBooksAsk('profit_and_loss', { from }), String(from)).toEqual({ error: '"from" is a month written YYYY-MM, like 2026-10.' });
    }
    expect(parseBooksAsk('months', { from: '2026-01', to: '2026/06' })).toEqual({ error: '"to" is a month written YYYY-MM, like 2026-10.' });
    expect(parseBooksAsk('profit_and_loss', { from: '2026-10', to: '2026-09' })).toEqual({ error: '"from" comes after "to".' });
  });
});

describe('the months a profit and loss read covers', () => {
  // Reports' latest month is November 2026, this one; last month is October.
  const months = (ask: Omit<BooksAsk, 'read'> & { read?: BooksAsk['read'] }) =>
    monthsAsked({ read: 'profit_and_loss', ...ask }, '2026-10-01', '2026-11-01');

  it('is last month for the profit and loss, and this year so far month by month, when none are given', () => {
    expect(months({})).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(months({ read: 'months' })).toEqual({ from: '2026-01-01', to: '2026-11-01' });
  });

  it('runs through this month from a month given, and is the month "to" alone without "from"', () => {
    expect(months({ from: '2026-03' })).toEqual({ from: '2026-03-01', to: '2026-11-01' });
    expect(months({ read: 'months', from: '2025-11' })).toEqual({ from: '2025-11-01', to: '2026-11-01' });
    expect(months({ to: '2026-06' })).toEqual({ from: '2026-06-01', to: '2026-06-01' });
    expect(months({ read: 'months', to: '2025-06' })).toEqual({ from: '2025-01-01', to: '2025-06-01' });
    expect(months({ from: '2026-01', to: '2026-06' })).toEqual({ from: '2026-01-01', to: '2026-06-01' });
  });

  it('keeps to the books: January 2025 through their latest month', () => {
    expect(months({ from: '2025-01', to: '2026-11' })).toEqual({ from: '2025-01-01', to: '2026-11-01' });
    const before = { error: "FleetSuite's books start in January 2025: the months before are QuickBooks', in Reports → Financial History." };
    expect(months({ from: '2024-12' })).toEqual(before);
    expect(months({ to: '2024-12' })).toEqual(before);
    expect(months({ read: 'months', to: '2024-06' })).toEqual(before);
    const after = { error: "FleetSuite's books have months from 2025-01 through 2026-11." };
    expect(months({ to: '2026-12' })).toEqual(after);
    expect(months({ from: '2026-12' })).toEqual(after);
    expect(months({ read: 'months', from: '2027-01', to: '2027-02' })).toEqual(after);
  });
});

/** FleetSuite's side, and NetSuite's, which the rows never read, a little apart. */
const side = (fleetsuite: number | null) => ({ fleetsuite, netsuite: (fleetsuite ?? 0) + 7 });

/** A customer or vendor in AR and AP agings, amounts in cents; `docs` is each open document's [open, days past due]. */
const party = (name: string, balance: number, docs: Array<[number, number | null]>, buckets: Partial<Record<string, number>> = {}, notOpen = 0) => ({
  name,
  balance: side(balance),
  notOpen: side(notOpen),
  buckets: Object.fromEntries(BUCKETS.map((b) => [b, side(buckets[b] ?? 0)])),
  documents: docs.map(([open, days]) => ({ open: side(open), days: side(days) })),
});
const agings = (kind: 'customer' | 'vendor', parties: ReturnType<typeof party>[]) => ({ kind, parties }) as unknown as Agings;

describe("each customer's and vendor's balance", () => {
  const customers = agings('customer', [
    party('Paid Up Co', 0, []),
    // An invoice with no date or due date is late by nothing.
    party('beta Builders', 10000, [[10000, 5], [2000, null]], { d1_30: 10000 }),
    party('Credit Only Co', -5000, [[-5000, 62]], { d61_90: -5000 }),
    // One open in NetSuite's books alone isn't one of FleetSuite's.
    party('Acme Fleet, Inc.', 130000, [[80000, 32], [50000, -18], [0, 40]], { current: 50000, d31_60: 80000 }),
    party('Square Co', 0, [[10000, 3], [-10000, 40]], { d1_30: 10000, d31_60: -10000 }),
    party('Alpha Body', 10000, [[18000, 95]], { d90plus: 18000 }, -8000),
  ]);

  it('lists those with a balance or something open, the largest first, then by name, in dollars', () => {
    expect(partyRows(customers)).toEqual([
      {
        customer: 'Acme Fleet, Inc.', balance: 1300, current: 500, days_1_30: 0, days_31_60: 800, days_61_90: 0, over_90_days: 0,
        not_in_an_open_document: 0, open_documents: 2, most_days_past_due: 32,
      },
      {
        customer: 'Alpha Body', balance: 100, current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90_days: 180,
        not_in_an_open_document: -80, open_documents: 1, most_days_past_due: 95,
      },
      expect.objectContaining({ customer: 'beta Builders', balance: 100, days_1_30: 100, open_documents: 2, most_days_past_due: 5 }),
      // Nothing owed, but an invoice and a credit memo open.
      expect.objectContaining({ customer: 'Square Co', balance: 0, open_documents: 2, most_days_past_due: 3 }),
      // How late an account is goes by its invoices: a credit memo, however old, makes nothing late.
      expect.objectContaining({ customer: 'Credit Only Co', balance: -50, days_61_90: -50, open_documents: 1, most_days_past_due: 0 }),
    ]);
  });

  it('finds a name by its letters and digits, whatever the case and punctuation', () => {
    for (const name of ['acme fleet inc', 'ACME', 'Fleet,', ' acme  fleet ']) {
      expect(partyRows(customers, name).map((r) => r.customer), name).toEqual(['Acme Fleet, Inc.']);
    }
    expect(partyRows(customers, 'co')).toHaveLength(2);
    expect(partyRows(customers, 'Zeta')).toEqual([]);
    expect(partyRows(customers, '')).toHaveLength(5);
  });

  it("names a vendor's row by vendor", () => {
    expect(partyRows(agings('vendor', [party('Parts Co', 100000, [[90000, 13]], { d1_30: 90000 }, 10000)]))).toEqual([{
      vendor: 'Parts Co', balance: 1000, current: 0, days_1_30: 900, days_31_60: 0, days_61_90: 0, over_90_days: 0,
      not_in_an_open_document: 100, open_documents: 1, most_days_past_due: 13,
    }]);
  });
});

describe('the open invoices and bills', () => {
  const invoice = (over: Partial<OpenArInvoice>): OpenArInvoice => ({
    id: '101', tranid: 'INV101', date: '2026-09-01', dueDate: '2026-10-01', po: 'PO-77', customer: 'Acme Fleet, Inc.', entityId: 'e-1',
    total: 1000, unpaid: 800, daysPastDue: 32, bucket: 'd31_60', nsUrl: 'https://ns.example/custinvc/101', ...over,
  });
  const bill = (over: Partial<OpenVendorBill>): OpenVendorBill => ({
    id: '4001', tranid: 'VB1', date: '2026-09-20', dueDate: '2026-10-20', vendor: 'Parts Co', memo: 'Oct parts',
    total: 900, unpaid: 650, daysPastDue: 13, nsUrl: 'https://ns.example/vendbill/4001', ...over,
  });

  it("keeps the list's order, a credit memo marked, without NetSuite's links", () => {
    const list = [
      invoice({ id: '107', tranid: 'CM7', dueDate: null, po: 'RMA-9', total: -50, unpaid: -50, daysPastDue: 62, bucket: 'd61_90', creditMemo: true }),
      invoice({}),
      invoice({ id: '201', tranid: 'INV201', customer: 'Bravo Trucking', po: null, total: 900, unpaid: 900, daysPastDue: 0, bucket: 'current' }),
    ];
    expect(invoiceRows(list)).toEqual([
      { number: 'CM7', customer: 'Acme Fleet, Inc.', date: '2026-09-01', due: null, po: 'RMA-9', total: -50, open: -50, days_past_due: 62, credit_memo: true },
      { number: 'INV101', customer: 'Acme Fleet, Inc.', date: '2026-09-01', due: '2026-10-01', po: 'PO-77', total: 1000, open: 800, days_past_due: 32 },
      { number: 'INV201', customer: 'Bravo Trucking', date: '2026-09-01', due: '2026-10-01', po: null, total: 900, open: 900, days_past_due: 0 },
    ]);
    expect(invoiceRows(list, 'bravo trucking').map((r) => r.number)).toEqual(['INV201']);
    expect(invoiceRows(list, 'acme, inc')).toEqual([]);
    expect(invoiceRows(list, 'Acme Fleet Inc').map((r) => r.number)).toEqual(['CM7', 'INV101']);
  });

  it('does the same for bills, a bill credit marked', () => {
    const list = [
      bill({ id: '4003', tranid: 'VB2', vendor: 'Steel Inc', memo: null, total: 200, unpaid: 200, daysPastDue: 48 }),
      bill({}),
      bill({ id: '4002', tranid: 'VC1', dueDate: null, memo: null, total: -30, unpaid: -30, daysPastDue: 8, billCredit: true }),
    ];
    expect(billRows(list)).toEqual([
      { number: 'VB2', vendor: 'Steel Inc', date: '2026-09-20', due: '2026-10-20', memo: null, total: 200, open: 200, days_past_due: 48 },
      { number: 'VB1', vendor: 'Parts Co', date: '2026-09-20', due: '2026-10-20', memo: 'Oct parts', total: 900, open: 650, days_past_due: 13 },
      { number: 'VC1', vendor: 'Parts Co', date: '2026-09-20', due: null, memo: null, total: -30, open: -30, days_past_due: 8, bill_credit: true },
    ]);
    expect(billRows(list, 'parts').map((r) => r.number)).toEqual(['VB1', 'VC1']);
  });
});

describe("the tab's tiles and the accounts behind them", () => {
  it('gives the tiles, without what only the screen needs', () => {
    const f = {
      ar: { total: 1250, pastDue: 750, openCount: 3, buckets: { current: 500, d1_30: 0, d31_60: 800, d61_90: -50, d90plus: 0 }, topOverdue: [], notOpen: -80 },
      ap: { vendorBills: 1000, cardOwed: 500, salesTax: 70, total: 1570 },
      cash: 9100,
      net: 8780,
      config: { balancesOk: true, balancesError: null, bankConfigured: true, cardConfigured: true, apConfigured: true, salesTaxConfigured: true },
      books: { company: 'BMG', name: 'Example Fleet', postedAt: '2026-11-02T17:48:00Z', postingError: null, postingPartial: false },
    } as BooksFinancials;
    expect(summaryRow(f)).toEqual({
      cash: 9100, customers_owe: 1250, past_due: 750, current: 500, days_1_30: 0, days_31_60: 800, days_61_90: -50, over_90_days: 0,
      not_in_an_open_invoice: -80, open_invoices_and_credit_memos: 3, bmg_owes: 1570, vendor_bills: 1000, cards: 500, sales_tax: 70, net: 8780,
    });
  });

  it('lists each bank, card, payable and sales tax account with its balance', () => {
    const groups: BooksAccountGroups = {
      success: true,
      bank: [{ id: '10', name: '1000 Checking', type: 'bank', balance: 9100 }, { id: '11', name: '1010 Savings', type: 'bank', balance: 250 }],
      card: [{ id: '21', name: '2100 Chase card', type: 'credit_card', balance: 500 }],
      ap: [{ id: '20', name: '2000 Payables', type: 'accounts_payable', balance: 1000 }],
      salesTax: [{ id: '22', name: '2200 Sales tax', type: 'other_current_liability', balance: 70 }],
      has: { bank: true, card: true, ap: true, salesTax: true },
    };
    expect(accountRows(groups)).toEqual([
      { kind: 'bank', account: '1000 Checking', balance: 9100 },
      { kind: 'bank', account: '1010 Savings', balance: 250 },
      { kind: 'credit card', account: '2100 Chase card', balance: 500 },
      { kind: 'payable', account: '2000 Payables', balance: 1000 },
      { kind: 'sales tax', account: '2200 Sales tax', balance: 70 },
    ]);
    expect(accountRows({ ...groups, bank: [], card: [], ap: [], salesTax: [] })).toEqual([]);
  });
});

describe('the profit and loss', () => {
  const account = (ns: string, number: string, name: string, type: string) => ({
    id: `a${ns}`, netsuite_account_id: ns, number, name, account_type: type, parent_id: null, company: null,
    statement: type === 'bank' ? 'balance_sheet' : 'income_statement',
  });
  const amount = (account: string, month: string, debit: number, credit: number) => ({ account, month, debit: debit.toFixed(2), credit: credit.toFixed(2) });
  const data = {
    company: 'BMG',
    accounts: [
      account('10', '1000', 'Checking', 'bank'), account('40', '4000', 'Sales', 'income'), account('50', '5000', 'Materials', 'cost_of_goods_sold'),
      account('61', '6010', 'Wages', 'expense'), account('65', '6500', 'Rent', 'expense'), account('70', '7000', 'Interest earned', 'other_income'),
      account('75', '7500', 'Interest paid', 'other_expense'),
    ],
    opening: [],
    netsuite: [],
    fleetsuite: [
      amount('40', '2026-09-01', 0, 500), amount('65', '2026-09-01', 100, 0),
      amount('40', '2026-10-01', 0, 1000), amount('50', '2026-10-01', 400, 0), amount('61', '2026-10-01', 300, 0), amount('65', '2026-10-01', 200, 0),
      amount('70', '2026-10-01', 0, 50), amount('75', '2026-10-01', 25, 0), amount('10', '2026-10-01', 125, 0),
      amount('40', '2026-11-01', 0, 200),
    ],
  } as unknown as ReportData;
  const payroll = new Set(['61']);

  it("adds up the months as the tab's band does, payroll apart, with what customers paid", () => {
    expect(pnlRow(data, { from: '2026-10-01', to: '2026-10-01' }, payroll, { total: 900, count: 3 }, '2026-11-01')).toEqual({
      from: '2026-10', to: '2026-10', revenue: 1000, cost_of_sales: 400, gross_profit: 600, gross_margin_pct: 60, payroll: 300, expenses: 200,
      other_income: 50, other_expenses: 25, net_income: 125, net_margin_pct: 12.5, customers_paid: 900, payments: 3,
    });
    // With no payroll accounts named, wages are an expense like rent; with no collections read, none is said.
    expect(pnlRow(data, { from: '2026-10-01', to: '2026-10-01' }, new Set(), null, '2026-11-01')).toEqual({
      from: '2026-10', to: '2026-10', revenue: 1000, cost_of_sales: 400, gross_profit: 600, gross_margin_pct: 60, expenses: 500,
      other_income: 50, other_expenses: 25, net_income: 125, net_margin_pct: 12.5,
    });
  });

  it('marks months that take in this one as not over yet', () => {
    expect(pnlRow(data, { from: '2026-09-01', to: '2026-11-01' }, payroll, { total: 0, count: 0 }, '2026-11-01')).toEqual({
      from: '2026-09', to: '2026-11', revenue: 1700, cost_of_sales: 400, gross_profit: 1300, gross_margin_pct: 76.47, payroll: 300, expenses: 300,
      other_income: 50, other_expenses: 25, net_income: 725, net_margin_pct: 42.65, customers_paid: 0, payments: 0, not_over_yet: true,
    });
  });

  it('gives each month apart, oldest first, a month with no revenue no margins', () => {
    const rows = monthRows(data, { from: '2026-08-01', to: '2026-11-01' }, payroll, '2026-11-01');
    expect(rows).toEqual([
      {
        month: '2026-08', revenue: 0, cost_of_sales: 0, gross_profit: 0, gross_margin_pct: null, payroll: 0, expenses: 0,
        other_income: 0, other_expenses: 0, net_income: 0, net_margin_pct: null,
      },
      {
        month: '2026-09', revenue: 500, cost_of_sales: 0, gross_profit: 500, gross_margin_pct: 100, payroll: 0, expenses: 100,
        other_income: 0, other_expenses: 0, net_income: 400, net_margin_pct: 80,
      },
      {
        month: '2026-10', revenue: 1000, cost_of_sales: 400, gross_profit: 600, gross_margin_pct: 60, payroll: 300, expenses: 200,
        other_income: 50, other_expenses: 25, net_income: 125, net_margin_pct: 12.5,
      },
      {
        month: '2026-11', revenue: 200, cost_of_sales: 0, gross_profit: 200, gross_margin_pct: 100, payroll: 0, expenses: 0,
        other_income: 0, other_expenses: 0, net_income: 200, net_margin_pct: 100, not_over_yet: true,
      },
    ]);
    expect(monthRows(data, { from: '2026-10-01', to: '2026-10-01' }, new Set(), '2026-11-01')).toEqual([
      expect.not.objectContaining({ payroll: expect.anything() }),
    ]);
  });
});

describe('when the books are as of', () => {
  const from = "From BMG's books in FleetSuite, as Home → Financials shows them";

  it('names the last posting run in Central time', () => {
    expect(booksNote({ at: '2026-11-02T17:48:00Z', error: null, partial: false }))
      .toBe(`${from}, as of the posting run at 11/2/2026, 11:48 AM Central (it runs every two hours).`);
    expect(booksNote({ at: '2026-07-01T17:00:00Z', error: null, partial: false }))
      .toBe(`${from}, as of the posting run at 7/1/2026, 12:00 PM Central (it runs every two hours).`);
    expect(booksNote({ at: '2027-01-01T03:30:00Z', error: null, partial: false }))
      .toBe(`${from}, as of the posting run at 12/31/2026, 9:30 PM Central (it runs every two hours).`);
  });

  it('has the assistant say so when the books may be behind NetSuite', () => {
    expect(booksNote(null)).toBe(`${from}. The posting run hasn't run yet, so documents NetSuite has may be missing: say so.`);
    expect(booksNote({ at: '2026-11-02T17:48:00Z', error: 'Deadlock', partial: true }))
      .toBe(`${from}. The last posting run, at 11/2/2026, 11:48 AM Central, failed (Deadlock), so they may be behind NetSuite: say so.`);
    expect(booksNote({ at: '2026-11-02T17:48:00Z', error: null, partial: true }))
      .toBe(`${from}, as of the posting run at 11/2/2026, 11:48 AM Central, which stopped for time with documents left to post, so they may be behind NetSuite: say so.`);
  });
});

describe("the assistant's prompt with the books on", () => {
  const prompt = [
    'COMMON NETSUITE PATTERNS:',
    "- AR: SELECT c.companyname, SUM(t.foreignamountunpaid) FROM transaction t WHERE t.type = 'CustInvc'",
    '- AP: Same but VendBill/vendor',
    "- Top customers: SELECT c.companyname, SUM(t.foreigntotal) FROM transaction t WHERE t.type = 'SalesOrd'",
    "- Revenue by month: SELECT EXTRACT(MONTH FROM t.trandate) mo, SUM(t.foreigntotal) FROM transaction t WHERE t.type = 'CustInvc'",
    "- Overdue invoices: SELECT t.tranid FROM transaction t WHERE t.type = 'CustInvc' AND t.duedate < SYSDATE",
    '',
    'PAYROLL:',
    "- Labor cost by month: SELECT to_char(period_end, 'YYYY-MM') AS month, SUM(total_labor_cost) FROM payroll_checks GROUP BY 1",
    'ANSWER FORMAT:',
    '- Be concise',
  ].join('\n');

  it("drops NetSuite's A/R, A/P, revenue and overdue examples and adds the books' reads at the end", () => {
    const out = withBooks(prompt);
    expect(out).toBe([
      'COMMON NETSUITE PATTERNS:',
      "- Top customers: SELECT c.companyname, SUM(t.foreigntotal) FROM transaction t WHERE t.type = 'SalesOrd'",
      '',
      'PAYROLL:',
      "- Labor cost by month: SELECT to_char(period_end, 'YYYY-MM') AS month, SUM(total_labor_cost) FROM payroll_checks GROUP BY 1",
      'ANSWER FORMAT:',
      '- Be concise',
      '',
      BOOKS_PROMPT,
    ].join('\n'));
  });

  it('tells the assistant every read and how to ask it', () => {
    for (const read of BOOKS_READS) expect(BOOKS_PROMPT).toContain(`- ${read}: `);
    expect(BOOKS_PROMPT).toContain('{"id": "owed", "source": "books", "read": "receivables"}');
    expect(BOOKS_PROMPT).toContain('"params": {"customer": "acme"}');
    expect(BOOKS_PROMPT).toContain("1084's rent and mortgage aren't in them");
  });

  it('tells it where to go when it asks the wrong place', () => {
    expect(BOOKS_OFF).toBe("FleetSuite's books aren't switched on for the assistant (Books → Switches → Financials on FleetSuite's books), so answer from NetSuite.");
    expect(BOOKS_INSTEAD).toContain('ask with source "books" (summary, receivables, open_invoices, payables, open_bills or accounts)');
  });
});
