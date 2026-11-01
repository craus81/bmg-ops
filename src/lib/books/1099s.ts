import { toCents } from './netsuite-gl';

/**
 * The 1099 dry run (part 50, migration 481, docs/books.md "1099s"; the
 * NetSuite Exit Checklist, thread "Replacing NetSuite with FleetSuite",
 * 2026-10-31): what each vendor was paid in a year for its 1099, worked out
 * from FleetSuite's copy of NetSuite the way NetSuite counts it, so the two
 * can be checked against each other before FleetSuite makes 1099s itself.
 *
 * NetSuite counts what it pays a vendor it marks to get a 1099, by the date
 * paid, on the accounts it gives a 1099-MISC category: each category is a
 * box of the form. A check counts on the accounts of its own lines. A bill
 * payment counts on the accounts of the bills it paid: its money is spread
 * over the bills by what it paid on each, a bill credit it applied counting
 * against them, and each bill's share over the bill's lines by account, all
 * in proportion, to the cent, so the shares add up to exactly what was
 * paid. A discount taken for paying early isn't money paid, so it's in no
 * box. Card payments are left out, as the card company reports them (on a
 * 1099-K): card charges and refunds, and checks and bill payments paid from
 * a credit card account. They're listed instead.
 *
 * Also listed, for someone to look at: who was paid on accounts that count
 * toward a 1099 without being marked to get one, who is marked but was paid
 * only on other accounts, and the payments FleetSuite can't split, a bill
 * payment that paid a bill from before the copy of NetSuite's ledger starts
 * (2025), say. No minimum is applied: every vendor paid on an account that
 * counts is shown, whatever the amount.
 *
 * Pure: amounts are whole cents. Nothing is filed or sent.
 */

export type PaymentType = 'Check' | 'VendPymt' | 'CardChrg' | 'CardRfnd';

/** A GL line in the copy of NetSuite's ledger (migration 361): amounts are decimal strings. */
export interface GlLineData {
  account: string;
  debit: string;
  credit: string;
}

/** A document a bill payment paid, from the copy of the payments (migration 389). */
export interface LinkData {
  netsuite_id: string;
  /** NetSuite's type for it: VendBill, VendCred, Journal... */
  type: string | null;
  number: string | null;
  /** What the payment paid on it, or the bill credit applied, kept positive. */
  amount: string | null;
  /** Its GL lines; null when the copy of NetSuite's ledger doesn't have it (dated before 2025, say). */
  lines: GlLineData[] | null;
}

export interface PaymentData {
  netsuite_id: string;
  type: PaymentType;
  number: string | null;
  date: string;
  payee: string | null;
  payee_name: string | null;
  /** Kept positive. */
  total: string;
  lines: GlLineData[];
  /** A bill payment's: what it paid, null until a run could read it. Null for the rest. */
  links: LinkData[] | null;
}

/** One company's year, as gl_1099_year returns it (migration 481). */
export interface Year1099Data {
  payments: PaymentData[];
  payees: Array<{ netsuite_id: string; name: string; entity_id: string | null; legal_name: string | null; is_1099: string | null }>;
  accounts: Array<{ netsuite_id: string; number: string | null; name: string; type: string }>;
  categories: Array<{ netsuite_id: string; category: string }>;
  flags_copied: boolean;
  not_copied: Array<{ netsuite_id: string; type: string; number: string | null; date: string }>;
}

/** Why FleetSuite can't split a payment over the accounts it paid for. */
export type Unsplit =
  /** The payment isn't in the copy of NetSuite's ledger yet. */
  | { kind: 'not_in_ledger' }
  /** What the bill payment paid hasn't been copied yet. */
  | { kind: 'links_not_copied' }
  /** NetSuite lists nothing the bill payment paid. */
  | { kind: 'paid_nothing' }
  /** It paid a document the copy of NetSuite's ledger doesn't have: one dated before 2025, say. */
  | { kind: 'doc_not_in_ledger'; type: string | null; number: string | null }
  /** It paid something other than a bill or a bill credit, a journal entry say. */
  | { kind: 'not_a_bill'; type: string | null; number: string | null }
  /** NetSuite didn't say how much it paid on a bill. */
  | { kind: 'no_amount'; type: string | null; number: string | null }
  /** What it paid for comes to nothing. */
  | { kind: 'nothing_to_split' };

