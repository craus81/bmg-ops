import { describe, it, expect } from 'vitest';
import {
  centsOf, checkInvoice, checkMonth, costLines, invoiceReasons, pickReceivable, problemReason, summarize, withOwnAmounts,
  type ChartAccount, type CheckContext, type InvoiceMonthData, type LineFacts, type NetSuitePosting, type ReasonNames,
} from './invoice-check';
import type { InvoiceLine, RuleItem } from './invoice-rule';

// Made-up books: '120' receivable, '400' and '410' income, '220' sales tax
// payable, '500' cost of goods sold, '130' inventory.
const item = (number: string, type: string, incomeAccount: string | null, assetAccount: string | null = null): RuleItem =>
  ({ number, type, incomeAccount, assetAccount });

const CTX: CheckContext = {
  items: new Map([
    ['11', item('PART-A', 'InvtPart', '400', '130')],
    ['13', item('INSTALL LABOR', 'Service', '400')],
    ['18', item('ODD PART', 'NonInvtPart', '500')],
  ]),
  taxAccounts: new Map([['900', '220']]),
  receivable: '120',
  accountTypes: new Map([['120', 'accounts_receivable'], ['400', 'income'], ['410', 'income'], ['220', 'other_current_liability'], ['500', 'cost_of_goods_sold'], ['130', 'other_current_asset']]),
};

const NAMES: ReasonNames = {
  account: (id) => ({ '120': '1200 Receivables', '400': '4000 Sales', '410': '4100 Other Sales', '220': '2200 Sales Tax', '500': '5000 Cost of Goods' } as Record<string, string>)[id] ?? `NetSuite account ${id}`,
  taxCode: (id) => (id === '900' ? 'Some County' : `tax code ${id}`),
  doc: 'invoice',
};

const line = (lineId: string, itemId: string | null, cents: number | null, fields: Partial<InvoiceLine> = {}): InvoiceLine =>
  ({ lineId, itemId, itemNumber: itemId === '11' ? 'PART-A' : itemId === '13' ? 'INSTALL LABOR' : null, tax: false, cents, ...fields });
const ns = (lineId: string, account: string, cents: number): NetSuitePosting => ({ lineId, account, cents });

// An invoice of a part and labor plus tax, as NetSuite posts it.
const LINES = [line('1', '11', 10000), line('2', '13', 5000), line('3', '900', 1200, { tax: true, itemNumber: null })];
const POSTED = [ns('0', '120', 16200), ns('1', '400', -10000), ns('2', '400', -5000), ns('3', '220', -1200)];

const check = (lines = LINES, netsuite = POSTED, ctx = CTX) => checkInvoice({ lines, netsuite, linesCopied: true }, ctx);

