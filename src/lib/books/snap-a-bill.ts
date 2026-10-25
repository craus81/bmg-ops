import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { addDays, chicagoDate } from './own-invoices';
import { toCents } from './own-bills';
import type { BillRead, BillReadLine } from './bill-reader';

/**
 * Snap a bill (migration 436; owner decision 2026-10-25, thread "Replacing
 * NetSuite with FleetSuite", "Snap a bill", as Books Previews drew it;
 * docs/books.md "Snap a bill").
 *
 * A super admin takes a picture of a vendor's bill, or picks its PDF, and
 * FleetSuite reads it (src/lib/books/bill-reader.ts). This works out the rest
 * of the form from what the copies of NetSuite hold, and says what's still to
 * check before Send to NetSuite:
 *   - the vendor, matched by name to NetSuite's vendor list (the copy of it,
 *     every two hours, migration 363);
 *   - the due date, from the vendor's terms in NetSuite; the date printed on
 *     the bill when they have none;
 *   - each line's account, from where the vendor's earlier bills went (the
 *     copy of NetSuite's bills, migration 384): a line like one on an earlier
 *     bill goes where that one went, and the bill's biggest line where their
 *     bills keep going. A line that's new for the vendor waits for someone to
 *     pick the account;
 *   - the company and location, from where the copy of the general ledger
 *     books their bills (migration 361);
 *   - whether NetSuite already has it, by the Mistake checks rules: a bill
 *     from the vendor with the same number stops it (NetSuite is asked, and
 *     the copy of its bills looked through); a bill, check or card charge to
 *     them for the same amount within a week only warns.
 * Every rule here is pure; the route (/api/admin/books/snap-a-bill) gathers
 * what they read. Sending is the route's, once only (src/lib/bill-once.ts).
 */

export const SNAP_STORAGE_PREFIX = 'books-bills';
/** NetSuite takes a bill number (its Reference No.) this long at most; FleetSuite's other bills keep to it too. */
export const BILL_NUMBER_MAX = 40;
/** A bill and a check or card charge this many days apart can be one purchase (mistake-checks.ts BOTH_WAYS_DAYS). */
export const NEAR_DAYS = 7;
/** At most this many of a vendor's latest bills are looked at for suggestions. */
export const HISTORY_BILLS = 24;
/** The accounts an expense line can go to: what a bill can be for, not where its money comes from. */
export const BILL_LINE_ACCOUNT_TYPES: readonly string[] = [
  'expense', 'cost_of_goods_sold', 'other_expense', 'other_current_asset', 'fixed_asset', 'other_asset',
  'deferred_expense', 'other_current_liability', 'long_term_liability',
];

// ── What the rules read ────────────────────────────────────────────────────

export interface SnapLine {
  description: string;
  /** Whole cents; null while it's empty. */
  cents: number | null;
  /** NetSuite's id for the account. */
  accountId: string | null;
  /** True once someone chose the account, so a suggestion never replaces it. */
  picked: boolean;
}

/** The form as the page has it. */
export interface SnapForm {
  /** 'BMG' or '1084'. */
  company: string;
  vendorId: string | null;
  vendorName: string | null;
  billNumber: string | null;
  billDate: string | null;
  dueDate: string | null;
  /** True once someone typed the due date, so the terms never replace it. */
  duePicked: boolean;
  totalCents: number | null;
  locationId: string | null;
  lines: SnapLine[];
}

export interface SnapCompany {
  /** gl_companies.id. */
  id: string;
  code: string;
  name: string;
  subsidiaryId: string | null;
  locations: Array<{ id: string; name: string }>;
}

export interface SnapAccount {
  /** NetSuite's id. */
  id: string;
  number: string | null;
  name: string;
  type: string;
  /** The companies that can use it on a bill. */
  companies: string[];
}

export interface SnapVendor {
  id: string;
  name: string;
  entityId: string | null;
  termsId: string | null;
  expenseAccountId: string | null;
}

/** One of the vendor's earlier bills, as gl_vendor_bill_history gives it. */
export interface HistoryBill {
  netsuite_id: string;
  number: string | null;
  date: string;
  total: string;
  lines: Array<{ account: string | null; memo: string | null; amount: string | null }>;
  lines_known: boolean;
  companies: string[];
  locations: string[];
}

export interface VendorHistory {
  bills: HistoryBill[];
  same_number: Array<{ netsuite_id: string; number: string | null; date: string; total: string }>;
}

export const NO_HISTORY: VendorHistory = { bills: [], same_number: [] };

