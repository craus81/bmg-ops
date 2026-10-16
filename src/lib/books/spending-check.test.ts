import { describe, it, expect } from 'vitest';
import type { ChartAccount, NetSuitePosting } from './invoice-check';
import type { BillItem, BillLine } from './bill-rule';
import { PAID_FROM_LINE } from './bill-payment-rule';
import type { SpendingType } from './spending-rule';
import {
  checkSpending, checkSpendingMonth, spendingAccount, spendingLineSigns, spendingReasons, workOutSpendingMonth,
  type SpendingMonthData,
} from './spending-check';

// Made-up books: '100' the bank, '220' the Chase card, '130' inventory,
// '610' shop supplies, '640' meals, '520' freight in, '480' vendor discounts.
const NAMES: Record<string, [string, string]> = {
  '100': ['1000 Operating Checking', 'bank'], '220': ['2200 Chase Card', 'credit_card'], '130': ['1300 Inventory', 'other_current_asset'],
  '610': ['6100 Shop Supplies', 'expense'], '640': ['6400 Meals', 'expense'], '520': ['5200 Freight In', 'cost_of_goods_sold'],
  '480': ['4800 Vendor Discounts', 'other_income'],
};
const TYPES = new Map(Object.entries(NAMES).map(([id, [, type]]) => [id, type]));
const account = (id: string) => NAMES[id]?.[0] ?? `NetSuite account ${id}`;
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: null, active: true, is_summary: false,
}));

const ITEMS = new Map<string, BillItem>([
  ['901', { number: 'WIDGET-1', type: 'InvtPart', assetAccount: '130', expenseAccount: null, incomeAccount: null }],
  ['902', { number: 'SUPPLY-2', type: 'NonInvtPart', assetAccount: null, expenseAccount: '610', incomeAccount: null }],
]);
const CTX = { items: ITEMS, accountTypes: TYPES };

const ns = (lineId: string, acct: string, cents: number): NetSuitePosting => ({ lineId, account: acct, cents });
const expense = (lineId: string, acct: string | null, cents: number | null): BillLine => ({ lineId, itemId: null, account: acct, cents, tax: false });
const line = (lineId: string, itemId: string, cents: number | null): BillLine => ({ lineId, itemId, account: null, cents, tax: false });

// A $165.12 check from the bank: lunch for the crew, and supplies.
const LINES = [expense('1', '640', 4512), line('2', '902', 12000)];
// NetSuite's posting of it: the bank credited on its main line, each line where it goes.
const POSTED = [ns('0', '100', -16512), ns('1', '640', 4512), ns('2', '610', 12000)];

const check = (lines: BillLine[] | null = LINES, netsuite = POSTED, type: SpendingType = 'Check', cents: number | null = 16512, ctx = CTX) =>
  checkSpending({ type, cents, lines, netsuite }, ctx);
const rows = (c: ReturnType<typeof checkSpending>) =>
  c.rows.map((r) => [r.lineId, r.role, r.fleetsuite && [r.fleetsuite.account, r.fleetsuite.cents], r.netsuite && [r.netsuite.account, r.netsuite.cents], r.same]);