describe('checkInvoice', () => {
  it('matches when every line posts the same account and amount as NetSuite', () => {
    const c = check();
    expect(c.status).toBe('matches');
    expect(c.rows.map((r) => [r.lineId, r.fleetsuite?.account, r.netsuite?.account, r.same])).toEqual([
      ['0', '120', '120', true], ['1', '400', '400', true], ['2', '400', '400', true], ['3', '220', '220', true],
    ]);
  });

  it('differs when NetSuite posts a line to another account, and says which', () => {
    const c = check(LINES, [ns('0', '120', 16200), ns('1', '410', -10000), ns('2', '400', -5000), ns('3', '220', -1200)]);
    expect(c.status).toBe('differs');
    expect(c.rows.filter((r) => !r.same).map((r) => r.lineId)).toEqual(['1']);
    expect(invoiceReasons(c, NAMES)).toEqual([{
      key: 'item|11|400|410',
      text: 'PART-A: FleetSuite used its income account, 4000 Sales; NetSuite posted to 4100 Other Sales.',
    }]);
  });

  it('names amounts that differ, lines only NetSuite posts, and a different total', () => {
    const c = check(LINES, [ns('0', '120', 16300), ns('1', '400', -10000), ns('2', '400', -5000), ns('3', '220', -1200), ns('7', '410', -100)]);
    expect(c.status).toBe('differs');
    expect(invoiceReasons(c, NAMES).map((r) => r.text)).toEqual([
      'The total FleetSuite works out differs from what NetSuite put in receivables.',
      "NetSuite posts to 4100 Other Sales on a line the copy of the invoice doesn't have.",
    ]);
    expect(c.rows.map((r) => r.lineId)).toEqual(['0', '1', '2', '3', '7']);
  });

  it('treats a line NetSuite posts nothing on like no line', () => {
    expect(check(LINES, [...POSTED, ns('8', '400', 0)]).status).toBe('matches');
  });

  it('leaves out the cost of goods NetSuite books on an invoice that wasn\'t fulfilled first', () => {
    // Lines 4 and 5 relieve the part's stock: whatever amounts the copy gives them, they're not sales.
    const lines = [...LINES, line('4', '11', -3000), line('5', '11', 3000)];
    const netsuite = [...POSTED, ns('4', '500', 3000), ns('5', '130', -3000)];
    const c = check(lines, netsuite);
    expect(c.status).toBe('matches');
    expect(c.rows.filter((r) => r.cost).map((r) => [r.lineId, r.fleetsuite, r.netsuite?.account])).toEqual([['4', null, '500'], ['5', null, '130']]);
    expect(c.rows.find((r) => r.lineId === '0')?.fleetsuite?.cents).toBe(16200);
  });

  it('also goes by NetSuite\'s own cost of goods flag, whatever account the cost went to', () => {
    // Line 5's stock went to '135', an account the item doesn't name: only NetSuite's flag says it's cost.
    const lines = [...LINES, line('4', '11', 0), line('5', '11', 0)];
    const netsuite = [...POSTED, ns('4', '500', 3000), ns('5', '135', -3000)];
    expect(check(lines, netsuite).status).toBe('differs');
    const c = checkInvoice({ lines, netsuite, linesCopied: true, cogs: new Set(['5']) }, CTX);
    expect(c.status).toBe('matches');
    expect(c.rows.filter((r) => r.cost).map((r) => r.lineId)).toEqual(['4', '5']);
  });

  it('counts a line posted to its item\'s own income account as a sale, whatever kind of account that is', () => {
    const lines = [line('1', '18', 2000, { itemNumber: 'ODD PART' })];
    const posted = new Map([['1', ns('1', '500', -2000)]]);
    expect([...costLines(lines, posted, CTX)]).toEqual([]);
    expect(check(lines, [ns('0', '120', 2000), ns('1', '500', -2000)]).status).toBe('matches');
  });

  it('counts a line posted where NetSuite posts an item with no income account as a sale, even its asset account', () => {
    const ctx = { ...CTX, items: new Map([...CTX.items, ['16', { ...item('PREPAYMENT', 'Payment', null, '110'), postedAccount: '110' }]]) };
    const lines = [line('1', '11', 50000), line('2', '16', -40000, { itemNumber: 'PREPAYMENT' })];
    const netsuite = [ns('0', '120', 10000), ns('1', '400', -50000), ns('2', '110', 40000)];
    expect([...costLines(lines, new Map(netsuite.map((p) => [p.lineId, p])), ctx)]).toEqual([]);
    expect(check(lines, netsuite, ctx).status).toBe('matches');
  });

  it('can\'t work out an invoice with an item it doesn\'t know, and still shows what NetSuite posted', () => {
    const c = check([...LINES, line('4', '99', 100, { itemNumber: 'NEW PART' })], [...POSTED, ns('4', '400', -100)]);
    expect(c.status).toBe('unworkable');
    expect(c.rows.every((r) => r.fleetsuite === null)).toBe(true);
    expect(invoiceReasons(c, NAMES)).toEqual([{
      key: 'not_copied|99',
      text: "NEW PART isn't in the copy of NetSuite's items yet. Sync now on the NetSuite lists page copies it.",
    }]);
  });

  it('waits for an invoice\'s lines, and for NetSuite\'s GL when FleetSuite would post it', () => {
    expect(checkInvoice({ lines: LINES, netsuite: POSTED, linesCopied: false }, CTX)).toEqual({ status: 'waiting', waiting: 'lines', problems: [], rows: [] });
    expect(check(LINES, [])).toMatchObject({ status: 'waiting', waiting: 'gl' });
    expect(check([line('1', '11', 0)], []).status).toBe('matches');
  });

  it('checks a credit memo the other way round, leaving out the cost of the stock that comes back', () => {
    // The part and labor given back with their tax. Lines 4 and 5 put the part's stock back: they're not sales.
    const lines = [line('1', '11', -10000), line('2', '13', -5000), line('3', '900', -1200, { tax: true, itemNumber: null }), line('4', '11', 0), line('5', '11', 0)];
    const netsuite = [ns('0', '120', -16200), ns('1', '400', 10000), ns('2', '400', 5000), ns('3', '220', 1200), ns('4', '130', 3000), ns('5', '500', -3000)];
    const c = check(lines, netsuite);
    expect(c.status).toBe('matches');
    expect(c.rows.map((r) => [r.lineId, r.fleetsuite?.account ?? null, r.fleetsuite?.cents ?? null, r.cost])).toEqual([
      ['0', '120', -16200, false], ['1', '400', 10000, false], ['2', '400', 5000, false], ['3', '220', 1200, false], ['4', null, null, true], ['5', null, null, true],
    ]);
    // Read the wrong way round, every line would differ.
    expect(check(lines.map((l) => ({ ...l, cents: -(l.cents ?? 0) })), netsuite).status).toBe('differs');
  });
});

