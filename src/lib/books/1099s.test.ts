// The 1099 dry run's rule (src/lib/books/1099s.ts): what each vendor was paid
// on the accounts that count toward a 1099, from made-up payments.
import { describe, it, expect } from 'vitest';
import {
  buildYear1099, docName, splitPayment, spread, unsplitReason,
  type GlLineData, type LinkData, type PaymentData, type Year1099Data,
} from './1099s';

// Made-up books: '100' checking, '220' a company card, '200' payables,
// '530' subcontractors and '540' rent, which count toward a 1099, '610'
// shop supplies and '485' purchase discounts, which don't.
const TYPES = new Map([
  ['100', 'bank'], ['220', 'credit_card'], ['200', 'accounts_payable'],
  ['530', 'expense'], ['540', 'expense'], ['610', 'expense'], ['485', 'other_income'],
]);
const CATEGORIES = new Map([['530', 'Nonemployee Compensation'], ['540', 'Rents']]);

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
/** A GL line: debit above 0, credit below. */
const line = (account: string, cents: number): GlLineData => ({
  account, debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00',
});
const bill = (id: string, number: string, amount: number | null, lines: GlLineData[] | null, type = 'VendBill'): LinkData => ({
  netsuite_id: id, type, number, amount: amount === null ? null : money(amount), lines,
});
const payment = (fields: Partial<PaymentData> & Pick<PaymentData, 'netsuite_id' | 'type' | 'total'>): PaymentData => ({
  number: null, date: '2025-06-01', payee: '50', payee_name: 'V-50 Sample Painting', lines: [], links: null, ...fields,
});
const check = (id: string, cents: number, lines: GlLineData[], fields: Partial<PaymentData> = {}) =>
  payment({ netsuite_id: id, type: 'Check', total: money(cents), lines: [line('100', -cents), ...lines], ...fields });
const billPayment = (id: string, cents: number, links: LinkData[] | null, fields: Partial<PaymentData> = {}) =>
  payment({ netsuite_id: id, type: 'VendPymt', total: money(cents), lines: [line('200', cents), line('100', -cents)], links, ...fields });

const split = (p: PaymentData) => splitPayment(p, TYPES, CATEGORIES);

describe('spreading an amount to the cent', () => {
  it('shares it in proportion, the cents left over to the largest remainders, so it adds up exactly', () => {
    expect(spread(10000, new Map([['a', 1], ['b', 1], ['c', 1]]))).toEqual(new Map([['a', 3334], ['b', 3333], ['c', 3333]]));
    expect(spread(100, new Map([['a', 2], ['b', 1]]))).toEqual(new Map([['a', 67], ['b', 33]]));
    // Ties go by key, whatever order the weights came in.
    expect(spread(1, new Map([['b', 1], ['a', 1]]))).toEqual(new Map([['b', 0], ['a', 1]]));
    expect(spread(5, new Map([['x', 1], ['y', 3]]))).toEqual(new Map([['x', 1], ['y', 4]]));
  });

  it('takes a weight below 0 against the rest, and leaves out a weight of nothing', () => {
    expect(spread(80000, new Map([['530', 100000], ['610', -20000]]))).toEqual(new Map([['530', 100000], ['610', -20000]]));
    expect(spread(300, new Map([['a', 1], ['b', 0]]))).toEqual(new Map([['a', 300]]));
  });

  it('has nothing to spread over when the weights come to nothing or less', () => {
    expect(spread(100, new Map())).toBeNull();
    expect(spread(100, new Map([['a', 0]]))).toBeNull();
    expect(spread(100, new Map([['a', 5], ['b', -5]]))).toBeNull();
    expect(spread(100, new Map([['a', -5]]))).toBeNull();
  });

  it("isn't thrown a cent by floating point", () => {
    // 0.1 + 0.2 of 100 cents each is 30, not 29 and a remainder.
    expect(spread(30, new Map([['a', 0.1], ['b', 0.2]]))).toEqual(new Map([['a', 10], ['b', 20]]));
    const shares = spread(999999, new Map([['a', 1 / 3], ['b', 1 / 3], ['c', 1 / 3]]))!;
    expect([...shares.values()].reduce((n, c) => n + c, 0)).toBe(999999);
  });
});