/** A bill, check or card charge near the bill's date, as gl_mistake_docs gives it. */
export interface NearbyDoc {
  netsuite_id: string;
  type: string;
  number: string | null;
  date: string;
  party: string | null;
  total: string;
  voided: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const dollars = (cents: number) => money.format(cents / 100);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Oct 20', with the year when it isn't this one. */
export const shortDay = (iso: string, today: string) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}${iso.slice(0, 4) === today.slice(0, 4) ? '' : `, ${iso.slice(0, 4)}`}`;
const DAY_MS = 86_400_000;
const daysApart = (a: string, b: string) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const amountOf = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? toCents(n) : null;
};
/** "Late payment charge" → "the late payment charge"; a name in capitals stays as it is. */
const theLine = (description: string, n: number) => {
  const d = description.trim();
  if (!d) return `line ${n}`;
  return `the ${/^[A-Z][a-z]/.test(d) ? d.charAt(0).toLowerCase() + d.slice(1) : d}`;
};

export const accountLabel = (a: Pick<SnapAccount, 'number' | 'name'>) => [a.number, a.name].filter(Boolean).join(' ');

// ── Vendor ─────────────────────────────────────────────────────────────────

const VENDOR_NOISE = new Set(['inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'the', 'and', 'of', 'lp', 'llp', 'pllc', 'pc']);

/** A vendor's name as words to compare: lowercase, no punctuation, no Inc, LLC or Co. */
export function vendorWords(name: string | null | undefined): string[] {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !VENDOR_NOISE.has(w));
}

const overlap = (a: string[], b: string[]) => {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let both = 0;
  for (const w of sa) if (sb.has(w)) both++;
  return both / (sa.size + sb.size - both);
};

export interface VendorMatch {
  vendor: SnapVendor | null;
  /** exact: the same name once Inc, LLC and punctuation are left out; close: the nearest, to check. */
  how: 'exact' | 'close' | null;
  /** Others it could be, nearest first. */
  others: SnapVendor[];
}

/** The NetSuite vendor a name read off a bill is. Pure. */
export function matchVendor(name: string | null, vendors: SnapVendor[]): VendorMatch {
  const words = vendorWords(name);
  if (!words.length) return { vendor: null, how: null, others: [] };
  const key = words.join(' ');
  const exact = vendors.filter((v) => vendorWords(v.name).join(' ') === key || (v.entityId && vendorWords(v.entityId).join(' ') === key));
  if (exact.length === 1) return { vendor: exact[0], how: 'exact', others: [] };
  if (exact.length > 1) return { vendor: null, how: null, others: exact.slice(0, 5) };
  const scored = vendors
    .map((v) => ({ v, score: Math.max(overlap(words, vendorWords(v.name)), v.entityId ? overlap(words, vendorWords(v.entityId)) : 0) }))
    .filter((s) => s.score >= 1 / 3)
    .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name));
  const [best, next] = scored;
  if (best && best.score >= 0.5 && (!next || next.score < best.score)) {
    return { vendor: best.v, how: 'close', others: scored.slice(1, 5).map((s) => s.v) };
  }
  return { vendor: null, how: null, others: scored.slice(0, 5).map((s) => s.v) };
}

// ── Due date ───────────────────────────────────────────────────────────────

export interface DueSuggestion {
  date: string | null;
  text: string | null;
}

/** The due date: the bill's date plus the vendor's terms in NetSuite, else as printed on the bill. Pure. */
export function suggestDue(
  billDate: string | null,
  terms: { name: string; days: number } | null,
  printed: string | null,
  vendorKnown: boolean,
  today: string,
): DueSuggestion {
  if (billDate && terms) {
    const date = addDays(billDate, Math.max(0, Math.round(terms.days)));
    const differs = printed && printed !== date ? ` The bill itself says ${shortDay(printed, today)}.` : '';
    return { date, text: `${terms.name}, their terms in NetSuite.${differs}` };
  }
  if (printed) return { date: printed, text: vendorKnown ? 'As printed on the bill: their vendor in NetSuite has no terms.' : 'As printed on the bill.' };
  return { date: null, text: vendorKnown && billDate ? "Their vendor in NetSuite has no terms and the bill prints no due date. Left empty, NetSuite works it out." : null };
}

// ── Accounts ───────────────────────────────────────────────────────────────

export interface AccountSuggestion {
  accountId: string | null;
  /** Why, in a sentence; amber when there's no account. */
  text: string;
}

const MONTH_WORDS = new Set([
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'january', 'february',
  'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
]);
const MEMO_NOISE = new Set(['and', 'the', 'for', 'from', 'thru', 'through', 'with', 'per', 'our', 'your', 'this', 'that', 'inv', 'invoice', 'bill']);

/** What a line is for, as words to compare: no dates, numbers or months. */
export function memoWords(text: string | null | undefined): string[] {
  return (text ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ')
    .filter((w) => w.length >= 3 && !MONTH_WORDS.has(w) && !MEMO_NOISE.has(w));
}

/** A line is like an earlier one when this much of what they're for is the same. */
export const LIKE_SHARE = 0.5;

/** The account of a bill's biggest expense line, or null when its lines aren't known. */
const mainAccount = (bill: HistoryBill): string | null => {
  let best: { account: string; cents: number } | null = null;
  for (const l of bill.lines) {
    const c = Math.abs(amountOf(l.amount) ?? 0);
    if (l.account && (!best || c > best.cents)) best = { account: l.account, cents: c };
  }
  return best?.account ?? null;
};

/**
 * Where the vendor's bills keep going: the account of the biggest line on their latest bills when it's the same on
 * each, or on at least two thirds of up to twelve of them. Pure.
 */
export function usualAccount(bills: HistoryBill[]): { accountId: string; bills: number; of: number } | null {
  const mains = bills.map(mainAccount).filter((a): a is string => !!a);
  if (!mains.length) return null;
  let run = 0;
  while (run < mains.length && mains[run] === mains[0]) run++;
  if (run === mains.length) return { accountId: mains[0], bills: run, of: run };
  const latest = mains.slice(0, 12);
  const counts = new Map<string, number>();
  for (const a of latest) counts.set(a, (counts.get(a) ?? 0) + 1);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return top && top[1] * 3 >= latest.length * 2 ? { accountId: top[0], bills: top[1], of: latest.length } : null;
}

/**
 * Each line's account from where the vendor's earlier bills went, in the company it's for (their bills the copy of the
 * general ledger books elsewhere are left out). A line like an earlier one goes where that one went; the biggest line
 * where their bills keep going, else to the vendor's default expense account when they've no bills yet. Anything else
 * waits for someone to pick. Only accounts the company can use are suggested. Pure.
 */
export function suggestAccounts(
  lines: Array<Pick<SnapLine, 'description' | 'cents'>>,
  history: HistoryBill[],
  ctx: {
    company: string;
    vendorKnown: boolean;
    vendorDefault: string | null;
    usable: (accountId: string) => boolean;
    label: (accountId: string) => string;
  },
): AccountSuggestion[] {
  if (!ctx.vendorKnown) return lines.map(() => ({ accountId: null, text: "Pick the account. FleetSuite suggests one once it knows the vendor." }));
  const bills = history.filter((b) => !b.companies.length || b.companies.includes(ctx.company));
  const usual = usualAccount(bills);
  const usualText = usual
    ? usual.bills === usual.of
      ? `Their last ${usual.bills === 1 ? 'bill' : `${usual.bills} bills`} went to ${ctx.label(usual.accountId)}.`
      : `${usual.bills} of their last ${usual.of} bills went to ${ctx.label(usual.accountId)}.`
    : null;
  const earlier = bills.flatMap((b) => b.lines.filter((l) => l.account && l.memo).map((l) => ({ account: l.account!, memo: l.memo!, words: memoWords(l.memo) })));
  let biggest = -1;
  lines.forEach((l, i) => {
    if (biggest < 0 || Math.abs(l.cents ?? 0) > Math.abs(lines[biggest].cents ?? 0)) biggest = i;
  });

  const fresh = bills.length ? 'New for this vendor, so pick the account.' : 'No earlier bills from them, so pick the account.';
  const offer = (accountId: string, text: string): AccountSuggestion => (ctx.usable(accountId)
    ? { accountId, text }
    : { accountId: null, text: `Their earlier bills went to ${ctx.label(accountId)}, which ${ctx.company} can't use on a bill, so pick the account.` });

  return lines.map((line, i) => {
    const words = memoWords(line.description);
    let like: (typeof earlier)[number] | null = null;
    let likeShare = 0;
    for (const e of earlier) {
      const share = overlap(words, e.words);
      if (share > likeShare) {
        like = e;
        likeShare = share;
      }
    }
    if (like && likeShare >= LIKE_SHARE) {
      if (i === biggest && usual?.accountId === like.account) return offer(like.account, usualText!);
      const memo = like.memo.length > 60 ? `${like.memo.slice(0, 57)}…` : like.memo;
      return offer(like.account, `Like their earlier line "${memo}", which went to ${ctx.label(like.account)}.`);
    }
    if (i === biggest && usual) return offer(usual.accountId, usualText!);
    if (i === biggest && !bills.length && ctx.vendorDefault) return offer(ctx.vendorDefault, 'Their default expense account in NetSuite.');
    return { accountId: null, text: fresh };
  });
}