describe('withOwnAmounts', () => {
  // A card fee of 3% set at the top: NetSuite's net amounts carry each line's share of it.
  const NET = [line('1', '11', 10300), line('2', '13', 5150), line('3', '19', 0, { itemNumber: 'CARD FEE' }), line('4', '900', 1200, { tax: true })];
  const own = (amount: string | null, fields: Partial<LineFacts> = {}): LineFacts => ({ cogs: false, topDiscount: false, amount, ...fields });
  const FACTS = [own('-100.00'), own('-50.00'), own('-4.50', { topDiscount: true }), own('-12.00')];
  const spread = (lines: InvoiceLine[], facts: Array<LineFacts | undefined>) => withOwnAmounts(lines, facts, CTX.items);
  const cents = (r: ReturnType<typeof withOwnAmounts>) => [r.amounts, r.lines.map((l) => [l.lineId, l.cents])];

  it('takes each line at its own amount, the fee\'s own line included, so the total stays the same', () => {
    expect(cents(spread(NET, FACTS))).toEqual(['own', [['1', 10000], ['2', 5000], ['3', 450], ['4', 1200]]]);
  });

  it('does the same for a discount on a line under the lines it applies to, which NetSuite doesn\'t flag as set at the top', () => {
    const net = [line('1', '11', 9000), line('2', '13', 4500), line('3', '14', 0, { itemNumber: 'DISCOUNT' })];
    expect(cents(spread(net, [own('-100.00'), own('-50.00'), own('15.00')]))).toEqual(['own', [['1', 10000], ['2', 5000], ['3', -1500]]]);
  });

  it('gives a discount set at the top with no amount of its own what the other lines carried', () => {
    for (const top of [own(null, { topDiscount: true }), own('0.00', { topDiscount: true })]) {
      expect(cents(spread(NET, [FACTS[0], FACTS[1], top, FACTS[3]]))).toEqual(['own', [['1', 10000], ['2', 5000], ['3', 450], ['4', 1200]]]);
    }
  });

  it('takes a discount or payment bigger than the line it applies to, which leaves that line\'s net amount a credit', () => {
    // $205 off $200 of labor: NetSuite's net amount on the labor is a $5 credit.
    const discounted = [line('1', '13', -500), line('2', '14', 0, { itemNumber: 'DISCOUNT' })];
    expect(cents(spread(discounted, [own('-200.00'), own('205.00')]))).toEqual(['own', [['1', 20000], ['2', -20500]]]);

    // A $400 prepayment under $20 of freight, on an invoice with a part too. A payment item can carry an account
    // of its own, unlike stock it isn't a line of $0 to leave alone.
    const items = new Map([...CTX.items, ['16', item('PREPAYMENT', 'Payment', null, '110')]]);
    const paid = [line('1', '11', 30000), line('2', '15', -38000, { itemNumber: 'FREIGHT' }), line('3', '16', 0, { itemNumber: 'PREPAYMENT' })];
    const r = withOwnAmounts(paid, [own('-300.00'), own('-20.00'), own('400.00')], items);
    expect(cents(r)).toEqual(['own', [['1', 30000], ['2', 2000], ['3', -40000]]]);
    expect(r.lines[0]).toBe(paid[0]);
  });

  it('leaves alone tax, a subtotal, which repeats the shares, cost of goods, and a stock item\'s line of $0', () => {
    const net = [...NET, line('5', '-2', 15450), line('6', '11', 0), line('7', '11', 0)];
    const facts = [...FACTS, own('-150.00'), own('-30.00', { cogs: true }), own('25.00')];
    expect(cents(spread(net, facts)))
      .toEqual(['own', [['1', 10000], ['2', 5000], ['3', 450], ['4', 1200], ['5', 15450], ['6', 0], ['7', 0]]]);
  });

  it('changes nothing when each line\'s own amount is its net amount, or NetSuite gave none', () => {
    const plain = [line('1', '11', 10000), line('2', '13', 5000)];
    for (const [lines, facts] of [
      [plain, [own('-100.00'), own('-50.00')]],
      [NET, [undefined, undefined, undefined, undefined]],
      [NET, [own(null), own(null), own(null, { topDiscount: true }), own(null)]],
    ] as Array<[InvoiceLine[], Array<LineFacts | undefined>]>) {
      const r = spread(lines, facts);
      expect([r.amounts, r.lines]).toEqual(['net', lines]);
      expect(r.lines).toBe(lines);
    }
  });

  it('keeps every net amount when the own amounts don\'t add up, or one can\'t be read', () => {
    for (const facts of [
      [FACTS[0], FACTS[1], own(null), FACTS[3]],
      [FACTS[0], FACTS[1], own('-3.00', { topDiscount: true }), FACTS[3]],
      [FACTS[0], own('-50.00', { topDiscount: true }), own(null, { topDiscount: true }), FACTS[3]],
      [own('100.00'), own('50.00'), FACTS[2], FACTS[3]],
      [own('0.00'), FACTS[1], FACTS[2], FACTS[3]],
      [own('a lot'), FACTS[1], FACTS[2], FACTS[3]],
    ]) {
      const r = spread(NET, facts);
      expect(r.amounts).toBe('unfit');
      expect(r.lines).toBe(NET);
    }
  });
});