describe('splitting a payment over the accounts it paid for', () => {
  it("counts a check on its own lines' accounts", () => {
    expect(split(check('1', 150000, [line('530', 120000), line('610', 30000)]))).toMatchObject({
      cents: 150000, byCard: false, boxes: { 'Nonemployee Compensation': 120000 }, unsplit: null,
    });
    // A line taking something off (a credit to an expense) counts against the rest.
    expect(split(check('2', 90000, [line('530', 100000), line('530', -10000)])).boxes).toEqual({ 'Nonemployee Compensation': 90000 });
  });

  it('counts a bill payment on the accounts of the bills it paid, in proportion to what it paid on each', () => {
    const b1 = bill('701', 'B-701', 100000, [line('530', 60000), line('540', 40000), line('200', -100000)]);
    const b2 = bill('702', 'B-702', 50000, [line('610', 50000), line('200', -50000)]);
    expect(split(billPayment('9', 150000, [b1, b2]))).toMatchObject({
      boxes: { 'Nonemployee Compensation': 60000, Rents: 40000 },
      paid: [{ type: 'VendBill', number: 'B-701' }, { type: 'VendBill', number: 'B-702' }],
      unsplit: null,
    });
    // Half of a bill paid is half of each of its lines.
    const half = bill('703', 'B-703', 50000, [line('530', 70000), line('610', 30000), line('200', -100000)]);
    expect(split(billPayment('10', 50000, [half])).boxes).toEqual({ 'Nonemployee Compensation': 35000 });
    // Half of one bill and all of another: each counts by what was paid on it, not by how big it is.
    const halfOfB1 = { ...b1, amount: '500.00' };
    expect(split(billPayment('16', 100000, [halfOfB1, b2])).boxes).toEqual({ 'Nonemployee Compensation': 30000, Rents: 20000 });
  });

  it('takes a bill credit it applied off the accounts the credit was on, and leaves a discount taken out', () => {
    const b = bill('711', 'B-711', 100000, [line('530', 100000), line('200', -100000)]);
    const credit = bill('712', 'BC-712', 20000, [line('530', -20000), line('200', 20000)], 'VendCred');
    expect(split(billPayment('11', 80000, [b, credit])).boxes).toEqual({ 'Nonemployee Compensation': 80000 });
    // A credit on another account comes off that one: the bill's account keeps what the bill had on it.
    const other = bill('713', 'BC-713', 20000, [line('610', -20000), line('200', 20000)], 'VendCred');
    expect(split(billPayment('12', 80000, [b, other])).boxes).toEqual({ 'Nonemployee Compensation': 100000 });
    // Paid 2% early: the bill is paid off with 980.00 of money and a 20.00 discount, and only the money counts.
    const discounted = payment({
      netsuite_id: '13', type: 'VendPymt', total: '980.00',
      lines: [line('200', 100000), line('100', -98000), line('485', -2000)], links: [b],
    });
    expect(split(discounted)).toMatchObject({ cents: 98000, boxes: { 'Nonemployee Compensation': 98000 }, unsplit: null });
  });

  it('adds what it paid on accounts that count to the cent, and has no box for an account that counts for nothing', () => {
    const b = bill('721', 'B-721', 10000, [line('530', 3333), line('540', 3333), line('610', 3334), line('200', -10000)]);
    const result = split(billPayment('14', 10000, [b]));
    expect(result.boxes).toEqual({ 'Nonemployee Compensation': 3333, Rents: 3333 });
    expect(split(check('15', 5000, [line('610', 5000)])).boxes).toEqual({});
  });

  it('leaves a card payment out: card charges and refunds, and a check or bill payment paid from a credit card account', () => {
    expect(split(payment({ netsuite_id: '20', type: 'CardChrg', total: '45.00', lines: [line('530', 4500), line('220', -4500)] })))
      .toMatchObject({ cents: 4500, byCard: true, boxes: {}, unsplit: null });
    expect(split(payment({ netsuite_id: '21', type: 'CardRfnd', total: '5.00' }))).toMatchObject({ cents: -500, byCard: true });
    const b = bill('731', 'B-731', 30000, [line('530', 30000), line('200', -30000)]);
    const byCard = payment({ netsuite_id: '22', type: 'VendPymt', total: '300.00', lines: [line('200', 30000), line('220', -30000)], links: [b] });
    expect(split(byCard)).toMatchObject({ byCard: true, boxes: {} });
    // From the bank and the card both: it isn't all card.
    const both = check('23', 30000, [line('530', 30000)], { lines: [line('100', -10000), line('220', -20000), line('530', 30000)] });
    expect(split(both)).toMatchObject({ byCard: false, boxes: { 'Nonemployee Compensation': 30000 } });
    // A check that pays the card off isn't a card payment, and pays no account that counts.
    expect(split(check('24', 40000, [line('220', 40000)]))).toMatchObject({ byCard: false, boxes: {}, unsplit: null });
  });

  it("says why when it can't split one", () => {
    const b = bill('741', 'B-741', 10000, [line('530', 10000), line('200', -10000)]);
    expect(split(payment({ netsuite_id: '30', type: 'Check', total: '100.00' })).unsplit).toEqual({ kind: 'not_in_ledger' });
    expect(split(billPayment('31', 10000, null)).unsplit).toEqual({ kind: 'links_not_copied' });
    expect(split(billPayment('32', 10000, [])).unsplit).toEqual({ kind: 'paid_nothing' });
    expect(split(billPayment('33', 10000, [b, bill('742', 'B-742', 5000, null)])).unsplit)
      .toEqual({ kind: 'doc_not_in_ledger', type: 'VendBill', number: 'B-742' });
    expect(split(billPayment('34', 10000, [bill('743', 'JE-743', 10000, [line('200', 10000), line('610', -10000)], 'Journal')])).unsplit)
      .toEqual({ kind: 'not_a_bill', type: 'Journal', number: 'JE-743' });
    expect(split(billPayment('35', 10000, [bill('744', 'B-744', null, [line('530', 10000), line('200', -10000)])])).unsplit)
      .toEqual({ kind: 'no_amount', type: 'VendBill', number: 'B-744' });
    expect(split(billPayment('36', 10000, [bill('745', 'B-745', 10000, [line('200', -10000)])])).unsplit).toEqual({ kind: 'nothing_to_split' });
    expect(split(check('37', 10000, [])).unsplit).toEqual({ kind: 'nothing_to_split' });
    // A bill it paid something on whose lines come to nothing can't be told apart, even next to one that can.
    expect(split(billPayment('42', 15000, [b, bill('748', 'B-748', 5000, [line('200', -5000)])])).unsplit).toEqual({ kind: 'nothing_to_split' });
    // One it paid nothing on is left out, whatever's on it or wherever it is.
    expect(split(billPayment('43', 10000, [b, bill('749', 'B-749', 0, [line('200', 0)]), bill('750', 'B-750', 0, null)]))).toMatchObject({
      boxes: { 'Nonemployee Compensation': 10000 }, unsplit: null,
    });
    // A credit bigger than the bills it was applied with leaves nothing paid on them.
    const credit = bill('746', 'BC-746', 20000, [line('530', -20000), line('200', 20000)], 'VendCred');
    expect(split(billPayment('38', 10000, [b, credit])).unsplit).toEqual({ kind: 'nothing_to_split' });
    // Unsplit, it has no box at all.
    expect(split(billPayment('39', 10000, [b, bill('747', null as unknown as string, 5000, null)])).boxes).toEqual({});
  });

  it('reads an amount it can\'t read as nothing rather than failing', () => {
    expect(split(payment({ netsuite_id: '40', type: 'Check', total: 'lots', lines: [line('100', -100), line('530', 100)] })))
      .toMatchObject({ cents: 0, boxes: {} });
    expect(split(check('41', 10000, [{ account: '530', debit: 'x', credit: '' }, line('610', 10000)])).boxes).toEqual({});
  });
});

