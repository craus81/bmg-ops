/**
 * Checks printed on BMG's own check stock (Books part 58, docs/books.md
 * "Checks printed on BMG's stock"; the NetSuite Exit Checklist's "Pay
 * vendors": checks printed on your stock. Owner fact 2026-10-10: vendor
 * checks print on pre-printed check stock).
 *
 * A payment run's checks are made in NetSuite To Be Printed (part 57). From
 * the run on the Pay vendors page, FleetSuite gives each the next number on
 * the stock in the printer, sets that number in NetSuite (which takes the
 * check off NetSuite's Print Checks), and prints it: one check a page, on
 * voucher stock with the check at the top, middle or bottom and the other two
 * parts as stubs listing the bills it pays. The stock already carries the
 * bank's details, the MICR line, the check number and the signature line,
 * so only what changes is printed. Where it lands is set for each bank
 * account, with a test page on plain paper to hold against the stock.
 *
 * The rules here are pure: /api/pay-vendors/checks and the page both use
 * them, and src/lib/check-pdf.ts lays the checks out.
 */

import { formatCents } from '@/lib/pay-vendors';

export { formatCents };

/** The highest check number FleetSuite gives: eight digits. */
export const CHECK_NUMBER_MAX = 99_999_999;

/** How far a layout moves the print, in sixteenths of an inch, either way. */
export const NUDGE_MAX = 16;

/** The longest reason a check didn't print right. */
export const SPOILED_REASON_MAX = 300;

/** Where the check is on a sheet of the stock; the other two parts are stubs. */
export type CheckPosition = 'top' | 'middle' | 'bottom';

export const CHECK_POSITIONS: Readonly<Record<CheckPosition, string>> = {
  top: 'Check at the top',
  middle: 'Check in the middle',
  bottom: 'Check at the bottom',
};

export const isCheckPosition = (v: unknown): v is CheckPosition => v === 'top' || v === 'middle' || v === 'bottom';

/** Where a bank account's checks land: the check's place on the sheet, and how far the print moves right and down. */
export interface CheckLayout {
  position: CheckPosition;
  /** Sixteenths of an inch to the right; less than 0 moves it left. */
  right: number;
  /** Sixteenths of an inch down; less than 0 moves it up. */
  down: number;
}

export const DEFAULT_LAYOUT: Readonly<CheckLayout> = { position: 'top', right: 0, down: 0 };

const nudge = (v: unknown) => (Number.isInteger(v) && Math.abs(v as number) <= NUDGE_MAX ? (v as number) : 0);

/** A layout as kept (vendor_check_layouts, migration 489), or the default when there's none. */
export const layoutOf = (row: { check_position?: unknown; right_sixteenths?: unknown; down_sixteenths?: unknown } | null | undefined): CheckLayout => ({
  position: isCheckPosition(row?.check_position) ? row.check_position : DEFAULT_LAYOUT.position,
  right: nudge(row?.right_sixteenths),
  down: nudge(row?.down_sixteenths),
});

/** What's wrong with a layout someone set, if anything. */
export function layoutProblems(layout: CheckLayout): string[] {
  const problems: string[] = [];
  if (!isCheckPosition(layout.position)) problems.push('Pick where the check is on the sheet: top, middle or bottom.');
  for (const [v, way] of [[layout.right, 'right or left'], [layout.down, 'down or up']] as const) {
    if (!Number.isInteger(v) || Math.abs(v) > NUDGE_MAX) problems.push(`Move it ${way} by a whole number of sixteenths of an inch, ${NUDGE_MAX} at most (one inch).`);
  }
  return problems;
}

/** How far a layout moves the print, said the way the page says it: "1/8 inch right, 1/16 inch up". */
export function nudgeText(layout: Pick<CheckLayout, 'right' | 'down'>): string {
  const part = (n: number, plus: string, minus: string) => {
    if (n === 0) return null;
    const a = Math.abs(n);
    const g = a % 16 === 0 ? 16 : a % 8 === 0 ? 8 : a % 4 === 0 ? 4 : a % 2 === 0 ? 2 : 1;
    const size = a === 16 ? '1 inch' : `${a / g}/${16 / g} inch`;
    return `${size} ${n > 0 ? plus : minus}`;
  };
  const parts = [part(layout.right, 'right', 'left'), part(layout.down, 'down', 'up')].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'not moved';
}

