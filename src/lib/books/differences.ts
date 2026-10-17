import { COPY_FROM, monthsBetween, toCents, TRAN_TYPE_NAMES } from './netsuite-gl';
import { DEPOSIT_SOURCE_TYPE } from './deposit-rule';
import { BILL_SOURCE_TYPE } from './bill-rule';
import { BILL_PAYMENT_SOURCE_TYPE } from './bill-payment-rule';
import { SPENDING_SOURCE_TYPE } from './spending-rule';
import { JOURNAL_ENTRY_SOURCE_TYPE, JOURNAL_TYPE } from './journal-entry-rule';
import { BANK_SOURCE_TYPE } from './bank-rule';

/**
 * What still differs between FleetSuite's own books and NetSuite's, and why
 * (migration 377, docs/books.md "Differences"; owner decision 2026-10-15,
 * thread "Replacing NetSuite with FleetSuite").
 *
 * For one company and every month from January 2025, each account's movement
 * in FleetSuite's journal is put next to its movement in the copy of
 * NetSuite's general ledger, NetSuite's split by the kind of document behind
 * it. What NetSuite moved with kinds of documents FleetSuite doesn't post yet
 * is expected to differ and is counted apart ("not posted yet"). What
 * FleetSuite does post should come to the same as NetSuite; where it doesn't,
 * each document that differs is listed with the reason.
 *
 * Months are compared by their movements, not their month-end balances, so a
 * difference shows in the month it comes from rather than in every month
 * after it. NetSuite's side is grouped by the month NetSuite posted to (its
 * accounting period), FleetSuite's by each entry's date. Amounts are whole
 * cents, debit positive.
 */

/** FleetSuite's documents that copy NetSuite's, by the NetSuite transaction type each one copies. */
export const NETSUITE_TYPE: Readonly<Record<string, string>> = {
  invoice: 'CustInvc',
  credit_memo: 'CustCred',
  payment: 'CustPymt',
  [DEPOSIT_SOURCE_TYPE.CustDep]: 'CustDep',
  [DEPOSIT_SOURCE_TYPE.DepAppl]: 'DepAppl',
  [BILL_SOURCE_TYPE.VendBill]: 'VendBill',
  [BILL_SOURCE_TYPE.VendCred]: 'VendCred',
  [BILL_PAYMENT_SOURCE_TYPE]: 'VendPymt',
  [SPENDING_SOURCE_TYPE.Check]: 'Check',
  [SPENDING_SOURCE_TYPE.CardChrg]: 'CardChrg',
  [SPENDING_SOURCE_TYPE.CardRfnd]: 'CardRfnd',
  [JOURNAL_ENTRY_SOURCE_TYPE]: JOURNAL_TYPE,
  [BANK_SOURCE_TYPE.Deposit]: 'Deposit',
  [BANK_SOURCE_TYPE.Transfer]: 'Transfer',
};

const DEPOSIT_KINDS: ReadonlySet<string> = new Set(Object.values(DEPOSIT_SOURCE_TYPE));
const BILL_KINDS: ReadonlySet<string> = new Set(Object.values(BILL_SOURCE_TYPE));
const SPENDING_KINDS: ReadonlySet<string> = new Set(Object.values(SPENDING_SOURCE_TYPE));
const BANK_KINDS: ReadonlySet<string> = new Set(Object.values(BANK_SOURCE_TYPE));

/**
 * The switch of Invoices vs NetSuite that lists a kind of FleetSuite
 * document: deposits and their applications share one, bills and bill
 * credits another, checks, card charges and card refunds a third, and bank
 * deposits and transfers a fourth.
 */
export const listKindOf = (sourceType: string): string =>
  (DEPOSIT_KINDS.has(sourceType) ? 'deposit' : BILL_KINDS.has(sourceType) ? 'bill' : SPENDING_KINDS.has(sourceType) ? 'spending'
    : BANK_KINDS.has(sourceType) ? 'bank' : sourceType);