describe("a company's year", () => {
  const payees: Year1099Data['payees'] = [
    { netsuite_id: '50', name: 'V-50 Sample Painting', entity_id: ' V-50 ', legal_name: 'Sample Painting LLC', is_1099: 'T' },
    { netsuite_id: '51', name: 'V-51 Example Rentals', entity_id: null, legal_name: 'V-51 Example Rentals', is_1099: 'T' },
    { netsuite_id: '52', name: 'V-52 Placeholder Labor', entity_id: null, legal_name: null, is_1099: 'F' },
    { netsuite_id: '53', name: 'V-53 Demo Signs', entity_id: null, legal_name: null, is_1099: null },
    { netsuite_id: '54', name: 'V-54 Test Supply', entity_id: null, legal_name: null, is_1099: 'T' },
    { netsuite_id: '55', name: 'V-55 Sample Cards', entity_id: null, legal_name: null, is_1099: 'T' },
  ];
  const data = (payments: PaymentData[], fields: Partial<Year1099Data> = {}): Year1099Data => ({
    payments,
    payees,
    accounts: [
      { netsuite_id: '530', number: '5300', name: 'Subcontractors', type: 'expense' },
      { netsuite_id: '540', number: '540', name: 'Rent', type: 'expense' },
      ...[...TYPES].filter(([id]) => id !== '530' && id !== '540').map(([id, type]) => ({ netsuite_id: id, number: null, name: `Account ${id}`, type })),
    ],
    categories: [{ netsuite_id: '530', category: 'Nonemployee Compensation' }, { netsuite_id: '540', category: 'Rents' }],
    flags_copied: true,
    not_copied: [],
    ...fields,
  });

  const year = buildYear1099(data([
    check('1', 120000, [line('530', 120000)], { payee: '50', date: '2025-03-04' }),
    billPayment('2', 30000, [bill('701', 'B-701', 30000, [line('530', 30000), line('200', -30000)])], { payee: '50', date: '2025-02-01' }),
    billPayment('3', 5000, null, { payee: '50', date: '2025-05-01' }),
    check('4', 240000, [line('540', 240000)], { payee: '51' }),
    check('5', 80000, [line('530', 80000)], { payee: '52', payee_name: 'V-52 Placeholder Labor' }),
    check('6', 10000, [line('530', 10000)], { payee: '53' }),
    check('7', 20000, [line('530', 20000)], { payee: '77', payee_name: 'E-77 Sample Employee' }),
    check('8', 60000, [line('610', 60000)], { payee: '54' }),
    payment({ netsuite_id: '9', type: 'CardChrg', total: '45.00', payee: '55' }),
    payment({ netsuite_id: '10', type: 'CardRfnd', total: '5.00', payee: '55' }),
    check('11', 3000, [line('530', 3000)], { payee: null, payee_name: null }),
    // Paid by card and not marked: neither on a 1099 nor among the card payments of those marked.
    check('12', 7000, [line('530', 7000)], { payee: '52', lines: [line('220', -7000), line('530', 7000)] }),
  ]));

  it("lists the 1099s: vendors marked to get one, paid on accounts that count, the largest first, with the year's totals", () => {
    expect(year.forms.map((f) => [f.name, f.boxes, f.total])).toEqual([
      ['V-51 Example Rentals', { Rents: 240000 }, 240000],
      ['V-50 Sample Painting', { 'Nonemployee Compensation': 150000 }, 150000],
    ]);
    expect(year.totals).toEqual({ boxes: { Rents: 240000, 'Nonemployee Compensation': 150000 }, total: 390000 });
    const painting = year.forms[1];
    expect(painting).toMatchObject({ payee: '50', vendor: true, marked: true, legalName: 'Sample Painting LLC', entityId: 'V-50', paid: 155000, unsplit: 5000, byCard: 0 });
    expect(painting.payments.map((p) => p.netsuiteId)).toEqual(['1', '2', '3']);
    // A legal name that's only the name again isn't shown twice.
    expect(year.forms[0].legalName).toBeNull();
    expect(year.forms[0].entityId).toBeNull();
  });

  it('puts the categories in order of how much went in them, counting those not marked too', () => {
    // The 1099s alone have more in Rents (2,400.00 to 1,500.00), but 1,130.00 more went to subcontractors not marked.
    expect(year.categories).toEqual(['Nonemployee Compensation', 'Rents']);
    const more = buildYear1099(data([check('1', 100, [line('530', 100)], { payee: '50' }), check('2', 300000, [line('540', 300000)], { payee: '52' })]));
    expect(more.categories).toEqual(['Rents', 'Nonemployee Compensation']);
    expect(more.totals).toEqual({ boxes: { 'Nonemployee Compensation': 100 }, total: 100 });
  });

  it('lists who was paid on accounts that count without being marked: not marked, not said, or not a vendor', () => {
    expect(year.notMarked.map((p) => [p.payee, p.name, p.vendor, p.marked, p.total])).toEqual([
      ['52', 'V-52 Placeholder Labor', true, false, 80000],
      ['77', 'E-77 Sample Employee', false, null, 20000],
      ['53', 'V-53 Demo Signs', true, null, 10000],
      ['', 'No payee named', false, null, 3000],
    ]);
  });

  it('lists the marked vendors paid only on other accounts, the card payments left out, and the payments it can\'t split', () => {
    expect(year.nothingCounted.map((p) => [p.name, p.paid])).toEqual([['V-54 Test Supply', 60000]]);
    expect(year.byCard.map((p) => [p.name, p.byCard, p.paid])).toEqual([['V-55 Sample Cards', 4000, 0]]);
    expect(year.unsplit.map((p) => [p.netsuiteId, p.payee, p.name, p.marked, p.unsplit])).toEqual([
      ['3', '50', 'V-50 Sample Painting', true, { kind: 'links_not_copied' }],
    ]);
  });

  it('lists the accounts that count by number, naming one the chart lacks', () => {
    expect(year.accounts).toEqual([
      { netsuiteId: '540', number: '540', name: 'Rent', category: 'Rents' },
      { netsuiteId: '530', number: '5300', name: 'Subcontractors', category: 'Nonemployee Compensation' },
    ]);
    const lacking = buildYear1099(data([], { categories: [{ netsuite_id: '999', category: 'Royalties' }] }));
    expect(lacking.accounts).toEqual([{ netsuiteId: '999', number: null, name: 'NetSuite account 999', category: 'Royalties' }]);
  });

  it('names a payee the vendors copy lacks by the payment, or by its id', () => {
    const named = buildYear1099(data([
      check('1', 100, [line('530', 100)], { payee: '88', payee_name: null }),
      check('2', 100, [line('530', 100)], { payee: '89', payee_name: 'O-89 Sample Other' }),
    ]));
    expect(named.notMarked.map((p) => p.name)).toEqual(['NetSuite 88', 'O-89 Sample Other']);
  });

  it("is empty with nothing paid, and carries what the copies don't have yet and whether the flags are copied", () => {
    const empty = buildYear1099(data([], { flags_copied: false, not_copied: [{ netsuite_id: '5', type: 'Check', number: '1005', date: '2025-01-02' }] }));
    expect(empty).toMatchObject({
      categories: [], forms: [], notMarked: [], nothingCounted: [], byCard: [], unsplit: [],
      totals: { boxes: {}, total: 0 }, flagsCopied: false,
      notCopied: [{ netsuite_id: '5', type: 'Check', number: '1005', date: '2025-01-02' }],
    });
  });

  it("orders the payments it can't split by date, then NetSuite's id", () => {
    const later = buildYear1099(data([
      billPayment('20', 100, null, { payee: '51', date: '2025-04-01' }),
      billPayment('3', 100, null, { payee: '50', date: '2025-04-01' }),
      billPayment('100', 100, null, { payee: '50', date: '2025-01-01' }),
    ]));
    expect(later.unsplit.map((p) => p.netsuiteId)).toEqual(['100', '3', '20']);
  });
});

