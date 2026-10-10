import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * FleetSuite's own books (migration 359): the one way server code writes to
 * the journal. Built hidden on main in late 2026 to run beside NetSuite
 * through 2027 and keep the books alone from 2028-01-01 (docs/books.md).
 *
 * The database is the real guard. It refuses unbalanced, edited, deleted,
 * closed-month and duplicate postings no matter who writes. This layer
 * catches mistakes before the round trip with readable reasons, and sends
 * amounts as exact two-decimal strings instead of floats.
 *
 * Server-only: pass the service-role client (createServiceClient). The API
 * roles have no access to the gl_* tables or functions.
 */

export const BOOKS_COMPANIES = ['BMG', '1084'] as const;
export type BooksCompany = (typeof BOOKS_COMPANIES)[number];

export const BOOKS_DIVISIONS = ['upfit', 'graphics', 'shared'] as const;
export type BooksDivision = (typeof BOOKS_DIVISIONS)[number];

/** Dollars, as a number or a plain decimal string like '1250.00'. At most two decimals. */
export type Amount = number | string;

export interface BooksActor {
  /** profiles.id; null when the system posts. */
  id: string | null;
  name: string | null;
}

export interface JournalLineInput {
  accountId: string;
  /** Exactly one of debit or credit, above zero. */
  debit?: Amount | null;
  credit?: Amount | null;
  memo?: string | null;
  division?: BooksDivision | null;
  /** Location key as invoice-location.ts names it ('ofallon', 'socialcircle', …). */
  location?: string | null;
  customerId?: string | null;
  vendorRef?: string | null;
  /** '<kind>:<id>', e.g. 'so:1060'. */
  jobRef?: string | null;
  itemNumber?: string | null;
  sourceLineRef?: string | null;
}

export interface JournalEntryInput {
  company: BooksCompany;
  /** YYYY-MM-DD. */
  entryDate: string;
  /** The document type ('invoice', 'vendor_bill', …), 'manual' for a typed entry, or 'opening_balance'. */
  sourceType: string;
  sourceId?: string | null;
  /** The rule and its version, e.g. 'invoice@1'; 'manual' for a typed entry. */
  postingRule: string;
  /** Unique per posting: a retry with the same key writes nothing new. */
  idempotencyKey: string;
  memo?: string | null;
  postedBy?: BooksActor | null;
  lines: JournalLineInput[];
}

export interface PostedEntry {
  id: string;
  entryNo: number;
  /** True when this idempotency key had already posted, so nothing new was written. */
  alreadyPosted: boolean;
}

export class BooksError extends Error {
  /**
   * invalid: refused here, before reaching the database.
   * refused: the database's own rules said no (closed month, control account, …).
   * failed: anything else.
   */
  readonly kind: 'invalid' | 'refused' | 'failed';
  readonly problems: string[];

  constructor(kind: BooksError['kind'], problems: string[]) {
    super(problems.join('; '));
    this.name = 'BooksError';
    this.kind = kind;
    this.problems = problems;
  }
}

type RpcClient = Pick<SupabaseClient, 'rpc'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPE = /^[a-z][a-z_]{1,39}$/;
const LOCATION = /^[a-z0-9_]{2,40}$/;
const PLAIN_AMOUNT = /^\d+(\.\d{1,2})?$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Whole cents from dollars: 0 when no amount is given, null when the amount
 * is negative, not a number, or has fractions of a cent. A number may carry
 * float noise (19.99 * 100 = 1998.9999999999998), so it only has to sit
 * within a hair of a whole cent; a string must be a plain decimal.
 */
export function toCents(amount: Amount | null | undefined): number | null {
  if (amount === null || amount === undefined) return 0;
  if (typeof amount === 'string') {
    const s = amount.trim();
    if (s === '') return 0;
    if (!PLAIN_AMOUNT.test(s)) return null;
    const [whole, frac = ''] = s.split('.');
    const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
  }
  if (!Number.isFinite(amount) || amount < 0) return null;
  const raw = amount * 100;
  const cents = Math.round(raw);
  if (Math.abs(raw - cents) > 1e-4 || !Number.isSafeInteger(cents)) return null;
  return cents;
}

