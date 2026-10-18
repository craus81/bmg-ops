import {
  booksCounts, centsOf, entryDate,
  type ChartAccount, type CheckStatus, type InvoiceBooks, type InvoiceRowView, type InvoiceView, type MonthCheck, type MonthReason,
  type MonthSummary, type Reason,
} from './invoice-check';
import { journalEntryLines, lineMemo, type JournalLine, type JournalProblem, type JournalRuleLine } from './journal-entry-rule';

/**
 * Each NetSuite journal entry of a month as FleetSuite posts it
 * (docs/books.md "Journal entries"): its lines for the company from the
 * copy of NetSuite's GL (migration 361), each next to the line of the entry
 * the journal entry rule makes of it, for the invoices page's Journal
 * entries switch and the posting job (src/lib/books/invoice-posting.ts).
 * With nothing to work out, an entry whose lines balance matches NetSuite
 * line for line; one whose lines don't balance can't be posted. Pure;
 * amounts are whole cents, debit positive.
 *
 * Bank deposits, transfers and customer refunds post line for line the same
 * way (src/lib/books/bank-check.ts), so the month's work here takes any
 * document posted from the GL copy.
 */

/**
 * One NetSuite document posted line for line from the copy of its GL, as
 * gl_journal_month (migration 393) and gl_bank_month (migration 394) give it.
 */
export interface LedgerCopyDocument {
  netsuite_id: string;
  number: string | null;
  date: string;
  /** The month NetSuite booked it into, 'YYYY-MM-01'. */
  posting_month: string;
  /** Every company the copy of NetSuite's GL has lines of it for. */
  companies: string[];
  /** Its lines for the company, in NetSuite's order. */
  lines: Array<{
    line_id: string;
    account: string;
    debit: string;
    credit: string;
    memo: string | null;
    /** NetSuite's id for the line's name. */
    entity_id: string | null;
    /** The name in words: the vendors copy's, else the ledger mirror's for a customer. */
    name: string | null;
    /** The FleetSuite customer the ledger mirror matched the name to. */
    customer_id: string | null;
  }>;
}

/** What gl_journal_month (migration 393) returns: one company's journal entries NetSuite booked into a month. */
export interface JournalMonthData {
  journal_entries: LedgerCopyDocument[];
}

export interface CheckedJournalEntry {
  /** 'matches' when its lines balance, 'unworkable' when they don't. */
  status: CheckStatus;
  problems: JournalProblem[];
  /** Its lines that aren't $0, in NetSuite's order, each with the line FleetSuite's entry has for it. */
  rows: InvoiceRowView[];
  /** FleetSuite's entry line by line, as it posts; empty when it can't be worked out. */
  lines: JournalRuleLine[];
}

/** One document of the month posted from the GL copy, worked out line for line with the journal entry rule. */
export interface WorkedLedgerCopy<D extends LedgerCopyDocument = LedgerCopyDocument> {
  entry: D;
  number: string;
  checked: CheckedJournalEntry;
}

/** One journal entry of the month, worked out with the journal entry rule. */
export type WorkedJournalEntry = WorkedLedgerCopy;

/** One journal entry, checked: FleetSuite's line for each of NetSuite's. */
export function checkJournalEntry(lines: JournalLine[], accountTypes: Map<string, string>): CheckedJournalEntry {
  const entry = journalEntryLines(lines, accountTypes);
  const ours = new Map(entry.lines.map((l) => [l.lineId, l]));
  const rows = lines.flatMap((l, i): InvoiceRowView[] => {
    if (l.cents === 0) return [];
    const netsuite = l.cents === null ? null : { account: l.account, cents: l.cents };
    const f = ours.get(l.lineId);
    const fleetsuite = f ? { account: f.account, cents: f.cents } : null;
    return [{
      lineId: l.lineId,
      label: lineMemo(l.name, l.memo) ?? `Line ${i + 1}`,
      division: null,
      fleetsuite,
      netsuite,
      cost: false,
      same: !!fleetsuite && !!netsuite && fleetsuite.account === netsuite.account && fleetsuite.cents === netsuite.cents,
    }];
  });
  return { status: entry.problems.length ? 'unworkable' : 'matches', problems: entry.problems, rows, lines: entry.lines };
}

export function journalProblemReason(p: JournalProblem): Reason {
  return p.kind === 'unbalanced'
    ? { key: 'unbalanced', text: "Its lines for this company don't balance on their own, so FleetSuite's books can't take them as one entry." }
    : { key: 'unreadable', text: "A line's amount couldn't be read from the copy of NetSuite's GL." };
}

/** Every journal entry of the month worked out with the journal entry rule: what checkJournalMonth shows and the posting job posts. */
export function workOutJournalMonth(
  data: JournalMonthData,
  opts: { company: string; chart: ChartAccount[] },
): { journalEntries: WorkedJournalEntry[]; account: (id: string) => string } {
  const { worked, account } = workOutLedgerCopies(data.journal_entries ?? [], opts.chart);
  return { journalEntries: worked, account };
}