/** NetSuite's lines booking the cost of stock on invoices and credit memos (gl_netsuite_cost_lines): FleetSuite posts that with fulfillments. */
export const COST = 'cost';

/** A FleetSuite source type that copies no NetSuite type is compared under 'fleetsuite:<source type>'. */
const FLEETSUITE_ONLY = 'fleetsuite:';

/** The kind a FleetSuite source type is compared under: the NetSuite type it copies, else its own. */
export const kindOf = (sourceType: string): string => NETSUITE_TYPE[sourceType] ?? `${FLEETSUITE_ONLY}${sourceType}`;

const FLEETSUITE_NAMES: Record<string, string> = { manual: 'Typed entry', opening_balance: 'Opening balance' };

/** A kind of document as the page names it. */
export function kindName(kind: string): string {
  if (kind === COST) return 'Cost of goods on invoices';
  if (kind.startsWith(FLEETSUITE_ONLY)) {
    const type = kind.slice(FLEETSUITE_ONLY.length);
    const name = FLEETSUITE_NAMES[type] ?? `${type.charAt(0).toUpperCase()}${type.slice(1)}`.replace(/_/g, ' ');
    return `${name} (FleetSuite only)`;
  }
  return TRAN_TYPE_NAMES[kind] ?? kind;
}

// ── What gl_books_differences returns ──────────────────────────────────────

/** One side's movement on one account in one month from one kind of document. */
export interface DiffAmount {
  /** 'YYYY-MM-01'. */
  month: string;
  /** NetSuite's account id, or 'fs:<id>' for a FleetSuite account with none. */
  account: string;
  /** NetSuite's transaction type or COST; FleetSuite's source type. */
  kind: string;
  /** Debits less credits. */
  net: string;
}

/** How many documents of one kind moved anything in a month, and how much (the debits of their movements). */
export interface DiffKindCount {
  month: string;
  kind: string;
  documents: number;
  moved: string;
}

export interface DiffData {
  netsuite: DiffAmount[];
  fleetsuite: DiffAmount[];
  netsuite_kinds: DiffKindCount[];
  fleetsuite_kinds: DiffKindCount[];
  /** Cost of goods sold accounts and items' inventory asset accounts. */
  cost_accounts?: string[];
}

/** An account of the chart, to name the rows by. */
export interface DiffChartAccount {
  id: string;
  netsuite_account_id: string | null;
  number: string | null;
  name: string;
}

// ── Comparing a month ──────────────────────────────────────────────────────

interface KindTotal {
  documents: number;
  /** Cents. */
  moved: number;
}

interface Side {
  /** Account → kind → cents. */
  accounts: Map<string, Map<string, number>>;
  kinds: Map<string, KindTotal>;
}

/** Both sides of one month; FleetSuite's kinds already keyed by kindOf. */
export interface MonthSides {
  netsuite: Side;
  fleetsuite: Side;
}

/** Both sides of every month either has, by 'YYYY-MM-01'. */
export function indexMonths(data: DiffData): Map<string, MonthSides> {
  const out = new Map<string, MonthSides>();
  const month = (m: string): MonthSides => {
    let sides = out.get(m);
    if (!sides) {
      sides = { netsuite: { accounts: new Map(), kinds: new Map() }, fleetsuite: { accounts: new Map(), kinds: new Map() } };
      out.set(m, sides);
    }
    return sides;
  };
  const sides = [
    { side: 'netsuite', amounts: data.netsuite, counts: data.netsuite_kinds, key: (k: string) => k },
    { side: 'fleetsuite', amounts: data.fleetsuite, counts: data.fleetsuite_kinds, key: kindOf },
  ] as const;
  for (const { side, amounts, counts, key } of sides) {
    for (const r of amounts) {
      const accounts = month(r.month)[side].accounts;
      const kinds = accounts.get(r.account) ?? new Map<string, number>();
      kinds.set(key(r.kind), (kinds.get(key(r.kind)) ?? 0) + toCents(r.net));
      accounts.set(r.account, kinds);
    }
    for (const r of counts) {
      const kinds = month(r.month)[side].kinds;
      const was = kinds.get(key(r.kind)) ?? { documents: 0, moved: 0 };
      kinds.set(key(r.kind), { documents: was.documents + r.documents, moved: was.moved + toCents(r.moved) });
    }
  }
  return out;
}