/** The company the vendor's bills are booked to most, when it's one, else null. Pure. */
export function usualCompany(history: HistoryBill[]): string | null {
  const counts = new Map<string, number>();
  for (const b of history) if (b.companies.length === 1) counts.set(b.companies[0], (counts.get(b.companies[0]) ?? 0) + 1);
  const [top, next] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return top && (!next || top[1] > next[1]) ? top[0] : null;
}

/** Where the vendor's bills in the company usually go, from those the company has; else the company's main location. Pure. */
export function suggestLocation(company: SnapCompany, history: HistoryBill[], fallbackId: string | null): { id: string | null; text: string | null } {
  const have = new Set(company.locations.map((l) => l.id));
  const counts = new Map<string, number>();
  for (const b of history) {
    if (b.companies.length && !b.companies.includes(company.code)) continue;
    for (const loc of b.locations) if (have.has(loc)) counts.set(loc, (counts.get(loc) ?? 0) + 1);
  }
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (top) return { id: top[0], text: 'Where their bills usually go.' };
  if (fallbackId && have.has(fallbackId)) return { id: fallbackId, text: null };
  const main = company.locations.find((l) => /fallon/i.test(l.name)) ?? company.locations[0];
  return { id: main?.id ?? null, text: null };
}

// ── The same bill ──────────────────────────────────────────────────────────

/** NetSuite's bill that would make this one a second entry. */
export interface SameBill {
  netsuiteId: string;
  number: string | null;
  date: string | null;
  cents: number | null;
}

/** What NetSuite said when asked for a bill from the vendor with this number: the bill, none, or why it couldn't say. */
export type AskedNetsuite = { found: SameBill | null } | { error: string } | null;

/** A bill, check or card charge to the vendor for the same amount within NEAR_DAYS, as a sentence's facts. */
export interface NearCharge {
  netsuiteId: string;
  type: string;
  number: string | null;
  date: string;
  days: number;
}

const NOUNS: Record<string, string> = { VendBill: 'bill', Check: 'check', CardChrg: 'card charge' };

