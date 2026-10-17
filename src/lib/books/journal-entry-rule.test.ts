import { describe, it, expect } from 'vitest';
import {
  JOURNAL_ENTRY_RULE, JOURNAL_ENTRY_SOURCE_TYPE, JOURNAL_TYPE, journalEntryLines, lineMemo, type JournalLine,
} from './journal-entry-rule';

// Made-up books: '120' receivables, '200' payables, '220' the Chase card,
// '610' shop supplies, '640' fuel.
const TYPES = new Map([
  ['120', 'accounts_receivable'], ['200', 'accounts_payable'], ['220', 'credit_card'], ['610', 'expense'], ['640', 'expense'],
]);
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';

const line = (lineId: string, account: string, cents: number | null, fields: Partial<JournalLine> = {}): JournalLine => ({
  lineId, account, cents, memo: null, entityId: null, name: null, customerId: null, ...fields,
});
const entry = (lines: JournalLine[]) => journalEntryLines(lines, TYPES);
const posted = (r: ReturnType<typeof journalEntryLines>) => r.lines.map((l) => [l.lineId, l.account, l.cents, l.memo]);

describe('lineMemo', () => {
  it('puts the line\'s name in front of its memo', () => {
    expect(lineMemo('Shell Oil', 'Fuel for the box truck')).toBe('Shell Oil · Fuel for the box truck');
  });

  it('gives whichever it has, trimmed, the name once when the memo is only the name, and nothing when it has neither', () => {
    expect(lineMemo('Shell Oil', null)).toBe('Shell Oil');
    expect(lineMemo(null, ' Chase statement 09/2026 ')).toBe('Chase statement 09/2026');
    expect(lineMemo(' Shell Oil ', 'shell oil')).toBe('Shell Oil');
    expect(lineMemo('  ', '')).toBeNull();
    expect(lineMemo(null, null)).toBeNull();
  });
});

describe('journalEntryLines (journal_entry@1)', () => {
  it('names its rule with a version, and files its entries as journal entries', () => {
    expect(JOURNAL_ENTRY_RULE).toBe('journal_entry@1');
    expect(JOURNAL_ENTRY_SOURCE_TYPE).toBe('journal_entry');
    expect(JOURNAL_TYPE).toBe('Journal');
  });

  it('posts each line to the same account for the same amount, in NetSuite\'s order, its memo with its name in front', () => {
    // The bookkeeper's entry for a Chase statement: fuel and supplies charged to the card.
    const r = entry([
      line('1', '640', 4512, { memo: 'Fuel', entityId: '77', name: 'Shell Oil' }),
      line('2', '610', 12000, { memo: 'Gloves' }),
      line('3', '220', -16512, { memo: 'Chase statement 09/2026' }),
    ]);
    expect(r.problems).toEqual([]);
    expect(posted(r)).toEqual([
      ['1', '640', 4512, 'Shell Oil · Fuel'],
      ['2', '610', 12000, 'Gloves'],
      ['3', '220', -16512, 'Chase statement 09/2026'],
    ]);
    // Nobody to carry on an expense or a card line, whatever the name.
    expect(r.lines.map((l) => [l.customerId, l.vendorRef])).toEqual([[null, null], [null, null], [null, null]]);
  });

  it('carries the customer on a receivables line and the vendor on a payables line, and neither anywhere else', () => {
    const r = entry([
      // A customer's balance written off to supplies.
      line('1', '120', -5000, { entityId: '310', name: 'A Customer', customerId: CUSTOMER }),
      line('2', '610', 5000, { entityId: '310', name: 'A Customer', customerId: CUSTOMER }),
      // A vendor's balance paid on the card.
      line('3', '200', 2000, { entityId: '50', name: 'Sample Supply Co' }),
      line('4', '220', -2000, { entityId: '50', name: 'Sample Supply Co' }),
    ]);
    expect(r.lines.map((l) => [l.lineId, l.customerId, l.vendorRef])).toEqual([
      ['1', CUSTOMER, null], ['2', null, null], ['3', null, '50'], ['4', null, null],
    ]);
    // A receivables line whose name isn't a customer FleetSuite has matched carries none, and an account the chart
    // doesn't have carries nobody.
    expect(entry([line('1', '120', 100, { entityId: '311' }), line('2', '999', -100, { entityId: '50', customerId: CUSTOMER })]).lines
      .map((l) => [l.customerId, l.vendorRef])).toEqual([[null, null], [null, null]]);
    // A payables line with no name has no vendor.
    expect(entry([line('1', '200', 100), line('2', '220', -100)]).lines.map((l) => l.vendorRef)).toEqual([null, null]);
  });

  it('posts nothing for a line of $0, and nothing at all for an entry of $0', () => {
    expect(posted(entry([line('1', '640', 2500), line('2', '610', 0), line('3', '220', -2500)])).map((l) => l[0])).toEqual(['1', '3']);
    expect(entry([line('1', '640', 0), line('2', '220', 0)])).toEqual({ lines: [], problems: [] });
    expect(entry([])).toEqual({ lines: [], problems: [] });
  });

  it('posts nothing, and says why, when its lines don\'t balance or an amount can\'t be read', () => {
    // An intercompany entry's lines for one company.
    expect(entry([line('1', '640', 4512), line('2', '220', -4000)])).toEqual({ lines: [], problems: [{ kind: 'unbalanced' }] });
    expect(entry([line('1', '640', 4512)])).toEqual({ lines: [], problems: [{ kind: 'unbalanced' }] });
    expect(entry([line('1', '640', 4512), line('2', '220', null)])).toEqual({ lines: [], problems: [{ kind: 'unreadable' }] });
  });
});