describe('problemReason', () => {
  it('words every reason an invoice can\'t be worked out', () => {
    expect([
      problemReason({ kind: 'no_item', lineId: '1' }, NAMES),
      problemReason({ kind: 'no_income_account', lineId: '1', itemId: '17', itemNumber: 'NO ACCOUNT' }, NAMES),
      problemReason({ kind: 'no_tax_account', lineId: '1', taxCode: '' }, NAMES),
      problemReason({ kind: 'no_receivable' }, NAMES),
    ]).toEqual([
      { key: 'no_item', text: 'A line carries an amount but no item, so it has no income account.' },
      {
        key: 'no_income|17',
        text: "NO ACCOUNT has no income account in the copy of NetSuite's items, and FleetSuite doesn't know where NetSuite posts it yet. "
          + "It learns that from NetSuite's invoices since January 2025, as of the last copy of the NetSuite lists.",
      },
      {
        key: 'no_tax|',
        text: "FleetSuite doesn't know where sales tax with no tax code posts yet. It learns that from NetSuite's sales tax postings "
          + 'since January 2025, as of the last copy of the NetSuite lists.',
      },
      { key: 'no_receivable', text: 'The chart of accounts has no receivable account this company can use.' },
    ]);
  });
});

describe('summarize', () => {
  it('counts each status and each reason once per invoice, with a few examples', () => {
    const wrong = check(LINES, [ns('0', '120', 16200), ns('1', '410', -10000), ns('2', '410', -5000), ns('3', '220', -1200)]);
    const { summary, reasons } = summarize([
      { number: 'INV1', checked: check() },
      { number: 'INV2', checked: wrong },
      { number: 'INV3', checked: wrong },
      { number: 'INV4', checked: checkInvoice({ lines: LINES, netsuite: POSTED, linesCopied: false }, CTX) },
    ], NAMES, 1);
    expect(summary).toEqual({ invoices: 4, matches: 1, differs: 2, unworkable: 0, waiting: 1, withCost: 0 });
    expect(reasons.map((r) => [r.invoices, r.examples, r.key])).toEqual([[2, ['INV2'], 'item|13|400|410'], [2, ['INV2'], 'item|11|400|410']]);
  });
});

describe('pickReceivable', () => {
  const ar = (id: string, company: string | null = null, extra: Partial<ChartAccount> = {}): ChartAccount => ({
    netsuite_account_id: id, number: `12${id}`, name: `Receivables ${id}`, account_type: 'accounts_receivable', company, active: true, is_summary: false, ...extra,
  });

  it('uses the company\'s only receivable account', () => {
    expect(pickReceivable([ar('120'), ar('121', 'OTHER'), ar('122', null, { active: false }), ar('123', null, { is_summary: true })], 'BMG', []))
      .toEqual({ account: '120', note: null });
  });

  it('says so when there isn\'t one', () => {
    expect(pickReceivable([ar('121', 'OTHER')], 'BMG', [])).toEqual({ account: null, note: 'The chart of accounts has no receivable account BMG can use.' });
  });

  it('picks the one NetSuite\'s invoices used most when there are several', () => {
    const r = pickReceivable([ar('120'), ar('121', 'BMG')], 'BMG', [ns('0', '121', 1), ns('0', '121', 1), ns('0', '120', 1)]);
    expect(r.account).toBe('121');
    expect(r.note).toBe("BMG can use 2 receivable accounts, so FleetSuite used 12121 Receivables 121, the one NetSuite's invoices used most this month.");
  });
});

