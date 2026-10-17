import { describe, it, expect } from 'vitest';
import type { ChartAccount, InvoiceBooks } from './invoice-check';
import type { JournalLine } from './journal-entry-rule';
import {
  checkJournalEntry, checkJournalMonth, journalProblemReason, workOutJournalMonth, type JournalMonthData, type WorkedJournalEntry,
} from './journal-entry-check';

// Made-up books: '120' receivables, '200' payables, '220' the Chase card,
// '610' shop supplies, '640' fuel.
const NAMES: Record<string, [string, string]> = {
  '120': ['1200 Receivables', 'accounts_receivable'], '200': ['2000 Payables', 'accounts_payable'], '220': ['2200 Chase Card', 'credit_card'],
  '610': ['6100 Shop Supplies', 'expense'], '640': ['6400 Fuel', 'expense'],
};
const TYPES = new Map(Object.entries(NAMES).map(([id, [, type]]) => [id, type]));
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: null, active: true, is_summary: false,
}));
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';

const line = (lineId: string, account: string, cents: number | null, fields: Partial<JournalLine> = {}): JournalLine => ({
  lineId, account, cents, memo: null, entityId: null, name: null, customerId: null, ...fields,
});
const rows = (c: ReturnType<typeof checkJournalEntry>) =>
  c.rows.map((r) => [r.lineId, r.label, r.fleetsuite && [r.fleetsuite.account, r.fleetsuite.cents], r.netsuite && [r.netsuite.account, r.netsuite.cents], r.same]);

describe('checkJournalEntry', () => {
  it('matches NetSuite line for line, each line labelled by its memo with its name in front', () => {
    const c = checkJournalEntry([
      line('1', '640', 4512, { memo: 'Fuel', name: 'Shell Oil' }),
      line('2', '610', 12000, { memo: 'Gloves' }),
      line('3', '220', -16512),
    ], TYPES);
    expect(c.status).toBe('matches');
    expect(c.problems).toEqual([]);
    expect(rows(c)).toEqual([
      ['1', 'Shell Oil · Fuel', ['640', 4512], ['640', 4512], true],
      ['2', 'Gloves', ['610', 12000], ['610', 12000], true],
      // A line with neither memo nor name goes by where it is in the entry.
      ['3', 'Line 3', ['220', -16512], ['220', -16512], true],
    ]);
    expect(c.rows.map((r) => [r.division, r.cost])).toEqual([[null, false], [null, false], [null, false]]);
    expect(c.lines.map((l) => [l.lineId, l.account, l.cents])).toEqual([['1', '640', 4512], ['2', '610', 12000], ['3', '220', -16512]]);
  });

  it('leaves out a line of $0, and matches an entry of $0 with nothing on either side', () => {
    const c = checkJournalEntry([line('1', '640', 2500), line('2', '610', 0), line('3', '220', -2500)], TYPES);
    expect(rows(c).map((r) => [r[0], r[1]])).toEqual([['1', 'Line 1'], ['3', 'Line 3']]);
    expect(checkJournalEntry([line('1', '640', 0), line('2', '220', 0)], TYPES)).toEqual({ status: 'matches', problems: [], rows: [], lines: [] });
  });

  it('can\'t work out one whose lines don\'t balance, and still shows what NetSuite posted', () => {
    const c = checkJournalEntry([line('1', '640', 4512, { memo: 'Fuel' }), line('2', '220', -4000)], TYPES);
    expect(c.status).toBe('unworkable');
    expect(c.problems).toEqual([{ kind: 'unbalanced' }]);
    expect(c.lines).toEqual([]);
    expect(rows(c)).toEqual([['1', 'Fuel', null, ['640', 4512], false], ['2', 'Line 2', null, ['220', -4000], false]]);
    // An amount the copy can't read.
    const unread = checkJournalEntry([line('1', '640', 4512), line('2', '220', null)], TYPES);
    expect(unread).toMatchObject({ status: 'unworkable', problems: [{ kind: 'unreadable' }], lines: [] });
    expect(rows(unread)).toEqual([['1', 'Line 1', null, ['640', 4512], false], ['2', 'Line 2', null, null, false]]);
  });
});

describe('journalProblemReason', () => {
  it('says why in words', () => {
    expect(journalProblemReason({ kind: 'unbalanced' })).toEqual({
      key: 'unbalanced', text: "Its lines for this company don't balance on their own, so FleetSuite's books can't take them as one entry.",
    });
    expect(journalProblemReason({ kind: 'unreadable' })).toEqual({
      key: 'unreadable', text: "A line's amount couldn't be read from the copy of NetSuite's GL.",
    });
  });
});

// ── A month ────────────────────────────────────────────────────────────────