describe('spendingAccount', () => {
  it('is the account on NetSuite\'s main line, whichever way it posts', () => {
    expect(spendingAccount(POSTED, 'Check', TYPES)).toBe('100');
    expect(spendingAccount([ns('0', '220', 2599), ns('1', '610', -2599)], 'CardRfnd', TYPES)).toBe('220');
  });

  it('is, with no main line, the one account outside income and expenses credited for a check or a charge, debited for a refund', () => {
    expect(spendingAccount([ns('5', '100', -16512), ns('1', '640', 4512), ns('2', '610', 12000)], 'Check', TYPES)).toBe('100');
    // A discount credited to income isn't where the money came from.
    expect(spendingAccount([ns('5', '220', -9200), ns('1', '130', 10000), ns('2', '480', -800)], 'CardChrg', TYPES)).toBe('220');
    expect(spendingAccount([ns('5', '220', 2599), ns('1', '610', -2599)], 'CardRfnd', TYPES)).toBe('220');
  });

  it('is none when NetSuite\'s posting doesn\'t say', () => {
    expect(spendingAccount([], 'Check', TYPES)).toBeNull();
    expect(spendingAccount([ns('5', '100', -10000), ns('6', '220', -6512), ns('1', '640', 16512)], 'Check', TYPES)).toBeNull();
    expect(spendingAccount([ns('1', '640', 500), ns('2', '610', -500)], 'CardChrg', TYPES)).toBeNull();
    // A refund's money goes back to the account it debits, never one it credits.
    expect(spendingAccount([ns('5', '220', -2599), ns('1', '610', 2599)], 'CardRfnd', TYPES)).toBeNull();
  });
});

describe('checkSpending', () => {
  it('matches a check NetSuite posts the same, account by account', () => {
    const c = check();
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      [PAID_FROM_LINE, 'paid_from', ['100', -16512], ['100', -16512], true],
      ['account:640', 'expense', ['640', 4512], ['640', 4512], true],
      ['account:610', 'item', ['610', 12000], ['610', 12000], true],
    ]);
    // The entry it posts, line by line, the account the money comes out of first.
    expect(c.lines.map((l) => [l.lineId, l.account, l.cents, l.itemNumber, l.role])).toEqual([
      [PAID_FROM_LINE, '100', -16512, null, 'paid_from'],
      ['1', '640', 4512, null, 'expense'],
      ['2', '610', 12000, 'SUPPLY-2', 'item'],
    ]);
    // However NetSuite splits its lines over the accounts.
    expect(check(LINES, [ns('0', '100', -16512), ns('1', '640', 4512), ns('5', '610', 7000), ns('6', '610', 5000)]).status).toBe('matches');
  });

  it('matches a card charge, its stock in the asset account', () => {
    const c = check([line('1', '901', 30000), expense('2', '520', 3000)], [ns('0', '220', -33000), ns('1', '130', 30000), ns('2', '520', 3000)], 'CardChrg', 33000);
    expect(c.status).toBe('matches');
    expect(rows(c).map((r) => [r[0], r[1], r[4]])).toEqual([
      [PAID_FROM_LINE, 'paid_from', true], ['account:130', 'stock', true], ['account:520', 'expense', true],
    ]);
  });

  it('matches a card refund, the other way round', () => {
    const c = check([expense('1', '610', -2599)], [ns('0', '220', 2599), ns('1', '610', -2599)], 'CardRfnd', 2599);
    expect(c.status).toBe('matches');
    expect(rows(c)).toEqual([
      [PAID_FROM_LINE, 'paid_from', ['220', 2599], ['220', 2599], true],
      ['account:610', 'expense', ['610', -2599], ['610', -2599], true],
    ]);
  });

  it('waits for the GL copy, then for the lines, and matches $0 with nothing on either side', () => {
    expect(check(LINES, [])).toEqual({ status: 'waiting', waiting: 'gl', problems: [], rows: [], lines: [] });
    expect(check(null)).toEqual({ status: 'waiting', waiting: 'lines', problems: [], rows: [], lines: [] });
    expect(check([], [], 'Check', 0)).toEqual({ status: 'matches', problems: [], rows: [], lines: [] });
    // A voided check whose lines NetSuite zeroed: an account its lines come to nothing on is the same as none.
    expect(check([expense('1', '640', 0)], [ns('0', '100', 500), ns('1', '100', -500)], 'Check', 0).status).toBe('matches');
  });

  it('leaves out an account the rule\'s lines come to nothing on, as it does NetSuite\'s', () => {
    // Freight charged on the check and taken back off it.
    const c = check([...LINES, expense('3', '520', 1500), expense('4', '520', -1500)], [...POSTED, ns('3', '520', 1500), ns('4', '520', -1500)]);
    expect(c.status).toBe('matches');
    expect(rows(c).map((r) => r[0])).toEqual([PAID_FROM_LINE, 'account:640', 'account:610']);
  });

  it('differs when NetSuite puts something elsewhere, posts a different amount, or posts more', () => {
    const elsewhere = check(LINES, [ns('0', '100', -16512), ns('1', '520', 4512), ns('2', '610', 12000)]);
    expect(elsewhere.status).toBe('differs');
    expect(rows(elsewhere).slice(1)).toEqual([
      ['account:640', 'expense', ['640', 4512], null, false],
      ['account:610', 'item', ['610', 12000], ['610', 12000], true],
      ['account:520', 'other', null, ['520', 4512], false],
    ]);
    const amount = check(LINES, [ns('0', '100', -17012), ns('1', '640', 5012), ns('2', '610', 12000)]);
    expect(rows(amount).map((r) => r[4])).toEqual([false, false, true]);
    // The lines that do post are still the entry.
    expect(amount.lines.map((l) => l.account)).toEqual(['100', '640', '610']);
  });

  it('can\'t work out what the rule can\'t, and still shows what NetSuite posted', () => {
    const c = check([line('1', '999', 16512)]);
    expect(c.status).toBe('unworkable');
    expect(c.problems).toEqual([{ kind: 'not_copied', lineId: '1', itemId: '999' }]);
    // A document posts whole or not at all.
    expect(c.lines).toEqual([]);
    expect(rows(c).map((r) => [r[0], r[2], r[4]])).toEqual([['account:100', null, false], ['account:640', null, false], ['account:610', null, false]]);
    // NetSuite's posting doesn't say which account the money came out of.
    const nowhere = check(LINES, [ns('1', '640', 4512), ns('2', '610', 12000), ns('5', '100', -10000), ns('6', '220', -6512)]);
    expect(nowhere).toMatchObject({ status: 'unworkable', problems: [{ kind: 'no_paid_from' }], lines: [] });
  });
});

