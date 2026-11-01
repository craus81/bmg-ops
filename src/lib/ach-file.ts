/**
 * The ACH file BMG uploads to First Bank to pay vendors (Books part 60,
 * docs/books.md "The ACH file for First Bank"; the NetSuite Exit Checklist's
 * "Pay vendors": the First Bank ACH file, which NetSuite makes today).
 *
 * A payment run's ACH payments are made in NetSuite as bill payments (part
 * 57). From the run on the Pay Vendors page, a super admin makes the file: a
 * NACHA file of one batch, a credit to each vendor's bank numbers confirmed
 * on a call-back (part 59, src/lib/vendor-bank.ts), each with an addenda that
 * lists the bills it pays, and uploads it to First Bank, which pays them on
 * the file's effective date. How the file starts (First Bank's routing
 * number, BMG's company ID and names, whether First Bank wants the offsetting
 * debit to BMG's account in the file) is set for each bank account, typed or
 * read from the last ACH file NetSuite made for it.
 *
 * The rules here are pure: /api/pay-vendors/ach makes the file with them and
 * the page shows what it will pay. Reading NetSuite's file happens in the
 * browser, and only how it starts leaves it: never a vendor's numbers.
 */

import { formatCents } from '@/lib/pay-vendors';
import { digitsOf, routingProblem, isAccountType, type AccountType, type BankNumbers } from '@/lib/vendor-bank';

export { formatCents };

/** Every record in the file is this long. */
export const RECORD = 94;

/** The longest name of the bank the file goes to, and of BMG as the file names it. */
export const BANK_NAME_MAX = 23;
export const ORIGIN_NAME_MAX = 23;
/** The longest company name in the batch. */
export const COMPANY_NAME_MAX = 16;
/** The longest entry description, which the vendor's statement shows. */
export const DESCRIPTION_MAX = 10;
/** What the entry description starts out as. */
export const DESCRIPTION_DEFAULT = 'VENDOR PAY';
/** What the bank's name starts out as. */
export const BANK_NAME_DEFAULT = 'FIRST BANK';
/** The longest reason a file was set aside. */
export const WHY_MAX = 300;
/** Files made for one day to one bank: a letter or digit tells each apart. */
export const MODIFIERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** CCD pays a business, PPD a person; the file uses the one First Bank set BMG up for. */
export type SecCode = 'CCD' | 'PPD';
export const isSecCode = (v: unknown): v is SecCode => v === 'CCD' || v === 'PPD';

export type LineEnding = 'crlf' | 'lf';
export const isLineEnding = (v: unknown): v is LineEnding => v === 'crlf' || v === 'lf';

/** How a bank account's ACH file starts, as First Bank set BMG up to send it. */
export interface AchSetup {
  /** First Bank's routing number, where the file goes (immediate destination): 9 digits. */
  destination: string;
  destinationName: string;
  /** BMG as First Bank knows it (immediate origin): 10 characters, or 9 digits sent after a space. */
  origin: string;
  originName: string;
  /** The first 8 digits of the routing number of the bank sending the payments (originating bank). */
  odfi: string;
  companyName: string;
  /** BMG's company ID for ACH, as First Bank gave it: often 1 and the EIN. */
  companyId: string;
  entryDescription: string;
  secCode: SecCode;
  /** Whether each payment has an addenda listing the bills it pays. */
  addenda: boolean;
  /** Whether First Bank wants the offsetting debit to BMG's account in the file (a balanced file). */
  balanced: boolean;
  lineEnding: LineEnding;
}