describe('the words for a payment it can\'t split', () => {
  it('names the document it paid', () => {
    expect(docName({ type: 'VendBill', number: 'B-701' })).toBe('bill B-701');
    expect(docName({ type: 'VendCred', number: null })).toBe('bill credit');
    expect(docName({ type: 'Journal', number: 'JE-9' })).toBe('journal entry JE-9');
    expect(docName({ type: 'ExpRept', number: '4' })).toBe('ExpRept 4');
    expect(docName({ type: null, number: null })).toBe('a document');
    expect(unsplitReason({ kind: 'doc_not_in_ledger', type: 'VendBill', number: 'B-1' }))
      .toBe("It paid bill B-1, which isn't in FleetSuite's copy of NetSuite's ledger. The copy starts with 2025.");
    expect(unsplitReason({ kind: 'not_a_bill', type: 'Journal', number: 'JE-2' })).toBe('It paid journal entry JE-2, not a bill, so there are no bill lines to split it over.');
    expect(unsplitReason({ kind: 'no_amount', type: 'VendBill', number: 'B-3' })).toBe("NetSuite didn't say how much it paid on bill B-3.");
    for (const kind of ['not_in_ledger', 'links_not_copied', 'paid_nothing', 'nothing_to_split'] as const) {
      expect(unsplitReason({ kind })).toMatch(/\.$/);
    }
  });
});
