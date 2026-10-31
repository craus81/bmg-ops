/**
 * Chase card charges coded in FleetSuite and sent to NetSuite as a journal
 * entry (Books part 36, docs/books.md "Card charges coded in FleetSuite";
 * owner decisions 2026-10-31, thread "Replacing NetSuite with FleetSuite":
 * from January 1, 2027 the team works only in FleetSuite, apart from
 * payments, deposits and banking).
 *
 * The bookkeeper enters the Chase card's statements in NetSuite as journal
 * entries (owner, 2026-10-16: NetSuite has no credit card charges of BMG's),
 * so FleetSuite does the same: the card's activity downloaded from Chase as a
 * CSV file, each charge given the account it's for (FleetSuite remembers each
 * merchant's account and fills it in next time), and each month's charges
 * sent as one journal entry, two lines a charge: its account, and the card's
 * account, so the card's side matches Chase's statement line for line. A
 * return or credit from a merchant goes the other way. Payments to the card
 * are left out: they're paid from the bank, which stays in NetSuite.
 *
 * The rules here are pure; /api/card-charges and the Card charges page both
 * use them, the page to show what a send would make and the route to make it
 * from the charges as they're kept.
 */

import { centsOf, formatCents } from '@/lib/credit-memo';
import { parseCsv, toAmount, toIsoDate } from '@/lib/paychex-payroll';

/** How a month's charges become a journal entry: two lines a charge, each to the cent. */
export const CARD_CHARGE_RULE = 'card_charges@1';

/** The most lines after the headings one file can have: a few months of a busy card. */
export const MAX_FILE_ROWS = 3000;

/** The most charges one journal entry takes (two lines each); a month with more goes in parts. */
export const MAX_CHARGES_PER_ENTRY = 250;

/** The most charges one Save codes. */
export const MAX_CODED_AT_ONCE = 500;

/**
 * The first month FleetSuite sends. The months before it are on the
 * bookkeeper's journal entries in NetSuite already, so sending them would
 * book the card's charges twice.
 */
export const FIRST_SEND_MONTH = '2027-01';

export const DESCRIPTION_MAX = 200;
export const MEMO_MAX = 300;

/** The kinds of account the card's own account can be in Books' chart. */
export const CARD_ACCOUNT_TYPES: readonly string[] = ['credit_card', 'other_current_liability'];

export { formatCents };

const NOT_CHASE = "This isn't a Chase card download: its first line should name Transaction Date, Description and Amount. "
  + 'In Chase, open the card, choose Download account activity, and pick CSV.';

export interface ChaseRow {
  /** The charge's number in the file, counting from the first one after the headings. */
  row: number;
  /** The transaction date, YYYY-MM-DD. */
  date: string;
  postDate: string | null;
  description: string;
  merchantKey: string;
  category: string | null;
  /** Chase's Type as the file has it (Sale, Return, Fee, Adjustment), when it has one. */
  type: string | null;
  /** What it puts on the card: above 0 for a charge or fee, below 0 for money back. */
  cents: number;
  /** The card's last digits, when the download names the card. */
  card: string | null;
  chaseMemo: string | null;
  /** The same charge in another download has the same fingerprint, so it's only added once. */
  fingerprint: string;
}

export interface ChaseDownload {
  rows: ChaseRow[];
  /** Payments to the card, left out: they're paid from the bank in NetSuite. */
  payments: number;
  /** Lines of $0, left out. */
  zero: number;
  problems: string[];
}