/**
 * The NetSuite kinds FleetSuite posts for a company: every kind it has a rule
 * for when the company posts (POSTING_COMPANIES), and any it holds entries of.
 */
export function postedKinds(data: DiffData, posts: boolean): Set<string> {
  const out = new Set<string>(posts ? Object.values(NETSUITE_TYPE) : []);
  for (const r of data.fleetsuite) if (NETSUITE_TYPE[r.kind]) out.add(NETSUITE_TYPE[r.kind]);
  return out;
}

export interface DiffAccountRow {
  account: string;
  number: string | null;
  name: string;
  /** False for an account the chart doesn't have. */
  inChart: boolean;
  fleetsuite: number;
  netsuite: number;
  /** NetSuite's movement from kinds of documents FleetSuite doesn't post yet. */
  notPosted: number;
  /** FleetSuite less NetSuite on the kinds FleetSuite posts: what shouldn't be there. */
  differs: number;
}

export type KindState = 'posted' | 'cost' | 'not_posted' | 'fleetsuite_only';

export interface DiffKindRow {
  kind: string;
  name: string;
  state: KindState;
  netsuite: KindTotal | null;
  fleetsuite: KindTotal | null;
  /** For a kind FleetSuite posts: how many of its documents differ (gl_books_difference_documents); null when not known. */
  differing: number | null;
}

export type MonthStatus = 'matches' | 'differs' | 'none';

export interface MonthComparison {
  month: string;
  /**
   * 'matches': what FleetSuite posts this month comes to what NetSuite posted
   * for the same documents, on every account; 'differs': it doesn't; 'none':
   * neither side has any of the kinds FleetSuite posts.
   */
  status: MonthStatus;
  /** Accounts where what FleetSuite posts differs. */
  differing: number;
  /** The share of NetSuite's movement that is of kinds FleetSuite posts, 0 to 1; null when NetSuite moved nothing. */
  covered: number | null;
  accounts: Array<Omit<DiffAccountRow, 'number' | 'name' | 'inChart'>>;
  kinds: Array<Omit<DiffKindRow, 'differing'>>;
}

const sum = (kinds: Map<string, number> | undefined, keep: (kind: string) => boolean = () => true) => {
  let total = 0;
  for (const [kind, cents] of kinds ?? []) if (keep(kind)) total += cents;
  return total;
};

const stateOf = (kind: string, posted: ReadonlySet<string>): KindState => (posted.has(kind)
  ? 'posted'
  : kind === COST ? 'cost' : kind.startsWith(FLEETSUITE_ONLY) ? 'fleetsuite_only' : 'not_posted');