type MonthEntry = JournalMonthData['journal_entries'][number];
type MonthLine = MonthEntry['lines'][number];
const gl = (lineId: string, account: string, cents: number, fields: Partial<MonthLine> = {}): MonthLine => ({
  line_id: lineId, account, debit: cents > 0 ? (cents / 100).toFixed(2) : '0.00', credit: cents < 0 ? (-cents / 100).toFixed(2) : '0.00',
  memo: null, entity_id: null, name: null, customer_id: null, ...fields,
});
const monthEntry = (fields: Partial<MonthEntry>): MonthEntry => ({
  netsuite_id: '9001', number: 'JE1201', date: '2026-09-30', posting_month: '2026-09-01', companies: ['BMG'],
  // The bookkeeper's entry for September's Chase statement.
  lines: [
    gl('1', '640', 4512, { memo: 'Fuel', entity_id: '77', name: 'Shell Oil' }),
    gl('2', '610', 12000, { memo: 'Gloves' }),
    gl('3', '220', -16512, { memo: 'Chase statement 09/2026' }),
  ],
  ...fields,
});
const MONTH: JournalMonthData = {
  journal_entries: [
    monthEntry({}),
    // A customer's small balance written off, with no number: the list goes by its first name.
    monthEntry({
      netsuite_id: '9002', number: null, date: '2026-09-12',
      lines: [
        gl('1', '120', -2500, { entity_id: '310', name: 'A Customer', customer_id: CUSTOMER }),
        gl('2', '610', 2500, { entity_id: '310', name: 'A Customer' }),
      ],
    }),
    // Dated in August, booked by NetSuite into September, with lines for 1084 too.
    monthEntry({
      netsuite_id: '9003', number: 'JE1188', date: '2026-08-31', companies: ['1084', 'BMG'],
      lines: [gl('1', '200', 5000, { entity_id: '50', name: 'Sample Supply Co', memo: 'Paid on the card' }), gl('2', '220', -5000)],
    }),
  ],
};

describe('workOutJournalMonth', () => {
  it('takes each line\'s amount as its debit less its credit, and names each entry by its number, else NetSuite\'s id', () => {
    const { journalEntries, account } = workOutJournalMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(journalEntries.map((w) => [w.number, w.checked.status, w.checked.lines.map((l) => l.cents)])).toEqual([
      ['JE1201', 'matches', [4512, 12000, -16512]],
      ['NetSuite 9002', 'matches', [-2500, 2500]],
      ['JE1188', 'matches', [5000, -5000]],
    ]);
    // The customer stays on the receivables line only, and the vendor goes on the payables line.
    expect(journalEntries[1].checked.lines.map((l) => [l.customerId, l.memo])).toEqual([[CUSTOMER, 'A Customer'], [null, 'A Customer']]);
    expect(journalEntries[2].checked.lines.map((l) => [l.vendorRef, l.memo])).toEqual([['50', 'Sample Supply Co · Paid on the card'], [null, null]]);
    expect(account('640')).toBe('6400 Fuel');
    expect(account('999')).toBe('NetSuite account 999');
  });

  it('can\'t work out a line whose amounts can\'t be read', () => {
    const { journalEntries } = workOutJournalMonth({ journal_entries: [monthEntry({ lines: [gl('1', '640', 100), { ...gl('2', '220', -100), credit: 'n/a' }] })] }, {
      company: 'BMG', chart: CHART,
    });
    expect(journalEntries[0].checked).toMatchObject({ status: 'unworkable', problems: [{ kind: 'unreadable' }] });
  });
});

