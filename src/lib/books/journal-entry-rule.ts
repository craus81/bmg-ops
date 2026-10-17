/**
 * How a NetSuite journal entry posts: journal_entry@1 (docs/books.md
 * "Journal entries").
 *
 * A journal entry (NetSuite's Journal) is lines typed straight into
 * NetSuite's books, such as the bookkeeper's entries for the Chase card
 * statements. There's nothing to work out: its lines for a company, to the
 * same accounts and for the same amounts, are that company's entry (owner
 * decision 2026-10-17, thread "Replacing NetSuite with FleetSuite": posted
 * from the copy of NetSuite's GL, migration 361, which already holds every
 * line). Each line keeps its memo with its name in front, as FleetSuite's
 * lines have no name of their own, and a receivables line carries its
 * customer and a payables line its vendor, as an invoice's receivable and a
 * bill's payables do.
 *
 * An entry posts whole or not at all, and the journal takes only an entry
 * that balances, so one whose lines for the company don't balance on their
 * own can't be worked out. A line of $0 posts nothing, and an entry of $0
 * posts nothing at all.
 *
 * Pure: it works out an entry, or says why it can't, and posts nothing.
 * Amounts are whole cents, debit positive.
 */

export const JOURNAL_ENTRY_RULE = 'journal_entry@1';

/** What a journal entry's entries are filed as (gl_entries.source_type, migration 393), keyed journal_entry:<NetSuite id>:<n>. */
export const JOURNAL_ENTRY_SOURCE_TYPE = 'journal_entry';

/** NetSuite's transaction type for a journal entry, as the copy of its GL keeps it. */
export const JOURNAL_TYPE = 'Journal';

/** One of a journal entry's lines for a company, as the copy of NetSuite's GL has it. */
export interface JournalLine {
  /** NetSuite's id for the line. */
  lineId: string;
  /** NetSuite's id for the account. */
  account: string;
  /** Debit positive; null when the copy's amounts can't be read. */
  cents: number | null;
  memo: string | null;
  /** NetSuite's id for the line's name: a customer, a vendor, an employee or another name. */
  entityId: string | null;
  /** The name in words, when FleetSuite has a copy of it. */
  name: string | null;
  /** The FleetSuite customer the name is, when it's a customer FleetSuite has matched. */
  customerId: string | null;
}

export interface JournalRuleLine {
  lineId: string;
  account: string;
  /** Debit positive, never 0. */
  cents: number;
  /** NetSuite's memo with the line's name in front ('Shell Oil · Fuel'); null when it has neither. */
  memo: string | null;
  /** The customer, on a receivables line. */
  customerId: string | null;
  /** NetSuite's id for the vendor, on a payables line. */
  vendorRef: string | null;
}

export type JournalProblem = { kind: 'unreadable' } | { kind: 'unbalanced' };

export interface JournalRuleResult {
  /** Empty whenever there's a problem: an entry posts whole or not at all. */
  lines: JournalRuleLine[];
  problems: JournalProblem[];
}

/** A line's memo with its name in front, the name once when the memo is only the name; null when it has neither. */
export function lineMemo(name: string | null, memo: string | null): string | null {
  const n = name?.trim() || '';
  const m = memo?.trim() || '';
  if (n && m && n.toLowerCase() !== m.toLowerCase()) return `${n} · ${m}`;
  return n || m || null;
}

/**
 * One journal entry's entry for a company, from its lines for the company in
 * NetSuite's order. `accountTypes` gives each NetSuite account's type in
 * FleetSuite's chart, which says which lines are receivables and payables.
 */
export function journalEntryLines(lines: JournalLine[], accountTypes: Map<string, string>): JournalRuleResult {
  if (lines.some((l) => l.cents === null)) return { lines: [], problems: [{ kind: 'unreadable' }] };
  const entry = lines.filter((l) => l.cents !== 0).map((l): JournalRuleLine => {
    const type = accountTypes.get(l.account);
    return {
      lineId: l.lineId,
      account: l.account,
      cents: l.cents!,
      memo: lineMemo(l.name, l.memo),
      customerId: type === 'accounts_receivable' ? l.customerId : null,
      vendorRef: type === 'accounts_payable' ? l.entityId : null,
    };
  });
  if (entry.reduce((n, l) => n + l.cents, 0) !== 0) return { lines: [], problems: [{ kind: 'unbalanced' }] };
  return { lines: entry, problems: [] };
}
