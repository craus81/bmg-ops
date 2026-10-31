/**
 * Journal entries typed in FleetSuite, approved, and sent on to NetSuite
 * (Books part 37, docs/books.md "Journal entries typed in FleetSuite"; owner
 * decisions 2026-10-31, thread "Replacing NetSuite with FleetSuite": from
 * January 1, 2027 the team works only in FleetSuite, apart from payments,
 * deposits and banking).
 *
 * The entries the bookkeeper types straight into NetSuite's books today
 * (accruals, reclasses, depreciation and the like) are typed here instead,
 * line by line: each line an account and a debit or a credit. Someone asks
 * for approval, a super admin who didn't ask approves it, and FleetSuite
 * makes it in NetSuite once, exactly as typed, and keeps Books' own copy.
 * A line to Accounts Receivable or Accounts Payable isn't taken: NetSuite
 * needs a customer or vendor on those, which invoices, credit memos, bills
 * and vendor credits carry.
 *
 * The rules here are pure; /api/journal-entries and the Journal entries page
 * both use them, the page to show what asking for approval would find and
 * the route to check and make the entry from its lines as they're kept.
 */

import { formatCents } from '@/lib/credit-memo';

/** How a typed entry becomes a journal entry: its lines as typed, each to the cent. */
export const TYPED_JOURNAL_RULE = 'typed_journal_entry@1';

/** The most lines one entry takes. */
export const MAX_LINES = 200;

export const MEMO_MAX = 300;

/** The longest reason for sending an entry back. */
export const REASON_MAX = 500;

/** The most one line can be: $100,000,000.00. */
export const MAX_LINE_CENTS = 10_000_000_000;

/** Kinds of account NetSuite needs a customer or vendor on, which a typed line doesn't carry. */
export const NEEDS_A_NAME: readonly string[] = ['accounts_receivable', 'accounts_payable'];

/** The kinds of account a typed line can go to: all but those, and NetSuite's own unbilled receivables. */
export const JOURNAL_LINE_ACCOUNT_TYPES: readonly string[] = [
  'bank', 'other_current_asset', 'fixed_asset', 'other_asset', 'deferred_expense',
  'credit_card', 'other_current_liability', 'long_term_liability', 'deferred_revenue', 'equity',
  'income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense',
];

export { formatCents };

/**
 * Where an entry is: being typed (or sent back to be fixed), asked for
 * approval, approved and being made in NetSuite, or made.
 */
export type TypedStatus = 'draft' | 'waiting' | 'sending' | 'made';

export interface JournalCompany {
  code: string;
  name: string;
  subsidiaryId: string | null;
}

export interface JournalAccount {
  id: string;
  number: string | null;
  name: string;
  type: string;
  /** The companies a typed line can use it for. */
  companies: string[];
}

export interface TypedLine {
  accountId: string | null;
  debitCents: number;
  creditCents: number;
  memo: string | null;
}

export interface TypedEntry {
  /** YYYY-MM-DD. */
  date: string;
  memo: string | null;
  lines: TypedLine[];
}

export interface TypedEntryFacts {
  company: JournalCompany | undefined;
  /** The chart's accounts by NetSuite's id, each with the companies a typed line can use it for. */
  accounts: Map<string, JournalAccount>;
}

export interface WorkedTypedLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string | null;
}

export interface WorkedTypedEntry {
  date: string;
  memo: string;
  /** Its lines, in the order typed, once each is whole. */
  lines: WorkedTypedLine[];
  /** What its lines' debits and credits come to, as typed. */
  debitCents: number;
  creditCents: number;
  problems: string[];
}

/** How a typed line is kept (typed_journal_entries.lines, migration 469). */
export interface KeptLine {
  account_netsuite_id: string | null;
  debit_cents: number | string;
  credit_cents: number | string;
  memo: string | null;
}

export const accountName = (a: Pick<JournalAccount, 'number' | 'name'>) => [a.number, a.name].filter(Boolean).join(' ');

/** A real day, written YYYY-MM-DD: not February 30, which Date would make March 2. */
export function isDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Works out the journal entry an entry's lines make, or says why it can't be
 * made: the company needs a NetSuite subsidiary; it needs a date, a memo
 * saying what it's for, and two lines or more; each line an account the
 * company can use and a debit or a credit above $0, to the cent; and its
 * debits must match its credits.
 */
