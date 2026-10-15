import { describe, it, expect } from 'vitest';
import { BooksError } from './journal';
import { workOutMonth, type ChartAccount, type InvoiceMonthData, type LineFactsRead } from './invoice-check';
import {
  decide, decidePayment, entryLines, failureReason, invoiceBooks, invoiceJournalEntry, parsePostingState, paymentBooks, paymentEntryLines,
  paymentJournalEntry, postingQueue, signature, unsaidFacts,
  type InvoicePosting, type PaymentPosting,
} from './invoice-posting';
import { workOutPaymentMonth, type PaymentMonthData } from './payment-check';

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

  it('changes with the date, an account, an amount, a division, a line or the customer', () => {
    const base = signature('2026-09-15', lines);
    expect(signature('2026-09-16', lines)).not.toBe(base);
    for (const change of [{ account: '410' }, { cents: -16100 }, { division: 'graphics' }, { lineRef: '2' }, { customerId: 'd' }]) {
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
    expect(decide(worked(invoice({ voided: true })), undefined)).toEqual({ kind: 'keep' });
  });

  it('reverses the entry of an invoice that comes to nothing now', () => {
    const zero = invoice({ total: '0.00', lines: invoice().lines.map((l) => ({ ...l, amount: '0.00', netamount: '0' })), netsuite: [] });
    expect(entryLines(worked(zero))).toEqual([]);
    expect(decide(worked(zero), posting())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decide(worked(zero), undefined)).toEqual({ kind: 'keep' });
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

  it('says nothing is next when NetSuite couldn\'t say enough about the month\'s lines', () => {
    expect(invoiceBooks(worked(), undefined, false)).toEqual({ entryNo: null, next: null, earlier: [] });
    expect(invoiceBooks(worked(invoice({ voided: true })), posting(), false)).toMatchObject({ entryNo: 7, next: null });
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
    expect(decidePayment(paid(payment({ voided: true })), undefined)).toEqual({ kind: 'keep' });
    // $0, and NetSuite posts no lines for it.
    const zero = payment({ total: '0.00', companies: [], netsuite: [] });
    expect(paymentEntryLines(paid(zero))).toEqual([]);
    expect(decidePayment(paid(zero), held())).toEqual({ kind: 'reverse', why: 'nothing' });
    expect(decidePayment(paid(zero), undefined)).toEqual({ kind: 'keep' });
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