describe('spendingLineSigns', () => {
  const doc = (type: SpendingType, ...amounts: Array<string | null>) => ({ type, lines: amounts.map((amount) => ({ amount })) });

  it('takes NetSuite\'s lines as they come when a check\'s or a card charge\'s add up to more than nothing and a refund\'s to less', () => {
    expect(spendingLineSigns([doc('Check', '165.12'), doc('CardChrg', '330.00', '-20.00'), doc('CardRfnd', '-25.99')]))
      .toEqual({ Check: 1, CardChrg: 1, CardRfnd: 1 });
  });

  it('turns each kind round when most of the month\'s say NetSuite signs it the other way', () => {
    expect(spendingLineSigns([doc('Check', '-165.12'), doc('Check', '-50.00'), doc('Check', '5.00'), doc('CardChrg', '330.00'), doc('CardRfnd', '25.99')]))
      .toEqual({ Check: -1, CardChrg: 1, CardRfnd: -1 });
  });

  it('goes by the GL when the month has no say: no documents, lines not copied, or lines that come to nothing', () => {
    expect(spendingLineSigns([])).toEqual({ Check: 1, CardChrg: 1, CardRfnd: 1 });
    expect(spendingLineSigns([{ type: 'Check', lines: null }, doc('CardChrg', '50.00', '-50.00'), doc('CardRfnd', null)]))
      .toEqual({ Check: 1, CardChrg: 1, CardRfnd: 1 });
    expect(spendingLineSigns([doc('Check', '-5.00'), doc('Check', '5.00')])).toEqual({ Check: 1, CardChrg: 1, CardRfnd: 1 });
  });
});