export function workOutTypedEntry(e: TypedEntry, f: TypedEntryFacts): WorkedTypedEntry {
  const problems: string[] = [];
  const company = f.company;
  if (!company) problems.push('Pick the company.');
  else if (!company.subsidiaryId) problems.push(`${company.name} has no NetSuite subsidiary in Books, so NetSuite can't take its journal entries.`);
  if (!isDay(e.date)) problems.push('Pick the date.');
  const memo = (e.memo ?? '').trim();
  if (!memo) problems.push('Say what the entry is for in its memo.');
  else if (memo.length > MEMO_MAX) problems.push(`The memo takes ${MEMO_MAX} characters at most.`);
  if (e.lines.length < 2) problems.push('A journal entry needs two lines or more.');
  else if (e.lines.length > MAX_LINES) problems.push(`One journal entry takes ${MAX_LINES} lines at most, not ${e.lines.length}.`);

  const lines: WorkedTypedLine[] = [];
  let debitCents = 0;
  let creditCents = 0;
  e.lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    const amounts = [l.debitCents, l.creditCents];
    if (!amounts.every(Number.isSafeInteger)) { problems.push(`${n}'s amount isn't to the cent.`); return; }
    if (amounts.some((c) => c < 0)) { problems.push(`${n}'s amount can't be below $0.`); return; }
    if (amounts.some((c) => c > MAX_LINE_CENTS)) { problems.push(`${n}'s amount is more than ${formatCents(MAX_LINE_CENTS)}.`); return; }
    debitCents += l.debitCents;
    creditCents += l.creditCents;
    if ((l.debitCents > 0) === (l.creditCents > 0)) { problems.push(`${n} needs a debit or a credit, not both.`); return; }
    if (!l.accountId) { problems.push(`${n} has no account.`); return; }
    const account = f.accounts.get(l.accountId);
    if (account && NEEDS_A_NAME.includes(account.type)) {
      problems.push(`${n} goes to ${accountName(account)}, and NetSuite needs a customer or vendor there: make it an invoice, credit memo, bill or vendor credit instead.`);
      return;
    }
    if (!account || !company || !account.companies.includes(company.code)) {
      problems.push(`${n} goes to an account ${company ? `${company.name} can't use` : "FleetSuite can't use"}.`);
      return;
    }
    const lineMemo = (l.memo ?? '').trim();
    if (lineMemo.length > MEMO_MAX) { problems.push(`${n}'s memo takes ${MEMO_MAX} characters at most.`); return; }
    lines.push({ accountId: l.accountId, debitCents: l.debitCents, creditCents: l.creditCents, memo: lineMemo || null });
  });
  if (debitCents !== creditCents) {
    problems.push(`Its debits (${formatCents(debitCents)}) and credits (${formatCents(creditCents)}) don't match: they're ${formatCents(Math.abs(debitCents - creditCents))} apart.`);
  }
  return { date: e.date, memo, lines, debitCents, creditCents, problems };
}

/** An entry's lines as the page and the route read them back from how they're kept. */
export const keptLines = (lines: KeptLine[] | null | undefined): TypedLine[] => (Array.isArray(lines) ? lines : []).map((l) => ({
  accountId: l.account_netsuite_id || null,
  debitCents: Number(l.debit_cents),
  creditCents: Number(l.credit_cents),
  memo: l.memo || null,
}));

/** An entry's lines as they're kept. */
export const linesToKeep = (lines: TypedLine[]): KeptLine[] => lines.map((l) => ({
  account_netsuite_id: l.accountId || null,
  debit_cents: l.debitCents,
  credit_cents: l.creditCents,
  memo: (l.memo ?? '').trim() || null,
}));

/** The same lines the other way round: each debit a credit and each credit a debit, to undo an entry. */
export const reversed = (lines: TypedLine[]): TypedLine[] => lines.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents }));

/** When an entry's reversal is dated: the first of the next month, as a month-end accrual is undone. '' for no date. */
export function reversalDate(date: string): string {
  if (!isDay(date)) return '';
  const [y, m] = date.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** FleetSuite's own name for an entry's journal entry in NetSuite: approving it again never makes a second one. */
export const typedExternalId = (entryId: string) => `fleetsuite-je-${entryId}`;

/** What createJournalEntry sends. */
export function netsuiteTypedEntry(w: WorkedTypedEntry, subsidiaryId: string, entryId: string) {
  return {
    subsidiaryId,
    tranDate: w.date,
    memo: w.memo,
    externalId: typedExternalId(entryId),
    lines: w.lines.map((l) => ({
      accountId: l.accountId,
      ...(l.debitCents > 0 ? { debit: l.debitCents / 100 } : { credit: l.creditCents / 100 }),
      ...(l.memo ? { memo: l.memo } : {}),
    })),
  };
}