/** Bills, checks and card charges to the vendor for the same amount within NEAR_DAYS of the bill's date. Pure. */
export function nearCharges(docs: NearbyDoc[], vendorId: string, cents: number, billDate: string): NearCharge[] {
  return docs
    .filter((d) => d.party === vendorId && !d.voided && NOUNS[d.type] && amountOf(d.total) === cents && daysApart(d.date, billDate) <= NEAR_DAYS)
    .map((d) => ({ netsuiteId: d.netsuite_id, type: d.type, number: d.number, date: d.date, days: daysApart(d.date, billDate) }))
    .sort((a, b) => a.days - b.days || a.date.localeCompare(b.date));
}

// ── What the page shows ────────────────────────────────────────────────────

export interface SnapNote {
  tone: 'green' | 'amber' | 'red';
  text: string;
  link?: { label: string; url: string } | null;
}

export interface SnapView {
  vendor: { tone: 'green' | 'amber' | null; text: string | null; others: Array<{ id: string; name: string }> };
  due: DueSuggestion;
  /** One per line of the form, in its order. */
  accounts: AccountSuggestion[];
  location: { id: string | null; text: string | null };
  /** A note under Company, when the vendor's bills usually go to the other one. */
  company: string | null;
  /** NetSuite already has the bill: Send stays greyed out. */
  stop: (SameBill & { url: string | null; text: string }) | null;
  /** Under the lines, in order: green, then amber, then red. */
  notes: SnapNote[];
  /** What must change before Send, each in a sentence (the red notes). */
  problems: string[];
  canSend: boolean;
}

/** Everything the view is worked out from, besides the form. */
export interface SnapFacts {
  companies: SnapCompany[];
  accounts: Map<string, SnapAccount>;
  vendor: SnapVendor | null;
  /** How the vendor was matched to the name read off the bill, when it was. */
  match: VendorMatch | null;
  terms: { name: string; days: number } | null;
  history: VendorHistory;
  asked: AskedNetsuite;
  nearby: NearbyDoc[];
  read: BillRead | null;
  /** The location to fall back on when the vendor's bills say nothing: NETSUITE_DEFAULT_LOCATION_ID. */
  defaultLocationId: string | null;
  link: (type: string, netsuiteId: string) => string | null;
  today: string;
}

/** Whether a company can use an account on a bill. */
export const usableBy = (account: SnapAccount | undefined, company: string) => !!account && account.companies.includes(company);

