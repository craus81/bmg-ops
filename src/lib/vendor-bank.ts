/**
 * Vendor bank numbers kept in FleetSuite, locked, for paying vendors by ACH
 * (Books part 59, docs/books.md "Vendor bank numbers kept encrypted"; owner
 * decision 2026-10-09, thread "Replacing NetSuite with FleetSuite": FleetSuite
 * keeps vendor bank numbers encrypted and builds the ACH file NetSuite builds
 * today, shown masked, with a second person and a call-back for a change; the
 * NetSuite Exit Checklist's "Pay vendors").
 *
 * A super admin enters a vendor's routing and account numbers from the
 * vendor's ACH form, and they wait for a call-back: another super admin calls
 * the vendor on a number BMG already had, has them read the numbers out, and
 * types what they read. FleetSuite opens the locked numbers and compares, and
 * they're confirmed only when what was read matches; three call-backs that
 * don't match refuse them. A vendor's confirmed numbers are the only ones a
 * payment will be sent to (part 60's ACH file). The numbers are locked with a
 * key only the server has (src/lib/vendor-bank-lock.ts), and the account
 * number never goes back to a browser: pages show the four digits it ends
 * with.
 *
 * The rules here are pure; /api/pay-vendors/bank and the Pay vendors page
 * both use them, the page to say what's wrong before anything's sent and the
 * route to check it again.
 */

export type AccountType = 'checking' | 'savings';

export const ACCOUNT_TYPES: Readonly<Record<AccountType, string>> = { checking: 'Checking', savings: 'Savings' };

export const isAccountType = (v: unknown): v is AccountType => v === 'checking' || v === 'savings';

/** Where a vendor's bank numbers are. */
export type BankStatus = 'pending' | 'confirmed' | 'replaced' | 'refused' | 'removed';

export const BANK_STATUSES: Readonly<Record<BankStatus, string>> = {
  pending: 'Waiting for a call-back',
  confirmed: 'Confirmed on a call-back',
  replaced: 'Replaced',
  refused: 'Refused',
  removed: 'Removed',
};

/** What's locked: the numbers a payment is sent to. */
export interface BankNumbers {
  /** 9 digits. */
  routing: string;
  /** 4 to 17 digits. */
  account: string;
  type: AccountType;
}

/** The longest name on the account: the ACH file has room for no more. */
export const NAME_MAX = 22;

/** The longest note: where the numbers came from, and why they were refused or removed. */
export const NOTE_MAX = 300;

/** The longest name of who read the numbers out on the call-back. */
export const SPOKE_WITH_MAX = 100;

/** The longest phone number called. */
export const PHONE_MAX = 40;

/** Call-backs that don't match before the numbers are refused. */
export const TRIES = 3;

/** The fewest and most digits in an account number. */
export const ACCOUNT_MIN = 4;
export const ACCOUNT_MAX = 17;

/** Its digits, with spaces and dashes taken out; null when anything else is left. */
export function digitsOf(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, '');
  return /^\d*$/.test(digits) ? digits : null;
}

/** The first two digits of a routing number for an ordinary bank, a thrift or an electronic one. */
const routingStarts = (first: number) => (first >= 1 && first <= 12) || (first >= 21 && first <= 32) || (first >= 61 && first <= 72);

/** Why this isn't a routing number, or null when it is. */
export function routingProblem(typed: string): string | null {
  const d = digitsOf(typed);
  if (d === null) return 'A routing number is digits only.';
  if (d === '') return 'Type the routing number.';
  if (d.length !== 9) return `A routing number has 9 digits; that has ${d.length}.`;
  if (!routingStarts(Number(d.slice(0, 2)))) return `${d} isn't a routing number: they start 01 to 12, 21 to 32 or 61 to 72.`;
  const n = [...d].map(Number);
  // Every routing number's digits, weighted 3, 7, 1 in turn, add up to a multiple of 10.
  if ((3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + n[2] + n[5] + n[8]) % 10 !== 0) {
    return `${d} isn't a routing number: its last digit doesn't check, so a digit is likely wrong.`;
  }
  return null;
}

/** Why this isn't an account number, or null when it is. It never says the number back. */
export function accountProblem(typed: string): string | null {
  const d = digitsOf(typed);
  if (d === null) return 'An account number is digits only.';
  if (d === '') return 'Type the account number.';
  if (d.length < ACCOUNT_MIN || d.length > ACCOUNT_MAX) return `An account number has ${ACCOUNT_MIN} to ${ACCOUNT_MAX} digits; that has ${d.length}.`;
  return null;
}

/** An account number as pages show it: the four digits it ends with. */
export const maskedAccount = (last4: string) => `•••• ${last4}`;