describe('spendingReasons', () => {
  const reasons = (c: ReturnType<typeof checkSpending>, type: SpendingType = 'Check') => spendingReasons(c, type, account);

  it('says once that NetSuite used another account for the same amount', () => {
    const c = check(LINES, [ns('0', '100', -16512), ns('1', '520', 4512), ns('2', '610', 12000)]);
    expect(reasons(c)).toEqual([{ key: 'swap|expense|640|520', text: 'Expense: FleetSuite used 6400 Meals, NetSuite 5200 Freight In.' }]);
  });

  it('says what differs, what NetSuite posts that the rule doesn\'t, and what NetSuite left out', () => {
    const c = check(LINES, [ns('0', '100', -17012), ns('1', '640', 5512), ns('9', '480', 11500)]);
    expect(reasons(c)).toEqual([
      { key: 'amount|100', text: "The check's total differs from what NetSuite posted to 1000 Operating Checking." },
      { key: 'amount|640', text: 'What FleetSuite posts to 6400 Meals differs from what NetSuite posted there.' },
      { key: 'none|Check|610', text: 'NetSuite posted nothing to 6100 Shop Supplies for the check.' },
      { key: 'other|480', text: "NetSuite also posts to 4800 Vendor Discounts, which the spending rule doesn't." },
    ]);
  });

  it('gives the rule\'s problems in words, a refund\'s its own way, and nothing for a match or a wait', () => {
    expect(reasons(check())).toEqual([]);
    expect(reasons(check(null))).toEqual([]);
    const c = check([line('1', '999', 100), { ...expense('2', null, 100), tax: true }, expense('3', null, 100), line('4', '901', null)]);
    expect(reasons(c, 'CardChrg').map((r) => r.text)).toEqual([
      "Item 999 isn't in the copy of NetSuite's items yet. Sync now on the NetSuite lists page copies it.",
      "The card charge has a tax line, which the spending rule doesn't post yet.",
      "An expense line on the card charge has no account: NetSuite didn't say which account it goes to.",
      "A line's amount couldn't be read from the copy of the card charge.",
    ]);
    expect(reasons(check(LINES, [ns('1', '640', 4512), ns('2', '610', 12000)])).map((r) => r.text)).toEqual([
      "NetSuite's posting of the check doesn't say which account the money came out of.",
    ]);
    expect(reasons(check([expense('1', '610', -2599)], [ns('1', '610', -2599)], 'CardRfnd', 2599), 'CardRfnd').map((r) => r.text)).toEqual([
      "NetSuite's posting of the card refund doesn't say which account the money went back to.",
    ]);
    const without = (id: string, fields: Partial<BillItem>) => ({ ...CTX, items: new Map([[id, { ...ITEMS.get(id)!, ...fields }]]) });
    expect(reasons(check([line('1', '901', 16512)], POSTED, 'Check', 16512, without('901', { assetAccount: null }))).map((r) => r.text)).toEqual([
      "WIDGET-1 has no asset account in the copy of NetSuite's items.",
    ]);
    expect(reasons(check([line('1', '902', 16512)], POSTED, 'Check', 16512, without('902', { expenseAccount: null }))).map((r) => r.text)).toEqual([
      "SUPPLY-2 has no expense account in the copy of NetSuite's items, and no copied check, card charge or refund shows where NetSuite posts it.",
    ]);
  });
});

// ── A month ────────────────────────────────────────────────────────────────