/** The characters the file takes in names and references, as the name on a vendor's account. */
const TEXT_CHARS = /[^A-Z0-9 &',./#-]/g;

/** Text as the file has it: capitals, accents taken off, what it can't take left out, spaces closed up, cut to fit. */
export function achText(typed: string, max: number): string {
  return typed.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(TEXT_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** Why a name typed for the file can't be used, or null when it can. */
function nameProblem(what: string, typed: string, max: number): string | null {
  const t = typed.trim();
  if (!t) return `Type ${what}.`;
  if (t.length > max) return `${upper(what)} takes ${max} characters at most: the file has room for no more.`;
  if (achText(t, max) !== t.toUpperCase().replace(/\s+/g, ' ')) return `${upper(what)} takes letters, digits, spaces and & ' , . / # - only.`;
  return null;
}

const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** BMG as First Bank knows it, as the file's header has it: 10 characters, a space before 9 digits. */
export const originField = (origin: string) => (/^\d{9}$/.test(origin) ? ` ${origin}` : origin);

/** A setup as it's typed on the page or read from NetSuite's file. */
export type SetupTyped = { [K in keyof AchSetup]: AchSetup[K] extends boolean ? boolean : string };

/** What's wrong with a setup, in the page's words; none when the file can be made with it. */
export function setupProblems(s: SetupTyped): string[] {
  const problems: string[] = [];
  const destination = routingProblem(s.destination);
  if (destination) problems.push(`First Bank's routing number: ${destination}`);
  const bank = nameProblem("the bank's name", s.destinationName, BANK_NAME_MAX);
  if (bank) problems.push(bank);
  const origin = s.origin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(origin) && !/^\d{9}$/.test(origin)) {
    problems.push("BMG's ACH ID with First Bank (the immediate origin) is the 10 characters, or 9 digits, First Bank gave BMG.");
  }
  const originName = nameProblem("BMG's name for First Bank", s.originName, ORIGIN_NAME_MAX);
  if (originName) problems.push(originName);
  const odfi = digitsOf(s.odfi);
  if (odfi === null || odfi.length !== 8) problems.push("The sending bank is the first 8 digits of First Bank's routing number, as First Bank gave them.");
  const company = nameProblem('the company name', s.companyName, COMPANY_NAME_MAX);
  if (company) problems.push(company);
  if (!/^[A-Z0-9]{1,10}$/.test(s.companyId.trim().toUpperCase())) {
    problems.push("BMG's company ID is the letters or digits First Bank gave BMG for ACH, 10 at most, often 1 and the EIN.");
  }
  const description = nameProblem('the description', s.entryDescription, DESCRIPTION_MAX);
  if (description) problems.push(description);
  if (!isSecCode(s.secCode)) problems.push('Pick CCD, paying businesses, or PPD, paying people, as First Bank set BMG up.');
  if (!isLineEnding(s.lineEnding)) problems.push('Pick how the file ends its lines.');
  return problems;
}

/** A setup as it's kept, from one with no problems. */
export function setupOf(s: SetupTyped): AchSetup {
  return {
    destination: digitsOf(s.destination) ?? '',
    destinationName: achText(s.destinationName, BANK_NAME_MAX),
    origin: s.origin.trim().toUpperCase(),
    originName: achText(s.originName, ORIGIN_NAME_MAX),
    odfi: digitsOf(s.odfi) ?? '',
    companyName: achText(s.companyName, COMPANY_NAME_MAX),
    companyId: s.companyId.trim().toUpperCase(),
    entryDescription: achText(s.entryDescription, DESCRIPTION_MAX),
    secCode: s.secCode as SecCode,
    addenda: s.addenda === true,
    balanced: s.balanced === true,
    lineEnding: s.lineEnding as LineEnding,
  };
}

// ── Banking days ─────────────────────────────────────────────────────────

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const timeOf = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const addDays = (day: string, n: number) => isoOf(timeOf(day) + n * 86_400_000);
const weekdayOf = (day: string) => new Date(timeOf(day)).getUTCDay();

/** The day of the month of a month's nth weekday (0 Sunday to 6 Saturday), or its last when n is 0. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n === 0) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return last - ((new Date(Date.UTC(year, month - 1, last)).getUTCDay() - weekday + 7) % 7);
  }
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/**
 * The days the Federal Reserve doesn't settle ACH in a year: its holidays, a Sunday one on the Monday after. One on a
 * Saturday isn't moved: the Federal Reserve is open the Friday before.
 */
export function bankHolidays(year: number): Set<string> {
  const days = new Set<string>();
  const add = (month: number, day: number) => days.add(`${year}-${pad(month)}-${pad(day)}`);
  for (const [month, day] of [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]]) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (weekday === 0) days.add(isoOf(Date.UTC(year, month - 1, day + 1)));
    else if (weekday !== 6) add(month, day);
  }
  add(1, nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr. Day
  add(2, nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  add(5, nthWeekday(year, 5, 1, 0)); // Memorial Day
  add(9, nthWeekday(year, 9, 1, 1)); // Labor Day
  add(10, nthWeekday(year, 10, 1, 2)); // Columbus Day
  add(11, nthWeekday(year, 11, 4, 4)); // Thanksgiving
  return days;
}

/** Whether ACH settles on a day ('YYYY-MM-DD'): a weekday the Federal Reserve is open. */
export function isBankDay(day: string): boolean {
  const weekday = weekdayOf(day);
  return weekday !== 0 && weekday !== 6 && !bankHolidays(Number(day.slice(0, 4))).has(day);
}

/** The first day after this one that ACH settles. */
export function nextBankDay(day: string): string {
  let next = addDays(day, 1);
  while (!isBankDay(next)) next = addDays(next, 1);
  return next;
}

/**
 * The day First Bank pays a file made today for a run paid on `payDate`: the run's day when that's a banking day
 * after today, or else the first banking day after it, and never sooner than the next banking day after today.
 */
export function effectiveDate(payDate: string, today: string): string {
  const soonest = nextBankDay(today);
  let day = payDate > soonest ? payDate : soonest;
  while (!isBankDay(day)) day = addDays(day, 1);
  return day;
}

/** A day as the page says it: 'Friday, November 6'. */
export const dayText = (day: string) =>
  new Date(timeOf(day)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** The day ('YYYY-MM-DD') and time ('HHMM') it is at BMG, in Central time. */
export function chicagoClock(at: Date = new Date()): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}${part('minute')}` };
}

/** The letter or digit for the nth file made for a day to a bank, from 0; null past the 36th. */
export const modifierFor = (n: number): string | null => (Number.isInteger(n) && n >= 0 && n < MODIFIERS.length ? MODIFIERS[n] : null);

// ── The file ─────────────────────────────────────────────────────────────

/** One vendor's payment in the file. */
export interface AchPayee {
  routing: string;
  account: string;
  type: AccountType;
  cents: number;
  /** The name on the vendor's account, as their bank has it. */
  name: string;
  /** BMG's reference for the payment, which the vendor sees: NetSuite's number for the bill payment. */
  reference: string;
  /** The bills it pays, for its addenda. */
  bills: Array<{ number: string | null; cents: number }>;
}

export interface AchFileInput {
  setup: AchSetup;
  /** BMG's account the payments come from, for the offsetting debit; only when the setup is balanced. */
  offset: BankNumbers | null;
  /** When it's made, at BMG: 'YYYY-MM-DD' and 'HHMM'. */
  createdDay: string;
  createdTime: string;
  /** Tells it apart from the other files made for the day to First Bank. */
  modifier: string;
  /** The day First Bank pays them, 'YYYY-MM-DD'. */
  effectiveDate: string;
  payees: AchPayee[];
}

export interface AchFile {
  text: string;
  /** Its payments, the offsetting debit not counted. */
  entryCount: number;
  /** What it pays. */
  totalCents: number;
  /** The last 10 digits of the sum of the banks' 8-digit numbers, as First Bank checks the file with. */
  entryHash: string;
  /** Its records, the 9s that fill its last block too. */
  lines: number;
}

/** The most one payment can be: the file has 10 digits for it. */
export const ENTRY_MAX_CENTS = 9_999_999_999;

/** The bank's code for the entry: a credit to a checking or savings account, or the debit that offsets them. */
const codeFor = (type: AccountType, debit: boolean) => (type === 'checking' ? (debit ? '27' : '22') : (debit ? '37' : '32'));

const left = (text: string, width: number) => text.slice(0, width).padEnd(width, ' ');
const zeros = (n: number | string, width: number) => String(n).padStart(width, '0');
const yymmdd = (day: string) => `${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}`;
const dollars = (cents: number) => (cents / 100).toFixed(2);

/** A bill number as an addenda can carry it: what the file can't take left out, and never the addenda's own marks. */
const billRef = (number: string | null) => achText(number ?? '', 30) || 'BILL';

/**
 * What an addenda says about the bills a payment pays, in the bankers' way vendors' systems read: an RMR*IV segment
 * for each bill, its number and what's paid on it ('RMR*IV*B-4410**812.40\'), as many as fit in its 80 characters.
 */
export function addendaText(bills: Array<{ number: string | null; cents: number }>): string {
  let text = '';
  for (const b of bills) {
    const segment = `RMR*IV*${billRef(b.number)}**${dollars(b.cents)}\\`;
    if (text.length + segment.length > 80) break;
    text += segment;
  }
  return text;
}

/** Why a file can't be made from this, or none. */
export function fileProblems(input: AchFileInput): string[] {
  const problems = setupProblems({ ...input.setup });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.createdDay) || !/^([01]\d|2[0-3])[0-5]\d$/.test(input.createdTime)) problems.push('The file needs the day and time it was made.');
  if (input.modifier.length !== 1 || !MODIFIERS.includes(input.modifier)) problems.push('The file needs a letter or digit telling it apart from others made today.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveDate) || !isBankDay(input.effectiveDate)) problems.push('The file needs a banking day for First Bank to pay it.');
  if (input.payees.length === 0) problems.push('The file has no payments in it.');
  input.payees.forEach((p, i) => {
    const which = `Payment ${i + 1}`;
    if (routingProblem(p.routing) || !/^\d{9}$/.test(p.routing)) problems.push(`${which}: the routing number isn't one.`);
    if (!/^\d{4,17}$/.test(p.account)) problems.push(`${which}: the account number isn't one.`);
    if (!isAccountType(p.type)) problems.push(`${which}: it's to a checking or savings account.`);
    if (!Number.isInteger(p.cents) || p.cents <= 0 || p.cents > ENTRY_MAX_CENTS) problems.push(`${which}: the amount isn't one the file can carry.`);
    if (!achText(p.name, 22)) problems.push(`${which}: it needs the name on the account.`);
  });
  if (input.setup.balanced) {
    const o = input.offset;
    if (!o || routingProblem(o.routing) || !/^\d{4,17}$/.test(o.account) || !isAccountType(o.type)) {
      problems.push("A balanced file needs BMG's account the payments come from.");
    }
  }
  return problems;
}