/** The characters the ACH file takes in a name. */
const NAME_CHARS = /^[A-Za-z0-9 &',./#-]*$/;

/** Why this can't be the name on the account, or null when it can. */
export function nameProblem(typed: string): string | null {
  const t = typed.trim();
  if (!t) return 'Type the name on the account.';
  if (t.length > NAME_MAX) return `The name on the account takes ${NAME_MAX} characters at most: the ACH file has room for no more.`;
  if (!NAME_CHARS.test(t)) return "The name on the account takes letters, digits, spaces and & ' , . / # - only.";
  return null;
}

/** The vendor's name as the name on the account starts out: what the ACH file can't take left out, cut to fit. */
export const nameFor = (vendorName: string) =>
  vendorName.replace(/[^A-Za-z0-9 &',./#-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();

/**
 * Why a note can't be kept, or null when it can: one is needed, it isn't too long, and it holds no account number,
 * since those are only ever kept locked. A run of six digits or more is taken for one, and so is `account` (the
 * numbers it's about) however it's spaced.
 */
export function noteProblem(what: string, typed: string, max: number, account?: string | null): string | null {
  const t = typed.trim();
  if (!t) return `Say ${what}.`;
  if (t.length > max) return `Say ${what} in ${max} characters at most.`;
  if (/\d{6}/.test(t) || (!!account && t.replace(/[\s-]/g, '').includes(account))) {
    return `Leave account numbers out of ${what}: they're only ever kept locked. A phone can go in as 636-555-0142.`;
  }
  return null;
}

/** What a super admin types to enter a vendor's bank numbers. */
export interface BankEntry {
  routing: string;
  account: string;
  /** The account number typed a second time. */
  accountAgain: string;
  type: string;
  name: string;
  /** Where the numbers came from: whose form, and how it reached BMG. */
  source: string;
}

export const WHERE_FROM = 'where the numbers came from';

/** Why these can't be entered; none when they can. */
export function entryProblems(e: BankEntry): string[] {
  const account = accountProblem(e.account);
  const problems = [routingProblem(e.routing), account];
  if (!account && digitsOf(e.accountAgain) !== digitsOf(e.account)) problems.push("The account number typed again doesn't match.");
  if (!isAccountType(e.type)) problems.push('Pick checking or savings.');
  problems.push(nameProblem(e.name), noteProblem(WHERE_FROM, e.source, NOTE_MAX, account ? null : digitsOf(e.account)));
  return problems.filter((p): p is string => p !== null);
}

/** What's entered, as it's locked. Only for an entry with no problems. */
export const numbersOf = (e: Pick<BankEntry, 'routing' | 'account' | 'type'>): BankNumbers =>
  ({ routing: digitsOf(e.routing)!, account: digitsOf(e.account)!, type: e.type as AccountType });

/** What the super admin who calls the vendor back types. */
export interface CallBack {
  /** The number they called the vendor on. */
  phone: string;
  /** Who at the vendor read the numbers out. */
  spokeWith: string;
  /** What they read. */
  routing: string;
  account: string;
  type: string;
}

export const SPOKE_WITH = 'who read them out';

/** Why a call-back can't be checked; none when it can. A call-back with problems doesn't count as one that didn't match. */
export function callBackProblems(c: CallBack): string[] {
  const phone = c.phone.trim();
  const account = accountProblem(c.account);
  const problems = [
    !phone ? 'Type the phone you called them on.'
      : phone.length > PHONE_MAX ? `The phone takes ${PHONE_MAX} characters at most.`
        : phone.replace(/\D/g, '').length < 10 ? `${phone} is too short to be a phone number: type it with its area code.` : null,
    noteProblem(SPOKE_WITH, c.spokeWith, SPOKE_WITH_MAX, account ? null : digitsOf(c.account)),
    routingProblem(c.routing),
    account,
    isAccountType(c.type) ? null : 'Pick checking or savings, as they said.',
  ];
  return problems.filter((p): p is string => p !== null);
}

/**
 * What a call-back read that isn't what was entered: the routing number, the account number, or checking or savings.
 * Three tries refuse the numbers, so how long a compare takes tells nobody anything.
 */
export function readBackDiffers(entered: BankNumbers, read: Pick<CallBack, 'routing' | 'account' | 'type'>): string[] {
  const differs: string[] = [];
  if (digitsOf(read.routing) !== entered.routing) differs.push('routing number');
  if (digitsOf(read.account) !== entered.account) differs.push('account number');
  if (read.type !== entered.type) differs.push('checking or savings');
  return differs;
}

/** What the page says when a call-back didn't match, with the tries left. */
export function mismatchText(differs: readonly string[], triesLeft: number): string {
  const parts = differs.length === 1 ? differs[0] : `${differs.slice(0, -1).join(', ')} and ${differs[differs.length - 1]}`;
  const left = triesLeft === 1 ? 'one more try' : `${triesLeft} more tries`;
  return `The ${parts} they read ${differs.length === 1 ? "doesn't" : "don't"} match what was entered, so nothing changed: ${left} before they're refused.`;
}