/** One month's accounts and kinds of documents, both sides, given the kinds FleetSuite posts. */
export function compareMonth(sides: MonthSides | undefined, month: string, posted: ReadonlySet<string>): MonthComparison {
  const ns = sides?.netsuite.accounts ?? new Map<string, Map<string, number>>();
  const fs = sides?.fleetsuite.accounts ?? new Map<string, Map<string, number>>();

  const accounts: MonthComparison['accounts'] = [];
  let postedAnything = false;
  for (const account of new Set([...ns.keys(), ...fs.keys()])) {
    const fleetsuite = sum(fs.get(account));
    const netsuite = sum(ns.get(account));
    const notPosted = sum(ns.get(account), (k) => !posted.has(k));
    if (fleetsuite || sum(ns.get(account), (k) => posted.has(k))) postedAnything = true;
    if (!fleetsuite && !netsuite && !notPosted) continue;
    accounts.push({ account, fleetsuite, netsuite, notPosted, differs: fleetsuite - (netsuite - notPosted) });
  }

  const nsKinds = sides?.netsuite.kinds ?? new Map<string, KindTotal>();
  const fsKinds = sides?.fleetsuite.kinds ?? new Map<string, KindTotal>();
  const kinds: MonthComparison['kinds'] = [...new Set([...nsKinds.keys(), ...fsKinds.keys()])].map((kind) => ({
    kind,
    name: kindName(kind),
    state: stateOf(kind, posted),
    netsuite: nsKinds.get(kind) ?? null,
    fleetsuite: fsKinds.get(kind) ?? null,
  }));

  let all = 0;
  let covered = 0;
  for (const [kind, t] of nsKinds) {
    all += t.moved;
    if (posted.has(kind)) covered += t.moved;
  }

  const differing = accounts.filter((a) => a.differs !== 0).length;
  return {
    month,
    status: differing ? 'differs' : postedAnything ? 'matches' : 'none',
    differing,
    covered: all ? covered / all : null,
    accounts,
    kinds,
  };
}

/** NetSuite's own totals and the copy's per account and month, as gl_netsuite_totals returns them. */
export interface GlTotals {
  netsuite?: Array<{ netsuite_account_id: string; month?: string; debit: string; credit: string }>;
  copied?: Array<{ netsuite_account_id: string; month?: string; debit: string; credit: string }>;
}

/**
 * Whether the copy of NetSuite's ledger holds everything NetSuite's own
 * totals say it moved in a month, account by account; null when those totals
 * haven't been read yet. Until it does, NetSuite's side here is short.
 */
export function copyHolds(totals: GlTotals | null | undefined, month: string): boolean | null {
  if (!totals?.netsuite?.length) return null;
  const gap = new Map<string, number>();
  const add = (rows: GlTotals['netsuite'], sign: number) => {
    for (const r of rows ?? []) {
      if (r.month !== month) continue;
      gap.set(r.netsuite_account_id, (gap.get(r.netsuite_account_id) ?? 0) + sign * (toCents(r.debit) - toCents(r.credit)));
    }
  };
  add(totals.netsuite, 1);
  add(totals.copied, -1);
  return [...gap.values()].every((cents) => cents === 0);
}

/** The latest month either side has, but never before `floor`. */
export function lastMonth(data: DiffData, floor: string): string {
  let last = floor;
  for (const r of [...data.netsuite, ...data.fleetsuite]) if (r.month > last) last = r.month;
  return last;
}

export interface DiffMonth {
  month: string;
  status: MonthStatus;
  differing: number;
  covered: number | null;
}

/** Each month from January 2025 through `through`, for the month strip. */
export function monthStatuses(index: Map<string, MonthSides>, posted: ReadonlySet<string>, through: string): DiffMonth[] {
  return monthsBetween(COPY_FROM, through).map((month) => {
    const { status, differing, covered } = compareMonth(index.get(month), month, posted);
    return { month, status, differing, covered };
  });
}

const collator = new Intl.Collator('en', { numeric: true });

/** Names an account key from the chart. */
export function accountNamer(chart: DiffChartAccount[]) {
  const byNetSuite = new Map<string, DiffChartAccount>();
  const byId = new Map<string, DiffChartAccount>();
  for (const a of chart) {
    byId.set(a.id, a);
    if (a.netsuite_account_id) byNetSuite.set(a.netsuite_account_id, a);
  }
  return (account: string): { number: string | null; name: string; inChart: boolean } => {
    const fleetsuiteOnly = account.startsWith('fs:');
    const a = fleetsuiteOnly ? byId.get(account.slice(3)) : byNetSuite.get(account);
    if (a) return { number: a.number, name: a.name, inChart: true };
    return { number: null, name: fleetsuiteOnly ? 'FleetSuite account no longer in the chart' : `NetSuite account ${account}`, inChart: false };
  };
}