/** Where a bank account's checks print, in a line: "Check at the top of the sheet · print moved 1/8 inch right". */
export function layoutText(layout: CheckLayout): string {
  const moved = nudgeText(layout);
  return `${CHECK_POSITIONS[layout.position]} of the sheet · ${moved === 'not moved' ? 'print not moved' : `print moved ${moved}`}`;
}

// ── The amount ───────────────────────────────────────────────────────────

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const words: string[] = [];
  if (hundreds > 0) words.push(`${ONES[hundreds]} hundred`);
  if (rest >= 20) words.push(rest % 10 ? `${TENS[Math.floor(rest / 10)]}-${ONES[rest % 10]}` : TENS[Math.floor(rest / 10)]);
  else if (rest > 0) words.push(ONES[rest]);
  return words.join(' ');
}

/** Whole dollars in words, as a check writes them: 1412 is "one thousand four hundred twelve". Up to 999,999,999. */
export function dollarsInWords(dollars: number): string {
  if (!Number.isInteger(dollars) || dollars < 0 || dollars > 999_999_999) throw new Error(`${dollars} isn't a whole number of dollars a check can say`);
  if (dollars === 0) return 'zero';
  const millions = Math.floor(dollars / 1_000_000);
  const thousands = Math.floor((dollars % 1_000_000) / 1000);
  const rest = dollars % 1000;
  return [
    millions > 0 ? `${belowThousand(millions)} million` : '',
    thousands > 0 ? `${belowThousand(thousands)} thousand` : '',
    rest > 0 ? belowThousand(rest) : '',
  ].filter(Boolean).join(' ');
}

/** The amount on the check's words line: 141240 cents is "One thousand four hundred twelve and 40/100". */
export function amountInWords(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`${cents} isn't a whole number of cents`);
  const words = dollarsInWords(Math.floor(cents / 100));
  return `${words[0].toUpperCase()}${words.slice(1)} and ${String(cents % 100).padStart(2, '0')}/100`;
}

/** The amount in the check's box, filled from the left so nothing can be written in front: "**1,412.40". */
export const amountInFigures = (cents: number) => `**${formatCents(cents).replace('$', '')}`;