/** '1250.00' from 125000. */
export function centsToAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Every reason the database would refuse this entry that can be seen without it. Empty = fine. */
export function validateEntry(entry: JournalEntryInput): string[] {
  const problems: string[] = [];
  if (!(BOOKS_COMPANIES as readonly string[]).includes(entry.company)) {
    problems.push(`Unknown company "${entry.company}"`);
  }
  if (!isIsoDate(entry.entryDate)) problems.push(`Entry date "${entry.entryDate}" isn't a YYYY-MM-DD date`);
  if (entry.sourceType === 'reversal') {
    problems.push('Reversals are posted with reverseEntry, not postEntry');
  } else if (!SOURCE_TYPE.test(entry.sourceType ?? '')) {
    problems.push(`Source type "${entry.sourceType}" must be lowercase letters and underscores`);
  }
  if (!entry.postingRule?.trim()) problems.push('Posting rule is required');
  if (!entry.idempotencyKey?.trim()) problems.push('Idempotency key is required');
  if (entry.postedBy?.id && !UUID.test(entry.postedBy.id)) problems.push('Posted-by id must be a profile id');

  const lines = Array.isArray(entry.lines) ? entry.lines : [];
  if (lines.length < 2) problems.push('An entry needs at least two lines');

  let debits = 0;
  let credits = 0;
  let amountsOk = true;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!UUID.test(line.accountId ?? '')) problems.push(`Line ${n}: account is missing`);
    const debit = toCents(line.debit);
    const credit = toCents(line.credit);
    if (debit === null) problems.push(`Line ${n}: debit "${line.debit}" isn't an amount with at most two decimals`);
    if (credit === null) problems.push(`Line ${n}: credit "${line.credit}" isn't an amount with at most two decimals`);
    if (debit === null || credit === null) {
      amountsOk = false;
    } else {
      if ((debit > 0) === (credit > 0)) problems.push(`Line ${n}: needs either a debit or a credit above zero, not both`);
      debits += debit;
      credits += credit;
    }
    if (line.division && !(BOOKS_DIVISIONS as readonly string[]).includes(line.division)) {
      problems.push(`Line ${n}: division "${line.division}" isn't upfit, graphics or shared`);
    }
    if (line.location && !LOCATION.test(line.location)) problems.push(`Line ${n}: location "${line.location}" isn't a location key`);
    if (line.customerId && !UUID.test(line.customerId)) problems.push(`Line ${n}: customer id isn't a customer`);
  });
  // Totals only mean something once every amount reads.
  if (lines.length >= 2 && amountsOk && debits !== credits) {
    problems.push(`Debits ${dollars(debits)} don't equal credits ${dollars(credits)}`);
  }
  return problems;
}

/** The gl_post_entry argument for a valid entry, amounts as exact strings. */
export function postPayload(entry: JournalEntryInput) {
  const side = (a: Amount | null | undefined) => {
    const cents = toCents(a);
    return cents ? centsToAmount(cents) : null;
  };
  return {
    company: entry.company,
    entry_date: entry.entryDate,
    source_type: entry.sourceType,
    source_id: entry.sourceId ?? null,
    posting_rule: entry.postingRule.trim(),
    idempotency_key: entry.idempotencyKey.trim(),
    memo: entry.memo ?? null,
    posted_by: entry.postedBy?.id ?? null,
    posted_by_name: entry.postedBy?.name ?? null,
    lines: entry.lines.map((l) => ({
      account_id: l.accountId,
      debit: side(l.debit),
      credit: side(l.credit),
      memo: l.memo ?? null,
      division: l.division ?? null,
      location: l.location ?? null,
      customer_id: l.customerId ?? null,
      vendor_ref: l.vendorRef ?? null,
      job_ref: l.jobRef ?? null,
      item_number: l.itemNumber ?? null,
      source_line_ref: l.sourceLineRef ?? null,
    })),
  };
}