/** The month's accounts, named, by number (unnumbered ones by name). */
export function accountRows(cmp: MonthComparison, name: ReturnType<typeof accountNamer>): DiffAccountRow[] {
  return cmp.accounts
    .map((a) => ({ ...a, ...name(a.account) }))
    .sort((a, b) => Number(a.number === null) - Number(b.number === null)
      || collator.compare(a.number ?? '', b.number ?? '')
      || collator.compare(a.name, b.name));
}

const STATE_ORDER: Record<KindState, number> = { posted: 0, cost: 1, not_posted: 2, fleetsuite_only: 3 };
const POSTED_ORDER = Object.values(NETSUITE_TYPE);

/**
 * The month's kinds of documents: the ones FleetSuite posts first, with how
 * many of their documents differ (`counts`, by FleetSuite source type), then
 * the rest, the most NetSuite moved first.
 */
export function kindRows(cmp: MonthComparison, counts: Record<string, number> | null): DiffKindRow[] {
  const differing = new Map<string, number>();
  for (const [type, n] of Object.entries(counts ?? {})) differing.set(kindOf(type), n);
  return cmp.kinds
    .map((k) => ({ ...k, differing: k.state === 'posted' && counts ? differing.get(k.kind) ?? 0 : null }))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]
      || (a.state === 'posted' ? POSTED_ORDER.indexOf(a.kind) - POSTED_ORDER.indexOf(b.kind) : 0)
      || (b.netsuite?.moved ?? 0) - (a.netsuite?.moved ?? 0)
      || (b.fleetsuite?.moved ?? 0) - (a.fleetsuite?.moved ?? 0)
      || collator.compare(a.name, b.name));
}

// ── Documents that differ ──────────────────────────────────────────────────

/** One document of a month as gl_books_difference_documents returns it. */
export interface DiffDocumentData {
  /**
   * FleetSuite's source type: 'invoice', 'credit_memo', 'payment', 'customer_deposit', 'deposit_application', 'vendor_bill',
   * 'vendor_credit', 'bill_payment', 'check', 'card_charge', 'card_refund', 'journal_entry', 'bank_deposit' or 'bank_transfer'.
   */
  kind: string;
  netsuite_id: string;
  /** Every account either side moved this month. */
  lines: Array<{ account: string; netsuite: string; fleetsuite: string }>;
  /** The copy of NetSuite's ledger: `month` is null when this company has no line of it there. */
  netsuite: { type: string; number: string | null; date: string; month: string | null } | null;
  /** FleetSuite's journal: how many entries it has had and the one that stands. */
  fleetsuite: { entries: number; standing: { entry_no: number; date: string } | null } | null;
  /**
   * The copy of NetSuite's invoices, credit memos, payments, deposits, bills,
   * bill payments or checks and card charges and refunds (deleted: a deposit,
   * bill, bill payment, check or card charge NetSuite no longer lists); a
   * bill's or bill payment's customer is its vendor, a check's or card
   * charge's its payee. Null for a journal entry, bank deposit or transfer,
   * which has no copy but the GL's.
   */
  copy: { number: string | null; customer: string | null; voided: boolean; deleted: boolean } | null;
}

export type DiffReason =
  /** A payment, deposit or application dated before FleetSuite's books start, posted by NetSuite to a month after. */
  | 'before_start'
  /** No FleetSuite entry, ever. */
  | 'not_posted'
  /** Voided in NetSuite and reversed in FleetSuite, while the copy of NetSuite's ledger still has lines of it. */
  | 'voided'
  /** FleetSuite reversed its entry and has none standing. */
  | 'reversed'
  /** FleetSuite's entry stands, but this company has no line of it in the copy of NetSuite's ledger. */
  | 'gone'
  /** Both have it, in different months. */
  | 'month'
  /** Same month; NetSuite also booked the cost of the stock on it. */
  | 'cost'
  /** Same month, different accounts or amounts. */
  | 'amounts';