export interface Payment1099 {
  netsuiteId: string;
  type: PaymentType;
  number: string | null;
  date: string;
  /** What was paid: a card refund's is below 0. */
  cents: number;
  /** Paid by card, so left out. */
  byCard: boolean;
  /** What it paid on accounts that count toward a 1099, by category; empty when it's by card or can't be split. */
  boxes: Record<string, number>;
  /** What a bill payment paid. */
  paid: Array<{ type: string | null; number: string | null }>;
  unsplit: Unsplit | null;
}

export interface Payee1099 {
  /** NetSuite's id for the payee; '' when a payment names none. */
  payee: string;
  name: string;
  /** Its legal name, as on its W-9, when NetSuite has one that differs from its name. */
  legalName: string | null;
  /** Its id in NetSuite (V-1001, say), when that differs from its name. */
  entityId: string | null;
  /** In the copy of NetSuite's vendor list: not an employee or anyone else NetSuite lists. */
  vendor: boolean;
  /** NetSuite marks it to get a 1099; null when NetSuite hasn't said, or it isn't a vendor. */
  marked: boolean | null;
  /** What the year's checks and bill payments here paid it from a bank account. */
  paid: number;
  /** What of that went to accounts that count toward a 1099, by category. */
  boxes: Record<string, number>;
  /** The boxes added up. */
  total: number;
  /** What of `paid` FleetSuite couldn't split over accounts. */
  unsplit: number;
  /** Paid by card, left out. */
  byCard: number;
  payments: Payment1099[];
}

export interface Year1099 {
  /** The categories anything went in this year, the largest first. */
  categories: string[];
  /** Marked to get a 1099 and paid on accounts that count toward one: the year's 1099s, the largest first. */
  forms: Payee1099[];
  /** Paid on accounts that count toward a 1099 without being marked to get one, or not a vendor. */
  notMarked: Payee1099[];
  /** Marked to get a 1099, paid from a bank account, nothing on an account that counts. */
  nothingCounted: Payee1099[];
  /** Marked to get a 1099 and paid by card. */
  byCard: Payee1099[];
  /** The payments FleetSuite can't split, the earliest first, each with whom it paid. */
  unsplit: Array<Payment1099 & { payee: string; name: string; marked: boolean | null }>;
  /** Checks and bill payments in the copy of NetSuite's ledger that the copies of the payments don't have yet. */
  notCopied: Year1099Data['not_copied'];
  /** The accounts that count toward a 1099, by number. */
  accounts: Array<{ netsuiteId: string; number: string | null; name: string; category: string }>;
  /** The forms added up. */
  totals: { boxes: Record<string, number>; total: number };
  /** Whether the copy of NetSuite's vendor list has the vendors' 1099 flags yet. */
  flagsCopied: boolean;
}

const BANK = 'bank';
const CARD = 'credit_card';
const PAYABLES = 'accounts_payable';

/** A copied amount as whole cents; null when it's missing or can't be read. */
function readCents(v: string | null | undefined): number | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  try {
    return toCents(v);
  } catch {
    return null;
  }
}

/** A GL line's amount, debit positive. */
const lineCents = (l: GlLineData) => (readCents(l.debit) ?? 0) - (readCents(l.credit) ?? 0);

/**
 * `total` cents spread over `weights` in proportion, to the cent: each
 * share's exact amount rounded down, then the cents left over one each to
 * the largest remainders (ties by key), so the shares add up to `total`
 * exactly. Null when the weights come to nothing to spread over. A weight
 * may be below 0, a bill credit's say, as long as they come to more than 0.
 */
export function spread(total: number, weights: ReadonlyMap<string, number>): Map<string, number> | null {
  const entries = [...weights].filter(([, w]) => w !== 0);
  const sum = entries.reduce((n, [, w]) => n + w, 0);
  if (!(sum > 1e-9)) return null;
  const shares = entries.map(([key, w]) => {
    const exact = (w / sum) * total;
    const whole = Math.floor(exact);
    return { key, whole, rest: exact - whole };
  });
  let left = total - shares.reduce((n, s) => n + s.whole, 0);
  for (const s of [...shares].sort((a, b) => b.rest - a.rest || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (left <= 0) break;
    s.whole += 1;
    left -= 1;
  }
  return new Map(shares.map((s) => [s.key, s.whole]));
}

/**
 * A payment's lines the money came out of: those crediting a bank or a
 * credit card account. It's paid by card when one credits a credit card
 * account and none a bank account.
 */
function paidFrom(lines: readonly GlLineData[], types: ReadonlyMap<string, string>): { lines: Set<GlLineData>; byCard: boolean } {
  const from = new Set(lines.filter((l) => {
    const type = types.get(l.account);
    return (type === BANK || type === CARD) && lineCents(l) < 0;
  }));
  const kinds = new Set([...from].map((l) => types.get(l.account)));
  return { lines: from, byCard: kinds.has(CARD) && !kinds.has(BANK) };
}

/** Lines' amounts added up by account, debit positive. */
function byAccount(lines: Iterable<GlLineData>): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.account, (out.get(l.account) ?? 0) + lineCents(l));
  return out;
}