type MonthDoc = SpendingMonthData['documents'][number];
const gl = (...lines: Array<[string, string, number]>) => lines.map(([lineId, acct, cents]) => ({
  line_id: lineId, account: acct, debit: cents > 0 ? (cents / 100).toFixed(2) : '0.00', credit: cents < 0 ? (-cents / 100).toFixed(2) : '0.00',
}));
const copied = (lineId: string, item: string | null, acct: string | null, amount: string, fields: Partial<NonNullable<MonthDoc['lines']>[number]> = {}) => ({
  line_id: lineId, item, account: acct, amount, quantity: null, memo: null, tax: false, ...fields,
});
const monthDoc = (fields: Partial<MonthDoc>): MonthDoc => ({
  netsuite_id: '801', type: 'Check', number: '10234', date: '2026-09-03', posting_month: '2026-09-01', total: '165.12', voided: false,
  status: null, payee: 'Sample Supply Co', payee_netsuite_id: '50', companies: ['BMG'],
  // NetSuite signs these lines the other way round from the GL; the check turns them.
  lines: [copied('1', null, '640', '-45.12', { memo: 'Lunch for the crew' }), copied('2', '902', null, '-120.00', { quantity: '-4', memo: 'Gloves' })],
  netsuite: gl(['0', '100', -16512], ['1', '640', 4512], ['2', '610', 12000]),
  ...fields,
});
const MONTH: SpendingMonthData = {
  documents: [
    monthDoc({}),
    // Stock and its freight on the Chase card; NetSuite gives a card charge no number.
    monthDoc({
      netsuite_id: '802', type: 'CardChrg', number: null, date: '2026-09-10', total: '330.00', payee: 'Uline', payee_netsuite_id: '51',
      lines: [copied('1', '901', null, '-300.00', { quantity: '-10' }), copied('2', '903', null, '-30.00')],
      netsuite: gl(['0', '220', -33000], ['1', '130', 30000], ['2', '520', 3000]),
    }),
    // Supplies sent back, refunded to the card.
    monthDoc({
      netsuite_id: '803', type: 'CardRfnd', number: 'R-803', date: '2026-09-15', total: '25.99', payee: 'Uline', payee_netsuite_id: '51',
      lines: [copied('1', null, '610', '25.99')],
      netsuite: gl(['0', '220', 2599], ['1', '610', -2599]),
    }),
    // Dated in August, booked by NetSuite into September.
    monthDoc({
      netsuite_id: '804', number: '10220', date: '2026-08-31', total: '50.00',
      lines: [copied('1', null, '640', '-50.00')], netsuite: gl(['0', '100', -5000], ['1', '640', 5000]),
    }),
    // Its lines not copied yet.
    monthDoc({ netsuite_id: '805', type: 'CardChrg', number: 'C-805', total: '10.00', lines: null, netsuite: gl(['0', '220', -1000], ['1', '640', 1000]) }),
    // In neither company's GL copy yet.
    monthDoc({ netsuite_id: '806', number: '10240', total: '75.00', lines: [copied('1', null, '640', '-75.00')], companies: [], netsuite: [] }),
  ],
  items: [
    { netsuite_id: '901', name: 'WIDGET-1', item_type: 'InvtPart', asset_account: '130', expense_account: null, income_account: null },
    { netsuite_id: '902', name: 'SUPPLY-2', item_type: 'NonInvtPart', asset_account: null, expense_account: '610', income_account: null },
    { netsuite_id: '903', name: 'FREIGHT', item_type: 'OthCharge', asset_account: null, expense_account: '520', income_account: null },
  ],
  not_copied: [{ netsuite_id: '809', type: 'Check', number: '10249' }],
};