export interface DiffDocumentLine {
  account: string;
  number: string | null;
  name: string;
  netsuite: number;
  fleetsuite: number;
}

export interface DiffDocument {
  /** FleetSuite's source type. */
  kind: string;
  netsuiteId: string;
  number: string;
  /** The customer, or a bill's, bill credit's or bill payment's vendor, or a check's or card charge's payee. */
  customer: string | null;
  /** NetSuite's date for it, else FleetSuite's. */
  date: string | null;
  /** The month NetSuite posted it to for this company. */
  netsuiteMonth: string | null;
  /** The month Invoices vs NetSuite lists it under; null when that page has no month for it. */
  listMonth: string | null;
  /** The switch of Invoices vs NetSuite it's listed under (listKindOf). */
  listKind: string;
  /** The date of FleetSuite's entry that stands. */
  fleetsuiteDate: string | null;
  entryNo: number | null;
  /** What each side moved this month: the debits of its movement per account. */
  netsuite: number;
  fleetsuite: number;
  lines: DiffDocumentLine[];
  reason: DiffReason;
  why: string;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 'YYYY-MM-01' → 'September 2026'. */
export const monthText = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const dateText = (iso: string) => `${MONTH_NAMES[Number(iso.slice(5, 7)) - 1].slice(0, 3)} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;

/** How many accounts' differences the reason spells out before counting the rest. */
const NAMED_ACCOUNTS = 2;

/**
 * FleetSuite's kinds of document that post in the month NetSuite booked them
 * to, whatever their own date (entryDate in invoice-check.ts, migrations 380,
 * 386, 390, 392, 393 and 394), and that Invoices vs NetSuite lists under that
 * month. Payments, deposits and applications post and are listed by their
 * own date.
 */
const IN_NETSUITE_MONTH: ReadonlySet<string> = new Set([
  'invoice', 'credit_memo', ...BILL_KINDS, BILL_PAYMENT_SOURCE_TYPE, ...SPENDING_KINDS, JOURNAL_ENTRY_SOURCE_TYPE, ...BANK_KINDS,
]);

/** FleetSuite's kinds of document posted line for line from the copy of NetSuite's GL, which have no copy of their own. */
const FROM_GL_COPY: ReadonlySet<string> = new Set([JOURNAL_ENTRY_SOURCE_TYPE, ...BANK_KINDS]);

function reasonFor(doc: DiffDocumentData, lines: DiffDocumentLine[], costAccounts: ReadonlySet<string>): { reason: DiffReason; why: string } {
  const ns = doc.netsuite;
  const standing = doc.fleetsuite?.standing ?? null;
  const lookWhy = 'Invoices vs NetSuite shows why.';

  if (!standing) {
    if (!doc.fleetsuite?.entries) {
      if (ns && ns.date < COPY_FROM && !IN_NETSUITE_MONTH.has(doc.kind)) {
        return {
          reason: 'before_start',
          why: `Dated ${dateText(ns.date)}, before FleetSuite's books start on January 1, 2025, so FleetSuite doesn't post it.`
            + (ns.month ? ` NetSuite posted it to ${monthText(ns.month)}.` : ''),
        };
      }
      return { reason: 'not_posted', why: `FleetSuite hasn't posted it. ${lookWhy}` };
    }
    if (doc.copy?.voided) {
      return { reason: 'voided', why: "Voided in NetSuite, so FleetSuite reversed its entry, but the copy of NetSuite's ledger still has lines of it." };
    }
    return { reason: 'reversed', why: `FleetSuite reversed its entry and has none standing. ${lookWhy}` };
  }

  if (!ns?.month) {
    if (doc.copy?.deleted) return { reason: 'gone', why: "Deleted in NetSuite. The next posting run reverses FleetSuite's entry." };
    if (doc.copy?.voided) return { reason: 'gone', why: "Voided in NetSuite, which posts nothing for it now. The next posting run reverses FleetSuite's entry." };
    // A journal entry, bank deposit or transfer is the company's only while the copy of NetSuite's ledger has lines of it
    // for the company.
    if (FROM_GL_COPY.has(doc.kind)) {
      return {
        reason: 'gone',
        why: ns
          ? "NetSuite posts it to the other company now. The next posting run reverses FleetSuite's entry for this one."
          : "Deleted in NetSuite. The next posting run reverses FleetSuite's entry.",
      };
    }
    return {
      reason: 'gone',
      why: ns
        ? "NetSuite posts it to the other company now, but FleetSuite's entry for this one stands."
        : "The copy of NetSuite's ledger has no lines of it, but FleetSuite's entry stands.",
    };
  }

  if (monthOf(standing.date) !== ns.month) {
    return {
      reason: 'month',
      why: `FleetSuite has it in ${monthText(monthOf(standing.date))}, dated ${dateText(standing.date)}; NetSuite posted it to ${monthText(ns.month)}.`,
    };
  }

  const differ = lines.filter((l) => l.netsuite !== l.fleetsuite);
  if (differ.length && differ.every((l) => l.fleetsuite === 0 && costAccounts.has(l.account))) {
    return { reason: 'cost', why: 'NetSuite also booked the cost of the stock on it, which FleetSuite will post with fulfillments.' };
  }
  const named = differ.slice(0, NAMED_ACCOUNTS).map((l) => `${[l.number, l.name].filter(Boolean).join(' ')}: FleetSuite ${dollars(l.fleetsuite)}, NetSuite ${dollars(l.netsuite)}`);
  if (differ.length > NAMED_ACCOUNTS) named.push(`${differ.length - NAMED_ACCOUNTS} more`);
  return {
    reason: 'amounts',
    why: `Posted differently on ${differ.length === 1 ? 'one account' : `${differ.length} accounts`}: ${named.join('; ')}.`,
  };
}