/** What a payment paid on each account that counts toward a 1099, by category, or why it can't be split. */
export function splitPayment(
  p: PaymentData,
  types: ReadonlyMap<string, string>,
  categories: ReadonlyMap<string, string>,
): Payment1099 {
  const total = readCents(p.total) ?? 0;
  const out: Payment1099 = {
    netsuiteId: p.netsuite_id,
    type: p.type,
    number: p.number,
    date: p.date,
    cents: total,
    byCard: false,
    boxes: {},
    paid: (p.links ?? []).map((l) => ({ type: l.type, number: l.number })),
    unsplit: null,
  };
  if (p.type === 'CardChrg' || p.type === 'CardRfnd') {
    return { ...out, cents: p.type === 'CardRfnd' ? -total : total, byCard: true };
  }
  if (!p.lines.length) return { ...out, unsplit: { kind: 'not_in_ledger' } };
  const from = paidFrom(p.lines, types);
  if (from.byCard) return { ...out, byCard: true };

  let weights: Map<string, number>;
  if (p.type === 'Check') {
    weights = byAccount(p.lines.filter((l) => !from.lines.has(l)));
  } else {
    if (p.links === null) return { ...out, unsplit: { kind: 'links_not_copied' } };
    if (!p.links.length) return { ...out, unsplit: { kind: 'paid_nothing' } };
    weights = new Map();
    for (const link of p.links) {
      const doc = { type: link.type, number: link.number };
      if (link.type !== 'VendBill' && link.type !== 'VendCred') return { ...out, unsplit: { kind: 'not_a_bill', ...doc } };
      const applied = readCents(link.amount);
      if (applied === null) return { ...out, unsplit: { kind: 'no_amount', ...doc } };
      // Nothing paid on it counts for nothing, whatever's on it.
      if (applied === 0) continue;
      if (link.lines === null) return { ...out, unsplit: { kind: 'doc_not_in_ledger', ...doc } };
      // A bill's lines but payables come to its total; a bill credit's to below 0.
      const parts = byAccount(link.lines.filter((l) => types.get(l.account) !== PAYABLES));
      const net = [...parts.values()].reduce((n, c) => n + c, 0);
      if (net === 0) return { ...out, unsplit: { kind: 'nothing_to_split' } };
      const share = Math.abs(applied) / Math.abs(net);
      for (const [account, c] of parts) weights.set(account, (weights.get(account) ?? 0) + share * c);
    }
  }

  const shares = spread(total, weights);
  if (!shares) return { ...out, unsplit: { kind: 'nothing_to_split' } };
  for (const [account, c] of shares) {
    const category = categories.get(account);
    if (category && c !== 0) out.boxes[category] = (out.boxes[category] ?? 0) + c;
  }
  return out;
}

const hasBox = (boxes: Record<string, number>) => Object.values(boxes).some((c) => c !== 0);
const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, c] of Object.entries(from)) into[k] = (into[k] ?? 0) + c;
};
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'en-US');