describe('checkMonth', () => {
  const CHART: ChartAccount[] = [
    { netsuite_account_id: '120', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', company: null, active: true, is_summary: false },
    { netsuite_account_id: '400', number: '4000', name: 'Sales', account_type: 'income', company: null, active: true, is_summary: false },
    { netsuite_account_id: '220', number: '2200', name: 'Sales Tax', account_type: 'other_current_liability', company: null, active: true, is_summary: false },
    { netsuite_account_id: '500', number: '5000', name: 'Cost of Goods', account_type: 'cost_of_goods_sold', company: null, active: true, is_summary: false },
  ];
  const invoice = (number: string, fields: Partial<InvoiceMonthData['invoices'][number]> = {}): InvoiceMonthData['invoices'][number] => ({
    id: `id-${number}`, doc_type: 'invoice', netsuite_id: number.replace(/\D/g, ''), number, date: '2026-09-15', total: '162.00', voided: false, customer: 'A Customer',
    lines_copied: true, companies: ['BMG'],
    lines: [
      { line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '100.00', netamount: '-100' },
      { line_id: '2', line_no: 2, kind: 'item', item_id: '13', item_number: 'INSTALL LABOR', amount: '50.00', netamount: '-50.00' },
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
  const ITEMS: InvoiceMonthData['items'] = [
    { kind: 'item', netsuite_id: '11', name: 'PART-A', item_type: 'InvtPart', income_account: '400', asset_account: '130' },
    { kind: 'item', netsuite_id: '13', name: 'INSTALL LABOR', item_type: 'Service', income_account: '400', asset_account: null },
    { kind: 'tax_code', netsuite_id: '900', name: 'Some County', item_type: null, income_account: null, asset_account: null },
  ];
  const TAX = [{ tax_code_id: '900', account_id: '221', lines: 2 }, { tax_code_id: '900', account_id: '220', lines: 40 }];

  it('works out each invoice from NetSuite\'s signed amounts and the tax code\'s most used account', () => {
    const m = checkMonth({ invoices: [invoice('INV101')], items: ITEMS }, { company: 'BMG', chart: CHART, taxAccounts: TAX });
    expect(m.summary).toEqual({ invoices: 1, matches: 1, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.notes).toEqual([]);
    expect(m.invoices[0]).toMatchObject({ number: 'INV101', total: 16200, status: 'matches', reasons: [] });
    expect(m.invoices[0].rows.map((r) => [r.label, r.division, r.fleetsuite?.cents, r.netsuite?.cents])).toEqual([
      ['Receivable', null, 16200, 16200],
      ['PART-A', 'upfit', -10000, -10000],
      ['INSTALL LABOR', 'upfit', -5000, -5000],
      ['Sales tax, Some County', null, -1200, -1200],
    ]);
    expect(m.accounts).toEqual({ '120': '1200 Receivables', '220': '2200 Sales Tax', '400': '4000 Sales' });
  });

  it('notes invoices in neither company\'s GL copy instead of counting them, unless they post nothing', () => {
    const zero = invoice('INV103', { companies: [], netsuite: [], lines: [{ line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '0.00', netamount: null }] });
    const m = checkMonth(
      { invoices: [invoice('INV101'), invoice('INV102', { companies: [], netsuite: [] }), zero], items: ITEMS },
      { company: 'BMG', chart: CHART, taxAccounts: TAX },
    );
    expect(m.summary.invoices).toBe(1);
    expect(m.notes).toEqual([
      "1 more invoice dated this month isn't in the copy of NetSuite's GL for either company: INV102. NetSuite may not have posted it "
      + "(an invoice waiting for approval doesn't post), or the copy, which runs every two hours, hasn't reached it yet.",
    ]);
  });

  it('says when where sales tax posts hasn\'t been read, and counts invoices that book cost of goods', () => {
    const withCost = invoice('INV104', {
      lines: [...invoice('X').lines, { line_id: '4', line_no: 4, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '0.00', netamount: null }],
      netsuite: [...invoice('X').netsuite, { line_id: '4', account: '500', debit: '30.00', credit: '0.00' }],
    });
    const m = checkMonth({ invoices: [withCost], items: ITEMS }, { company: 'BMG', chart: CHART, taxAccounts: null });
    expect(m.summary).toMatchObject({ invoices: 1, unworkable: 1, withCost: 1 });
    expect(m.notes).toEqual([
      "Where sales tax posts hasn't been read yet. Sync now on the NetSuite lists page reads it.",
      "1 invoice also books the cost of the stock sold, as NetSuite does when an invoice isn't fulfilled first. "
      + "FleetSuite will post that cost with the fulfillment rule, so those lines aren't compared here.",
    ]);
    expect(m.reasons.map((r) => r.text)).toEqual([
      "FleetSuite doesn't know where sales tax for Some County posts yet. It learns that from NetSuite's sales tax postings since "
      + 'January 2025, as of the last copy of the NetSuite lists.',
    ]);
  });

  it('goes by what NetSuite says about cost of goods and a card fee set at the top, when it was asked', () => {
    const items = [...ITEMS, { kind: 'item' as const, netsuite_id: '19', name: 'CARD FEE', item_type: 'Discount', income_account: '410', asset_account: null }];
    // INV106: a card fee of 3% set at the top. NetSuite's net amounts carry each line's share; it posts the fee on its own line.
    const fee = invoice('INV106', {
      total: '166.50',
      lines: [
        ...invoice('X').lines.map((l) => ({ ...l, netamount: l.line_id === '1' ? '-103.00' : l.line_id === '2' ? '-51.50' : l.netamount })),
        { line_id: '4', line_no: 4, kind: 'item', item_id: '19', item_number: 'CARD FEE', amount: '0.00', netamount: null },
      ],
      netsuite: [
        { line_id: '0', account: '120', debit: '166.50', credit: '0.00' },
        ...invoice('X').netsuite.slice(1),
        { line_id: '4', account: '410', debit: '0.00', credit: '4.50' },
      ],
    });
    // INV107 relieves its stock to an account the item doesn't name.
    const stock = invoice('INV107', {
      lines: [...invoice('X').lines, ...['5', '6'].map((id) => ({ line_id: id, line_no: Number(id), kind: 'item', item_id: '11', item_number: 'PART-A', amount: '0.00', netamount: null }))],
      netsuite: [...invoice('X').netsuite, { line_id: '5', account: '500', debit: '30.00', credit: '0.00' }, { line_id: '6', account: '135', debit: '0.00', credit: '30.00' }],
    });
    const said = (txn: string, lineId: string, amount: string, f: Partial<LineFacts> = {}): [string, LineFacts] =>
      [`${txn}:${lineId}`, { cogs: false, topDiscount: false, amount, ...f }];
    const facts = {
      lines: new Map([
        said('106', '1', '-100.00'), said('106', '2', '-50.00'), said('106', '3', '-12.00'), said('106', '4', '-4.50', { topDiscount: true }),
        said('107', '1', '-100.00'), said('107', '2', '-50.00'), said('107', '3', '-12.00'),
        said('107', '5', '30.00', { cogs: true }), said('107', '6', '-30.00', { cogs: true }),
      ]),
      missing: [],
    };
    const opts = { company: 'BMG', chart: CHART, taxAccounts: TAX };

    expect(checkMonth({ invoices: [fee, stock], items }, opts).invoices.map((i) => i.status)).toEqual(['differs', 'differs']);
    const m = checkMonth({ invoices: [fee, stock], items }, { ...opts, facts });
    expect(m.invoices.map((i) => [i.status, i.amounts])).toEqual([['matches', 'own'], ['matches', undefined]]);
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite?.account, r.fleetsuite?.cents])).toEqual([
      ['Receivable', '120', 16650], ['PART-A', '400', -10000], ['INSTALL LABOR', '400', -5000], ['Sales tax, Some County', '220', -1200], ['CARD FEE', '410', -450],
    ]);
    expect(m.invoices[1].rows.filter((r) => r.cost).map((r) => r.lineId)).toEqual(['5', '6']);
    expect(m.summary).toMatchObject({ invoices: 2, matches: 2, withCost: 1 });
  });

  it('takes a discount on a line under the ones it applies to at each line\'s own amount, and shows what NetSuite says', () => {
    const items = [...ITEMS, { kind: 'item' as const, netsuite_id: '14', name: 'DISCOUNT', item_type: 'Discount', income_account: '410', asset_account: null }];
    // 5% off the part and the labor, on a line under them: NetSuite's net amounts carry each line's share; it posts the discount on its own line.
    const discounted = (number: string) => invoice(number, {
      total: '154.50',
      lines: [
        ...invoice('X').lines.map((l) => ({ ...l, netamount: l.line_id === '1' ? '-95.00' : l.line_id === '2' ? '-47.50' : l.netamount })),
        { line_id: '4', line_no: 4, kind: 'item', item_id: '14', item_number: 'DISCOUNT', amount: '0.00', netamount: '0' },
      ],
      netsuite: [
        { line_id: '0', account: '120', debit: '154.50', credit: '0.00' },
        ...invoice('X').netsuite.slice(1),
        { line_id: '4', account: '410', debit: '7.50', credit: '0.00' },
      ],
    });
    const said = (txn: string, lineId: string, amount: string, f: Partial<LineFacts> = {}): [string, LineFacts] =>
      [`${txn}:${lineId}`, { cogs: false, topDiscount: false, amount, quantity: null, rate: null, ...f }];
    const facts = {
      lines: new Map([
        said('108', '1', '-100.00', { quantity: '-2', rate: '50.00' }), said('108', '2', '-50.00'), said('108', '3', '-12.00'), said('108', '4', '7.50'),
        // INV109's discount line gives no amount of its own, so its lines can't be taken at theirs.
        said('109', '1', '-100.00'), said('109', '2', '-50.00'), said('109', '3', '-12.00'),
      ]),
      missing: [],
    };
    const m = checkMonth({ invoices: [discounted('INV108'), discounted('INV109')], items }, { company: 'BMG', chart: CHART, taxAccounts: TAX, facts });

    expect(m.invoices.map((i) => [i.number, i.status, i.amounts])).toEqual([['INV108', 'matches', 'own'], ['INV109', 'differs', 'unfit']]);
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite?.cents, r.says?.net, r.says?.own])).toEqual([
      ['Receivable', 15450, undefined, undefined],
      ['PART-A', -10000, 9500, 10000],
      ['INSTALL LABOR', -5000, 4750, 5000],
      ['Sales tax, Some County', -1200, 1200, 1200],
      ['DISCOUNT', 750, 0, -750],
    ]);
    expect(m.invoices[0].rows[1].says).toEqual({ net: 9500, own: 10000, quantity: '-2', rate: '50.00', topDiscount: false, cogs: false });
    expect(m.invoices[1].rows.find((r) => r.lineId === '4')?.says).toBeUndefined();
    expect(m.notes).toEqual([
      "On 1 invoice NetSuite's own amounts for the lines don't add up to the invoice, so FleetSuite went by their net amounts: INV109. "
      + 'Open it to see what NetSuite says about each line.',
    ]);
  });

  it('posts a payment item with no income account where NetSuite posts it most, once the lists copy has read that', () => {
    const items = [
      ...ITEMS,
      { kind: 'item' as const, netsuite_id: '15', name: 'FREIGHT', item_type: 'OthCharge', income_account: '400', asset_account: null },
      { kind: 'item' as const, netsuite_id: '16', name: 'PREPAYMENT', item_type: 'Payment', income_account: null, asset_account: null },
    ];
    // A $50 prepayment under $20 of freight: NetSuite spreads it over the freight, whose net becomes a $30 credit,
    // and posts the payment on its own line, to the account it uses for that item.
    const paid = invoice('INV110', {
      total: '70.00',
      lines: [
        invoice('X').lines[0],
        { line_id: '2', line_no: 2, kind: 'item', item_id: '15', item_number: 'FREIGHT', amount: '-30.00', netamount: '30.00' },
        { line_id: '3', line_no: 3, kind: 'item', item_id: '16', item_number: 'PREPAYMENT', amount: '0.00', netamount: '0' },
      ],
      netsuite: [
        { line_id: '0', account: '120', debit: '70.00', credit: '0.00' },
        { line_id: '1', account: '400', debit: '0.00', credit: '100.00' },
        { line_id: '2', account: '400', debit: '0.00', credit: '20.00' },
        { line_id: '3', account: '110', debit: '50.00', credit: '0.00' },
      ],
    });
    const said = (lineId: string, amount: string): [string, LineFacts] => [`110:${lineId}`, { cogs: false, topDiscount: false, amount, quantity: null, rate: null }];
    const facts = { lines: new Map([said('1', '-100.00'), said('2', '-20.00'), said('3', '50.00')]), missing: [] };
    const month = { invoices: [paid], items };
    const opts = { company: 'BMG', chart: CHART, taxAccounts: TAX, facts };

    const learned = checkMonth(month, { ...opts, itemAccounts: [{ item_id: '16', account_id: '111', lines: 1 }, { item_id: '16', account_id: '110', lines: 3 }] });
    expect(learned.invoices[0]).toMatchObject({ status: 'matches', amounts: 'own' });
    expect(learned.invoices[0].rows.map((r) => [r.label, r.division, r.fleetsuite?.account, r.fleetsuite?.cents, r.cost])).toEqual([
      ['Receivable', null, '120', 7000, false],
      ['PART-A', 'upfit', '400', -10000, false],
      ['FREIGHT', null, '400', -2000, false],
      ['PREPAYMENT', null, '110', 5000, false],
    ]);

    for (const itemAccounts of [undefined, null, []]) {
      const before = checkMonth(month, { ...opts, itemAccounts });
      expect(before.invoices[0].status).toBe('unworkable');
      expect(before.invoices[0].reasons).toEqual([
        "PREPAYMENT has no income account in the copy of NetSuite's items, and FleetSuite doesn't know where NetSuite posts it yet. "
        + "It learns that from NetSuite's invoices since January 2025, as of the last copy of the NetSuite lists.",
      ]);
    }
  });

  it('says when NetSuite couldn\'t be asked about the lines, or wouldn\'t say everything', () => {
    const opts = { company: 'BMG', chart: CHART, taxAccounts: TAX };
    const month = { invoices: [invoice('INV101')], items: ITEMS };
    expect(checkMonth(month, { ...opts, facts: { error: 'NetSuite SuiteQL error (500): timed out' } }).notes).toEqual([
      "NetSuite couldn't be asked about these invoices' lines just now (NetSuite SuiteQL error (500): timed out), so cost of goods is "
      + "recognized by the accounts it went to, and a discount or markup spread over an invoice's lines isn't separated from them.",
    ]);
    expect(checkMonth(month, { ...opts, facts: { lines: new Map(), missing: ['cogs', 'amount'] } }).notes).toEqual([
      "NetSuite wouldn't say which lines are cost of goods and the lines' own amounts on these invoices, so cost of goods is recognized "
      + "by the accounts it went to and a discount or markup spread over an invoice's lines isn't separated from them.",
    ]);
    expect(checkMonth(month, { ...opts, facts: { lines: new Map(), missing: ['quantity', 'rate'] } }).notes).toEqual([
      "NetSuite wouldn't say the lines' quantities and the lines' rates on these invoices, so a line's quantity and rate aren't shown.",
    ]);
    expect(checkMonth(month, { ...opts, facts: { lines: new Map(), missing: [] } }).notes).toEqual([]);
  });

  it('can\'t work out a line whose amount the copy lost', () => {
    const lost = invoice('INV105', { lines: [{ line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '100.00', netamount: null }] });
    expect(checkMonth({ invoices: [lost], items: ITEMS }, { company: 'BMG', chart: CHART, taxAccounts: TAX }).invoices[0].reasons)
      .toEqual(["A line's amount couldn't be read from the copy of the invoice."]);
  });

  it('checks a month of credit memos, in their own words', () => {
    // NetSuite's signed amounts come back the other way round on a credit memo, and it credits receivables.
    const memo = (number: string, fields: Partial<InvoiceMonthData['invoices'][number]> = {}) => invoice(number, {
      doc_type: 'credit_memo',
      lines: invoice('X').lines.map((l) => ({ ...l, netamount: String(-Number(l.netamount)) })),
      netsuite: invoice('X').netsuite.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
      ...fields,
    });
    // The part's stock comes back on lines 4 and 5.
    const withCost = memo('CM102', {
      lines: [...memo('X').lines, ...['4', '5'].map((id) => ({ line_id: id, line_no: Number(id), kind: 'item', item_id: '11', item_number: 'PART-A', amount: '0.00', netamount: null }))],
      netsuite: [...memo('X').netsuite, { line_id: '4', account: '500', debit: '0.00', credit: '30.00' }, { line_id: '5', account: '130', debit: '30.00', credit: '0.00' }],
    });
    const lost = memo('CM103', { lines: [{ line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '100.00', netamount: null }] });
    const extra = memo('CM105', { netsuite: [...memo('X').netsuite, { line_id: '7', account: '400', debit: '1.00', credit: '0.00' }] });
    const m = checkMonth(
      { invoices: [memo('CM101'), withCost, lost, memo('CM104', { companies: [], netsuite: [] }), extra], items: ITEMS },
      { company: 'BMG', kind: 'credit_memo', chart: CHART, taxAccounts: TAX },
    );
    expect(m.summary).toEqual({ invoices: 4, matches: 2, differs: 1, unworkable: 1, waiting: 0, withCost: 1 });
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite?.cents, r.netsuite?.cents])).toEqual([
      ['Receivable', -16200, -16200],
      ['PART-A', 10000, 10000],
      ['INSTALL LABOR', 5000, 5000],
      ['Sales tax, Some County', 1200, 1200],
    ]);
    expect(m.reasons.map((r) => r.text)).toEqual([
      "A line's amount couldn't be read from the copy of the credit memo.",
      "NetSuite posts to 4000 Sales on a line the copy of the credit memo doesn't have.",
    ]);
    expect(m.notes).toEqual([
      '1 credit memo also books the cost of stock coming back, as NetSuite does when items are returned on a credit memo. '
      + "FleetSuite will post the cost of stock with its own rules, so those lines aren't compared here.",
      "1 more credit memo dated this month isn't in the copy of NetSuite's GL for either company: CM104. NetSuite may not have posted it, "
      + "or the copy, which runs every two hours, hasn't reached it yet.",
    ]);
  });
});

describe('centsOf', () => {
  it('reads signed amounts to whole cents, and nothing as zero', () => {
    expect([centsOf('-100'), centsOf('12.34'), centsOf(-0.29), centsOf(null), centsOf(''), centsOf('-0.00'), centsOf('abc')])
      .toEqual([-10000, 1234, -29, 0, 0, 0, null]);
  });
});