describe('checkSpendingMonth', () => {
  it('checks every check, card charge and refund of the company\'s, with its payee and lines, and says what it can\'t check', () => {
    const m = checkSpendingMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 5, matches: 4, differs: 0, unworkable: 0, waiting: 1, withCost: 0 });
    expect(m.invoices.map((d) => [d.number, d.type, d.status, d.waiting, d.customer, d.total])).toEqual([
      ['10234', 'Check', 'matches', undefined, 'Sample Supply Co', 16512],
      ['NetSuite 802', 'CardChrg', 'matches', undefined, 'Uline', 33000],
      ['R-803', 'CardRfnd', 'matches', undefined, 'Uline', 2599],
      ['10220', 'Check', 'matches', undefined, 'Sample Supply Co', 5000],
      ['C-805', 'CardChrg', 'waiting', 'lines', 'Sample Supply Co', 1000],
    ]);
    const [c801, c802, r803, c804] = m.invoices;
    expect(c801.lines).toEqual([
      { label: 'Expense to 6400 Meals', quantity: null, memo: 'Lunch for the crew', cents: 4512 },
      { label: 'SUPPLY-2', quantity: '-4', memo: 'Gloves', cents: 12000 },
    ]);
    expect(c801.rows.map((r) => [r.label, r.fleetsuite?.account, r.same])).toEqual([['Paid from', '100', true], ['Expense', '640', true], ['Items', '610', true]]);
    expect(c802.rows.map((r) => [r.label, r.fleetsuite?.account, r.same])).toEqual([['Paid from', '220', true], ['Inventory', '130', true], ['Items', '520', true]]);
    // A refund's money goes back to the card, and its lines show as the document has them.
    expect(r803.rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same])).toEqual([
      ['Refunded to', '220', 2599, true], ['Expense', '610', -2599, true],
    ]);
    expect(r803.lines).toEqual([{ label: 'Expense to 6100 Shop Supplies', quantity: null, memo: null, cents: 2599 }]);
    expect(c804.booked).toEqual({ month: '2026-09-01', date: '2026-09-01' });
    expect(c801.netsuiteStatus).toBeUndefined();
    expect(m.reasons).toEqual([]);
    expect(m.accounts).toEqual({
      100: '1000 Operating Checking', 130: '1300 Inventory', 220: '2200 Chase Card', 520: '5200 Freight In', 610: '6100 Shop Supplies', 640: '6400 Meals',
    });
    expect(m.notes).toEqual([
      '1 check, card charge or refund dated in another month is here because NetSuite booked it into this month: 10220.',
      "1 more check, card charge or refund dated this month isn't in the copy of NetSuite's GL for either company: 10240. NetSuite may have "
        + "deleted it, or the copy, which runs every two hours, hasn't reached it yet.",
      "The copy of NetSuite's GL has 1 check, card charge or refund of this company's booked into this month that the copy of the checks, "
        + "card charges and refunds doesn't: 10249. That copy runs every two hours and may not have reached it yet, or NetSuite deleted it "
        + "and the GL copy hasn't caught up.",
    ]);
  });

  it('counts what doesn\'t match by reason, and shows NetSuite\'s status, a voided check\'s too', () => {
    const m = checkSpendingMonth({
      ...MONTH,
      documents: [
        monthDoc({ netsuite: gl(['0', '100', -16512], ['1', '520', 4512], ['2', '610', 12000]) }),
        monthDoc({ netsuite_id: '812', number: '10243', netsuite: gl(['0', '100', -16512], ['1', '520', 4512], ['2', '610', 12000]) }),
        // Voided: NetSuite zeroed it.
        monthDoc({
          netsuite_id: '807', number: '10241', total: '0.00', voided: true, status: 'Voided',
          lines: [copied('1', null, '640', '0.00')], netsuite: gl(['0', '100', 0], ['1', '640', 0]),
        }),
        // Voided before the GL copy reached it: nothing to say about it.
        monthDoc({ netsuite_id: '811', number: '10242', total: '0.00', voided: true, status: 'Voided', lines: [], companies: [], netsuite: [] }),
      ],
      not_copied: [],
    }, { company: 'BMG', chart: CHART });
    expect(m.summary).toMatchObject({ invoices: 3, matches: 1, differs: 2 });
    expect(m.reasons).toEqual([
      { key: 'swap|expense|640|520', text: 'Expense: FleetSuite used 6400 Meals, NetSuite 5200 Freight In.', invoices: 2, examples: ['10234', '10243'] },
    ]);
    expect(m.invoices.map((d) => [d.number, d.status, d.voided, d.netsuiteStatus, d.total, d.reasons.length])).toEqual([
      ['10234', 'differs', false, undefined, 16512, 1], ['10243', 'differs', false, undefined, 16512, 1], ['10241', 'matches', true, 'Voided', 0, 0],
    ]);
    expect(m.invoices[2].rows).toEqual([]);
    expect(m.notes).toEqual([]);
  });

  // A $92.00 card charge: $100.00 of supplies, a subtotal, and 8% off it, NetSuite's net amounts sharing the discount out.
  const DISC = { netsuite_id: '904', name: 'DISC', item_type: 'Discount', asset_account: null, expense_account: null, income_account: '480' };
  const discounted = monthDoc({
    netsuite_id: '810', type: 'CardChrg', number: null, total: '92.00',
    lines: [
      copied('1', '902', null, '-92.00', { own_amount: '-100.00', quantity: '-1' }),
      copied('2', '-2', null, '-100.00', { own_amount: '-100.00' }),
      copied('3', '904', null, '0.00', { own_amount: '8.00' }),
    ],
    netsuite: gl(['0', '220', -9200], ['1', '610', 10000], ['3', '480', -800]),
  });
  const alone = (documents: MonthDoc[], items = [...MONTH.items, DISC]): SpendingMonthData => ({ ...MONTH, documents, items, not_copied: [] });

  it('matches a discount at the lines\' own amounts, the discount a credit of its own', () => {
    const m = checkSpendingMonth(alone([discounted]), { company: 'BMG', chart: CHART });
    expect(m.invoices[0]).toMatchObject({
      number: 'NetSuite 810',
      status: 'matches',
      amounts: 'own',
      reasons: [],
      lines: [
        { label: 'SUPPLY-2', quantity: '-1', cents: 10000 },
        { label: 'Subtotal', quantity: null, cents: 10000 },
        { label: 'DISC', quantity: null, cents: -800 },
      ],
    });
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents, r.same])).toEqual([
      ['Paid from', '220', -9200, true], ['Items', '610', 10000, true], ['Items', '480', -800, true],
    ]);
    expect(m.notes).toEqual([]);
  });

  it('says when a document\'s lines don\'t add up at their own amounts, and uses the net ones', () => {
    const unfit = { ...discounted, lines: discounted.lines!.map((l) => (l.line_id === '3' ? { ...l, own_amount: '5.00' } : l)) };
    const m = checkSpendingMonth(alone([unfit]), { company: 'BMG', chart: CHART });
    expect(m.invoices[0]).toMatchObject({ status: 'differs', amounts: 'unfit' });
    expect(m.invoices[0].lines.map((l) => l.cents)).toEqual([9200, 10000, 0]);
    expect(m.notes).toEqual([
      "NetSuite's own amounts for the lines of 1 check, card charge or refund don't add up to it, so FleetSuite took its lines at their net "
        + 'amounts, with any discount shared out over them: NetSuite 810.',
    ]);
  });

  it('puts an item the copy of NetSuite\'s items has no account for where NetSuite posted most of its lines', () => {
    const items = [...MONTH.items, { ...DISC, income_account: null }];
    const worked = (item_accounts?: SpendingMonthData['item_accounts']) =>
      workOutSpendingMonth({ ...alone([discounted], items), item_accounts }, { company: 'BMG', chart: CHART }).documents[0].checked;
    expect(worked([{ item: '904', account: '610', lines: 1 }, { item: '904', account: '480', lines: 6 }]).status).toBe('matches');
    // The lower NetSuite id on a tie.
    const tie = worked([{ item: '904', account: '481', lines: 2 }, { item: '904', account: '480', lines: 2 }]);
    expect(tie.rows.find((r) => r.fleetsuite?.cents === -800)?.fleetsuite).toEqual({ account: '480', cents: -800 });
    // Nowhere to go by: it can't be worked out, and says why.
    expect(worked([{ item: '905', account: '480', lines: 9 }]).status).toBe('unworkable');
    expect(checkSpendingMonth(alone([discounted], items), { company: 'BMG', chart: CHART }).invoices[0]).toMatchObject({
      status: 'unworkable',
      reasons: ["DISC has no expense account in the copy of NetSuite's items, and no copied check, card charge or refund shows where NetSuite posts it."],
    });
  });
});