/** The check's date as it's printed: 2026-11-06 is "11/06/2026". */
export const checkDate = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}/${ymd.slice(0, 4)}`;

// ── What's printed ───────────────────────────────────────────────────────

/** A vendor's address as NetSuite has it (getVendorAddresses, src/lib/netsuite.ts). */
export interface PayeeAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

/** The address lines under the payee's name, for the envelope's window: none when NetSuite has none. */
export function addressLines(address: PayeeAddress | null | undefined): string[] {
  if (!address) return [];
  const street = (address.street || '').split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const cityState = [address.city.trim(), address.state.trim()].filter(Boolean).join(', ');
  const last = [cityState, address.zip.trim()].filter(Boolean).join(' ');
  return [...street, ...(last ? [last] : [])].slice(0, 4);
}

/** Who the check is made out to: NetSuite's Print on Check As when the vendor has one, else its name. */
export const payeeName = (printOnCheckAs: string | null | undefined, vendorName: string) => (printOnCheckAs || '').trim() || vendorName;

/** One bill a check pays, on its stubs. */
export interface StubBill {
  number: string | null;
  date: string | null;
  cents: number;
}

/** One check as it's printed. */
export interface PrintedCheck {
  number: number;
  /** 'YYYY-MM-DD'. */
  date: string;
  payee: string;
  address: string[];
  cents: number;
  memo: string;
  /** The vendor's name as FleetSuite keeps it, on the stubs. */
  vendorName: string;
  /** The bank account it's drawn on, on the stubs. */
  accountName: string;
  bills: StubBill[];
}

/** The most bills a stub lists; a check that pays more lists that many less one, and a line for the rest. */
export const STUB_LINES = 12;

/** A stub's bill lines: each bill, or as many as fit and one line for the rest with what they come to. */
export function stubLines(bills: readonly StubBill[], max = STUB_LINES): Array<{ text: string; date: string; cents: number }> {
  const line = (b: StubBill) => ({ text: b.number ? `Bill ${b.number}` : 'Bill', date: b.date ? checkDate(b.date) : '', cents: b.cents });
  if (bills.length <= max) return bills.map(line);
  const shown = bills.slice(0, max - 1);
  const rest = bills.slice(max - 1);
  return [
    ...shown.map(line),
    { text: `and ${rest.length} more bills`, date: '', cents: rest.reduce((s, b) => s + b.cents, 0) },
  ];
}

/** A run's check as it's printed: made out to NetSuite's Print on Check As for the vendor, or else its name. */
export function checkToPrint(p: {
  number: number;
  date: string;
  vendorName: string;
  printOnCheckAs?: string | null;
  address?: PayeeAddress | null;
  cents: number;
  memo: string | null;
  accountName: string;
  bills: readonly StubBill[];
}): PrintedCheck {
  return {
    number: p.number,
    date: p.date,
    payee: payeeName(p.printOnCheckAs, p.vendorName),
    address: addressLines(p.address),
    cents: p.cents,
    memo: (p.memo || '').trim(),
    vendorName: p.vendorName,
    accountName: p.accountName,
    bills: p.bills.map((b) => ({ number: b.number, date: b.date, cents: b.cents })),
  };
}

/** What's printed on a check, as vendor_checks keeps it (migration 489), so printing it again prints the same. */
export interface StoredCheck {
  date: string;
  payee: string;
  address: string[];
  cents: number;
  memo: string;
  vendor_name: string;
  account_name: string;
  bills: Array<{ number: string | null; date: string | null; cents: number }>;
}

export const storedCheck = (c: PrintedCheck): StoredCheck => ({
  date: c.date, payee: c.payee, address: [...c.address], cents: c.cents, memo: c.memo, vendor_name: c.vendorName, account_name: c.accountName,
  bills: c.bills.map((b) => ({ number: b.number, date: b.date, cents: b.cents })),
});

const textOr = (v: unknown, or: string | null) => (typeof v === 'string' ? v : or);
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isCents = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** A check as it was kept, with its number, to print again; null when what's kept isn't a whole check. */
export function printedCheckOf(number: number, kept: unknown): PrintedCheck | null {
  const k = kept as Partial<Record<keyof StoredCheck, unknown>> | null;
  if (!k || typeof k !== 'object' || !isDay(k.date) || !isCents(k.cents) || typeof k.payee !== 'string' || !k.payee.trim()) return null;
  if (!Array.isArray(k.bills) || !Array.isArray(k.address)) return null;
  const bills = k.bills.map((b: any) => (b && isCents(b.cents)
    ? { number: textOr(b.number, null), date: isDay(b.date) ? b.date : null, cents: b.cents as number }
    : null));
  if (bills.some((b) => b === null)) return null;
  return {
    number,
    date: k.date,
    payee: k.payee,
    address: k.address.filter((l): l is string => typeof l === 'string'),
    cents: k.cents,
    memo: textOr(k.memo, '') ?? '',
    vendorName: textOr(k.vendor_name, '') || k.payee,
    accountName: textOr(k.account_name, '') ?? '',
    bills: bills as StubBill[],
  };
}

/** Check numbers as a sentence says them: "check 1050", "checks 1050 to 1052", "checks 1050, 1052 and 1054". */
export function checkNumbersText(numbers: readonly number[]): string {
  const n = [...new Set(numbers)].sort((a, b) => a - b);
  if (n.length === 0) return 'no checks';
  if (n.length === 1) return `check ${n[0]}`;
  if (n[n.length - 1] - n[0] === n.length - 1) return `checks ${n[0]} to ${n[n.length - 1]}`;
  return `checks ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** Where the stock goes for checks with these numbers, printed in number order. */
export function stockText(numbers: readonly number[]): string {
  const n = [...new Set(numbers)].sort((a, b) => a - b);
  if (n.length === 0) return '';
  if (n[n.length - 1] - n[0] === n.length - 1) return `Put check ${n[0]} on top of the stock in the printer.`;
  return `Put ${checkNumbersText(n)} in the printer in that order, check ${n[0]} on top.`;
}

