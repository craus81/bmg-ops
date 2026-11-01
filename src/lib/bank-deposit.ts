/**
 * Customer payments and deposits waiting in Undeposited Funds, deposited to a
 * bank account in FleetSuite and sent on to NetSuite as one bank deposit
 * (Books part 56, docs/books.md "Bank deposits made in FleetSuite"; owner
 * decisions 2026-10-31, thread "Replacing NetSuite with FleetSuite": deposits
 * and banking move into FleetSuite during 2027, and FleetSuite sends each on
 * to NetSuite so nobody types anything twice).
 *
 * Opened from Invoicing → Invoiced's Bank deposit: the company, the bank
 * account the money went into, the day, and the payments and deposits that
 * went to the bank together, ticked from what NetSuite has waiting in
 * Undeposited Funds, as NetSuite's Make Deposits has them. FleetSuite makes
 * one bank deposit in NetSuite with them, once, under its own External ID,
 * and keeps Books' own copy. Cash back and other deposits (money that isn't a
 * customer's payment or deposit) aren't done.
 *
 * The rules here are pure; /api/invoices/bank-deposit and the bank deposit
 * page both use them, the page to show what Make deposit would send and the
 * route to check it again, against what NetSuite has waiting, when it's
 * pressed.
 */

import { isIsoDate } from '@/lib/books/journal';
import { MEMO_MAX, OLDEST_DAYS, formatCents } from '@/lib/receive-payment';

export { formatCents, MEMO_MAX };

/** What a bank deposit's External ID in NetSuite starts with: the rest is the press's id (made_bank_deposits.id). */
const EXTERNAL_ID_PREFIX = 'fleetsuite-bd-';

export const bankDepositExternalId = (pressId: string) => `${EXTERNAL_ID_PREFIX}${pressId}`;

/** The most payments and deposits one bank deposit takes. */
export const MAX_LINES = 100;

/** A customer payment or customer deposit waiting in Undeposited Funds, as NetSuite has it now. */
export interface WaitingItem {
  netsuiteId: string;
  kind: 'payment' | 'deposit';
  number: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  customerName: string;
  /** The check's number, or the payment's reference, when NetSuite has one. */
  reference: string | null;
  cents: number;
}

/** One of the company's bank accounts, as Books' chart of accounts has it from NetSuite. */
export interface BankAccount {
  netsuiteId: string;
  number: string | null;
  name: string;
}

/** A bank deposit as ticked and typed. */
export interface BankDepositDraft {
  /** The day it went to the bank, 'YYYY-MM-DD'. */
  date: string;
  /** NetSuite's id for the bank account it went into. */
  accountId: string;
  memo: string;
  /** NetSuite's ids for the payments and deposits ticked. */
  lineIds: readonly string[];
  /** What the page had the ticked ones come to, when it's pressed: the route turns it away when they've changed. */
  expectedCents?: number;
}

export interface WorkedBankDeposit {
  /** Why it can't be sent; none when it can. */
  problems: string[];
  date: string;
  account: BankAccount | null;
  memo: string | null;
  /** The ticked payments and deposits as NetSuite has them, in the order it lists them. */
  lines: WaitingItem[];
  totalCents: number;
}

const DAY_MS = 86_400_000;
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** 'YYYY-MM-DD' less whole days. */
const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

/** An account's name with its number in front, as the page shows it. */
export const accountName = (a: BankAccount) => (a.number ? `${a.number} ${a.name}` : a.name);

/**
 * A bank deposit worked out from what's ticked and typed, the company's bank accounts and what NetSuite has waiting
 * in Undeposited Funds now, with every reason it can't be sent. `held` is what another press is depositing now;
 * `today` is the day in O'Fallon.
 */
export function workOutBankDeposit(
  draft: BankDepositDraft, waiting: readonly WaitingItem[], accounts: readonly BankAccount[],
  opts: { today: string; held?: ReadonlySet<string> },
): WorkedBankDeposit {
  const problems: string[] = [];

  const date = clean(draft.date);
  const dateOk = isIsoDate(date);
  if (!dateOk) problems.push(date ? `${date} isn't a day on the calendar.` : 'Fill in the day it went to the bank.');
  else if (date > opts.today) problems.push("A bank deposit can't be dated after today.");
  else if (date < daysBefore(opts.today, OLDEST_DAYS)) problems.push("A bank deposit can't be dated more than a year back.");

  const accountId = clean(draft.accountId);
  const account = accounts.find((a) => a.netsuiteId === accountId) ?? null;
  if (!account) problems.push(accountId ? "That isn't one of the company's bank accounts." : 'Pick the bank account it went into.');

  const memo = clean(draft.memo);
  if (memo.length > MEMO_MAX) problems.push(`The memo is ${MEMO_MAX} characters at most.`);

  const ids = new Set(draft.lineIds.map((id) => clean(id)).filter(Boolean));
  const lines = waiting.filter((w) => ids.has(w.netsuiteId));
  if (ids.size === 0) problems.push('Tick the payments and deposits that went to the bank together.');
  else if (ids.size > MAX_LINES) problems.push(`One bank deposit takes ${MAX_LINES} payments and deposits at most.`);
  else if (lines.length < ids.size) {
    const gone = ids.size - lines.length;
    problems.push(`${gone === 1 ? 'One' : gone} of the ones ticked ${gone === 1 ? "isn't" : "aren't"} waiting in Undeposited Funds any more: reload to see what is.`);
  }
  for (const line of lines) {
    if (opts.held?.has(line.netsuiteId)) problems.push(`${line.number} is in a bank deposit being made now.`);
  }

  const totalCents = lines.reduce((s, l) => s + l.cents, 0);
  const latest = lines.reduce((d, l) => (l.date > d ? l.date : d), '');
  if (dateOk && latest && date < latest) problems.push("A bank deposit can't be dated before the payments and deposits in it.");
  if (draft.expectedCents !== undefined && lines.length === ids.size && draft.expectedCents !== totalCents) {
    problems.push(`What's waiting changed since the page opened: the ones ticked come to ${formatCents(totalCents)} now. Check them and press again.`);
  }

  return { problems, date, account, memo: memo || null, lines, totalCents };
}

/** What createBankDeposit sends (src/lib/netsuite.ts). */
export function netsuiteBankDeposit(worked: WorkedBankDeposit, p: { pressId: string; subsidiaryId: string }) {
  return {
    externalId: bankDepositExternalId(p.pressId),
    subsidiaryId: p.subsidiaryId,
    accountId: worked.account?.netsuiteId ?? '',
    tranDate: worked.date,
    memo: worked.memo,
    paymentIds: worked.lines.map((l) => l.netsuiteId),
  };
}