/** A database error as a BooksError; the journal's own refusals start with "gl: ". */
export function booksErrorFrom(error: { message?: string } | null | undefined): BooksError {
  const message = error?.message || 'The books database returned an error with no message';
  return message.startsWith('gl: ')
    ? new BooksError('refused', [message.slice(4)])
    : new BooksError('failed', [message]);
}

/** Posts one entry. Throws BooksError when it's invalid or refused; a repeated key returns alreadyPosted. */
export async function postEntry(client: RpcClient, entry: JournalEntryInput): Promise<PostedEntry> {
  const problems = validateEntry(entry);
  if (problems.length) throw new BooksError('invalid', problems);
  const { data, error } = await client.rpc('gl_post_entry', { p: postPayload(entry) });
  if (error) throw booksErrorFrom(error);
  return { id: data.id, entryNo: Number(data.entry_no), alreadyPosted: data.already_posted === true };
}

/**
 * Posts the mirror image of an entry, linked to it. Dated `date` (default:
 * the original's date, which must still be in an open month). An entry is
 * reversed at most once, and a reversal is never reversed.
 */
export async function reverseEntry(
  client: RpcClient,
  opts: { entryId: string; date?: string | null; memo?: string | null; actor?: BooksActor | null },
): Promise<{ id: string; entryNo: number }> {
  const problems: string[] = [];
  if (!UUID.test(opts.entryId ?? '')) problems.push('Entry id is missing');
  if (opts.date && !isIsoDate(opts.date)) problems.push(`Reversal date "${opts.date}" isn't a YYYY-MM-DD date`);
  if (problems.length) throw new BooksError('invalid', problems);
  const { data, error } = await client.rpc('gl_reverse_entry', {
    p_entry_id: opts.entryId,
    p_date: opts.date || null,
    p_memo: opts.memo ?? null,
    p_actor_id: opts.actor?.id ?? null,
    p_actor_name: opts.actor?.name ?? null,
  });
  if (error) throw booksErrorFrom(error);
  return { id: data.id, entryNo: Number(data.entry_no) };
}

/** Closes or reopens one company's month ('YYYY-MM'). Reopening needs a reason; both are logged. */
export async function setPeriodStatus(
  client: RpcClient,
  opts: { company: BooksCompany; month: string; status: 'open' | 'closed'; actor: BooksActor; reason?: string | null },
): Promise<{ id: string; periodStart: string; status: 'open' | 'closed' }> {
  const problems: string[] = [];
  if (!(BOOKS_COMPANIES as readonly string[]).includes(opts.company)) problems.push(`Unknown company "${opts.company}"`);
  const monthStart = `${opts.month}-01`;
  if (!/^\d{4}-\d{2}$/.test(opts.month ?? '') || !isIsoDate(monthStart)) problems.push(`Month "${opts.month}" isn't YYYY-MM`);
  if (opts.status !== 'open' && opts.status !== 'closed') problems.push('Status must be open or closed');
  if (opts.status === 'open' && !opts.reason?.trim()) problems.push('Reopening a month needs a reason');
  if (problems.length) throw new BooksError('invalid', problems);
  const { data, error } = await client.rpc('gl_set_period_status', {
    p_company: opts.company,
    p_month: monthStart,
    p_status: opts.status,
    p_actor_id: opts.actor.id,
    p_actor_name: opts.actor.name,
    p_reason: opts.reason?.trim() || null,
  });
  if (error) throw booksErrorFrom(error);
  return { id: data.id, periodStart: data.period_start, status: data.status };
}

/**
 * Empties the journal and its months so a rehearsal can run again. The
 * database refuses this once any company's books are live.
 */
export async function resetJournal(client: RpcClient): Promise<void> {
  const { error } = await client.rpc('gl_reset_journal');
  if (error) throw booksErrorFrom(error);
}
