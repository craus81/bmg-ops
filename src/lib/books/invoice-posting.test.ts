import { describe, it, expect } from 'vitest';
import { BooksError } from './journal';
import { workOutMonth, type ChartAccount, type InvoiceMonthData, type LineFactsRead } from './invoice-check';
import {
  bankDocumentBooks, bankJournalEntry, bankPostingFor, billBooks, billJournalEntry, billPaymentBooks, billPaymentJournalEntry, billPostingFor, copiedJournalEntry,
  decide, decideBankDocument, decideBill, decideBillPayment, decideDeposit, decideJournalEntry, decidePayment, decideSpending, depositBooks,
  depositEntryLines, depositJournalEntry, depositPostingFor, entryLines, failureReason, invoiceBooks, invoiceJournalEntry, journalEntryBooks,
  parsePostingState, paymentBooks, paymentEntryLines, paymentJournalEntry, postingKey, postingQueue, signature, spendingBooks, spendingJournalEntry,
  spendingPostingFor, decideStockDocument, stockDocumentBooks, stockJournalEntry, stockPostingFor, unsaidFacts,
  type BankPosting, type BillPaymentPosting, type BillPosting, type DepositPosting, type InvoicePosting, type JournalEntryPosting,
  type PaymentPosting, type SpendingPosting, type StockPosting,
} from './invoice-posting';
import { workOutPaymentMonth, type PaymentMonthData } from './payment-check';
import { workOutDepositMonth, type DepositMonthData } from './deposit-check';
import { workOutBillMonth, type BillMonthData } from './bill-check';
import { workOutBillPaymentMonth, type BillPaymentMonthData } from './bill-payment-check';
import { workOutSpendingMonth, type SpendingMonthData } from './spending-check';
import { workOutJournalMonth, type JournalMonthData } from './journal-entry-check';
import { workOutBankMonth, type BankMonthData } from './bank-check';
import { workOutStockMonth, type StockMonthData } from './stock-check';