/** What the page shows for a form: the suggestions, the notes under the lines, and whether it can be sent. Pure. */
export function viewSnapForm(form: SnapForm, facts: SnapFacts): SnapView {
  const company = facts.companies.find((c) => c.code === form.company) ?? null;
  const label = (id: string) => {
    const a = facts.accounts.get(id);
    return a ? accountLabel(a) : `NetSuite account ${id}`;
  };
  const who = facts.vendor?.name ?? form.vendorName ?? 'the vendor';

  // The vendor.
  let vendor: SnapView['vendor'] = { tone: null, text: null, others: [] };
  if (facts.vendor) {
    vendor = facts.match?.how === 'close'
      ? { tone: 'amber', text: `Closest in NetSuite: ${facts.vendor.name}. Check it's the same vendor.`, others: facts.match.others.map((v) => ({ id: v.id, name: v.name })) }
      : { tone: 'green', text: `Matched to ${facts.vendor.name} in NetSuite.`, others: [] };
  } else if (facts.match?.others.length) {
    vendor = { tone: 'amber', text: 'Not sure which vendor in NetSuite this is. Pick one.', others: facts.match.others.map((v) => ({ id: v.id, name: v.name })) };
  }

  const due = suggestDue(form.billDate, facts.terms, facts.read?.dueDate ?? null, !!facts.vendor, facts.today);
  const accounts = suggestAccounts(form.lines, facts.history.bills, {
    company: form.company,
    vendorKnown: !!facts.vendor,
    vendorDefault: facts.vendor?.expenseAccountId ?? null,
    usable: (id) => usableBy(facts.accounts.get(id), form.company),
    label,
  });
  const location = company ? suggestLocation(company, facts.history.bills, facts.defaultLocationId) : { id: null, text: null };
  const usual = usualCompany(facts.history.bills);
  const companyNote = usual && usual !== form.company ? `Their earlier bills went to ${usual}.` : null;

  const notes: SnapNote[] = [];
  const problems: string[] = [];
  const red = (text: string) => problems.push(text);

  // The lines against the bill's total.
  const lineCents = form.lines.map((l) => l.cents);
  const sum = lineCents.every((c) => c !== null) ? lineCents.reduce((n: number, c) => n + (c as number), 0) : null;
  if (form.lines.length && sum !== null && form.totalCents !== null) {
    if (sum === form.totalCents) notes.push({ tone: 'green', text: `The lines add up to ${dollars(sum)}, the bill's total.` });
    else red(`The lines add up to ${dollars(sum)}, ${dollars(Math.abs(sum - form.totalCents))} ${sum < form.totalCents ? 'less' : 'more'} than the bill's total of ${dollars(form.totalCents)}.`);
  }
  const amountDue = facts.read?.amountDueCents ?? null;
  if (amountDue !== null && form.totalCents !== null && amountDue > form.totalCents) {
    notes.push({ tone: 'amber', text: `The bill says ${dollars(amountDue)} is due, more than its own charges: it likely carries an earlier balance. Only this bill's charges go into NetSuite.` });
  }

  // NetSuite already has it? NetSuite is asked for the number as typed; the copy of its bills also finds it typed
  // another way (88213-10 for 8821310), and has the date and amount NetSuite's answer leaves out.
  let stop: SnapView['stop'] = null;
  const number = form.billNumber?.trim() ?? '';
  if (form.vendorId && number) {
    const found = facts.asked && 'found' in facts.asked ? facts.asked.found : null;
    const copies = facts.history.same_number.map((b) => ({ netsuiteId: b.netsuite_id, number: b.number, date: b.date, cents: amountOf(b.total) }));
    const same: SameBill | null = found ? (copies.find((c) => c.netsuiteId === found.netsuiteId) ?? found) : (copies[0] ?? null);
    if (same) {
      const dated = same.date ? `, dated ${shortDay(same.date, facts.today)}` : '';
      const amount = same.cents !== null ? ` for ${dollars(same.cents)}` : '';
      stop = {
        ...same,
        url: facts.link('VendBill', same.netsuiteId),
        text: `NetSuite already has ${who}'s bill ${same.number ?? number}${amount}${dated}. Sending this one would enter it twice.`,
      };
    } else if (facts.asked && 'error' in facts.asked) {
      notes.push({ tone: 'amber', text: `Couldn't ask NetSuite whether it already has bill ${number}: ${facts.asked.error}. Send to NetSuite asks again before it enters anything.` });
    }
  }
  if (form.vendorId && form.totalCents !== null && form.totalCents > 0 && form.billDate && !stop) {
    const near = nearCharges(facts.nearby, form.vendorId, form.totalCents, form.billDate);
    for (const n of near) {
      const gap = n.days === 0 ? 'the same day' : `${plural(n.days, 'day', 'days')} ${n.date < form.billDate ? 'before' : 'after'} this bill`;
      const what = n.type === 'VendBill' ? `a bill${n.number ? ` (${n.number})` : ''}` : `a ${NOUNS[n.type]}`;
      notes.push({
        tone: 'amber',
        text: `${who} has ${what} for ${dollars(form.totalCents)} dated ${shortDay(n.date, facts.today)}, ${gap}. It may be this bill already entered. Check before sending.`,
        link: (() => {
          const url = facts.link(n.type, n.netsuiteId);
          return url ? { label: `The ${NOUNS[n.type]} in NetSuite`, url } : null;
        })(),
      });
    }
    if (!near.length && number && facts.asked && 'found' in facts.asked) {
      notes.push({ tone: 'green', text: `Not in NetSuite yet: no ${who} bill ${number}, and no bill, check or card charge to them for ${dollars(form.totalCents)} within a week.` });
    }
  }

  // What must change before Send.
  if (!company) red(`FleetSuite doesn't know the company ${form.company}.`);
  else if (!company.subsidiaryId) red(`${company.code} isn't linked to a NetSuite subsidiary yet, so its bills can't be sent.`);
  if (!form.vendorId) red("Pick the vendor from NetSuite's list before sending.");
  if (!number) red('Fill in the bill number.');
  else if (number.length > BILL_NUMBER_MAX) red(`NetSuite takes a bill number of up to ${BILL_NUMBER_MAX} characters.`);
  if (!form.billDate) red('Fill in the bill date.');
  if (form.billDate && form.dueDate && form.dueDate < form.billDate) red('The due date is before the bill date.');
  if (company?.locations.length) {
    if (!form.locationId) red('Pick a location.');
    else if (!company.locations.some((l) => l.id === form.locationId)) red(`Pick one of ${company.code}'s locations.`);
  }
  if (form.totalCents === null) red("Fill in the bill's total.");
  else if (form.totalCents <= 0) red("A bill's total must be more than $0.");
  if (!form.lines.length) red('Add a line.');
  if (form.lines.some((l) => l.cents === null || l.cents === 0)) red("Fill in each line's amount.");
  const noAccount = form.lines.map((l, i) => ({ l, i })).filter(({ l }) => !l.accountId);
  if (noAccount.length === 1) red(`Pick an account for ${theLine(noAccount[0].l.description, noAccount[0].i + 1)} before sending.`);
  else if (noAccount.length > 1) red(`Pick an account for ${noAccount.length} lines before sending.`);
  form.lines.forEach((l, i) => {
    if (l.accountId && !usableBy(facts.accounts.get(l.accountId), form.company)) {
      red(`${label(l.accountId)} can't be used on ${form.company}'s bills: pick another account for ${theLine(l.description, i + 1)}.`);
    }
  });
  for (const p of problems) notes.push({ tone: 'red', text: p });
  const TONES: SnapNote['tone'][] = ['green', 'amber', 'red'];

  return {
    vendor,
    due,
    accounts,
    location,
    company: companyNote,
    stop,
    notes: notes.map((n, i) => ({ n, i })).sort((a, b) => TONES.indexOf(a.n.tone) - TONES.indexOf(b.n.tone) || a.i - b.i).map(({ n }) => n),
    problems,
    canSend: !problems.length && !stop,
  };
}

/** A Send that failed, or one that kept its claim: NetSuite may have the bill without the snapped bill saying so. */
export const sendUnfinished = (row: Pick<SnappedBillRow, 'send_error' | 'bill_claimed_at'>) => !!row.send_error || !!row.bill_claimed_at;

/**
 * The bill Mark it sent keeps a snapped bill as: the one NetSuite itself just named under the vendor and number, for a
 * bill whose Send didn't finish and with nothing left in red. Else why not. Pure.
 */