/** A made-up check for the test page. */
export const SAMPLE_CHECK: Readonly<PrintedCheck> = {
  number: 1001,
  date: '2026-11-06',
  payee: 'Ozark Hose & Fitting',
  address: ['1200 Industrial Dr', 'Springfield, MO 65802'],
  cents: 141240,
  memo: 'November run',
  vendorName: 'Ozark Hose & Fitting',
  accountName: '10100 Operating Checking',
  bills: [{ number: 'B-4410', date: '2026-10-06', cents: 81240 }, { number: 'B-4471', date: '2026-10-22', cents: 60000 }],
};

// ── Numbers ──────────────────────────────────────────────────────────────

/** The number to suggest for the first check in the printer: one past the highest used on the account, or none. */
export function nextCheckNumber(used: readonly number[]): number | null {
  const top = used.filter((n) => Number.isInteger(n) && n > 0).reduce((a, b) => Math.max(a, b), 0);
  return top > 0 && top < CHECK_NUMBER_MAX ? top + 1 : null;
}

/**
 * What's wrong with numbering this many checks from this number, given the numbers already used on the account:
 * the checks take the numbers on the stock in order, so each has to be free.
 */
export function numberingProblems(first: number, count: number, used: ReadonlySet<number>): string[] {
  if (count < 1) return ['Tick the checks to print.'];
  if (!Number.isInteger(first) || first < 1 || first > CHECK_NUMBER_MAX) {
    return [`Type the number printed on the first check in the printer: a whole number from 1 to ${CHECK_NUMBER_MAX.toLocaleString('en-US')}.`];
  }
  const last = first + count - 1;
  if (last > CHECK_NUMBER_MAX) return [`${count} checks from ${first} go past ${CHECK_NUMBER_MAX.toLocaleString('en-US')}.`];
  const taken: number[] = [];
  for (let n = first; n <= last; n++) if (used.has(n)) taken.push(n);
  if (taken.length === 0) return [];
  const list = taken.length === 1 ? `Check ${taken[0]} was` : `Checks ${taken.slice(0, -1).join(', ')} and ${taken[taken.length - 1]} were`;
  return [`${list} used already on this bank account. Check the number printed on the first check in the printer.`];
}

// ── NetSuite ─────────────────────────────────────────────────────────────

/** A bill payment as NetSuite has it now (getChecksNow, src/lib/netsuite.ts). */
export interface CheckNow {
  number: string;
  toBePrinted: boolean;
  voided: boolean;
  vendorId: string | null;
  totalCents: number | null;
}

/** What NetSuite's bill payment says about printing its check here. */
export type CheckState =
  | { state: 'to_print' }
  | { state: 'printed_there'; number: number }
  | { state: 'refuse'; why: string };

/**
 * Whether a run's check can be numbered and printed here: still in NetSuite, not voided, the vendor's and for what
 * FleetSuite made it for, and still To Be Printed, or still with the number of a check FleetSuite gave it that didn't
 * print right (`spoiled`). One NetSuite took off To Be Printed with another number was printed there.
 */
export function checkStateOf(expected: { vendorId: string; cents: number }, now: CheckNow | undefined, spoiled: readonly number[] = []): CheckState {
  if (!now) return { state: 'refuse', why: "NetSuite doesn't have this bill payment any more." };
  if (now.voided) return { state: 'refuse', why: "It's voided in NetSuite." };
  if (now.vendorId !== expected.vendorId || now.totalCents !== expected.cents) {
    return { state: 'refuse', why: "NetSuite's bill payment isn't what FleetSuite made any more: look at it in NetSuite." };
  }
  if (now.toBePrinted) return { state: 'to_print' };
  const n = now.number.trim();
  if (/^\d{1,8}$/.test(n) && Number(n) > 0) {
    return spoiled.includes(Number(n)) ? { state: 'to_print' } : { state: 'printed_there', number: Number(n) };
  }
  return { state: 'refuse', why: "It isn't To Be Printed in NetSuite any more, and NetSuite gives it no check number." };
}

/** After NetSuite didn't answer about a number: whether it took it (the number set, off To Be Printed), or not. */
export function numberTaken(number: number, now: CheckNow | undefined): boolean {
  return !!now && !now.voided && !now.toBePrinted && now.number.trim() === String(number);
}