/** One company's year for its 1099s: the forms, what's left out, and what to look at. */
export function buildYear1099(data: Year1099Data): Year1099 {
  const types = new Map(data.accounts.map((a) => [a.netsuite_id, a.type]));
  const categories = new Map(data.categories.map((c) => [c.netsuite_id, c.category]));
  const vendors = new Map(data.payees.map((v) => [v.netsuite_id, v]));
  const payees = new Map<string, Payee1099>();

  for (const p of data.payments) {
    const key = p.payee ?? '';
    let payee = payees.get(key);
    if (!payee) {
      const v = vendors.get(key);
      const name = v?.name || p.payee_name || (key ? `NetSuite ${key}` : 'No payee named');
      const legal = v?.legal_name?.trim() || null;
      payee = {
        payee: key,
        name,
        legalName: legal && legal !== name ? legal : null,
        entityId: v?.entity_id?.trim() || null,
        vendor: !!v,
        marked: v?.is_1099 === 'T' ? true : v?.is_1099 === 'F' ? false : null,
        paid: 0, boxes: {}, total: 0, unsplit: 0, byCard: 0, payments: [],
      };
      payees.set(key, payee);
    }
    const payment = splitPayment(p, types, categories);
    payee.payments.push(payment);
    if (payment.byCard) {
      payee.byCard += payment.cents;
    } else {
      payee.paid += payment.cents;
      if (payment.unsplit) payee.unsplit += payment.cents;
      add(payee.boxes, payment.boxes);
    }
  }
  for (const payee of payees.values()) payee.total = Object.values(payee.boxes).reduce((n, c) => n + c, 0);

  const all = [...payees.values()];
  const largest = (amount: (p: Payee1099) => number) => (a: Payee1099, b: Payee1099) => amount(b) - amount(a) || byName(a, b);
  const forms = all.filter((p) => p.marked === true && hasBox(p.boxes)).sort(largest((p) => p.total));
  const totals = { boxes: {} as Record<string, number>, total: 0 };
  for (const f of forms) {
    add(totals.boxes, f.boxes);
    totals.total += f.total;
  }
  const everything: Record<string, number> = { ...totals.boxes };
  const notMarked = all.filter((p) => p.marked !== true && hasBox(p.boxes)).sort(largest((p) => p.total));
  for (const p of notMarked) add(everything, p.boxes);

  return {
    categories: Object.keys(everything).sort((a, b) => Math.abs(everything[b]) - Math.abs(everything[a]) || a.localeCompare(b, 'en-US')),
    forms,
    notMarked,
    nothingCounted: all.filter((p) => p.marked === true && !hasBox(p.boxes) && p.paid !== 0).sort(largest((p) => p.paid)),
    byCard: all.filter((p) => p.marked === true && p.byCard !== 0).sort(largest((p) => p.byCard)),
    unsplit: all
      .flatMap((p) => p.payments.filter((m) => m.unsplit).map((m) => ({ ...m, payee: p.payee, name: p.name, marked: p.marked })))
      .sort((a, b) => a.date.localeCompare(b.date) || a.netsuiteId.localeCompare(b.netsuiteId, 'en-US', { numeric: true })),
    notCopied: data.not_copied,
    accounts: data.categories
      .map((c) => {
        const a = data.accounts.find((x) => x.netsuite_id === c.netsuite_id);
        return { netsuiteId: c.netsuite_id, number: a?.number ?? null, name: a?.name ?? `NetSuite account ${c.netsuite_id}`, category: c.category };
      })
      .sort((a, b) => (a.number ?? '').localeCompare(b.number ?? '', 'en-US', { numeric: true }) || byName(a, b)),
    totals,
    flagsCopied: data.flags_copied,
  };
}

const DOC_NAMES: Record<string, string> = { VendBill: 'bill', VendCred: 'bill credit', Journal: 'journal entry' };

/** A document a bill payment paid, as the page names it: "bill B-701". */
export function docName(d: { type: string | null; number: string | null }): string {
  return [d.type ? DOC_NAMES[d.type] ?? d.type : 'a document', d.number].filter(Boolean).join(' ');
}

/** Why a payment can't be split, in plain words. */
export function unsplitReason(u: Unsplit): string {
  switch (u.kind) {
    case 'not_in_ledger': return "It isn't in FleetSuite's copy of NetSuite's ledger yet.";
    case 'links_not_copied': return "What it paid hasn't been copied from NetSuite yet.";
    case 'paid_nothing': return 'NetSuite lists nothing it paid.';
    case 'doc_not_in_ledger': return `It paid ${docName(u)}, which isn't in FleetSuite's copy of NetSuite's ledger. The copy starts with 2025.`;
    case 'not_a_bill': return `It paid ${docName(u)}, not a bill, so there are no bill lines to split it over.`;
    case 'no_amount': return `NetSuite didn't say how much it paid on ${docName(u)}.`;
    case 'nothing_to_split': return 'What it paid for comes to nothing.';
  }
}