/** The ACH file: its records, each 94 characters, filled out to blocks of ten with 9s. */
export function buildAchFile(input: AchFileInput): AchFile {
  const problems = fileProblems(input);
  if (problems.length > 0) throw new Error(`The ACH file can't be made: ${problems.join(' ')}`);
  const s = input.setup;
  const serviceClass = s.balanced ? '200' : '220';
  const records: string[] = [];

  records.push([
    '1', '01', ` ${s.destination}`, originField(s.origin), yymmdd(input.createdDay), input.createdTime, input.modifier, '094', '10', '1',
    left(s.destinationName, 23), left(s.originName, 23), left('', 8),
  ].join(''));
  records.push([
    '5', serviceClass, left(s.companyName, 16), left('', 20), left(s.companyId, 10), s.secCode, left(s.entryDescription, 10), left('', 6),
    yymmdd(input.effectiveDate), left('', 3), '1', s.odfi, zeros(1, 7),
  ].join(''));

  let sequence = 0;
  let hash = 0;
  let credits = 0;
  let addendaCount = 0;
  const entry = (n: BankNumbers, cents: number, debit: boolean, reference: string, name: string, addenda: string | null) => {
    sequence += 1;
    hash += Number(n.routing.slice(0, 8));
    records.push([
      '6', codeFor(n.type, debit), n.routing, left(n.account, 17), zeros(cents, 10), left(achText(reference, 15), 15), left(achText(name, 22), 22),
      left('', 2), addenda ? '1' : '0', s.odfi, zeros(sequence, 7),
    ].join(''));
    if (addenda) {
      addendaCount += 1;
      records.push(['7', '05', left(addenda, 80), zeros(1, 4), zeros(sequence, 7)].join(''));
    }
  };
  for (const p of input.payees) {
    credits += p.cents;
    entry(p, p.cents, false, p.reference, p.name, s.addenda ? addendaText(p.bills) || null : null);
  }
  const debits = s.balanced ? credits : 0;
  if (s.balanced && input.offset) entry(input.offset, credits, true, '', s.originName, null);

  const entryHash = zeros(String(hash).slice(-10), 10);
  const entriesAndAddenda = sequence + addendaCount;
  records.push([
    '8', serviceClass, zeros(entriesAndAddenda, 6), entryHash, zeros(debits, 12), zeros(credits, 12), left(s.companyId, 10), left('', 19), left('', 6),
    s.odfi, zeros(1, 7),
  ].join(''));
  const blocks = Math.ceil((records.length + 1) / 10);
  records.push(['9', zeros(1, 6), zeros(blocks, 6), zeros(entriesAndAddenda, 8), entryHash, zeros(debits, 12), zeros(credits, 12), left('', 39)].join(''));
  while (records.length < blocks * 10) records.push('9'.repeat(RECORD));

  const wrong = records.find((r) => r.length !== RECORD);
  if (wrong !== undefined) throw new Error(`An ACH record came out ${wrong.length} characters long, not ${RECORD}.`);
  const end = s.lineEnding === 'lf' ? '\n' : '\r\n';
  return { text: records.join(end) + end, entryCount: input.payees.length, totalCents: credits, entryHash, lines: records.length };
}