const heading = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const clean = (s: string | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');

/**
 * The merchant a charge is from, as FleetSuite remembers it: the description's
 * words up to the first that's a store number or a reference (three
 * characters or more with a digit in, or a number after the first word),
 * four words at most. "ACME HARDWARE #1234" and "ACME HARDWARE #5678" are the
 * same merchant, as are "WIDGETS MKTPL*AB1CD2" and "WIDGETS MKTPL*ZZ9";
 * "7-ELEVEN" and "3M" keep their digits.
 */
export function merchantKey(description: string): string {
  const words = description.toUpperCase().replace(/[^A-Z0-9&]+/g, ' ').trim().split(' ').filter(Boolean);
  const kept: string[] = [];
  for (const [i, w] of words.entries()) {
    const reference = /\d/.test(w) && (w.length >= 3 || (i > 0 && /^\d+$/.test(w)));
    if (reference || kept.length === 4) break;
    kept.push(w);
  }
  return (kept.length > 0 ? kept : words.slice(0, 1)).join(' ').slice(0, 60);
}

/**
 * Reads the card's activity as Chase downloads it (CSV): Transaction Date,
 * Post Date, Description, Category, Type, Amount and Memo, with a Card column
 * first when the account has more than one card. The columns are found by
 * their headings. Chase shows a purchase as money out, below 0; a file whose
 * sales are all above 0 has its signs the other way round, and is read that
 * way. Any line that can't be read refuses the whole file.
 */
export function readChaseDownload(text: string): ChaseDownload {
  const out: ChaseDownload = { rows: [], payments: 0, zero: 0, problems: [] };
  const table = parseCsv(text);
  const at = table.findIndex((r) => {
    const h = r.map(heading);
    return h.includes('transaction date') && h.includes('description') && h.includes('amount');
  });
  if (at < 0) {
    out.problems.push(NOT_CHASE);
    return out;
  }
  const head = table[at].map(heading);
  const col = (name: string) => head.indexOf(name);
  const c = {
    card: col('card'), date: col('transaction date'), post: col('post date'), description: col('description'),
    category: col('category'), type: col('type'), amount: col('amount'), memo: col('memo'),
  };
  const lines = table.slice(at + 1);
  if (lines.length > MAX_FILE_ROWS) {
    out.problems.push(`The file has ${lines.length} charges; FleetSuite takes ${MAX_FILE_ROWS} at a time. Download a shorter stretch of dates.`);
    return out;
  }

  type Read = Omit<ChaseRow, 'cents' | 'fingerprint'> & { amount: number };
  const read: Read[] = [];
  lines.forEach((cells, i) => {
    const row = i + 1;
    const cell = (k: number) => (k >= 0 ? clean(cells[k]) : '');
    const rawDate = cell(c.date);
    const date = toIsoDate(rawDate);
    if (!date) { out.problems.push(`Charge ${row}: "${rawDate}" isn't a date.`); return; }
    const rawPost = cell(c.post);
    const postDate = rawPost ? toIsoDate(rawPost) : null;
    if (rawPost && !postDate) { out.problems.push(`Charge ${row}: "${rawPost}" isn't a date.`); return; }
    const description = cell(c.description).slice(0, DESCRIPTION_MAX);
    if (!description) { out.problems.push(`Charge ${row} has no description.`); return; }
    const rawAmount = cell(c.amount);
    const amount = rawAmount ? toAmount(rawAmount) : null;
    if (amount === null) { out.problems.push(`Charge ${row}: "${rawAmount}" isn't an amount.`); return; }
    const type = cell(c.type) || null;
    // Payments to the card are paid from the bank, which stays in NetSuite.
    const payment = type ? type.toLowerCase() === 'payment' : c.type < 0 && amount > 0 && /\bpayment\b/i.test(description);
    if (payment) { out.payments += 1; return; }
    read.push({
      row, date, postDate, description, merchantKey: merchantKey(description), category: cell(c.category) || null, type,
      card: cell(c.card).slice(0, 20) || null, chaseMemo: cell(c.memo).slice(0, MEMO_MAX) || null, amount,
    });
  });

  const sales = read.filter((r) => r.type?.toLowerCase() === 'sale' && r.amount !== 0);
  const flipped = sales.length > 0 && sales.every((r) => r.amount > 0);
  if (!flipped && sales.some((r) => r.amount > 0)) {
    const rows = sales.filter((r) => r.amount > 0).slice(0, 5).map((r) => r.row).join(', ');
    out.problems.push(`Some sales in the file are money out and some money back (charge ${rows}), so FleetSuite can't tell which way its amounts go.`);
  }
  if (out.problems.length > 0) return out;

  const seen = new Map<string, number>();
  for (const r of read) {
    const cents = centsOf(flipped ? r.amount : -r.amount);
    if (cents === 0) { out.zero += 1; continue; }
    // Two identical charges in one file are two charges: the second is told apart by its place.
    const base = [r.date, r.postDate ?? '', r.description.toUpperCase(), cents, r.card ?? ''].join('|');
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const { amount: _amount, ...rest } = r;
    out.rows.push({ ...rest, cents, fingerprint: `${base}#${n}` });
  }
  return out;
}

/** A download's charges as card_charges_import takes them (migration 468). */
export const importRows = (rows: ChaseRow[]) => rows.map((r) => ({
  charge_date: r.date, post_date: r.postDate, description: r.description, merchant_key: r.merchantKey,
  category: r.category, chase_type: r.type, cents: r.cents, card: r.card, chase_memo: r.chaseMemo, fingerprint: r.fingerprint,
}));

// ── A month's journal entry ─────────────────────────────────────────────────

export interface CardCompany {
  code: string;
  name: string;
  subsidiaryId: string | null;
}

export interface CardAccount {
  id: string;
  number: string | null;
  name: string;
  /** Books' account type (credit_card, expense…). */
  type: string;
  /** The companies that can use it. */
  companies: string[];
}

/** A charge as it's kept, with the account it's coded to. */
export interface CardCharge {
  id: string;
  date: string;
  description: string;
  card: string | null;
  cents: number;
  accountId: string | null;
  memo: string | null;
}

/** A charge as card_charges keeps it (migration 468), as the database or a send's claim gives it back. */
export interface KeptChargeRow {
  id: string;
  charge_date: string;
  post_date: string | null;
  description: string;
  merchant_key: string;
  category: string | null;
  chase_type: string | null;
  cents: number | string;
  card: string | null;
  account_netsuite_id: string | null;
  memo: string | null;
  remembered: boolean;
}

export const keptCharge = (r: KeptChargeRow): CardCharge => ({
  id: r.id, date: String(r.charge_date).slice(0, 10), description: r.description, card: r.card, cents: Number(r.cents),
  accountId: r.account_netsuite_id, memo: r.memo,
});

export interface CardEntryFacts {
  company: CardCompany | undefined;
  /** The card's own account, as Books' chart has it. */
  cardAccount: CardAccount | undefined;
  /** The accounts a charge can go to. */
  accounts: Map<string, CardAccount>;
}

export interface WorkedCardLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  memo: string;
  chargeId: string;
}