// Made-up books: '120' receivable, '400' income, '220' sales tax payable.
const CHART: ChartAccount[] = [
  { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
  { netsuite_account_id: '400', number: '4000', name: 'Sales', account_type: 'income', company: null, active: true, is_summary: false },
  { netsuite_account_id: '220', number: '2200', name: 'Sales Tax', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
];
const ITEMS: InvoiceMonthData['items'] = [
  { kind: 'item', netsuite_id: '11', name: 'PART-A', item_type: 'InvtPart', income_account: '400', asset_account: '130' },
  { kind: 'item', netsuite_id: '13', name: 'INSTALL LABOR', item_type: 'Service', income_account: '400', asset_account: null },
  { kind: 'tax_code', netsuite_id: '900', name: 'Some County', item_type: null, income_account: null, asset_account: null },
];
const TAX = [{ tax_code_id: '900', account_id: '220', lines: 40 }];
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';

type Invoice = InvoiceMonthData['invoices'][number];

// A part and labor plus tax, as NetSuite posts it.
const invoice = (fields: Partial<Invoice> = {}): Invoice => ({
  id: 'id-101', doc_type: 'invoice', netsuite_id: '101', number: 'INV101', date: '2026-09-15', total: '162.00', voided: false,
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
const worked = (inv: Invoice = invoice(), opts: { taxAccounts?: typeof TAX | null } = {}) =>
  workOutMonth({ invoices: [inv], items: ITEMS }, { company: 'BMG', chart: CHART, taxAccounts: opts.taxAccounts === undefined ? TAX : opts.taxAccounts, facts: FACTS }).invoices[0];

/** What the journal holds when INV101 posted as it is now, as entry 7. */
const posting = (fields: Partial<InvoicePosting> = {}, lines?: NonNullable<InvoicePosting['current']>['lines']): InvoicePosting => ({
  source_type: 'invoice',
  source_id: '101',
  entries: 1,
  unreversed: ['e7'],
  current: {
    id: 'e7', entry_no: 7, entry_date: '2026-09-15',
    lines: lines ?? [
      { account: '120', debit: '162.00', credit: '0.00', division: null, source_line_ref: '0', customer_id: CUSTOMER },
      { account: '400', debit: '0.00', credit: '100.00', division: 'upfit', source_line_ref: '1', customer_id: null },
      { account: '400', debit: '0.00', credit: '50.00', division: 'upfit', source_line_ref: '2', customer_id: null },
      { account: '220', debit: '0.00', credit: '12.00', division: null, source_line_ref: '3', customer_id: null },
    ],
  },
  history: [{ entry_no: 7, entry_date: '2026-09-15', reversed_by: null }],
  invoice: { number: 'INV101', deleted: false, voided: false },
  ...fields,
});

describe('signature', () => {
  const lines = [
    { account: '120', cents: 16200, division: null, lineRef: '0', customerId: 'c' },
    { account: '400', cents: -16200, division: 'upfit', lineRef: '1', customerId: null },
  ];

  it('ignores the order of the lines', () => {
    expect(signature('2026-09-15', lines)).toBe(signature('2026-09-15', [...lines].reverse()));
  });

  it('changes with the date, an account, an amount, a division, a line, the customer or the vendor', () => {
    const base = signature('2026-09-15', lines);
    expect(signature('2026-09-16', lines)).not.toBe(base);
    for (const change of [{ account: '410' }, { cents: -16100 }, { division: 'graphics' }, { lineRef: '2' }, { customerId: 'd' }, { vendorRef: '50' }]) {
      expect(signature('2026-09-15', [lines[0], { ...lines[1], ...change }])).not.toBe(base);
    }
  });
});

describe('decide', () => {
  it('posts an invoice nothing stands for, and keeps one whose entry still fits', () => {
    expect(decide(worked(), undefined)).toEqual({ kind: 'post' });
    expect(decide(worked(), posting())).toEqual({ kind: 'keep' });
  });

  it('posts what the rule works out even where NetSuite differs: the differences are what the side-by-side run shows', () => {
    const w = worked(invoice({ netsuite: invoice().netsuite.map((l) => (l.line_id === '3' ? { ...l, account: '221' } : l)) }));
    expect(w.checked.status).toBe('differs');
    expect(decide(w, undefined)).toEqual({ kind: 'post' });
    expect(decide(w, posting())).toEqual({ kind: 'keep' });
  });

  it('replaces an entry when NetSuite changed the invoice: an amount, the date or the customer', () => {
    const more = invoice({
      total: '182.00',
      lines: invoice().lines.map((l) => (l.line_id === '1' ? { ...l, amount: '120.00', netamount: '-120' } : l)),
    });
    expect(decide(worked(more), posting())).toEqual({ kind: 'replace' });
    expect(decide(worked(invoice({ date: '2026-09-16' })), posting())).toEqual({ kind: 'replace' });
    expect(decide(worked(invoice({ customer_id: null })), posting())).toEqual({ kind: 'replace' });
  });

  it('reverses the entry of a voided invoice, and posts nothing for one never posted', () => {
    expect(decide(worked(invoice({ voided: true })), posting())).toEqual({ kind: 'reverse', why: 'voided' });
    expect(decide(worked(invoice({ voided: true })), undefined)).toEqual({ kind: 'keep', why: 'voided' });
  });

  it('reverses the entry of an invoice that comes to nothing now', () => {
    const zero = invoice({ total: '0.00', lines: invoice().lines.map((l) => ({ ...l, amount: '0.00', netamount: '0' })), netsuite: [] });
    expect(entryLines(worked(zero))).toEqual([]);
    expect(decide(worked(zero), posting())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decide(worked(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
  });

  it('leaves whatever stands when the rule can\'t work the invoice out or its lines aren\'t copied yet', () => {
    expect(decide(worked(invoice(), { taxAccounts: null }), posting())).toEqual({ kind: 'leave', why: 'unworkable' });
    expect(decide(worked(invoice(), { taxAccounts: null }), undefined)).toEqual({ kind: 'leave', why: 'unworkable' });
    expect(decide(worked(invoice({ lines_copied: false })), posting())).toEqual({ kind: 'leave', why: 'waiting' });
  });

  it('leaves whatever stands when the lines don\'t come to the invoice\'s total, as when the copy is caught mid-refresh', () => {
    expect(decide(worked(invoice({ lines: invoice().lines.slice(0, 1) })), posting())).toEqual({ kind: 'leave', why: 'total' });
    expect(decide(worked(invoice({ total: '170.00' })), undefined)).toEqual({ kind: 'leave', why: 'total' });
  });
});

describe('invoiceBooks', () => {
  it('says which entry stands, what the next run does, and the earlier entries with what reversed them', () => {
    expect(invoiceBooks(worked(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    const replaced = posting({
      entries: 2,
      current: { ...posting().current!, entry_no: 9 },
      history: [{ entry_no: 7, entry_date: '2026-09-15', reversed_by: 8 }, { entry_no: 9, entry_date: '2026-09-15', reversed_by: null }],
    });
    expect(invoiceBooks(worked(), replaced)).toEqual({ entryNo: 9, next: null, earlier: [{ entryNo: 7, reversedBy: 8 }] });
    expect(invoiceBooks(worked(invoice({ voided: true })), posting()).next).toBe('reverse');
    expect(invoiceBooks(worked(invoice({ date: '2026-09-20' })), posting()).next).toBe('replace');
    expect(invoiceBooks(worked(invoice(), { taxAccounts: null }), undefined)).toEqual({ entryNo: null, next: null, earlier: [] });
  });

  it('says an invoice has nothing to post when none of its entries stands and NetSuite voided it, or it comes to $0', () => {
    const zero = invoice({ total: '0.00', lines: invoice().lines.map((l) => ({ ...l, amount: '0.00', netamount: '0' })), netsuite: [] });
    expect(invoiceBooks(worked(invoice({ voided: true })), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'voided' });
    expect(invoiceBooks(worked(zero), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'zero' });
    // Its reversed entry still shows.
    const reversed = posting({ unreversed: [], current: null, history: [{ entry_no: 7, entry_date: '2026-09-15', reversed_by: 8 }] });
    expect(invoiceBooks(worked(invoice({ voided: true })), reversed))
      .toEqual({ entryNo: null, next: null, earlier: [{ entryNo: 7, reversedBy: 8 }], nothingToPost: 'voided' });
    // While its entry stands, the next run reverses that instead.
    expect(invoiceBooks(worked(zero), posting())).toEqual({ entryNo: 7, next: 'reverse', earlier: [] });
    // Never of one still to post, or that the rule can't work out, or whose lines don't come to its total yet.
    expect(invoiceBooks(worked(), undefined)).not.toHaveProperty('nothingToPost');
    expect(invoiceBooks(worked(invoice(), { taxAccounts: null }), undefined)).not.toHaveProperty('nothingToPost');
    expect(invoiceBooks(worked(invoice({ total: '0.00' })), undefined)).toEqual({ entryNo: null, next: null, earlier: [] });
  });

  it('says nothing is next when NetSuite couldn\'t say enough about the month\'s lines', () => {
    expect(invoiceBooks(worked(), undefined, false)).toEqual({ entryNo: null, next: null, earlier: [] });
    expect(invoiceBooks(worked(invoice({ voided: true })), posting(), false)).toMatchObject({ entryNo: 7, next: null });
    // What has nothing to post doesn't wait on the run.
    expect(invoiceBooks(worked(invoice({ voided: true })), undefined, false)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'voided' });
    expect(unsaidFacts({ lines: new Map(), missing: ['quantity', 'rate'] })).toEqual([]);
    expect(unsaidFacts({ lines: new Map(), missing: ['rate', 'amount', 'cogs'] }).map((f) => f.fact)).toEqual(['cogs', 'amount']);
  });
});

describe('invoiceJournalEntry', () => {
  const ids = new Map([['120', 'a-120'], ['400', 'a-400'], ['220', 'a-220']]);

  it('posts the rule\'s lines on the chart\'s accounts, the receivable carrying the customer, under the generation\'s key', () => {
    const { entry } = invoiceJournalEntry(worked(), 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-15', sourceType: 'invoice', sourceId: '101', postingRule: 'invoice@1',
      idempotencyKey: 'invoice:101:2', memo: 'INV101, A Customer', postedBy: null,
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-120', debit: '162.00', credit: null, division: null, itemNumber: null, sourceLineRef: '0', customerId: CUSTOMER },
      { accountId: 'a-400', debit: null, credit: '100.00', division: 'upfit', itemNumber: 'PART-A', sourceLineRef: '1', customerId: null },
      { accountId: 'a-400', debit: null, credit: '50.00', division: 'upfit', itemNumber: 'INSTALL LABOR', sourceLineRef: '2', customerId: null },
      { accountId: 'a-220', debit: null, credit: '12.00', division: null, itemNumber: null, sourceLineRef: '3', customerId: null },
    ]);
  });

  it('names the NetSuite accounts the chart doesn\'t have instead', () => {
    expect(invoiceJournalEntry(worked(), 'BMG', 1, new Map([['120', 'a-120']]))).toEqual({ entry: null, missing: ['400', '220'] });
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const { entry } = invoiceJournalEntry(worked(), 'BMG', 1, ids);
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    const lines = entry!.lines.map((l) => ({
      account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
      division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null,
    }));
    expect(decide(worked(), posting({}, lines))).toEqual({ kind: 'keep' });
  });
});

describe('credit memos', () => {
  const ids = new Map([['120', 'a-120'], ['400', 'a-400'], ['220', 'a-220']]);
  // CM105 gives the part and labor back with their tax: NetSuite's signed amounts the other way round from INV101's.
  const memo = (fields: Partial<Invoice> = {}): Invoice => invoice({
    id: 'id-105', doc_type: 'credit_memo', netsuite_id: '105', number: 'CM105',
    lines: invoice().lines.map((l) => ({ ...l, netamount: String(-Number(l.netamount)) })),
    netsuite: invoice().netsuite.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
    ...fields,
  });
  const held = (fields: Partial<InvoicePosting> = {}) => posting({ source_type: 'credit_memo', source_id: '105', ...fields }, [
    { account: '120', debit: '0.00', credit: '162.00', division: null, source_line_ref: '0', customer_id: CUSTOMER },
    { account: '400', debit: '100.00', credit: '0.00', division: 'upfit', source_line_ref: '1', customer_id: null },
    { account: '400', debit: '50.00', credit: '0.00', division: 'upfit', source_line_ref: '2', customer_id: null },
    { account: '220', debit: '12.00', credit: '0.00', division: null, source_line_ref: '3', customer_id: null },
  ]);

  it('posts a credit memo under its own kind and rule, receivables credited and revenue and tax debited', () => {
    const w = worked(memo());
    expect(w.checked.status).toBe('matches');
    expect(decide(w, undefined)).toEqual({ kind: 'post' });
    const { entry } = invoiceJournalEntry(w, 'BMG', 1, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-15', sourceType: 'credit_memo', sourceId: '105', postingRule: 'credit_memo@1',
      idempotencyKey: 'credit_memo:105:1', memo: 'CM105, A Customer',
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-120', debit: null, credit: '162.00', division: null, itemNumber: null, sourceLineRef: '0', customerId: CUSTOMER },
      { accountId: 'a-400', debit: '100.00', credit: null, division: 'upfit', itemNumber: 'PART-A', sourceLineRef: '1', customerId: null },
      { accountId: 'a-400', debit: '50.00', credit: null, division: 'upfit', itemNumber: 'INSTALL LABOR', sourceLineRef: '2', customerId: null },
      { accountId: 'a-220', debit: '12.00', credit: null, division: null, itemNumber: null, sourceLineRef: '3', customerId: null },
    ]);
  });

  it('keeps, replaces and reverses a credit memo\'s entry as it does an invoice\'s', () => {
    expect(decide(worked(memo()), held())).toEqual({ kind: 'keep' });
    expect(decide(worked(memo({ date: '2026-09-16' })), held())).toEqual({ kind: 'replace' });
    expect(decide(worked(memo({ voided: true })), held())).toEqual({ kind: 'reverse', why: 'voided' });
  });

  it('leaves a credit memo whose lines don\'t come to its total credited, as when they\'re read the wrong way round', () => {
    // With an invoice's signs the receivable would be debited, which no credit memo does.
    expect(decide(worked(memo({ lines: invoice().lines })), undefined)).toEqual({ kind: 'leave', why: 'total' });
    expect(decide(worked(memo({ total: '170.00' })), held())).toEqual({ kind: 'leave', why: 'total' });
  });
});

describe('payments', () => {
  // Besides the chart above: '110' Undeposited Funds, '100' a bank account, '480' sales discounts.
  const PAYMENT_CHART: ChartAccount[] = [
    ...CHART,
    { netsuite_account_id: '110', number: '1100', name: 'Undeposited Funds', account_type: 'other_current_asset', company: null, active: true, is_summary: false },
    { netsuite_account_id: '100', number: '1000', name: 'Checking', account_type: 'bank', company: null, active: true, is_summary: false },
    { netsuite_account_id: '480', number: '4800', name: 'Discounts', account_type: 'income', company: null, active: true, is_summary: false },
  ];
  const ids = new Map([['120', 'a-120'], ['110', 'a-110'], ['480', 'a-480']]);

  type Payment = PaymentMonthData['payments'][number];
  // $162.00 of invoices paid with $3.24 off, as NetSuite posts it: $158.76 came in, receivables take off both.
  const payment = (fields: Partial<Payment> = {}): Payment => ({
    id: 'id-201', netsuite_id: '201', number: 'PMT201', date: '2026-09-10', total: '158.76', voided: false,
    customer: 'A Customer', customer_id: CUSTOMER, companies: ['BMG'], applied: [],
    netsuite: [
      { line_id: '0', account: '110', debit: '158.76', credit: '0.00' },
      { line_id: '1', account: '120', debit: '0.00', credit: '162.00' },
      { line_id: '2', account: '480', debit: '3.24', credit: '0.00' },
    ],
    ...fields,
  });
  const paid = (p: Payment = payment()) => workOutPaymentMonth({ payments: [p] }, { company: 'BMG', chart: PAYMENT_CHART }).payments[0];

  /** What the journal holds when PMT201 posted as it is now, as entry 8. */
  const held = (fields: Partial<PaymentPosting> = {}, lines?: NonNullable<PaymentPosting['current']>['lines']): PaymentPosting => ({
    source_type: 'payment',
    source_id: '201',
    entries: 1,
    unreversed: ['e8'],
    current: {
      id: 'e8', entry_no: 8, entry_date: '2026-09-10',
      lines: lines ?? [
        { account: '110', debit: '158.76', credit: '0.00', division: null, source_line_ref: 'deposit', customer_id: null },
        { account: '480', debit: '3.24', credit: '0.00', division: null, source_line_ref: 'discount', customer_id: null },
        { account: '120', debit: '0.00', credit: '162.00', division: null, source_line_ref: 'receivable', customer_id: CUSTOMER },
      ],
    },
    history: [{ entry_no: 8, entry_date: '2026-09-10', reversed_by: null }],
    payment: { number: 'PMT201', deleted: false, voided: false },
    ...fields,
  });

  it('posts the money, the discount and the receivable under the payment rule, the receivable carrying the customer', () => {
    const w = paid();
    expect(paymentEntryLines(w).map((l) => [l.lineId, l.account, l.cents])).toEqual([
      ['deposit', '110', 15876], ['discount', '480', 324], ['receivable', '120', -16200],
    ]);
    const { entry } = paymentJournalEntry(w, 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-10', sourceType: 'payment', sourceId: '201', postingRule: 'payment@1',
      idempotencyKey: 'payment:201:2', memo: 'PMT201, A Customer', postedBy: null,
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-110', debit: '158.76', credit: null, division: null, itemNumber: null, sourceLineRef: 'deposit', customerId: null },
      { accountId: 'a-480', debit: '3.24', credit: null, division: null, itemNumber: null, sourceLineRef: 'discount', customerId: null },
      { accountId: 'a-120', debit: null, credit: '162.00', division: null, itemNumber: null, sourceLineRef: 'receivable', customerId: CUSTOMER },
    ]);
    expect(paymentJournalEntry(w, 'BMG', 1, new Map([['120', 'a-120']]))).toEqual({ entry: null, missing: ['110', '480'] });
  });

  it('posts a payment nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decidePayment(paid(), undefined)).toEqual({ kind: 'post' });
    expect(decidePayment(paid(), held())).toEqual({ kind: 'keep' });
    expect(decidePayment(paid(payment({ number: 'PMT201-A', customer: 'Renamed' })), held())).toEqual({ kind: 'keep' });
    expect(decidePayment(paid(payment({ date: '2026-09-11' })), held())).toEqual({ kind: 'replace' });
    expect(decidePayment(paid(payment({ customer_id: null })), held())).toEqual({ kind: 'replace' });
    const banked = payment({ netsuite: payment().netsuite.map((l) => (l.line_id === '0' ? { ...l, account: '100' } : l)) });
    expect(decidePayment(paid(banked), held())).toEqual({ kind: 'replace' });
  });

  it('reverses the entry of a voided payment or one that comes to nothing, and leaves one it can\'t work out or not copied yet', () => {
    expect(decidePayment(paid(payment({ voided: true })), held())).toEqual({ kind: 'reverse', why: 'voided' });
    expect(decidePayment(paid(payment({ voided: true })), undefined)).toEqual({ kind: 'keep', why: 'voided' });
    // $0, and NetSuite posts no lines for it.
    const zero = payment({ total: '0.00', companies: [], netsuite: [] });
    expect(paymentEntryLines(paid(zero))).toEqual([]);
    expect(decidePayment(paid(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decidePayment(paid(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    expect(decidePayment(paid(payment({ companies: [], netsuite: [] })), held())).toEqual({ kind: 'leave', why: 'waiting' });
    // NetSuite's posting doesn't say where the money went.
    const split = payment({
      total: '162.00',
      netsuite: [
        { line_id: '1', account: '120', debit: '0.00', credit: '162.00' },
        { line_id: '2', account: '110', debit: '100.00', credit: '0.00' },
        { line_id: '3', account: '100', debit: '62.00', credit: '0.00' },
      ],
    });
    expect(decidePayment(paid(split), held())).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('says what the journal holds for a payment and what the next run does', () => {
    expect(paymentBooks(paid(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(paymentBooks(paid(), held())).toEqual({ entryNo: 8, next: null, earlier: [] });
    expect(paymentBooks(paid(payment({ voided: true })), held()).next).toBe('reverse');
    expect(paymentBooks(paid(payment({ date: '2026-09-11' })), held()).next).toBe('replace');
    // Nothing to post, with none of its entries standing: voided, or $0.
    expect(paymentBooks(paid(payment({ voided: true })), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'voided' });
    expect(paymentBooks(paid(payment({ total: '0.00', companies: [], netsuite: [] })), undefined)).toMatchObject({ nothingToPost: 'zero' });
    expect(paymentBooks(paid(payment({ voided: true })), held())).not.toHaveProperty('nothingToPost');
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const { entry } = paymentJournalEntry(paid(), 'BMG', 1, ids);
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    const lines = entry!.lines.map((l) => ({
      account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
      division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null,
    }));
    expect(decidePayment(paid(), held({}, lines))).toEqual({ kind: 'keep' });
  });
});

describe('deposits', () => {
  // Besides the chart above: '110' Undeposited Funds, '100' a bank account, '230' customer deposits.
  const DEPOSIT_CHART: ChartAccount[] = [
    ...CHART,
    { netsuite_account_id: '110', number: '1100', name: 'Undeposited Funds', account_type: 'other_current_asset', company: null, active: true, is_summary: false },
    { netsuite_account_id: '100', number: '1000', name: 'Checking', account_type: 'bank', company: null, active: true, is_summary: false },
    { netsuite_account_id: '230', number: '2300', name: 'Customer Deposits', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
  ];
  const ids = new Map([['120', 'a-120'], ['110', 'a-110'], ['230', 'a-230']]);

  type Doc = DepositMonthData['deposits'][number];
  // A $500.00 deposit as NetSuite posts it: the money in Undeposited Funds, customer deposits credited.
  const deposit = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '301', type: 'CustDep', number: 'DEP301', date: '2026-09-10', total: '500.00', voided: false, status: null,
    customer: 'A Customer', customer_id: CUSTOMER, companies: ['BMG'], links: [], applications: [],
    netsuite: [
      { line_id: '0', account: '110', debit: '500.00', credit: '0.00' },
      { line_id: '1', account: '230', debit: '0.00', credit: '500.00' },
    ],
    ...fields,
  });
  // $300.00 of it applied to an invoice: customer deposits debited, receivables credited.
  const application = (fields: Partial<Doc> = {}): Doc => deposit({
    netsuite_id: '311', type: 'DepAppl', number: 'DA311', date: '2026-09-20', total: '300.00',
    netsuite: [
      { line_id: '0', account: '120', debit: '0.00', credit: '300.00' },
      { line_id: '1', account: '230', debit: '300.00', credit: '0.00' },
    ],
    ...fields,
  });
  const dep = (d: Doc = deposit()) => workOutDepositMonth(
    { deposits: [d], accounts: [{ account: '230', documents: 2 }], not_copied: [] },
    { company: 'BMG', chart: DEPOSIT_CHART },
  ).deposits[0];

  /** What the journal holds when DEP301 posted as it is now, as entry 9. */
  const held = (fields: Partial<DepositPosting> = {}, lines?: NonNullable<DepositPosting['current']>['lines']): DepositPosting => ({
    source_type: 'customer_deposit',
    source_id: '301',
    entries: 1,
    unreversed: ['e9'],
    current: {
      id: 'e9', entry_no: 9, entry_date: '2026-09-10',
      lines: lines ?? [
        { account: '110', debit: '500.00', credit: '0.00', division: null, source_line_ref: 'money', customer_id: null },
        { account: '230', debit: '0.00', credit: '500.00', division: null, source_line_ref: 'deposits', customer_id: CUSTOMER },
      ],
    },
    history: [{ entry_no: 9, entry_date: '2026-09-10', reversed_by: null }],
    deposit: { number: 'DEP301', deleted: false, voided: false },
    ...fields,
  });

  it('posts where a deposit\'s money went and credits customer deposits under the deposit rule, that line carrying the customer', () => {
    const w = dep();
    expect(depositEntryLines(w).map((l) => [l.lineId, l.account, l.cents])).toEqual([['money', '110', 50000], ['deposits', '230', -50000]]);
    const { entry } = depositJournalEntry(w, 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-10', sourceType: 'customer_deposit', sourceId: '301', postingRule: 'deposit@1',
      idempotencyKey: 'customer_deposit:301:2', memo: 'DEP301, A Customer', postedBy: null,
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-110', debit: '500.00', credit: null, division: null, itemNumber: null, sourceLineRef: 'money', customerId: null },
      { accountId: 'a-230', debit: null, credit: '500.00', division: null, itemNumber: null, sourceLineRef: 'deposits', customerId: CUSTOMER },
    ]);
    expect(depositJournalEntry(w, 'BMG', 1, new Map([['230', 'a-230']]))).toEqual({ entry: null, missing: ['110'] });
  });

  it('posts an application out of customer deposits and off receivables, both lines carrying the customer', () => {
    const { entry } = depositJournalEntry(dep(application()), 'BMG', 1, ids);
    expect(entry).toMatchObject({
      entryDate: '2026-09-20', sourceType: 'deposit_application', sourceId: '311', postingRule: 'deposit@1',
      idempotencyKey: 'deposit_application:311:1', memo: 'DA311, A Customer',
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-230', debit: '300.00', credit: null, division: null, itemNumber: null, sourceLineRef: 'deposits', customerId: CUSTOMER },
      { accountId: 'a-120', debit: null, credit: '300.00', division: null, itemNumber: null, sourceLineRef: 'receivable', customerId: CUSTOMER },
    ]);
    // No number, and no customer FleetSuite matched: the memo goes by NetSuite's id, the lines by no customer.
    const bare = depositJournalEntry(dep(application({ number: null, customer: null, customer_id: null })), 'BMG', 1, ids).entry!;
    expect(bare.memo).toBe('NetSuite 311');
    expect(bare.lines.map((l) => l.customerId)).toEqual([null, null]);
  });

  it('posts a deposit nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decideDeposit(dep(), undefined)).toEqual({ kind: 'post' });
    expect(decideDeposit(dep(), held())).toEqual({ kind: 'keep' });
    expect(decideDeposit(dep(deposit({ number: 'DEP301-A', customer: 'Renamed', status: 'Fully Applied' })), held())).toEqual({ kind: 'keep' });
    expect(decideDeposit(dep(deposit({ date: '2026-09-11' })), held())).toEqual({ kind: 'replace' });
    expect(decideDeposit(dep(deposit({ customer_id: null })), held())).toEqual({ kind: 'replace' });
    expect(decideDeposit(dep(deposit({ total: '450.00' })), held())).toEqual({ kind: 'replace' });
    const banked = deposit({ netsuite: deposit().netsuite.map((l) => (l.line_id === '0' ? { ...l, account: '100' } : l)) });
    expect(decideDeposit(dep(banked), held())).toEqual({ kind: 'replace' });
  });

  it('reverses the entry of a voided deposit or one that comes to nothing, and leaves one it can\'t work out or not in the GL copy yet', () => {
    expect(decideDeposit(dep(deposit({ voided: true })), held())).toEqual({ kind: 'reverse', why: 'voided' });
    expect(decideDeposit(dep(deposit({ voided: true })), undefined)).toEqual({ kind: 'keep', why: 'voided' });
    // $0, and NetSuite posts no lines for it.
    const zero = deposit({ total: '0.00', companies: [], netsuite: [] });
    expect(depositEntryLines(dep(zero))).toEqual([]);
    expect(decideDeposit(dep(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decideDeposit(dep(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    expect(decideDeposit(dep(deposit({ companies: [], netsuite: [] })), held())).toEqual({ kind: 'leave', why: 'waiting' });
    // NetSuite's posting doesn't say where the money went.
    const split = deposit({
      netsuite: [
        { line_id: '1', account: '230', debit: '0.00', credit: '500.00' },
        { line_id: '2', account: '110', debit: '200.00', credit: '0.00' },
        { line_id: '3', account: '100', debit: '300.00', credit: '0.00' },
      ],
    });
    expect(decideDeposit(dep(split), held())).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('says what the journal holds for a deposit and what the next run does, found by its kind and NetSuite id', () => {
    expect(depositBooks(dep(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(depositBooks(dep(), held())).toEqual({ entryNo: 9, next: null, earlier: [] });
    expect(depositBooks(dep(deposit({ voided: true })), held()).next).toBe('reverse');
    expect(depositBooks(dep(deposit({ date: '2026-09-11' })), held()).next).toBe('replace');
    expect(depositBooks(dep(deposit({ voided: true })), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'voided' });
    expect(depositBooks(dep(deposit({ total: '0.00', companies: [], netsuite: [] })), undefined)).toMatchObject({ nothingToPost: 'zero' });
    expect(depositBooks(dep(deposit({ voided: true })), held())).not.toHaveProperty('nothingToPost');
    const postings = new Map([[postingKey('customer_deposit', '301'), held()]]);
    expect(depositPostingFor(postings, dep())).toBe(postings.get('customer_deposit:301'));
    expect(depositPostingFor(postings, dep(application({ netsuite_id: '301' })))).toBeUndefined();
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    for (const d of [deposit(), application()]) {
      const { entry } = depositJournalEntry(dep(d), 'BMG', 1, ids);
      const lines = entry!.lines.map((l) => ({
        account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
        division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null,
      }));
      const current = { id: 'e9', entry_no: 9, entry_date: d.date, lines };
      expect(decideDeposit(dep(d), held({ current }))).toEqual({ kind: 'keep' });
    }
  });
});

describe('bills', () => {
  // Made-up books: '200' payables, '205' received not billed, '130' inventory, '530' subcontractors, '610' shop supplies.
  const BILL_CHART: ChartAccount[] = [
    { netsuite_account_id: '200', number: '2000', name: 'Accounts Payable', account_type: 'accounts_payable', company: 'BMG', active: true, is_summary: false },
    { netsuite_account_id: '205', number: '2050', name: 'Received Not Billed', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
    { netsuite_account_id: '130', number: '1300', name: 'Inventory', account_type: 'other_current_asset', company: null, active: true, is_summary: false },
    { netsuite_account_id: '530', number: '5300', name: 'Subcontractors', account_type: 'expense', company: null, active: true, is_summary: false },
    { netsuite_account_id: '610', number: '6100', name: 'Shop Supplies', account_type: 'expense', company: null, active: true, is_summary: false },
  ];
  const ids = new Map(['200', '205', '130', '530', '610'].map((a) => [a, `a-${a}`]));

  type Doc = BillMonthData['bills'][number];
  type Line = NonNullable<Doc['lines']>[number];
  const copied = (lineId: string, item: string | null, account: string | null, amount: string): Line => ({
    line_id: lineId, item, account, amount, quantity: null, memo: null, tax: false,
  });
  // A $650.00 bill from a purchase order, as NetSuite posts it: an installer's labor, supplies, and stock already received.
  const bill = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '701', type: 'VendBill', number: 'B-701', date: '2026-09-08', posting_month: '2026-09-01', total: '650.00', voided: false,
    status: 'Open', vendor: 'Sample Supply Co', vendor_netsuite_id: '50', vendor_payables: '200', companies: ['BMG'],
    lines: [copied('1', null, '530', '500.00'), copied('2', '902', null, '120.00'), copied('3', '901', null, '30.00')],
    links: [{ netsuite_id: '601', type: 'PurchOrd', number: 'PO601', amount: '650.00' }],
    netsuite: [
      { line_id: '0', account: '200', debit: '0.00', credit: '650.00' },
      { line_id: '1', account: '530', debit: '500.00', credit: '0.00' },
      { line_id: '2', account: '610', debit: '120.00', credit: '0.00' },
      { line_id: '3', account: '205', debit: '30.00', credit: '0.00' },
    ],
    ...fields,
  });
  // $120.00 of the supplies sent back: payables debited, the supplies' account credited.
  const credit = (fields: Partial<Doc> = {}): Doc => bill({
    netsuite_id: '702', type: 'VendCred', number: 'VC-702', date: '2026-09-12', total: '120.00', status: null,
    lines: [copied('1', '902', null, '-120.00')], links: [],
    netsuite: [
      { line_id: '0', account: '200', debit: '120.00', credit: '0.00' },
      { line_id: '1', account: '610', debit: '0.00', credit: '120.00' },
    ],
    ...fields,
  });
  const month = (bills: Doc[]) => workOutBillMonth(
    {
      bills,
      items: [
        { netsuite_id: '901', name: 'WIDGET-1', item_type: 'InvtPart', asset_account: '130', expense_account: null, income_account: null },
        { netsuite_id: '902', name: 'SUPPLY-2', item_type: 'NonInvtPart', asset_account: null, expense_account: '610', income_account: null },
      ],
      receipt_accounts: [{ account: '205', documents: 3 }],
      not_copied: [],
    },
    { company: 'BMG', chart: BILL_CHART },
  ).bills;
  const one = (d: Doc = bill()) => month([d])[0];

  /** What the journal holds when B-701 posted as it is now, as entry 11. */
  const held = (fields: Partial<BillPosting> = {}, lines?: NonNullable<BillPosting['current']>['lines']): BillPosting => ({
    source_type: 'vendor_bill',
    source_id: '701',
    entries: 1,
    unreversed: ['e11'],
    current: {
      id: 'e11', entry_no: 11, entry_date: '2026-09-08',
      lines: lines ?? [
        { account: '200', debit: '0.00', credit: '650.00', division: null, source_line_ref: 'payables', customer_id: null, vendor_ref: '50' },
        { account: '530', debit: '500.00', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '610', debit: '120.00', credit: '0.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
        { account: '205', debit: '30.00', credit: '0.00', division: null, source_line_ref: '3', customer_id: null, vendor_ref: null },
      ],
    },
    history: [{ entry_no: 11, entry_date: '2026-09-08', reversed_by: null }],
    bill: { number: 'B-701', deleted: false, voided: false },
    ...fields,
  });

  it('posts the rule\'s lines under the bill rule in the month NetSuite booked it into, the payables line carrying the vendor', () => {
    const { entry } = billJournalEntry(one(), 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-08', sourceType: 'vendor_bill', sourceId: '701', postingRule: 'bill@1',
      idempotencyKey: 'vendor_bill:701:2', memo: 'B-701, Sample Supply Co', postedBy: null,
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-200', debit: null, credit: '650.00', division: null, itemNumber: null, sourceLineRef: 'payables', vendorRef: '50' },
      { accountId: 'a-530', debit: '500.00', credit: null, division: null, itemNumber: null, sourceLineRef: '1', vendorRef: null },
      { accountId: 'a-610', debit: '120.00', credit: null, division: null, itemNumber: 'SUPPLY-2', sourceLineRef: '2', vendorRef: null },
      { accountId: 'a-205', debit: '30.00', credit: null, division: null, itemNumber: 'WIDGET-1', sourceLineRef: '3', vendorRef: null },
    ]);
    // Dated in August, booked into September: the entry goes on September's first day.
    expect(billJournalEntry(one(bill({ date: '2026-08-30' })), 'BMG', 1, ids).entry!.entryDate).toBe('2026-09-01');
    // No number and no vendor: the memo goes by NetSuite's id, the payables line by no vendor.
    const bare = billJournalEntry(one(bill({ number: null, vendor: null, vendor_netsuite_id: null })), 'BMG', 1, ids).entry!;
    expect(bare.memo).toBe('NetSuite 701');
    expect(bare.lines.map((l) => l.vendorRef)).toEqual([null, null, null, null]);
    expect(billJournalEntry(one(), 'BMG', 1, new Map([['200', 'a-200'], ['530', 'a-530']]))).toEqual({ entry: null, missing: ['610', '205'] });
  });

  it('posts a bill credit the other way round, under its own kind', () => {
    const { entry } = billJournalEntry(one(credit()), 'BMG', 1, ids);
    expect(entry).toMatchObject({
      entryDate: '2026-09-12', sourceType: 'vendor_credit', sourceId: '702', postingRule: 'bill@1', idempotencyKey: 'vendor_credit:702:1',
      memo: 'VC-702, Sample Supply Co',
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-200', debit: '120.00', credit: null, division: null, itemNumber: null, sourceLineRef: 'payables', vendorRef: '50' },
      { accountId: 'a-610', debit: null, credit: '120.00', division: null, itemNumber: 'SUPPLY-2', sourceLineRef: '1', vendorRef: null },
    ]);
  });

  it('posts a bill nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decideBill(one(), undefined)).toEqual({ kind: 'post' });
    expect(decideBill(one(), held())).toEqual({ kind: 'keep' });
    // A new number, status or vendor name only describes.
    expect(decideBill(one(bill({ number: 'B-701-A', status: 'Paid In Full', vendor: 'Renamed Supply' })), held())).toEqual({ kind: 'keep' });
    const changed: Array<Partial<Doc>> = [
      { date: '2026-09-09' },
      // Booked into October now: the entry moves to October's first day.
      { posting_month: '2026-10-01' },
      { vendor_netsuite_id: '51' },
      { total: '670.00', lines: [copied('1', null, '530', '520.00'), copied('2', '902', null, '120.00'), copied('3', '901', null, '30.00')] },
      { lines: [copied('1', null, '610', '500.00'), copied('2', '902', null, '120.00'), copied('3', '901', null, '30.00')] },
      // Not from a purchase order after all: the stock goes to its asset account.
      { links: [] },
    ];
    for (const fields of changed) expect(decideBill(one(bill(fields)), held()), JSON.stringify(fields)).toEqual({ kind: 'replace' });
  });

  it('reverses the entry of a voided bill or one that comes to nothing, and leaves one it can\'t work out or not copied yet', () => {
    expect(decideBill(one(bill({ voided: true })), held())).toEqual({ kind: 'reverse', why: 'voided' });
    expect(decideBill(one(bill({ voided: true })), undefined)).toEqual({ kind: 'keep', why: 'voided' });
    // $0, and NetSuite posts no lines for it.
    const zero = bill({ total: '0.00', lines: [copied('1', null, '530', '0.00')], companies: [], netsuite: [] });
    expect(one(zero).checked.lines).toEqual([]);
    expect(decideBill(one(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decideBill(one(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    // Not in the GL copy yet, or its lines not copied yet.
    expect(decideBill(one(bill({ companies: [], netsuite: [] })), held())).toEqual({ kind: 'leave', why: 'waiting' });
    expect(decideBill(one(bill({ lines: null })), held())).toEqual({ kind: 'leave', why: 'waiting' });
    // An item the copy of NetSuite's items doesn't have.
    expect(decideBill(one(bill({ lines: [copied('1', '999', null, '650.00')] })), held())).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('leaves whatever stands when the lines don\'t come to the total, as when the copy is caught mid-refresh or reads them the wrong way round', () => {
    expect(decideBill(one(bill({ total: '660.00' })), held())).toEqual({ kind: 'leave', why: 'total' });
    expect(decideBill(one(bill({ total: '660.00' })), undefined)).toEqual({ kind: 'leave', why: 'total' });
    // Most of the month's bill credits sign their lines one way and this one the other: it comes out a debit to its supplies.
    const credits = month([
      credit({ netsuite_id: '703', number: 'VC-703' }),
      credit({ netsuite_id: '704', number: 'VC-704' }),
      credit({ lines: [copied('1', '902', null, '120.00')] }),
    ]);
    expect(credits.map((w) => decideBill(w, undefined))).toEqual([{ kind: 'post' }, { kind: 'post' }, { kind: 'leave', why: 'total' }]);
  });

  it('says what the journal holds for a bill and what the next run does, found by its kind and NetSuite id', () => {
    expect(billBooks(one(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(billBooks(one(), held())).toEqual({ entryNo: 11, next: null, earlier: [] });
    expect(billBooks(one(bill({ voided: true })), held()).next).toBe('reverse');
    expect(billBooks(one(bill({ date: '2026-09-09' })), held()).next).toBe('replace');
    expect(billBooks(one(bill({ total: '660.00' })), held()).next).toBeNull();
    expect(billBooks(one(bill({ voided: true })), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'voided' });
    const zero = bill({ total: '0.00', lines: [copied('1', null, '530', '0.00')], companies: [], netsuite: [] });
    expect(billBooks(one(zero), undefined)).toMatchObject({ nothingToPost: 'zero' });
    // Lines that don't come to its total yet aren't nothing to post.
    expect(billBooks(one(bill({ total: '660.00' })), undefined)).not.toHaveProperty('nothingToPost');
    const postings = new Map([[postingKey('vendor_bill', '701'), held()]]);
    expect(billPostingFor(postings, one())).toBe(postings.get('vendor_bill:701'));
    expect(billPostingFor(postings, one(credit({ netsuite_id: '701' })))).toBeUndefined();
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    for (const d of [bill(), credit(), bill({ date: '2026-08-30' })]) {
      const w = one(d);
      const { entry } = billJournalEntry(w, 'BMG', 1, ids);
      const lines = entry!.lines.map((l) => ({
        account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
        division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null, vendor_ref: l.vendorRef ?? null,
      }));
      const current = { id: 'e11', entry_no: 11, entry_date: entry!.entryDate, lines };
      expect(decideBill(w, held({ current }))).toEqual({ kind: 'keep' });
    }
  });
});

describe('bill payments', () => {
  // Made-up books: '200' payables, '100' checking, '220' a company card, '485' purchase discounts.
  const PAY_CHART: ChartAccount[] = [
    { netsuite_account_id: '200', number: '2000', name: 'Accounts Payable', account_type: 'accounts_payable', company: 'BMG', active: true, is_summary: false },
    { netsuite_account_id: '100', number: '1000', name: 'Checking', account_type: 'bank', company: null, active: true, is_summary: false },
    { netsuite_account_id: '220', number: '2200', name: 'Company Card', account_type: 'credit_card', company: null, active: true, is_summary: false },
    { netsuite_account_id: '485', number: '4850', name: 'Purchase Discounts', account_type: 'other_income', company: null, active: true, is_summary: false },
  ];
  const ids = new Map(['200', '100', '220', '485'].map((a) => [a, `a-${a}`]));

  type Doc = BillPaymentMonthData['payments'][number];
  type Posted = Doc['netsuite'][number];
  const gl = (lineId: string, account: string, debit: string, credit: string): Posted => ({ line_id: lineId, account, debit, credit });
  // $650.00 of bills paid with $13.00 off, as NetSuite posts it: $637.00 out of checking, payables take off the money and the discount.
  const payment = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '801', number: 'CHK1001', date: '2026-09-08', posting_month: '2026-09-01', total: '637.00', voided: false,
    status: 'Online Bill Pay', vendor: 'Sample Supply Co', vendor_netsuite_id: '50', vendor_payables: '200', companies: ['BMG'],
    links: [{ netsuite_id: '701', type: 'VendBill', number: 'B-701', amount: '650.00' }],
    netsuite: [gl('0', '100', '0.00', '637.00'), gl('1', '200', '650.00', '0.00'), gl('2', '485', '0.00', '13.00')],
    ...fields,
  });
  const one = (d: Doc = payment()) => workOutBillPaymentMonth({ payments: [d], not_copied: [] }, { company: 'BMG', chart: PAY_CHART }).payments[0];

  /** What the journal holds when CHK1001 posted as it is now, as entry 21. */
  const held = (fields: Partial<BillPaymentPosting> = {}): BillPaymentPosting => ({
    source_type: 'bill_payment',
    source_id: '801',
    entries: 1,
    unreversed: ['e21'],
    current: {
      id: 'e21', entry_no: 21, entry_date: '2026-09-08',
      lines: [
        { account: '200', debit: '650.00', credit: '0.00', division: null, source_line_ref: 'payables', customer_id: null, vendor_ref: '50' },
        { account: '100', debit: '0.00', credit: '637.00', division: null, source_line_ref: 'paid_from', customer_id: null, vendor_ref: null },
        { account: '485', debit: '0.00', credit: '13.00', division: null, source_line_ref: 'discount', customer_id: null, vendor_ref: null },
      ],
    },
    history: [{ entry_no: 21, entry_date: '2026-09-08', reversed_by: null }],
    payment: { number: 'CHK1001', deleted: false, voided: false },
    ...fields,
  });

  it('posts payables, the money and the discount under the bill payment rule in the month NetSuite booked it into, payables carrying the vendor', () => {
    const { entry } = billPaymentJournalEntry(one(), 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-08', sourceType: 'bill_payment', sourceId: '801', postingRule: 'bill_payment@1',
      idempotencyKey: 'bill_payment:801:2', memo: 'CHK1001, Sample Supply Co', postedBy: null,
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-200', debit: '650.00', credit: null, division: null, itemNumber: null, sourceLineRef: 'payables', vendorRef: '50' },
      { accountId: 'a-100', debit: null, credit: '637.00', division: null, itemNumber: null, sourceLineRef: 'paid_from', vendorRef: null },
      { accountId: 'a-485', debit: null, credit: '13.00', division: null, itemNumber: null, sourceLineRef: 'discount', vendorRef: null },
    ]);
    // Dated in August, booked into September: the entry goes on September's first day.
    expect(billPaymentJournalEntry(one(payment({ date: '2026-08-30' })), 'BMG', 1, ids).entry!.entryDate).toBe('2026-09-01');
    // No number and no vendor: the memo goes by NetSuite's id, the payables line by no vendor.
    const bare = billPaymentJournalEntry(one(payment({ number: null, vendor: null, vendor_netsuite_id: null })), 'BMG', 1, ids).entry!;
    expect(bare.memo).toBe('NetSuite 801');
    expect(bare.lines.map((l) => l.vendorRef)).toEqual([null, null, null]);
    expect(billPaymentJournalEntry(one(), 'BMG', 1, new Map([['200', 'a-200']]))).toEqual({ entry: null, missing: ['100', '485'] });
  });

  it('posts a bill payment nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decideBillPayment(one(), undefined)).toEqual({ kind: 'post' });
    expect(decideBillPayment(one(), held())).toEqual({ kind: 'keep' });
    // A new number, status or vendor name only describes, as do the bills it paid.
    expect(decideBillPayment(one(payment({ number: 'CHK1001-A', status: 'Cleared', vendor: 'Renamed Supply', links: [] })), held()))
      .toEqual({ kind: 'keep' });
    // NetSuite took out more than the copy's total: FleetSuite posts what the rule works out, and Differences shows the gap.
    const short = one(payment({ total: '640.00' }));
    expect(short.checked.status).toBe('differs');
    expect(decideBillPayment(short, undefined)).toEqual({ kind: 'post' });
    const changed: Array<Partial<Doc>> = [
      { date: '2026-09-09' },
      // Booked into October now: the entry moves to October's first day.
      { posting_month: '2026-10-01' },
      { vendor_netsuite_id: '51' },
      // A bigger discount: less money out, the same off payables.
      { total: '630.00', netsuite: [gl('0', '100', '0.00', '630.00'), gl('1', '200', '650.00', '0.00'), gl('2', '485', '0.00', '20.00')] },
      // Paid by card.
      { netsuite: [gl('0', '220', '0.00', '637.00'), gl('1', '200', '650.00', '0.00'), gl('2', '485', '0.00', '13.00')] },
    ];
    for (const fields of changed) expect(decideBillPayment(one(payment(fields)), held()), JSON.stringify(fields)).toEqual({ kind: 'replace' });
  });

  it('posts a bill payment NetSuite voided but still books, as its journal entry reversing the payment posts too', () => {
    const voided = one(payment({ voided: true, status: 'Voided' }));
    expect(decideBillPayment(voided, undefined)).toEqual({ kind: 'post' });
    expect(decideBillPayment(voided, held())).toEqual({ kind: 'keep' });
    expect(decideBillPayment(one(payment({ voided: true, date: '2026-09-09' })), held())).toEqual({ kind: 'replace' });
    // Its entry, reversed when a run before this rule read it as voided, posts again.
    const reversed = held({ unreversed: [], current: null, history: [{ entry_no: 21, entry_date: '2026-09-08', reversed_by: 22 }] });
    expect(decideBillPayment(voided, reversed)).toEqual({ kind: 'post' });
    expect(billPaymentBooks(voided, undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
  });

  it('reverses the entry of a bill payment voided with its lines taken away or one that comes to nothing, and leaves one it can\'t work out or not in the GL copy yet', () => {
    const voids: Array<Partial<Doc>> = [
      // Its lines taken away, with the total kept or zeroed.
      { companies: [], netsuite: [] },
      { total: '0.00', companies: [], netsuite: [] },
      // Its lines kept at nothing, or coming to nothing on every account.
      { total: '0.00', netsuite: [gl('0', '100', '0.00', '0.00'), gl('1', '200', '0.00', '0.00')] },
      { netsuite: [gl('0', '100', '0.00', '637.00'), gl('1', '200', '650.00', '0.00'), gl('2', '485', '0.00', '13.00'),
        gl('3', '100', '637.00', '0.00'), gl('4', '200', '0.00', '650.00'), gl('5', '485', '13.00', '0.00')] },
    ];
    for (const fields of voids) {
      const voided = one(payment({ voided: true, ...fields }));
      expect(decideBillPayment(voided, held()), JSON.stringify(fields)).toEqual({ kind: 'reverse', why: 'voided' });
      expect(decideBillPayment(voided, undefined), JSON.stringify(fields)).toEqual({ kind: 'keep', why: 'voided' });
    }
    // $0: it only applies a bill credit to a bill, and NetSuite posts no lines for it.
    const zero = payment({ total: '0.00', companies: [], netsuite: [] });
    expect(one(zero).checked.lines).toEqual([]);
    expect(decideBillPayment(one(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decideBillPayment(one(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    expect(decideBillPayment(one(payment({ companies: [], netsuite: [] })), held())).toEqual({ kind: 'leave', why: 'waiting' });
    // NetSuite's posting doesn't say where the money came from: no main line, and two accounts credited.
    const split = payment({
      netsuite: [gl('1', '200', '650.00', '0.00'), gl('2', '100', '0.00', '400.00'), gl('3', '220', '0.00', '237.00'), gl('4', '485', '0.00', '13.00')],
    });
    expect(decideBillPayment(one(split), held())).toEqual({ kind: 'leave', why: 'unworkable' });
    expect(decideBillPayment(one(split), undefined)).toEqual({ kind: 'leave', why: 'unworkable' });
    // The copy's total can't be read.
    expect(decideBillPayment(one(payment({ total: 'n/a' })), held())).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('says what the journal holds for a bill payment and what the next run does', () => {
    expect(billPaymentBooks(one(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(billPaymentBooks(one(), held())).toEqual({ entryNo: 21, next: null, earlier: [] });
    expect(billPaymentBooks(one(payment({ voided: true, companies: [], netsuite: [] })), held()).next).toBe('reverse');
    expect(billPaymentBooks(one(payment({ date: '2026-09-09' })), held()).next).toBe('replace');
    expect(billPaymentBooks(one(payment({ companies: [], netsuite: [] })), held()).next).toBeNull();
    expect(billPaymentBooks(one(payment({ voided: true, companies: [], netsuite: [] })), undefined))
      .toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'voided' });
    expect(billPaymentBooks(one(payment({ total: '0.00', companies: [], netsuite: [] })), undefined)).toMatchObject({ nothingToPost: 'zero' });
    // $0 with a discount taken still posts: payables and the discount.
    const discountOnly = payment({ total: '0.00', netsuite: [gl('1', '200', '13.00', '0.00'), gl('2', '485', '0.00', '13.00')] });
    expect(billPaymentBooks(one(discountOnly), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    // Its first entry, reversed when NetSuite changed the payment.
    const again = held({
      entries: 2,
      history: [{ entry_no: 14, entry_date: '2026-09-08', reversed_by: 20 }, { entry_no: 21, entry_date: '2026-09-08', reversed_by: null }],
    });
    expect(billPaymentBooks(one(), again)).toEqual({ entryNo: 21, next: null, earlier: [{ entryNo: 14, reversedBy: 20 }] });
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    const paidInFull = payment({ total: '650.00', netsuite: [gl('0', '100', '0.00', '650.00'), gl('1', '200', '650.00', '0.00')] });
    for (const d of [payment(), payment({ date: '2026-08-30' }), payment({ vendor_netsuite_id: null }), paidInFull]) {
      const w = one(d);
      const { entry } = billPaymentJournalEntry(w, 'BMG', 1, ids);
      const lines = entry!.lines.map((l) => ({
        account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
        division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null, vendor_ref: l.vendorRef ?? null,
      }));
      const current = { id: 'e21', entry_no: 21, entry_date: entry!.entryDate, lines };
      expect(decideBillPayment(w, held({ current })), JSON.stringify(d)).toEqual({ kind: 'keep' });
    }
  });
});

describe('checks and card charges', () => {
  // Made-up books: '100' checking, '220' the Chase card, '130' inventory, '610' shop supplies, '640' meals.
  const SPEND_CHART: ChartAccount[] = [
    { netsuite_account_id: '100', number: '1000', name: 'Checking', account_type: 'bank', company: null, active: true, is_summary: false },
    { netsuite_account_id: '220', number: '2200', name: 'Chase Card', account_type: 'credit_card', company: null, active: true, is_summary: false },
    { netsuite_account_id: '130', number: '1300', name: 'Inventory', account_type: 'other_current_asset', company: null, active: true, is_summary: false },
    { netsuite_account_id: '610', number: '6100', name: 'Shop Supplies', account_type: 'expense', company: null, active: true, is_summary: false },
    { netsuite_account_id: '640', number: '6400', name: 'Meals', account_type: 'expense', company: null, active: true, is_summary: false },
  ];
  const ids = new Map(['100', '220', '130', '610', '640'].map((a) => [a, `a-${a}`]));

  type Doc = SpendingMonthData['documents'][number];
  type Line = NonNullable<Doc['lines']>[number];
  type Posted = Doc['netsuite'][number];
  const copied = (lineId: string, item: string | null, account: string | null, amount: string): Line => ({
    line_id: lineId, item, account, amount, quantity: null, memo: null, tax: false,
  });
  const gl = (lineId: string, account: string, debit: string, credit: string): Posted => ({ line_id: lineId, account, debit, credit });
  // A $165.12 check for meals and supplies, as NetSuite posts it; NetSuite gives the check's lines negative.
  const check = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '801', type: 'Check', number: '10234', date: '2026-09-03', posting_month: '2026-09-01', total: '165.12', voided: false,
    status: null, payee: 'Sample Supply Co', payee_netsuite_id: '50', companies: ['BMG'],
    lines: [copied('1', null, '640', '-45.12'), copied('2', '902', null, '-120.00')],
    netsuite: [gl('0', '100', '0.00', '165.12'), gl('1', '640', '45.12', '0.00'), gl('2', '610', '120.00', '0.00')],
    ...fields,
  });
  // $300.00 of stock on the card, which NetSuite gives no number.
  const charge = (fields: Partial<Doc> = {}): Doc => check({
    netsuite_id: '802', type: 'CardChrg', number: null, date: '2026-09-10', total: '300.00', payee: 'Another Supplier', payee_netsuite_id: '51',
    lines: [copied('1', '901', null, '-300.00')],
    netsuite: [gl('0', '220', '0.00', '300.00'), gl('1', '130', '300.00', '0.00')],
    ...fields,
  });
  // $25.99 of supplies refunded to the card: the card debited, the supplies' account credited; NetSuite gives a refund's lines positive.
  const refund = (fields: Partial<Doc> = {}): Doc => check({
    netsuite_id: '803', type: 'CardRfnd', number: 'R-803', date: '2026-09-15', total: '25.99', payee: 'Another Supplier', payee_netsuite_id: '51',
    lines: [copied('1', null, '610', '25.99')],
    netsuite: [gl('0', '220', '25.99', '0.00'), gl('1', '610', '0.00', '25.99')],
    ...fields,
  });
  const month = (documents: Doc[]) => workOutSpendingMonth(
    {
      documents,
      items: [
        { netsuite_id: '901', name: 'WIDGET-1', item_type: 'InvtPart', asset_account: '130', expense_account: null, income_account: null },
        { netsuite_id: '902', name: 'SUPPLY-2', item_type: 'NonInvtPart', asset_account: null, expense_account: '610', income_account: null },
      ],
      not_copied: [],
    },
    { company: 'BMG', chart: SPEND_CHART },
  ).documents;
  const one = (d: Doc = check()) => month([d])[0];

  /** What the journal holds when check 10234 posted as it is now, as entry 31. */
  const held = (fields: Partial<SpendingPosting> = {}): SpendingPosting => ({
    source_type: 'check',
    source_id: '801',
    entries: 1,
    unreversed: ['e31'],
    current: {
      id: 'e31', entry_no: 31, entry_date: '2026-09-03',
      lines: [
        { account: '100', debit: '0.00', credit: '165.12', division: null, source_line_ref: 'paid_from', customer_id: null, vendor_ref: null },
        { account: '640', debit: '45.12', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '610', debit: '120.00', credit: '0.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
      ],
    },
    history: [{ entry_no: 31, entry_date: '2026-09-03', reversed_by: null }],
    document: { number: '10234', deleted: false, voided: false },
    ...fields,
  });

  it('posts the rule\'s lines under the spending rule in the month NetSuite booked it into, the money out of its account first, no vendor on any', () => {
    const { entry } = spendingJournalEntry(one(), 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-03', sourceType: 'check', sourceId: '801', postingRule: 'spending@1',
      idempotencyKey: 'check:801:2', memo: '10234, Sample Supply Co', postedBy: null,
    });
    expect(entry!.lines).toEqual([
      { accountId: 'a-100', debit: null, credit: '165.12', division: null, itemNumber: null, sourceLineRef: 'paid_from' },
      { accountId: 'a-640', debit: '45.12', credit: null, division: null, itemNumber: null, sourceLineRef: '1' },
      { accountId: 'a-610', debit: '120.00', credit: null, division: null, itemNumber: 'SUPPLY-2', sourceLineRef: '2' },
    ]);
    // Dated in August, booked into September: the entry goes on September's first day.
    expect(spendingJournalEntry(one(check({ date: '2026-08-30' })), 'BMG', 1, ids).entry!.entryDate).toBe('2026-09-01');
    // No number and no payee: the memo goes by NetSuite's id.
    expect(spendingJournalEntry(one(check({ number: null, payee: null, payee_netsuite_id: null })), 'BMG', 1, ids).entry!.memo).toBe('NetSuite 801');
    expect(spendingJournalEntry(one(), 'BMG', 1, new Map([['100', 'a-100']]))).toEqual({ entry: null, missing: ['640', '610'] });
  });

  it('posts a card charge and a card refund under their own kinds, the refund the other way round', () => {
    const { entry: charged } = spendingJournalEntry(one(charge()), 'BMG', 1, ids);
    expect(charged).toMatchObject({
      entryDate: '2026-09-10', sourceType: 'card_charge', sourceId: '802', postingRule: 'spending@1', idempotencyKey: 'card_charge:802:1',
      memo: 'NetSuite 802, Another Supplier',
    });
    expect(charged!.lines).toEqual([
      { accountId: 'a-220', debit: null, credit: '300.00', division: null, itemNumber: null, sourceLineRef: 'paid_from' },
      { accountId: 'a-130', debit: '300.00', credit: null, division: null, itemNumber: 'WIDGET-1', sourceLineRef: '1' },
    ]);
    const { entry: refunded } = spendingJournalEntry(one(refund()), 'BMG', 1, ids);
    expect(refunded).toMatchObject({
      entryDate: '2026-09-15', sourceType: 'card_refund', sourceId: '803', postingRule: 'spending@1', idempotencyKey: 'card_refund:803:1',
      memo: 'R-803, Another Supplier',
    });
    expect(refunded!.lines).toEqual([
      { accountId: 'a-220', debit: '25.99', credit: null, division: null, itemNumber: null, sourceLineRef: 'paid_from' },
      { accountId: 'a-610', debit: null, credit: '25.99', division: null, itemNumber: null, sourceLineRef: '1' },
    ]);
  });

  it('posts one nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decideSpending(one(), undefined)).toEqual({ kind: 'post' });
    expect(decideSpending(one(), held())).toEqual({ kind: 'keep' });
    // A new number, status or payee only describes: only the entry's memo carries them.
    expect(decideSpending(one(check({ number: '10234-A', status: 'Cleared', payee: 'Renamed Supply', payee_netsuite_id: '51' })), held()))
      .toEqual({ kind: 'keep' });
    // NetSuite posted more to meals than the copy's lines say: FleetSuite posts what the rule works out, and Differences shows the gap.
    const off = one(check({ netsuite: [gl('0', '100', '0.00', '165.12'), gl('1', '640', '50.12', '0.00'), gl('2', '610', '115.00', '0.00')] }));
    expect(off.checked.status).toBe('differs');
    expect(decideSpending(off, undefined)).toEqual({ kind: 'post' });
    const changed: Array<Partial<Doc>> = [
      { date: '2026-09-04' },
      // Booked into October now: the entry moves to October's first day.
      { posting_month: '2026-10-01' },
      {
        total: '175.12', lines: [copied('1', null, '640', '-55.12'), copied('2', '902', null, '-120.00')],
        netsuite: [gl('0', '100', '0.00', '175.12'), gl('1', '640', '55.12', '0.00'), gl('2', '610', '120.00', '0.00')],
      },
      { lines: [copied('1', null, '610', '-45.12'), copied('2', '902', null, '-120.00')] },
      // Paid by card.
      { netsuite: [gl('0', '220', '0.00', '165.12'), gl('1', '640', '45.12', '0.00'), gl('2', '610', '120.00', '0.00')] },
    ];
    for (const fields of changed) expect(decideSpending(one(check(fields)), held()), JSON.stringify(fields)).toEqual({ kind: 'replace' });
  });

  it('posts one NetSuite voided but still books, as its journal entry reversing the check posts too', () => {
    const voided = one(check({ voided: true, status: 'Voided' }));
    expect(decideSpending(voided, undefined)).toEqual({ kind: 'post' });
    expect(decideSpending(voided, held())).toEqual({ kind: 'keep' });
    expect(decideSpending(one(check({ voided: true, date: '2026-09-04' })), held())).toEqual({ kind: 'replace' });
    // Its entry, reversed when a run before this rule read it as voided, posts again.
    const reversed = held({ unreversed: [], current: null, history: [{ entry_no: 31, entry_date: '2026-09-03', reversed_by: 32 }] });
    expect(decideSpending(voided, reversed)).toEqual({ kind: 'post' });
    expect(spendingBooks(voided, undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    // A voided card charge or refund NetSuite still books posts the same way.
    expect(decideSpending(one(charge({ voided: true })), undefined)).toEqual({ kind: 'post' });
    expect(decideSpending(one(refund({ voided: true })), undefined)).toEqual({ kind: 'post' });
  });

  it('reverses the entry of one voided with its lines taken away or one that comes to nothing, and leaves one it can\'t work out or not copied yet', () => {
    const voids: Array<Partial<Doc>> = [
      // Its GL lines taken away, with the total kept or zeroed.
      { companies: [], netsuite: [] },
      { total: '0.00', lines: [copied('1', null, '640', '0.00')], companies: [], netsuite: [] },
      // Its GL lines coming to nothing on every account.
      { netsuite: [gl('0', '100', '0.00', '165.12'), gl('1', '640', '45.12', '0.00'), gl('2', '610', '120.00', '0.00'),
        gl('3', '100', '165.12', '0.00'), gl('4', '640', '0.00', '45.12'), gl('5', '610', '0.00', '120.00')] },
    ];
    for (const fields of voids) {
      const voided = one(check({ voided: true, ...fields }));
      expect(decideSpending(voided, held()), JSON.stringify(fields)).toEqual({ kind: 'reverse', why: 'voided' });
      expect(decideSpending(voided, undefined), JSON.stringify(fields)).toEqual({ kind: 'keep', why: 'voided' });
    }
    // $0, and NetSuite posts no lines for it.
    const zero = check({ total: '0.00', lines: [copied('1', null, '640', '0.00')], companies: [], netsuite: [] });
    expect(one(zero).checked.lines).toEqual([]);
    expect(decideSpending(one(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decideSpending(one(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    // Not in the GL copy yet, or its lines not copied yet.
    expect(decideSpending(one(check({ companies: [], netsuite: [] })), held())).toEqual({ kind: 'leave', why: 'waiting' });
    expect(decideSpending(one(check({ lines: null })), held())).toEqual({ kind: 'leave', why: 'waiting' });
    // An item the copy of NetSuite's items doesn't have.
    expect(decideSpending(one(check({ lines: [copied('1', '999', null, '-165.12')] })), held())).toEqual({ kind: 'leave', why: 'unworkable' });
    // NetSuite's posting doesn't say where the money came from: no main line, and two accounts credited.
    const split = check({
      netsuite: [gl('1', '640', '45.12', '0.00'), gl('2', '610', '120.00', '0.00'), gl('3', '100', '0.00', '100.00'), gl('4', '220', '0.00', '65.12')],
    });
    expect(decideSpending(one(split), held())).toEqual({ kind: 'leave', why: 'unworkable' });
    expect(decideSpending(one(split), undefined)).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('leaves whatever stands when the lines don\'t come to the total, as when the copy is caught mid-refresh or reads them the wrong way round', () => {
    expect(decideSpending(one(check({ total: '170.00' })), held())).toEqual({ kind: 'leave', why: 'total' });
    expect(decideSpending(one(check({ total: '170.00' })), undefined)).toEqual({ kind: 'leave', why: 'total' });
    // The copy's total can't be read: nothing is posted or reversed on the strength of it, lines or none.
    expect(decideSpending(one(check({ total: 'n/a' })), held())).toEqual({ kind: 'leave', why: 'total' });
    expect(decideSpending(one(check({ total: 'n/a', lines: [], companies: [], netsuite: [] })), held())).toEqual({ kind: 'leave', why: 'total' });
    // Most of the month's refunds sign their lines one way and this one the other: it comes out a charge to the card.
    const refunds = month([
      refund({ netsuite_id: '804', number: 'R-804' }),
      refund({ netsuite_id: '805', number: 'R-805' }),
      refund({ lines: [copied('1', null, '610', '-25.99')] }),
    ]);
    expect(refunds.map((w) => decideSpending(w, undefined))).toEqual([{ kind: 'post' }, { kind: 'post' }, { kind: 'leave', why: 'total' }]);
  });

  it('says what the journal holds for one and what the next run does, found by its kind and NetSuite id', () => {
    expect(spendingBooks(one(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(spendingBooks(one(), held())).toEqual({ entryNo: 31, next: null, earlier: [] });
    expect(spendingBooks(one(check({ voided: true, companies: [], netsuite: [] })), held()).next).toBe('reverse');
    expect(spendingBooks(one(check({ date: '2026-09-04' })), held()).next).toBe('replace');
    expect(spendingBooks(one(check({ total: '170.00' })), held()).next).toBeNull();
    expect(spendingBooks(one(check({ voided: true, companies: [], netsuite: [] })), undefined))
      .toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'voided' });
    expect(spendingBooks(one(check({ total: '0.00', lines: [], companies: [], netsuite: [] })), undefined)).toMatchObject({ nothingToPost: 'zero' });
    // Lines that don't come to its total yet aren't nothing to post.
    expect(spendingBooks(one(check({ total: '170.00' })), undefined)).not.toHaveProperty('nothingToPost');
    // Its first entry, reversed when NetSuite changed the check.
    const again = held({
      entries: 2,
      history: [{ entry_no: 24, entry_date: '2026-09-03', reversed_by: 30 }, { entry_no: 31, entry_date: '2026-09-03', reversed_by: null }],
    });
    expect(spendingBooks(one(), again)).toEqual({ entryNo: 31, next: null, earlier: [{ entryNo: 24, reversedBy: 30 }] });
    const postings = new Map([[postingKey('check', '801'), held()]]);
    expect(spendingPostingFor(postings, one())).toBe(postings.get('check:801'));
    // A card charge with the check's NetSuite id is another document.
    expect(spendingPostingFor(postings, one(charge({ netsuite_id: '801' })))).toBeUndefined();
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    for (const d of [check(), charge(), refund(), check({ date: '2026-08-30' })]) {
      const w = one(d);
      const { entry } = spendingJournalEntry(w, 'BMG', 1, ids);
      const lines = entry!.lines.map((l) => ({
        account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
        division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null, vendor_ref: l.vendorRef ?? null,
      }));
      const current = { id: 'e31', entry_no: 31, entry_date: entry!.entryDate, lines };
      expect(decideSpending(w, held({ current })), JSON.stringify(d)).toEqual({ kind: 'keep' });
    }
  });
});

describe('journal entries', () => {
  // Made-up books: '120' receivables, '200' payables, '220' the Chase card, '610' shop supplies, '640' fuel.
  const JE_CHART: ChartAccount[] = [
    { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
    { netsuite_account_id: '200', number: '2000', name: 'Payables', account_type: 'accounts_payable', company: null, active: true, is_summary: false },
    { netsuite_account_id: '220', number: '2200', name: 'Chase Card', account_type: 'credit_card', company: null, active: true, is_summary: false },
    { netsuite_account_id: '610', number: '6100', name: 'Shop Supplies', account_type: 'expense', company: null, active: true, is_summary: false },
    { netsuite_account_id: '640', number: '6400', name: 'Fuel', account_type: 'expense', company: null, active: true, is_summary: false },
  ];
  const ids = new Map(['120', '200', '220', '610', '640'].map((a) => [a, `a-${a}`]));

  type Entry = JournalMonthData['journal_entries'][number];
  type Line = Entry['lines'][number];
  const gl = (lineId: string, account: string, debit: string, credit: string, fields: Partial<Line> = {}): Line => ({
    line_id: lineId, account, debit, credit, memo: null, entity_id: null, name: null, customer_id: null, ...fields,
  });
  // The bookkeeper's entry for September's Chase statement: fuel and supplies charged to the card, and a vendor's bill paid with it.
  const je = (fields: Partial<Entry> = {}): Entry => ({
    netsuite_id: '9001', number: 'JE1201', date: '2026-09-30', posting_month: '2026-09-01', companies: ['BMG'],
    lines: [
      gl('1', '640', '45.12', '0.00', { memo: 'Fuel', entity_id: '77', name: 'Shell Oil' }),
      gl('2', '610', '120.00', '0.00', { memo: 'Gloves' }),
      gl('3', '200', '50.00', '0.00', { entity_id: '50', name: 'Sample Supply Co' }),
      gl('4', '220', '0.00', '215.12', { memo: 'Chase statement 09/2026' }),
    ],
    ...fields,
  });
  const one = (e: Entry = je()) => workOutJournalMonth({ journal_entries: [e] }, { company: 'BMG', chart: JE_CHART }).journalEntries[0];
  const zero = () => je({ lines: [gl('1', '640', '0.00', '0.00'), gl('2', '220', '0.00', '0.00')] });
  // Only some of an intercompany entry's lines are this company's.
  const unbalanced = () => je({ lines: je().lines.slice(0, 3) });
  const writeOff = (customer: string | null = CUSTOMER) => je({
    lines: [gl('1', '120', '0.00', '25.00', { entity_id: '310', name: 'A Customer', customer_id: customer }), gl('2', '610', '25.00', '0.00')],
  });

  /** What the journal holds when JE1201 posted as it is now, as entry 41. */
  const held = (fields: Partial<JournalEntryPosting> = {}): JournalEntryPosting => ({
    source_type: 'journal_entry',
    source_id: '9001',
    entries: 1,
    unreversed: ['e41'],
    current: {
      id: 'e41', entry_no: 41, entry_date: '2026-09-30',
      lines: [
        { account: '640', debit: '45.12', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '610', debit: '120.00', credit: '0.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
        { account: '200', debit: '50.00', credit: '0.00', division: null, source_line_ref: '3', customer_id: null, vendor_ref: '50' },
        { account: '220', debit: '0.00', credit: '215.12', division: null, source_line_ref: '4', customer_id: null, vendor_ref: null },
      ],
    },
    history: [{ entry_no: 41, entry_date: '2026-09-30', reversed_by: null }],
    journal: { number: 'JE1201', deleted: false },
    ...fields,
  });

  it('posts its lines as they are under the journal entry rule, in the month NetSuite booked it into, each with its memo', () => {
    const { entry } = copiedJournalEntry(one(), 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-30', sourceType: 'journal_entry', sourceId: '9001', postingRule: 'journal_entry@1',
      idempotencyKey: 'journal_entry:9001:2', memo: 'JE1201', postedBy: null,
    });
    const line = (accountId: string, debit: string | null, credit: string | null, memo: string | null, sourceLineRef: string, vendorRef: string | null = null) => ({
      accountId, debit, credit, memo, division: null, itemNumber: null, sourceLineRef, customerId: null, vendorRef,
    });
    // The vendor goes on the payables line.
    expect(entry!.lines).toEqual([
      line('a-640', '45.12', null, 'Shell Oil · Fuel', '1'),
      line('a-610', '120.00', null, 'Gloves', '2'),
      line('a-200', '50.00', null, 'Sample Supply Co', '3', '50'),
      line('a-220', null, '215.12', 'Chase statement 09/2026', '4'),
    ]);
    // Dated in August, booked into September: the entry goes on September's first day.
    expect(copiedJournalEntry(one(je({ date: '2026-08-31' })), 'BMG', 1, ids).entry!.entryDate).toBe('2026-09-01');
    // No number: the memo goes by NetSuite's id.
    expect(copiedJournalEntry(one(je({ number: null })), 'BMG', 1, ids).entry!.memo).toBe('NetSuite 9001');
    // A receivables line carries its customer.
    expect(copiedJournalEntry(one(writeOff()), 'BMG', 1, ids).entry!.lines.map((l) => [l.accountId, l.customerId, l.memo])).toEqual([
      ['a-120', CUSTOMER, 'A Customer'], ['a-610', null, null],
    ]);
    expect(copiedJournalEntry(one(), 'BMG', 1, new Map([['640', 'a-640']]))).toEqual({ entry: null, missing: ['610', '200', '220'] });
  });

  it('posts one nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decideJournalEntry(one(), undefined)).toEqual({ kind: 'post' });
    expect(decideJournalEntry(one(), held())).toEqual({ kind: 'keep' });
    // A new number, memo or name only describes: only the entry's memos carry them.
    const described = je({
      number: 'JE1201-A',
      lines: je().lines.map((l) => ({ ...l, memo: `${l.memo ?? ''} (edited)`, name: l.name && `${l.name} Inc` })),
    });
    expect(decideJournalEntry(one(described), held())).toEqual({ kind: 'keep' });
    const [fuel, gloves, bill, card] = je().lines;
    const changed: Array<Partial<Entry>> = [
      { date: '2026-09-29' },
      // Booked into October now: the entry moves to October's first day.
      { posting_month: '2026-10-01' },
      // More fuel.
      { lines: [{ ...fuel, debit: '55.12' }, gloves, bill, { ...card, credit: '225.12' }] },
      // The fuel was supplies after all.
      { lines: [{ ...fuel, account: '610' }, gloves, bill, card] },
      // Another vendor's bill.
      { lines: [fuel, gloves, { ...bill, entity_id: '51' }, card] },
      // The card's line split in two.
      { lines: [fuel, gloves, bill, { ...card, credit: '200.00' }, gl('5', '220', '0.00', '15.12')] },
    ];
    for (const fields of changed) expect(decideJournalEntry(one(je(fields)), held()), JSON.stringify(fields)).toEqual({ kind: 'replace' });

    // The customer on a receivables line, once FleetSuite matches the name to one.
    const unmatched = held({
      current: {
        id: 'e41', entry_no: 41, entry_date: '2026-09-30',
        lines: [
          { account: '120', debit: '0.00', credit: '25.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
          { account: '610', debit: '25.00', credit: '0.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
        ],
      },
    });
    expect(decideJournalEntry(one(writeOff(null)), unmatched)).toEqual({ kind: 'keep' });
    expect(decideJournalEntry(one(writeOff()), unmatched)).toEqual({ kind: 'replace' });
  });

  it('reverses the entry of one that comes to nothing now, and leaves whatever stands for one whose lines don\'t balance', () => {
    expect(decideJournalEntry(one(zero()), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decideJournalEntry(one(zero()), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    expect(decideJournalEntry(one(unbalanced()), held())).toEqual({ kind: 'leave', why: 'unworkable' });
    expect(decideJournalEntry(one(unbalanced()), undefined)).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('says what the journal holds for one and what the next run does', () => {
    expect(journalEntryBooks(one(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(journalEntryBooks(one(), held())).toEqual({ entryNo: 41, next: null, earlier: [] });
    expect(journalEntryBooks(one(je({ date: '2026-09-29' })), held()).next).toBe('replace');
    expect(journalEntryBooks(one(zero()), held()).next).toBe('reverse');
    expect(journalEntryBooks(one(zero()), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'zero' });
    // Lines that don't balance aren't nothing to post.
    expect(journalEntryBooks(one(unbalanced()), undefined)).toEqual({ entryNo: null, next: null, earlier: [] });
    // Its first entry, reversed when NetSuite changed the journal entry.
    const again = held({
      entries: 2,
      history: [{ entry_no: 33, entry_date: '2026-09-30', reversed_by: 40 }, { entry_no: 41, entry_date: '2026-09-30', reversed_by: null }],
    });
    expect(journalEntryBooks(one(), again)).toEqual({ entryNo: 41, next: null, earlier: [{ entryNo: 33, reversedBy: 40 }] });
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    for (const e of [je(), je({ date: '2026-08-31' }), je({ date: '2026-10-02' }), writeOff()]) {
      const w = one(e);
      const { entry } = copiedJournalEntry(w, 'BMG', 1, ids);
      const lines = entry!.lines.map((l) => ({
        account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
        division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null, vendor_ref: l.vendorRef ?? null,
      }));
      const current = { id: 'e41', entry_no: 41, entry_date: entry!.entryDate, lines };
      expect(decideJournalEntry(w, held({ current })), JSON.stringify(e)).toEqual({ kind: 'keep' });
    }
  });
});

describe('bank deposits, transfers and customer refunds', () => {
  // Made-up books: '100' checking, '105' Undeposited Funds, '110' savings, '120' receivables, '200' payables.
  const BANK_CHART: ChartAccount[] = [
    { netsuite_account_id: '100', number: '1000', name: 'Checking', account_type: 'bank', company: null, active: true, is_summary: false },
    { netsuite_account_id: '105', number: '1050', name: 'Undeposited Funds', account_type: 'other_current_asset', company: null, active: true, is_summary: false },
    { netsuite_account_id: '110', number: '1100', name: 'Savings', account_type: 'bank', company: null, active: true, is_summary: false },
    { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
    { netsuite_account_id: '200', number: '2000', name: 'Payables', account_type: 'accounts_payable', company: null, active: true, is_summary: false },
  ];
  const ids = new Map(['100', '105', '110', '120', '200'].map((a) => [a, `a-${a}`]));

  type Doc = BankMonthData['documents'][number];
  type Line = Doc['lines'][number];
  const gl = (lineId: string, account: string, debit: string, credit: string, fields: Partial<Line> = {}): Line => ({
    line_id: lineId, account, debit, credit, memo: null, entity_id: null, name: null, customer_id: null, ...fields,
  });
  // Two customer payments taken out of Undeposited Funds and put in the bank, and a vendor's refund with them.
  const deposit = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '8001', type: 'Deposit', number: 'DEP0412', date: '2026-09-15', posting_month: '2026-09-01', companies: ['BMG'],
    lines: [
      gl('0', '100', '1525.00', '0.00', { memo: 'Deposit 9/15' }),
      gl('1', '105', '0.00', '1000.00', { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER }),
      gl('2', '105', '0.00', '500.00', { entity_id: '311', name: 'Another Customer', memo: 'PMT1977' }),
      gl('3', '200', '0.00', '25.00', { entity_id: '50', name: 'Sample Supply Co', memo: 'Refund' }),
    ],
    ...fields,
  });
  // Money moved to savings.
  const transfer = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '8002', type: 'Transfer', number: 'TRN0031', date: '2026-09-20', posting_month: '2026-09-01', companies: ['BMG'],
    lines: [gl('1', '110', '5000.00', '0.00', { memo: 'To savings' }), gl('2', '100', '0.00', '5000.00', { memo: 'To savings' })],
    ...fields,
  });
  // A customer paid back a credit they held, out of checking.
  const refund = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '8003', type: 'CustRfnd', number: 'RFND31', date: '2026-09-18', posting_month: '2026-09-01', companies: ['BMG'],
    lines: [
      gl('0', '100', '0.00', '250.00', { memo: 'Check 4410' }),
      gl('1', '120', '250.00', '0.00', { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER, memo: 'Overpaid INV1977' }),
    ],
    ...fields,
  });
  const one = (d: Doc = deposit()) => workOutBankMonth({ documents: [d] }, { company: 'BMG', chart: BANK_CHART }).documents[0];

  /** What the journal holds when DEP0412 posted as it is now, as entry 52. */
  const held = (fields: Partial<BankPosting> = {}): BankPosting => ({
    source_type: 'bank_deposit',
    source_id: '8001',
    entries: 1,
    unreversed: ['e52'],
    current: {
      id: 'e52', entry_no: 52, entry_date: '2026-09-15',
      lines: [
        { account: '100', debit: '1525.00', credit: '0.00', division: null, source_line_ref: '0', customer_id: null, vendor_ref: null },
        { account: '105', debit: '0.00', credit: '1000.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '105', debit: '0.00', credit: '500.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
        { account: '200', debit: '0.00', credit: '25.00', division: null, source_line_ref: '3', customer_id: null, vendor_ref: '50' },
      ],
    },
    history: [{ entry_no: 52, entry_date: '2026-09-15', reversed_by: null }],
    document: { number: 'DEP0412', deleted: false },
    ...fields,
  });

  it('posts its lines as they are under the bank rule, filed as a bank deposit or a transfer, in the month NetSuite booked it into', () => {
    const { entry } = bankJournalEntry(one(), 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-15', sourceType: 'bank_deposit', sourceId: '8001', postingRule: 'bank@1',
      idempotencyKey: 'bank_deposit:8001:2', memo: 'DEP0412', postedBy: null,
    });
    const line = (accountId: string, debit: string | null, credit: string | null, memo: string | null, sourceLineRef: string, vendorRef: string | null = null) => ({
      accountId, debit, credit, memo, division: null, itemNumber: null, sourceLineRef, customerId: null, vendorRef,
    });
    // Undeposited Funds isn't receivables, so no customer goes on it; the vendor goes on the payables line.
    expect(entry!.lines).toEqual([
      line('a-100', '1525.00', null, 'Deposit 9/15', '0'),
      line('a-105', null, '1000.00', 'A Customer', '1'),
      line('a-105', null, '500.00', 'Another Customer · PMT1977', '2'),
      line('a-200', null, '25.00', 'Sample Supply Co · Refund', '3', '50'),
    ]);
    expect(bankJournalEntry(one(transfer()), 'BMG', 1, ids).entry).toMatchObject({
      entryDate: '2026-09-20', sourceType: 'bank_transfer', sourceId: '8002', postingRule: 'bank@1', idempotencyKey: 'bank_transfer:8002:1',
      memo: 'TRN0031',
      lines: [
        { accountId: 'a-110', debit: '5000.00', credit: null, memo: 'To savings', sourceLineRef: '1' },
        { accountId: 'a-100', debit: null, credit: '5000.00', memo: 'To savings', sourceLineRef: '2' },
      ],
    });
    // A customer refund is filed as one, its receivables line carrying the customer.
    expect(bankJournalEntry(one(refund()), 'BMG', 1, ids).entry).toMatchObject({
      entryDate: '2026-09-18', sourceType: 'customer_refund', sourceId: '8003', postingRule: 'bank@1', idempotencyKey: 'customer_refund:8003:1',
      memo: 'RFND31',
      lines: [
        { accountId: 'a-100', debit: null, credit: '250.00', memo: 'Check 4410', sourceLineRef: '0', customerId: null },
        { accountId: 'a-120', debit: '250.00', credit: null, memo: 'A Customer · Overpaid INV1977', sourceLineRef: '1', customerId: CUSTOMER },
      ],
    });
    // Dated in August, booked into September: the entry goes on September's first day.
    expect(bankJournalEntry(one(deposit({ date: '2026-08-31' })), 'BMG', 1, ids).entry!.entryDate).toBe('2026-09-01');
    // No number: the memo goes by NetSuite's id.
    expect(bankJournalEntry(one(transfer({ number: null })), 'BMG', 1, ids).entry!.memo).toBe('NetSuite 8002');
    // A receivables line carries its customer.
    const counter = deposit({ lines: [gl('0', '100', '25.00', '0.00'), gl('1', '120', '0.00', '25.00', { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER })] });
    expect(bankJournalEntry(one(counter), 'BMG', 1, ids).entry!.lines.map((l) => [l.accountId, l.customerId])).toEqual([['a-100', null], ['a-120', CUSTOMER]]);
    expect(bankJournalEntry(one(), 'BMG', 1, new Map([['100', 'a-100']]))).toEqual({ entry: null, missing: ['105', '200'] });
  });

  it('posts one nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decideBankDocument(one(), undefined)).toEqual({ kind: 'post' });
    expect(decideBankDocument(one(), held())).toEqual({ kind: 'keep' });
    // A new number, memo or name only describes.
    const described = deposit({
      number: 'DEP0412-A',
      lines: deposit().lines.map((l) => ({ ...l, memo: `${l.memo ?? ''} (edited)`, name: l.name && `${l.name} Inc` })),
    });
    expect(decideBankDocument(one(described), held())).toEqual({ kind: 'keep' });
    const [bank, first, second, refund] = deposit().lines;
    const changed: Array<Partial<Doc>> = [
      { date: '2026-09-16' },
      // Booked into October now.
      { posting_month: '2026-10-01' },
      // A third payment put in with them.
      { lines: [{ ...bank, debit: '1625.00' }, first, second, refund, gl('4', '105', '0.00', '100.00')] },
      // Put in savings instead.
      { lines: [{ ...bank, account: '110' }, first, second, refund] },
      // Another vendor's refund.
      { lines: [bank, first, second, { ...refund, entity_id: '51' }] },
    ];
    for (const fields of changed) expect(decideBankDocument(one(deposit(fields)), held()), JSON.stringify(fields)).toEqual({ kind: 'replace' });
  });

  it('reverses the entry of one that comes to nothing now, and leaves whatever stands for one whose lines don\'t balance', () => {
    const zero = deposit({ lines: [gl('0', '100', '0.00', '0.00'), gl('1', '105', '0.00', '0.00')] });
    expect(decideBankDocument(one(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decideBankDocument(one(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    // Money moved to the other company's account: only this company's line is its.
    const across = transfer({ companies: ['1084', 'BMG'], lines: transfer().lines.slice(1) });
    expect(decideBankDocument(one(across), held())).toEqual({ kind: 'leave', why: 'unworkable' });
    expect(decideBankDocument(one(across), undefined)).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('says what the journal holds for one and what the next run does', () => {
    expect(bankDocumentBooks(one(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(bankDocumentBooks(one(), held())).toEqual({ entryNo: 52, next: null, earlier: [] });
    expect(bankDocumentBooks(one(deposit({ date: '2026-09-16' })), held()).next).toBe('replace');
    const zero = deposit({ lines: [gl('0', '100', '0.00', '0.00'), gl('1', '105', '0.00', '0.00')] });
    expect(bankDocumentBooks(one(zero), held()).next).toBe('reverse');
    expect(bankDocumentBooks(one(zero), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'zero' });
    // Its first entry, reversed when NetSuite changed the deposit.
    const again = held({
      entries: 2,
      history: [{ entry_no: 44, entry_date: '2026-09-15', reversed_by: 51 }, { entry_no: 52, entry_date: '2026-09-15', reversed_by: null }],
    });
    expect(bankDocumentBooks(one(), again)).toEqual({ entryNo: 52, next: null, earlier: [{ entryNo: 44, reversedBy: 51 }] });
  });

  it('finds what the journal holds for one by its kind and NetSuite id', () => {
    const deposited = held();
    const transferred = held({ source_type: 'bank_transfer', source_id: '8002', document: { number: 'TRN0031', deleted: false } });
    const refunded = held({ source_type: 'customer_refund', source_id: '8003', document: { number: 'RFND31', deleted: false } });
    // A transfer's or refund's entry under the bank deposit's NetSuite id is another document's.
    const others = [held({ source_type: 'bank_transfer', source_id: '8001' }), held({ source_type: 'customer_refund', source_id: '8001' })];
    const postings = new Map([deposited, transferred, refunded, ...others].map((p) => [postingKey(p.source_type, p.source_id), p]));
    expect(bankPostingFor(postings, one())).toBe(deposited);
    expect(bankPostingFor(postings, one(transfer()))).toBe(transferred);
    expect(bankPostingFor(postings, one(refund()))).toBe(refunded);
    expect(bankPostingFor(postings, one(deposit({ netsuite_id: '8002' })))).toBeUndefined();
    expect(bankPostingFor(postings, one(deposit({ netsuite_id: '8003' })))).toBeUndefined();
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    for (const d of [deposit(), deposit({ date: '2026-08-31' }), deposit({ date: '2026-10-02' }), transfer(), refund()]) {
      const w = one(d);
      const { entry } = bankJournalEntry(w, 'BMG', 1, ids);
      const lines = entry!.lines.map((l) => ({
        account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
        division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null, vendor_ref: l.vendorRef ?? null,
      }));
      const current = { id: 'e52', entry_no: 52, entry_date: entry!.entryDate, lines };
      expect(decideBankDocument(w, held({ current })), JSON.stringify(d)).toEqual({ kind: 'keep' });
    }
  });
});

describe('stock documents', () => {
  // Made-up books: '130' inventory, '205' stock received but not billed, '500' cost of goods sold, '120' receivables.
  const STOCK_CHART: ChartAccount[] = [
    { netsuite_account_id: '130', number: '1300', name: 'Inventory', account_type: 'other_current_asset', company: null, active: true, is_summary: false },
    { netsuite_account_id: '205', number: '2050', name: 'Received Not Billed', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
    { netsuite_account_id: '500', number: '5000', name: 'Cost of Goods Sold', account_type: 'cost_of_goods_sold', company: null, active: true, is_summary: false },
    { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
  ];
  const ids = new Map(['130', '205', '500', '120'].map((a) => [a, `a-${a}`]));

  type Doc = StockMonthData['documents'][number];
  type Line = Doc['lines'][number];
  const gl = (lineId: string, account: string, debit: string, credit: string, fields: Partial<Line> = {}): Line => ({
    line_id: lineId, account, debit, credit, memo: null, entity_id: null, name: null, customer_id: null, ...fields,
  });
  const named = { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER };
  // A part shipped to a customer: its cost out of inventory.
  const fulfillment = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '8101', type: 'ItemShip', number: 'IF1201', date: '2026-09-15', posting_month: '2026-09-01', companies: ['BMG'],
    lines: [gl('1', '500', '40.00', '0.00', { memo: 'WIDGET-1', ...named }), gl('2', '130', '0.00', '40.00', { memo: 'WIDGET-1', ...named })],
    ...fields,
  });
  // An invoice that wasn't fulfilled first, its cost lines alone, and a credit memo bringing the part back.
  const invoiceCost = (fields: Partial<Doc> = {}): Doc => ({
    netsuite_id: '8102', type: 'CustInvc', number: 'INV2312', date: '2026-09-18', posting_month: '2026-09-01', companies: ['BMG'],
    lines: [gl('3', '500', '12.50', '0.00', named), gl('4', '130', '0.00', '12.50', named)],
    ...fields,
  });
  const creditCost = (fields: Partial<Doc> = {}): Doc => invoiceCost({
    netsuite_id: '8103', type: 'CustCred', number: 'CM104', lines: [gl('5', '130', '12.50', '0.00', named), gl('6', '500', '0.00', '12.50', named)],
    ...fields,
  });
  const one = (d: Doc = fulfillment()) => workOutStockMonth({ documents: [d] }, { company: 'BMG', chart: STOCK_CHART }).documents[0];

  /** What the journal holds when IF1201 posted as it is now, as entry 61. */
  const held = (fields: Partial<StockPosting> = {}): StockPosting => ({
    source_type: 'item_fulfillment',
    source_id: '8101',
    entries: 1,
    unreversed: ['e61'],
    current: {
      id: 'e61', entry_no: 61, entry_date: '2026-09-15',
      lines: [
        { account: '500', debit: '40.00', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '130', debit: '0.00', credit: '40.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
      ],
    },
    history: [{ entry_no: 61, entry_date: '2026-09-15', reversed_by: null }],
    document: { number: 'IF1201', deleted: false },
    ...fields,
  });

  it('posts its lines as they are under the stock rule, filed by what it is, an invoice\'s and a credit memo\'s cost alike', () => {
    const { entry } = stockJournalEntry(one(), 'BMG', 2, ids);
    expect(entry).toMatchObject({
      company: 'BMG', entryDate: '2026-09-15', sourceType: 'item_fulfillment', sourceId: '8101', postingRule: 'stock@1',
      idempotencyKey: 'item_fulfillment:8101:2', memo: 'IF1201', postedBy: null,
    });
    const line = (accountId: string, debit: string | null, credit: string | null, memo: string | null, sourceLineRef: string) => ({
      accountId, debit, credit, memo, division: null, itemNumber: null, sourceLineRef, customerId: null, vendorRef: null,
    });
    // Neither cost of goods nor inventory is receivables, so the customer is named but not carried.
    expect(entry!.lines).toEqual([
      line('a-500', '40.00', null, 'A Customer · WIDGET-1', '1'),
      line('a-130', null, '40.00', 'A Customer · WIDGET-1', '2'),
    ]);
    expect(stockJournalEntry(one(invoiceCost()), 'BMG', 1, ids).entry).toMatchObject({
      entryDate: '2026-09-18', sourceType: 'invoice_cost', sourceId: '8102', postingRule: 'stock@1', idempotencyKey: 'invoice_cost:8102:1',
      memo: 'INV2312',
      lines: [
        { accountId: 'a-500', debit: '12.50', credit: null, memo: 'A Customer', sourceLineRef: '3' },
        { accountId: 'a-130', debit: null, credit: '12.50', memo: 'A Customer', sourceLineRef: '4' },
      ],
    });
    expect(stockJournalEntry(one(creditCost()), 'BMG', 1, ids).entry).toMatchObject({
      sourceType: 'invoice_cost', sourceId: '8103', idempotencyKey: 'invoice_cost:8103:1', memo: 'CM104',
    });
    for (const [type, sourceType] of [
      ['ItemRcpt', 'item_receipt'], ['InvAdjst', 'inventory_adjustment'], ['InvTrnfr', 'inventory_transfer'], ['Build', 'assembly_build'],
      ['Unbuild', 'assembly_unbuild'],
    ] as const) {
      expect(stockJournalEntry(one(fulfillment({ type })), 'BMG', 1, ids).entry, type).toMatchObject({ sourceType, idempotencyKey: `${sourceType}:8101:1` });
    }
    // Dated in August, booked into September: the entry goes on September's first day.
    expect(stockJournalEntry(one(fulfillment({ date: '2026-08-31' })), 'BMG', 1, ids).entry!.entryDate).toBe('2026-09-01');
    // No number: the memo goes by NetSuite's id.
    expect(stockJournalEntry(one(fulfillment({ number: null })), 'BMG', 1, ids).entry!.memo).toBe('NetSuite 8101');
    expect(stockJournalEntry(one(), 'BMG', 1, new Map([['500', 'a-500']]))).toEqual({ entry: null, missing: ['130'] });
  });

  it('posts one nothing stands for, keeps one whose entry still fits, and replaces one NetSuite changed', () => {
    expect(decideStockDocument(one(), undefined)).toEqual({ kind: 'post' });
    expect(decideStockDocument(one(), held())).toEqual({ kind: 'keep' });
    // A new number, memo or name only describes.
    const described = fulfillment({
      number: 'IF1201-A',
      lines: fulfillment().lines.map((l) => ({ ...l, memo: `${l.memo ?? ''} (edited)`, name: l.name && `${l.name} Inc` })),
    });
    expect(decideStockDocument(one(described), held())).toEqual({ kind: 'keep' });
    const [cost, stock] = fulfillment().lines;
    const changed: Array<Partial<Doc>> = [
      { date: '2026-09-16' },
      // Booked into October now.
      { posting_month: '2026-10-01' },
      // NetSuite costed it again.
      { lines: [{ ...cost, debit: '42.00' }, { ...stock, credit: '42.00' }] },
      // Out of another account.
      { lines: [{ ...cost, account: '205' }, stock] },
    ];
    for (const fields of changed) expect(decideStockDocument(one(fulfillment(fields)), held()), JSON.stringify(fields)).toEqual({ kind: 'replace' });
  });

  it('reverses the entry of one that comes to nothing now, and leaves whatever stands for one whose lines don\'t balance', () => {
    const zero = fulfillment({ lines: [gl('1', '500', '0.00', '0.00'), gl('2', '130', '0.00', '0.00')] });
    expect(decideStockDocument(one(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decideStockDocument(one(zero), undefined)).toEqual({ kind: 'keep', why: 'nothing' });
    // Stock moved to the other company: only this company's line is its.
    const across = fulfillment({ type: 'InvTrnfr', companies: ['1084', 'BMG'], lines: fulfillment().lines.slice(1) });
    expect(decideStockDocument(one(across), held())).toEqual({ kind: 'leave', why: 'unworkable' });
    expect(decideStockDocument(one(across), undefined)).toEqual({ kind: 'leave', why: 'unworkable' });
  });

  it('says what the journal holds for one and what the next run does', () => {
    expect(stockDocumentBooks(one(), undefined)).toEqual({ entryNo: null, next: 'post', earlier: [] });
    expect(stockDocumentBooks(one(), held())).toEqual({ entryNo: 61, next: null, earlier: [] });
    expect(stockDocumentBooks(one(fulfillment({ date: '2026-09-16' })), held()).next).toBe('replace');
    const zero = fulfillment({ lines: [gl('1', '500', '0.00', '0.00'), gl('2', '130', '0.00', '0.00')] });
    expect(stockDocumentBooks(one(zero), held()).next).toBe('reverse');
    expect(stockDocumentBooks(one(zero), undefined)).toEqual({ entryNo: null, next: null, earlier: [], nothingToPost: 'zero' });
    // Its first entry, reversed when NetSuite changed the fulfillment.
    const again = held({
      entries: 2,
      history: [{ entry_no: 55, entry_date: '2026-09-15', reversed_by: 60 }, { entry_no: 61, entry_date: '2026-09-15', reversed_by: null }],
    });
    expect(stockDocumentBooks(one(), again)).toEqual({ entryNo: 61, next: null, earlier: [{ entryNo: 55, reversedBy: 60 }] });
  });

  it('finds what the journal holds for one by its kind and NetSuite id, an invoice\'s cost apart from anything else under its id', () => {
    const shipped = held();
    const costed = held({ source_type: 'invoice_cost', source_id: '8102', document: { number: 'INV2312', deleted: false } });
    // A receipt's entry under the fulfillment's NetSuite id is another document's, and so is an adjustment's under the invoice's.
    const other = held({ source_type: 'item_receipt', source_id: '8101' });
    const adjusted = held({ source_type: 'inventory_adjustment', source_id: '8102' });
    const postings = new Map([shipped, costed, other, adjusted].map((p) => [postingKey(p.source_type, p.source_id), p]));
    expect(stockPostingFor(postings, one())).toBe(shipped);
    expect(stockPostingFor(postings, one(invoiceCost()))).toBe(costed);
    expect(stockPostingFor(postings, one(fulfillment({ type: 'ItemRcpt' })))).toBe(other);
    expect(stockPostingFor(postings, one(creditCost({ netsuite_id: '8102' })))).toBe(costed);
    expect(stockPostingFor(postings, one(fulfillment({ netsuite_id: '8102' })))).toBeUndefined();
  });

  it('builds an entry that fits what it is compared against once posted', () => {
    const back = new Map([...ids].map(([ns, id]) => [id, ns]));
    for (const d of [fulfillment(), fulfillment({ date: '2026-08-31' }), fulfillment({ date: '2026-10-02' }), invoiceCost(), creditCost()]) {
      const w = one(d);
      const { entry } = stockJournalEntry(w, 'BMG', 1, ids);
      const lines = entry!.lines.map((l) => ({
        account: back.get(l.accountId)!, debit: String(l.debit ?? '0.00'), credit: String(l.credit ?? '0.00'),
        division: l.division ?? null, source_line_ref: l.sourceLineRef ?? null, customer_id: l.customerId ?? null, vendor_ref: l.vendorRef ?? null,
      }));
      const current = { id: 'e61', entry_no: 61, entry_date: entry!.entryDate, lines };
      expect(decideStockDocument(w, held({ current })), JSON.stringify(d)).toEqual({ kind: 'keep' });
    }
  });
});

describe('failureReason', () => {
  it('keeps what the journal said, but never an amount', () => {
    expect(failureReason(new BooksError('refused', ['account 4010 (Old Sales) is inactive']))).toBe('Account 4010 (Old Sales) is inactive');
    expect(failureReason(new BooksError('refused', ['entry does not balance: debits 10.00 vs credits 9.00']))).toBe('The journal refused the entry.');
    expect(failureReason(new BooksError('invalid', ["Debits $10.00 don't equal credits $9.00"]))).toBe("FleetSuite's entry didn't pass the journal's own checks.");
    expect(failureReason(new Error('timeout after 162.00 seconds'))).toBe('Timeout after … seconds');
  });
});

describe('where a run carries on', () => {
  it('reads the stopping point back only when it\'s a posting company and a month', () => {
    expect(parsePostingState({ resume: { company: 'BMG', month: '2025-06-01' } })).toEqual({ resume: { company: 'BMG', month: '2025-06-01' } });
    for (const bad of [null, {}, { resume: { company: '1084', month: '2025-06-01' } }, { resume: { company: 'BMG', month: "2025-06-01'; --" } }]) {
      expect(parsePostingState(bad)).toEqual({ resume: null });
    }
  });

  it('goes through every month, starting where the last run stopped', () => {
    const months = ['2025-01-01', '2025-02-01', '2025-03-01'];
    expect(postingQueue(['BMG'], months, null).map((q) => q.month)).toEqual(months);
    expect(postingQueue(['BMG'], months, { company: 'BMG', month: '2025-02-01' }).map((q) => q.month))
      .toEqual(['2025-02-01', '2025-03-01', '2025-01-01']);
    expect(postingQueue(['BMG'], months, { company: 'BMG', month: '2024-12-01' }).map((q) => q.month)).toEqual(months);
  });
});