/** The name the file downloads as: 'ACH-BMG-2026-11-06-A.txt'. */
export const achFileName = (company: string, day: string, modifier: string) =>
  `ACH-${company.replace(/[^A-Za-z0-9]+/g, '') || 'BMG'}-${day}-${modifier}.txt`;

// ── Reading NetSuite's file ──────────────────────────────────────────────

/** How NetSuite's last ACH file for an account starts, and BMG's account when it's balanced: never a vendor's numbers. */
export interface ReadFile {
  setup: SetupTyped;
  /** BMG's account the offsetting debit comes from, when the file has one. */
  offset: BankNumbers | null;
  /** The payments in it, counted. */
  payments: number;
}

/**
 * How an ACH file NetSuite made starts, to set FleetSuite's up the same way: the names, IDs and codes from its file
 * header and first batch, whether its payments carry addenda, whether it ends with a debit to BMG's account that
 * offsets them (and that account), and how its lines end. Its payments are only counted.
 */
export function readAchFile(text: string): ReadFile | { problem: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (lines.length === 0 || lines[0][0] !== '1') return { problem: "That isn't an ACH file: one starts with its file header, a line starting 1." };
  if (lines.some((l) => l.length > RECORD)) return { problem: `That isn't an ACH file: its lines are ${RECORD} characters at most.` };
  const records = lines.map((l) => l.padEnd(RECORD, ' '));
  const header = records[0];
  const batchAt = records.findIndex((r) => r[0] === '5');
  if (batchAt < 0) return { problem: 'That ACH file has no batch in it, so how its payments are sent can\'t be read from it.' };
  const batch = records[batchAt];
  const endAt = records.findIndex((r, i) => i > batchAt && r[0] === '8');
  const entries = records.slice(batchAt + 1, endAt < 0 ? undefined : endAt).filter((r) => r[0] === '6');

  const code = (r: string) => r.slice(1, 3);
  const cents = (r: string) => Number(r.slice(29, 39));
  const payments = entries.filter((r) => code(r) === '22' || code(r) === '32');
  const debits = entries.filter((r) => code(r) === '27' || code(r) === '37');
  const paid = payments.reduce((sum, r) => sum + cents(r), 0);
  let offset: BankNumbers | null = null;
  if (debits.length > 0) {
    if (debits.length !== 1 || cents(debits[0]) !== paid) {
      return { problem: "That file's debits aren't one debit to BMG's account for what it pays, so how First Bank takes it can't be copied." };
    }
    const d = debits[0];
    const type: AccountType = code(d) === '27' ? 'checking' : 'savings';
    offset = { routing: d.slice(3, 12), account: d.slice(12, 29).trim(), type };
  }

  return {
    setup: {
      destination: header.slice(3, 13).trim(),
      destinationName: header.slice(40, 63).trim(),
      origin: header.slice(13, 23).trim(),
      originName: header.slice(63, 86).trim(),
      odfi: batch.slice(79, 87),
      companyName: batch.slice(4, 20).trim(),
      companyId: batch.slice(40, 50).trim(),
      entryDescription: batch.slice(53, 63).trim(),
      secCode: batch.slice(50, 53),
      addenda: payments.some((r) => r[78] === '1'),
      balanced: offset !== null,
      lineEnding: /\r\n/.test(text) ? 'crlf' : 'lf',
    },
    offset,
    payments: payments.length,
  };
}