export interface WorkedCardEntry {
  /** YYYY-MM. */
  month: string;
  /** The latest charge's date, so the entry is in the charges' month. */
  date: string;
  memo: string;
  lines: WorkedCardLine[];
  chargeCount: number;
  /** What the charges put on the card: charges less money back. */
  netCents: number;
  /** The entry's debits, which its credits match. */
  totalCents: number;
  problems: string[];
}

export const accountName = (a: Pick<CardAccount, 'number' | 'name'>) => [a.number, a.name].filter(Boolean).join(' ');

/** 'October 2026' for '2026-10'. */
export const monthName = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

/** 'Oct 3' for '2026-10-03'. */
const shortDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** What a charge's two lines say in NetSuite: the merchant, the day, the card and anything typed. */
export const chargeMemo = (c: Pick<CardCharge, 'description' | 'date' | 'card' | 'memo'>) =>
  [c.description, shortDay(c.date), c.card ? `card ${c.card}` : '', c.memo?.trim() ?? ''].filter(Boolean).join(' · ').slice(0, MEMO_MAX);

/** Oldest first, then by id as the database orders them, so the page and a send take the same charges. */
export const byDateThenId = (a: Pick<CardCharge, 'date' | 'id'>, b: Pick<CardCharge, 'date' | 'id'>) =>
  (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** What a charge from this merchant put on a card. */
const chargeName = (c: CardCharge) => `${c.description} on ${shortDay(c.date)}`;

/**
 * One month's journal entry for the card: for each charge, its account and
 * the card's account for its amount (a charge to its account and off the
 * card's balance owed, money back the other way), in date order. Every
 * charge has to be from one month on or after FIRST_SEND_MONTH, coded to an
 * account the company can use, and not to the card itself.
 */
export function workOutCardEntry(charges: CardCharge[], f: CardEntryFacts): WorkedCardEntry {
  const problems: string[] = [];
  const sorted = [...charges].sort(byDateThenId);
  const months = [...new Set(sorted.map((c) => c.date.slice(0, 7)))];
  const month = months[0] ?? '';
  const date = sorted.length > 0 ? sorted[sorted.length - 1].date : '';
  const company = f.company;
  const card = f.cardAccount;

  if (!company) problems.push('Pick the company.');
  else if (!company.subsidiaryId) problems.push(`${company.name} has no NetSuite subsidiary in Books, so NetSuite can't take its journal entries.`);
  if (!card) problems.push("Pick the card's account.");
  else if (!CARD_ACCOUNT_TYPES.includes(card.type) || (company && !card.companies.includes(company.code))) {
    problems.push(`${accountName(card)} isn't a card account ${company ? `${company.name} can use` : 'in the chart'}.`);
  }
  if (sorted.length === 0) problems.push('There are no charges to send.');
  if (sorted.length > MAX_CHARGES_PER_ENTRY) problems.push(`One journal entry takes ${MAX_CHARGES_PER_ENTRY} charges at most, not ${sorted.length}.`);
  if (months.length > 1) problems.push('One journal entry takes one month of charges.');
  else if (month && month < FIRST_SEND_MONTH) {
    problems.push(`${monthName(month)} is before ${monthName(FIRST_SEND_MONTH)}: its card charges are on the bookkeeper's journal entries in NetSuite already.`);
  }

  const uncoded = sorted.filter((c) => !c.accountId).length;
  if (uncoded > 0) problems.push(uncoded === 1 ? 'One charge has no account yet.' : `${uncoded} charges have no account yet.`);

  const lines: WorkedCardLine[] = [];
  let netCents = 0;
  let totalCents = 0;
  for (const c of sorted) {
    if (!Number.isSafeInteger(c.cents) || c.cents === 0) { problems.push(`The charge from ${chargeName(c)} has no amount.`); continue; }
    if (!c.accountId) continue;
    const account = f.accounts.get(c.accountId);
    if (card && c.accountId === card.id) { problems.push(`The charge from ${chargeName(c)} can't go to the card's own account.`); continue; }
    if (!account || (company && !account.companies.includes(company.code))) {
      problems.push(`The charge from ${chargeName(c)} goes to an account ${company ? `${company.name} can't use` : 'FleetSuite can\'t use'}.`);
      continue;
    }
    const memo = chargeMemo(c);
    const abs = Math.abs(c.cents);
    // A charge goes to its account and onto the card's balance owed; money back comes off both.
    lines.push(c.cents > 0
      ? { accountId: c.accountId, debitCents: abs, creditCents: 0, memo, chargeId: c.id }
      : { accountId: c.accountId, debitCents: 0, creditCents: abs, memo, chargeId: c.id });
    if (card) {
      lines.push(c.cents > 0
        ? { accountId: card.id, debitCents: 0, creditCents: abs, memo, chargeId: c.id }
        : { accountId: card.id, debitCents: abs, creditCents: 0, memo, chargeId: c.id });
    }
    netCents += c.cents;
    totalCents += abs;
  }

  const memo = `${card ? accountName(card) : 'Card'} charges, ${month ? monthName(month) : ''}, from FleetSuite`.slice(0, MEMO_MAX);
  return { month, date, memo, lines, chargeCount: sorted.length, netCents, totalCents, problems };
}

/** FleetSuite's own name for a send's journal entry in NetSuite: a second try never makes a second one. */
export const sendExternalId = (sendId: string) => `fleetsuite-card-${sendId}`;

/** What createJournalEntry sends. */
export function netsuiteJournalEntry(w: WorkedCardEntry, subsidiaryId: string, sendId: string) {
  return {
    subsidiaryId,
    tranDate: w.date,
    memo: w.memo,
    externalId: sendExternalId(sendId),
    lines: w.lines.map((l) => ({
      accountId: l.accountId,
      ...(l.debitCents > 0 ? { debit: l.debitCents / 100 } : { credit: l.creditCents / 100 }),
      memo: l.memo,
    })),
  };
}