export function billToMarkSent(unfinished: boolean, view: Pick<SnapView, 'problems'>, asked: AskedNetsuite, number: string): { bill: SameBill } | { error: string } {
  if (!unfinished) return { error: "Only a bill whose Send didn't finish can be marked sent." };
  if (view.problems.length) return { error: view.problems[0] };
  if (asked && 'found' in asked && asked.found) return { bill: asked.found };
  const why = asked && 'error' in asked ? `Couldn't ask NetSuite for it (${asked.error})` : `NetSuite has no bill ${number} from them`;
  return { error: `${why}, so nothing was marked sent.` };
}

/** What settleForm and formFromRead work from. */
export type SettleFacts = Pick<SnapFacts, 'companies' | 'accounts' | 'vendor' | 'terms' | 'history' | 'read' | 'defaultLocationId' | 'today'>;

/**
 * The form with what FleetSuite suggests filled in where nobody has chosen: each line's account until someone picks
 * one, the due date until someone types one, and the location when the company has no such location (it was just
 * switched). Run on the form each time it changes, so a suggestion follows the vendor, the lines and the company. Pure.
 */
export function settleForm(form: SnapForm, facts: SettleFacts): SnapForm {
  const label = (id: string) => {
    const a = facts.accounts.get(id);
    return a ? accountLabel(a) : `NetSuite account ${id}`;
  };
  const accounts = suggestAccounts(form.lines, facts.history.bills, {
    company: form.company,
    vendorKnown: !!facts.vendor,
    vendorDefault: facts.vendor?.expenseAccountId ?? null,
    usable: (id) => usableBy(facts.accounts.get(id), form.company),
    label,
  });
  const company = facts.companies.find((c) => c.code === form.company);
  const locationOk = !!company && company.locations.some((l) => l.id === form.locationId);
  return {
    ...form,
    dueDate: form.duePicked ? form.dueDate : suggestDue(form.billDate, facts.terms, facts.read?.dueDate ?? null, !!facts.vendor, facts.today).date,
    locationId: !company || locationOk ? form.locationId : suggestLocation(company, facts.history.bills, facts.defaultLocationId).id,
    lines: form.lines.map((l, i) => (l.picked ? l : { ...l, accountId: accounts[i]?.accountId ?? null })),
  };
}

/** The form FleetSuite starts from once it has read the bill, before anyone checks it. Pure. */
export function formFromRead(read: BillRead, facts: SettleFacts): SnapForm {
  return settleForm({
    company: usualCompany(facts.history.bills) ?? 'BMG',
    vendorId: facts.vendor?.id ?? null,
    vendorName: facts.vendor?.name ?? read.vendorName,
    billNumber: read.billNumber,
    billDate: read.billDate,
    dueDate: null,
    duePicked: false,
    // Never the lines added up: the total is what they're checked against.
    totalCents: read.totalCents,
    locationId: null,
    lines: read.lines.map((l: BillReadLine) => ({ description: l.description, cents: l.cents, accountId: null, picked: false })),
  }, { ...facts, read });
}

// ── The saved row ──────────────────────────────────────────────────────────

/** What FleetSuite keeps of a read (gl_snapped_bills.read_result): the bill as read, and the vendor its name matched. */
export interface StoredRead {
  read: BillRead;
  match: { vendorId: string | null; how: 'exact' | 'close' | null; others: Array<{ id: string; name: string }> };
}

/** The read kept for a match, as FleetSuite keeps it. Pure. */
export function storedReadOf(read: BillRead, match: VendorMatch): StoredRead {
  return { read, match: { vendorId: match.vendor?.id ?? null, how: match.how, others: match.others.map((v) => ({ id: v.id, name: v.name })) } };
}

/** A kept read back from the database; null when there's none, or it isn't one. */
export function storedReadFrom(v: unknown): StoredRead | null {
  const r = (v && typeof v === 'object' ? v : null) as Partial<StoredRead> | null;
  if (!r?.read || typeof r.read !== 'object' || !Array.isArray(r.read.lines) || !r.match || typeof r.match !== 'object') return null;
  return {
    read: r.read,
    match: {
      vendorId: typeof r.match.vendorId === 'string' ? r.match.vendorId : null,
      how: r.match.how === 'exact' || r.match.how === 'close' ? r.match.how : null,
      others: Array.isArray(r.match.others) ? r.match.others.filter((o) => o && typeof o.id === 'string' && typeof o.name === 'string') : [],
    },
  };
}

/**
 * How the form's vendor was found: as the read matched it while it's still that vendor, else picked from NetSuite's
 * list (shown as matched). With no vendor yet, the ones the name read off the bill could be. Pure.
 */
export function matchFor(vendorId: string | null, vendor: SnapVendor | null, stored: StoredRead | null): VendorMatch | null {
  if (!stored) return vendorId ? { vendor, how: 'exact', others: [] } : null;
  const others = stored.match.others.map((o) => ({ id: o.id, name: o.name, entityId: null, termsId: null, expenseAccountId: null }));
  if (!vendorId) return { vendor: null, how: null, others };
  if (vendorId === stored.match.vendorId) return { vendor, how: stored.match.how, others };
  return { vendor, how: 'exact', others: [] };
}