describe('checkJournalMonth', () => {
  it('checks every journal entry of the company\'s booked into the month, with its lines, and says which are dated elsewhere or shared', () => {
    const m = checkJournalMonth(MONTH, { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 3, matches: 3, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices.map((d) => [d.netsuiteId, d.number, d.date, d.customer, d.total, d.voided, d.status, d.reasons])).toEqual([
      // Its first memo stands in for a customer, and its total is its debits.
      ['9001', 'JE1201', '2026-09-30', 'Fuel', 16512, false, 'matches', []],
      ['9002', 'NetSuite 9002', '2026-09-12', 'A Customer', 2500, false, 'matches', []],
      ['9003', 'JE1188', '2026-08-31', 'Paid on the card', 5000, false, 'matches', []],
    ]);
    expect(m.invoices[0].rows.map((r) => [r.label, r.fleetsuite?.account, r.same])).toEqual([
      ['Shell Oil · Fuel', '640', true], ['Gloves', '610', true], ['Chase statement 09/2026', '220', true],
    ]);
    expect(m.invoices.map((d) => d.booked)).toEqual([undefined, undefined, { month: '2026-09-01', date: '2026-09-01' }]);
    expect(m.invoices.map((d) => d.books)).toEqual([undefined, undefined, undefined]);
    expect([m.summary.posted, m.summary.pending]).toEqual([undefined, undefined]);
    expect(m.reasons).toEqual([]);
    expect(m.accounts).toEqual({ 120: '1200 Receivables', 200: '2000 Payables', 220: '2200 Chase Card', 610: '6100 Shop Supplies', 640: '6400 Fuel' });
    expect(m.notes).toEqual([
      '1 journal entry dated in another month is here because NetSuite booked it into this month: JE1188.',
      "1 journal entry also has lines for the other company. Only this company's lines are shown here and make up its entry: JE1188.",
    ]);
  });

  it('counts the ones that can\'t be worked out by reason, with a few of them as examples', () => {
    const unbalanced = (n: number) => monthEntry({ netsuite_id: `91${n}`, number: `JE13${n}`, lines: [gl('1', '640', 100 + n), gl('2', '220', -100)] });
    const m = checkJournalMonth({
      journal_entries: [
        ...[1, 2, 3, 4, 5, 6].map(unbalanced),
        monthEntry({ netsuite_id: '9200', number: 'JE1400', lines: [gl('1', '640', 100), { ...gl('2', '220', -100), debit: 'n/a' }] }),
        monthEntry({}),
      ],
    }, { company: 'BMG', chart: CHART });
    expect(m.summary).toMatchObject({ invoices: 8, matches: 1, unworkable: 7 });
    expect(m.reasons).toEqual([
      {
        key: 'unbalanced', text: "Its lines for this company don't balance on their own, so FleetSuite's books can't take them as one entry.",
        invoices: 6, examples: ['JE131', 'JE132', 'JE133', 'JE134', 'JE135'],
      },
      { key: 'unreadable', text: "A line's amount couldn't be read from the copy of NetSuite's GL.", invoices: 1, examples: ['JE1400'] },
    ]);
    expect(m.invoices[0].reasons).toEqual(["Its lines for this company don't balance on their own, so FleetSuite's books can't take them as one entry."]);
    // One with neither a memo nor a name has nothing in a customer's place.
    expect(m.invoices[0].customer).toBeNull();
  });

  it('says what FleetSuite\'s books hold for each and what the next run does, when the company\'s journal entries post', () => {
    const asked: string[] = [];
    const books = (w: WorkedJournalEntry): InvoiceBooks => {
      asked.push(w.number);
      if (w.number === 'JE1201') return { entryNo: 41, next: null, earlier: [{ entryNo: 33, reversedBy: 40 }] };
      if (w.number === 'JE1188') return { entryNo: null, next: null, earlier: [], nothingToPost: 'zero' };
      return { entryNo: null, next: 'post', earlier: [] };
    };
    const m = checkJournalMonth(MONTH, { company: 'BMG', chart: CHART }, books);
    expect(asked).toEqual(['JE1201', 'NetSuite 9002', 'JE1188']);
    expect(m.invoices.map((d) => [d.number, d.books?.entryNo, d.books?.next])).toEqual([
      ['JE1201', 41, null], ['NetSuite 9002', null, 'post'], ['JE1188', null, null],
    ]);
    expect(m.invoices[0].books?.earlier).toEqual([{ entryNo: 33, reversedBy: 40 }]);
    expect(m.summary).toMatchObject({ posted: 1, pending: 1, nothingToPost: { voided: 0, zero: 1 } });
  });

  it('names several in one note each, and checks a month with none', () => {
    const m = checkJournalMonth({
      journal_entries: [
        monthEntry({ netsuite_id: '9004', number: 'JE1190', date: '2026-08-30', companies: ['1084', 'BMG'] }),
        monthEntry({ netsuite_id: '9005', number: 'JE1191', date: '2026-10-02', companies: ['1084', 'BMG'] }),
      ],
    }, { company: 'BMG', chart: CHART });
    // One dated after the month it's booked into goes on the month's last day.
    expect(m.invoices.map((d) => d.booked)).toEqual([{ month: '2026-09-01', date: '2026-09-01' }, { month: '2026-09-01', date: '2026-09-30' }]);
    expect(m.notes).toEqual([
      '2 journal entries dated in other months are here because NetSuite booked them into this month: JE1190, JE1191.',
      "2 journal entries also have lines for the other company. Only this company's lines are shown here and make up their entry: JE1190, JE1191.",
    ]);
    expect(checkJournalMonth({ journal_entries: [] }, { company: 'BMG', chart: CHART })).toEqual({
      summary: { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 }, reasons: [], notes: [], invoices: [], accounts: {},
    });
  });
});
