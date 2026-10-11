import { describe, it, expect } from 'vitest';
import {
  centsOf, checkInvoice, checkMonth, costLines, invoiceReasons, pickReceivable, problemReason, summarize,
  type ChartAccount, type CheckContext, type InvoiceMonthData, type NetSuitePosting, type ReasonNames,
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

  it('counts a line posted to its item\'s own income account as a sale, whatever kind of account that is', () => {
    const lines = [line('1', '18', 2000, { itemNumber: 'ODD PART' })];
    const posted = new Map([['1', ns('1', '500', -2000)]]);
    expect([...costLines(lines, posted, CTX)]).toEqual([]);
    expect(check(lines, [ns('0', '120', 2000), ns('1', '500', -2000)]).status).toBe('matches');
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
      { key: 'no_income|17', text: "NO ACCOUNT has no income account in the copy of NetSuite's items." },
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
    id: `id-${number}`, netsuite_id: number.replace(/\D/g, ''), number, date: '2026-09-15', total: '162.00', voided: false, customer: 'A Customer',
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

  it('can\'t work out a line whose amount the copy lost', () => {
    const lost = invoice('INV105', { lines: [{ line_id: '1', line_no: 1, kind: 'item', item_id: '11', item_number: 'PART-A', amount: '100.00', netamount: null }] });
    expect(checkMonth({ invoices: [lost], items: ITEMS }, { company: 'BMG', chart: CHART, taxAccounts: TAX }).invoices[0].reasons)
      .toEqual(["A line's amount couldn't be read from the copy of the invoice."]);
  });
});

describe('centsOf', () => {
  it('reads signed amounts to whole cents, and nothing as zero', () => {
    expect([centsOf('-100'), centsOf('12.34'), centsOf(-0.29), centsOf(null), centsOf(''), centsOf('-0.00'), centsOf('abc')])
      .toEqual([-10000, 1234, -29, 0, 0, 0, null]);
  });
});