/** A gl_snapped_bills row, as the route reads it. */
export interface SnappedBillRow {
  id: string;
  company_id: string;
  file_path: string;
  file_type: string;
  file_name: string | null;
  read_result: unknown;
  read_at: string | null;
  read_error: string | null;
  vendor_netsuite_id: string | null;
  vendor_name: string | null;
  bill_number: string | null;
  bill_date: string | null;
  due_date: string | null;
  total: string | number | null;
  location_netsuite_id: string | null;
  lines: unknown;
  due_picked: boolean;
  status: 'draft' | 'sent' | 'thrown_away';
  bill_claimed_at: string | null;
  send_error: string | null;
  netsuite_id: string | null;
  netsuite_number: string | null;
  sent_at: string | null;
  sent_by: string | null;
  thrown_away_at: string | null;
  thrown_away_by: string | null;
  made_by: string | null;
  made_at: string;
  saved_at: string;
}

export const SNAPPED_BILL_COLUMNS = 'id, company_id, file_path, file_type, file_name, read_result, read_at, read_error, '
  + 'vendor_netsuite_id, vendor_name, bill_number, bill_date, due_date, total, location_netsuite_id, lines, due_picked, '
  + 'status, bill_claimed_at, send_error, netsuite_id, netsuite_number, sent_at, sent_by, thrown_away_at, thrown_away_by, '
  + 'made_by, made_at, saved_at';

/** The form a saved row holds. Pure. */
export function formOfRow(row: SnappedBillRow, companies: Pick<SnapCompany, 'id' | 'code'>[]): SnapForm {
  const lines = Array.isArray(row.lines) ? (row.lines as Array<Record<string, unknown>>) : [];
  return {
    company: companies.find((c) => c.id === row.company_id)?.code ?? 'BMG',
    vendorId: row.vendor_netsuite_id,
    vendorName: row.vendor_name,
    billNumber: row.bill_number,
    billDate: row.bill_date,
    dueDate: row.due_date,
    duePicked: row.due_picked,
    totalCents: amountOf(row.total === null ? null : String(row.total)),
    locationId: row.location_netsuite_id,
    lines: lines.map((l) => ({
      description: typeof l.description === 'string' ? l.description : '',
      cents: amountOf(l.amount === null || l.amount === undefined ? null : String(l.amount)),
      accountId: typeof l.account_netsuite_id === 'string' && /^\d+$/.test(l.account_netsuite_id) ? l.account_netsuite_id : null,
      picked: l.picked === true,
    })),
  };
}

/** The columns a form is saved to. Pure. */
export function rowOfForm(form: SnapForm, companyId: string): Record<string, unknown> {
  const blank = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return {
    company_id: companyId,
    vendor_netsuite_id: form.vendorId,
    vendor_name: blank(form.vendorName),
    bill_number: blank(form.billNumber),
    bill_date: form.billDate,
    due_date: form.dueDate,
    due_picked: form.duePicked,
    total: form.totalCents === null ? null : (form.totalCents / 100).toFixed(2),
    location_netsuite_id: form.locationId,
    lines: form.lines.map((l) => ({
      description: l.description.trim(),
      amount: l.cents === null ? null : (l.cents / 100).toFixed(2),
      account_netsuite_id: l.accountId,
      picked: l.picked,
    })),
  };
}