/** One differing document, its lines named and the reason it differs spelled out. */
export function explainDocument(
  doc: DiffDocumentData,
  ctx: { name: ReturnType<typeof accountNamer>; costAccounts: ReadonlySet<string> },
): DiffDocument {
  const lines = doc.lines
    .map((l): DiffDocumentLine => {
      const { number, name } = ctx.name(l.account);
      return { account: l.account, number, name, netsuite: toCents(l.netsuite), fleetsuite: toCents(l.fleetsuite) };
    })
    .sort((a, b) => Number(a.number === null) - Number(b.number === null)
      || collator.compare(a.number ?? '', b.number ?? '')
      || collator.compare(a.name, b.name));
  const standing = doc.fleetsuite?.standing ?? null;
  const date = doc.netsuite?.date ?? standing?.date ?? null;
  const listed = IN_NETSUITE_MONTH.has(doc.kind) && doc.netsuite?.month ? doc.netsuite.month : date ? monthOf(date) : null;
  return {
    kind: doc.kind,
    netsuiteId: doc.netsuite_id,
    number: doc.netsuite?.number || doc.copy?.number || `NetSuite ${doc.netsuite_id}`,
    customer: doc.copy?.customer ?? null,
    date,
    netsuiteMonth: doc.netsuite?.month ?? null,
    listMonth: listed && listed >= COPY_FROM ? listed : null,
    listKind: listKindOf(doc.kind),
    fleetsuiteDate: standing?.date ?? null,
    entryNo: standing?.entry_no ?? null,
    netsuite: lines.reduce((s, l) => s + Math.max(0, l.netsuite), 0),
    fleetsuite: lines.reduce((s, l) => s + Math.max(0, l.fleetsuite), 0),
    lines,
    ...reasonFor(doc, lines, ctx.costAccounts),
  };
}