/** Documents posted from the GL copy, each worked out line for line with the journal entry rule, and how the chart names an account. */
export function workOutLedgerCopies<D extends LedgerCopyDocument>(
  documents: D[],
  chart: ChartAccount[],
): { worked: WorkedLedgerCopy<D>[]; account: (id: string) => string } {
  const accountTypes = new Map<string, string>();
  const accountNames = new Map<string, string>();
  for (const a of chart) {
    if (!a.netsuite_account_id) continue;
    accountTypes.set(a.netsuite_account_id, a.account_type);
    accountNames.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
  }
  const account = (id: string) => accountNames.get(id) ?? `NetSuite account ${id}`;

  const worked = documents.map((e): WorkedLedgerCopy<D> => {
    const lines = (e.lines ?? []).map((l): JournalLine => {
      const debit = centsOf(l.debit);
      const credit = centsOf(l.credit);
      return {
        lineId: l.line_id,
        account: l.account,
        cents: debit === null || credit === null ? null : debit - credit,
        memo: l.memo,
        entityId: l.entity_id,
        name: l.name,
        customerId: l.customer_id,
      };
    });
    return { entry: e, number: e.number || `NetSuite ${e.netsuite_id}`, checked: checkJournalEntry(lines, accountTypes) };
  });
  return { worked, account };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const listed = (numbers: string[]) => `${numbers.slice(0, 10).join(', ')}${numbers.length > 10 ? ', …' : ''}`;

/** The first memo of a document's lines, or else the first name: what the list shows of a document with no customer. */
export const firstMemo = (d: LedgerCopyDocument): string | null =>
  d.lines.find((l) => l.memo?.trim())?.memo?.trim() ?? d.lines.find((l) => l.name?.trim())?.name?.trim() ?? null;

/**
 * One company's journal entries for one month, each with its lines next to
 * FleetSuite's. `books`, when the company's journal entries post, says what
 * FleetSuite's books hold for each.
 */
export function checkJournalMonth(
  data: JournalMonthData,
  opts: { company: string; chart: ChartAccount[] },
  books?: (worked: WorkedJournalEntry) => InvoiceBooks,
): MonthCheck {
  const { worked, account } = workOutLedgerCopies(data.journal_entries ?? [], opts.chart);
  // A journal entry has no customer: the list shows its first memo, or its first name.
  const words = { one: 'journal entry', many: 'journal entries' };
  return checkLedgerCopyMonth(worked, account, { company: opts.company, words, describe: firstMemo }, books);
}

/**
 * One company's documents posted from the GL copy for one month, each with
 * its lines next to FleetSuite's: `words` name them in the month's notes and
 * `describe` gives what the list shows in place of a customer.
 */
export function checkLedgerCopyMonth<D extends LedgerCopyDocument>(
  worked: WorkedLedgerCopy<D>[],
  account: (id: string) => string,
  opts: { company: string; words: { one: string; many: string }; describe: (d: D) => string | null },
  books?: (worked: WorkedLedgerCopy<D>) => InvoiceBooks,
): MonthCheck {
  const summary: MonthSummary = { invoices: 0, matches: 0, differs: 0, unworkable: 0, waiting: 0, withCost: 0 };
  const reasons = new Map<string, MonthReason>();
  const views: InvoiceView[] = [];
  const notes: string[] = [];
  const moved: string[] = [];
  const shared: string[] = [];
  const used = new Set<string>();
  for (const w of worked) {
    const { entry: e, number, checked } = w;
    const why = checked.problems.map(journalProblemReason);
    summary.invoices += 1;
    summary[checked.status] += 1;
    for (const r of why) {
      const m = reasons.get(r.key) ?? { ...r, invoices: 0, examples: [] };
      m.invoices += 1;
      if (m.examples.length < 5) m.examples.push(number);
      reasons.set(r.key, m);
    }
    for (const r of checked.rows) {
      if (r.fleetsuite) used.add(r.fleetsuite.account);
      if (r.netsuite) used.add(r.netsuite.account);
    }

    const bookedInto = e.posting_month && e.posting_month.slice(0, 7) !== e.date.slice(0, 7) ? e.posting_month : null;
    if (bookedInto) moved.push(number);
    if (e.companies.some((c) => c !== opts.company)) shared.push(number);
    views.push({
      netsuiteId: e.netsuite_id,
      number,
      date: e.date,
      ...(bookedInto ? { booked: { month: bookedInto, date: entryDate(e) } } : {}),
      customer: opts.describe(e),
      total: checked.rows.reduce((n, r) => n + Math.max(0, r.netsuite?.cents ?? 0), 0),
      voided: false,
      status: checked.status,
      reasons: why.map((r) => r.text),
      rows: checked.rows,
      ...(books ? { books: books(w) } : {}),
    });
  }

  if (books) Object.assign(summary, booksCounts(views));

  const { words } = opts;
  if (moved.length) {
    const them = moved.length === 1 ? 'it' : 'them';
    notes.push(`${plural(moved.length, `${words.one} dated in another month is`, `${words.many} dated in other months are`)} `
      + `here because NetSuite booked ${them} into this month: ${listed(moved)}.`);
  }
  if (shared.length) {
    const one = shared.length === 1;
    notes.push(`${plural(shared.length, `${words.one} also has`, `${words.many} also have`)} lines for the other company. `
      + `Only this company's lines are shown here and make up ${one ? 'its' : 'their'} entry: ${listed(shared)}.`);
  }

  return {
    summary,
    reasons: [...reasons.values()].sort((a, b) => b.invoices - a.invoices || a.text.localeCompare(b.text)),
    notes,
    invoices: views,
    accounts: Object.fromEntries([...used].sort().map((id) => [id, account(id)])),
  };
}