/** A send NetSuite turned down, as the page says it: NetSuite's own words, not the body FleetSuite sent. Pure. */
export function plainSendError(error: string): string {
  const text = error.replace(/ \| sent: [\s\S]*$/, '');
  if (!/^NetSuite error \(/.test(text)) return text.slice(0, 600);
  const detail = text.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\"/g, '"');
  const hint = text.match(/ — NetSuite won't accept a currency[\s\S]*$/)?.[0] ?? '';
  return (detail ? `NetSuite didn't take the bill: ${detail}${hint}` : text).slice(0, 600);
}

// ── Reading what the rules read ────────────────────────────────────────────

/** The companies a bill can be for, with their NetSuite subsidiary and its locations. */
export async function readCompanies(service: SupabaseClient): Promise<SnapCompany[]> {
  const [companies, locations] = await Promise.all([
    service.from('gl_companies').select('id, code, name, netsuite_subsidiary_id').order('code'),
    fetchAllRows<{ netsuite_id: string; name: string; details: { subsidiary_id?: string } | null }>((from, to) => service
      .from('gl_netsuite_lists')
      .select('netsuite_id, name, details')
      .eq('kind', 'location')
      .eq('active', true)
      .is('gone_at', null)
      .order('netsuite_id', { ascending: true })
      .range(from, to)),
  ]);
  if (companies.error) throw new Error(`couldn't read the companies (${companies.error.message})`);
  if (locations.error) throw new Error(`couldn't read NetSuite's locations (${locations.error.message})`);
  return ((companies.data ?? []) as Array<{ id: string; code: string; name: string; netsuite_subsidiary_id: string | null }>).map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    subsidiaryId: c.netsuite_subsidiary_id,
    locations: c.netsuite_subsidiary_id
      ? locations.data
        .filter((l) => l.details?.subsidiary_id === c.netsuite_subsidiary_id)
        .map((l) => ({ id: l.netsuite_id, name: l.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
      : [],
  }));
}

/** Every account a bill's line can go to, each with the companies that can use it, by NetSuite's id. */
export async function readAccounts(service: SupabaseClient, companies: SnapCompany[]): Promise<Map<string, SnapAccount>> {
  const rows = await fetchAllRows<{
    netsuite_account_id: string; number: string | null; name: string; account_type: string; company_id: string | null;
    netsuite_subsidiary_ids: string[] | null; active: boolean; is_summary: boolean;
  }>((from, to) => service
    .from('gl_accounts')
    .select('netsuite_account_id, number, name, account_type, company_id, netsuite_subsidiary_ids, active, is_summary')
    .not('netsuite_account_id', 'is', null)
    .order('netsuite_account_id', { ascending: true })
    .range(from, to));
  if (rows.error) throw new Error(`couldn't read the accounts (${rows.error.message})`);
  const codeOf = new Map(companies.map((c) => [c.id, c.code]));
  const accounts = new Map<string, SnapAccount>();
  for (const a of rows.data) {
    const usable = a.active && !a.is_summary && BILL_LINE_ACCOUNT_TYPES.includes(a.account_type);
    const companiesFor = usable
      ? companies
        .filter((c) => c.subsidiaryId
          && (!a.company_id || codeOf.get(a.company_id) === c.code)
          && (!a.netsuite_subsidiary_ids?.length || a.netsuite_subsidiary_ids.includes(c.subsidiaryId)))
        .map((c) => c.code)
      : [];
    accounts.set(a.netsuite_account_id, { id: a.netsuite_account_id, number: a.number, name: a.name, type: a.account_type, companies: companiesFor });
  }
  return accounts;
}

interface VendorListRow {
  netsuite_id: string;
  name: string;
  details: { entity_id?: string; terms_id?: string; expense_account?: string } | null;
}

const vendorOf = (r: VendorListRow): SnapVendor => ({
  id: r.netsuite_id,
  name: r.name,
  entityId: r.details?.entity_id ?? null,
  termsId: r.details?.terms_id ?? null,
  expenseAccountId: r.details?.expense_account ?? null,
});

/** Every active vendor in the copy of NetSuite's vendor list. */
export async function readVendors(service: SupabaseClient): Promise<SnapVendor[]> {
  const res = await fetchAllRows<VendorListRow>((from, to) => service
    .from('gl_netsuite_lists')
    .select('netsuite_id, name, details')
    .eq('kind', 'vendor')
    .eq('active', true)
    .is('gone_at', null)
    .order('netsuite_id', { ascending: true })
    .range(from, to));
  if (res.error) throw new Error(`couldn't read NetSuite's vendors (${res.error.message})`);
  return res.data.map(vendorOf);
}

/** One vendor from the copy of NetSuite's vendor list, active or not; null when the copy doesn't have it. */
export async function readVendor(service: SupabaseClient, id: string): Promise<SnapVendor | null> {
  const res = await service.from('gl_netsuite_lists').select('netsuite_id, name, details').eq('kind', 'vendor').eq('netsuite_id', id).maybeSingle();
  if (res.error) throw new Error(`couldn't read the vendor (${res.error.message})`);
  return res.data ? vendorOf(res.data as VendorListRow) : null;
}

/** Up to twelve active vendors whose name has each word typed, in order. */
export async function searchVendors(service: SupabaseClient, typed: string): Promise<SnapVendor[]> {
  const words = typed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (!words.length) return [];
  const res = await service
    .from('gl_netsuite_lists')
    .select('netsuite_id, name, details')
    .eq('kind', 'vendor')
    .eq('active', true)
    .is('gone_at', null)
    .ilike('name', `%${words.slice(0, 6).join('%')}%`)
    .order('name', { ascending: true })
    .limit(12);
  if (res.error) throw new Error(`couldn't search NetSuite's vendors (${res.error.message})`);
  return ((res.data ?? []) as VendorListRow[]).map(vendorOf);
}

/** The vendor's terms in NetSuite: their name and days until due; null without terms or days. */
export async function readTerms(service: SupabaseClient, termsId: string | null): Promise<{ name: string; days: number } | null> {
  if (!termsId) return null;
  const res = await service.from('gl_netsuite_lists').select('name, details').eq('kind', 'term').eq('netsuite_id', termsId).maybeSingle();
  if (res.error) throw new Error(`couldn't read the vendor's terms (${res.error.message})`);
  const row = res.data as { name: string; details: { days_until_net_due?: number | string } | null } | null;
  const days = Number(row?.details?.days_until_net_due);
  return row && row.details?.days_until_net_due !== undefined && Number.isFinite(days) ? { name: row.name, days } : null;
}

/** What the copies hold about the vendor's bills, with any of theirs numbered like this one. */
export async function readHistory(service: SupabaseClient, vendorId: string | null, billNumber: string | null): Promise<VendorHistory> {
  if (!vendorId) return NO_HISTORY;
  const res = await service.rpc('gl_vendor_bill_history', { p_vendor: vendorId, p_number: billNumber?.trim() || null, p_limit: HISTORY_BILLS });
  if (res.error) throw new Error(`couldn't read the vendor's earlier bills (${res.error.message})`);
  const data = (res.data ?? {}) as Partial<VendorHistory>;
  return { bills: data.bills ?? [], same_number: data.same_number ?? [] };
}

/** The bills, checks and card charges in the copies within NEAR_DAYS of the bill's date. */
export async function readNearby(service: SupabaseClient, billDate: string | null): Promise<NearbyDoc[]> {
  if (!billDate) return [];
  const res = await service.rpc('gl_mistake_docs', { p_from: addDays(billDate, -NEAR_DAYS), p_to: addDays(billDate, NEAR_DAYS + 1) });
  if (res.error) throw new Error(`couldn't read the bills, checks and card charges near its date (${res.error.message})`);
  return (res.data ?? []) as NearbyDoc[];
}

/** Today in Central time, for the dates the page writes. */
export const snapToday = (at: Date = new Date()) => chicagoDate(at);
