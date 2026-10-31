/**
 * Vendor credits made in FleetSuite (Books part 35, migration 467,
 * docs/books.md "Vendor credits made in FleetSuite"; owner decisions
 * 2026-10-31, thread "Replacing NetSuite with FleetSuite": from January 1,
 * 2027 the team works only in FleetSuite, apart from payments). Entered in
 * Purchasing → Vendor Credits: the vendor's credit by its own number and
 * date, money back to an account or a part going back to the vendor, and
 * which of the vendor's open bills it applies to. FleetSuite makes it in
 * NetSuite and keeps its own copy for the books.
 *
 * Rule vendor_credit@1: an account line is its own amount; a part line is its
 * quantity times its rate, rounded half-even to the cent; the total is its
 * lines. It applies to the bills picked, never more than a bill has open nor
 * more than the credit comes to; the rest stays open on the vendor, for
 * NetSuite to apply when the vendor is paid. Bills carry no sales tax, so
 * neither does the credit. A stock part goes back out of O'Fallon, the only
 * location that keeps stock, so a credit sending one back is booked there.
 *
 * The page and /api/purchasing/vendor-credit both work it out by these rules;
 * the route works it out again from what NetSuite and the copies hold before
 * it sends anything.
 */

import { centsOf, formatCents, STOCK_LOCATION_ID } from '@/lib/credit-memo';

export const VENDOR_CREDIT_RULE = 'vendor_credit@1';

/** Lines one vendor credit can have. */
export const MAX_VENDOR_CREDIT_LINES = 50;

/** Bills one vendor credit can be applied to. */
export const MAX_APPLIED_BILLS = 100;

/** The vendor's credit number is NetSuite's Reference No., as a bill's is (Snap a bill). */
export const CREDIT_NUMBER_MAX = 40;

/** The company whose stock parts go back from; 1084 keeps none. */
export const PART_COMPANY = 'BMG';

export { formatCents, STOCK_LOCATION_ID };

/** A company a vendor credit can be for, with its NetSuite subsidiary and locations (Snap a bill's readCompanies). */
export interface CreditCompany {
  code: string;
  name: string;
  subsidiaryId: string | null;
  locations: Array<{ id: string; name: string }>;
}

/** An account a line can go to, with the companies that can use it (Snap a bill's readAccounts). */
export interface CreditAccount {
  id: string;
  number: string | null;
  name: string;
  companies: string[];
}

/** A part a line can send back, from FleetSuite's copy of NetSuite's items. */
export interface CreditPart {
  /** NetSuite's internal id. */
  id: string;
  itemNumber: string;
  description: string | null;
  /** NetSuite keeps stock of it, so sending it back takes it off the shelf. */
  stock: boolean;
  /** What BMG pays for it, for the rate box. */
  cost: number | null;
  onHand: number | null;
}

/** One of the vendor's open bills in NetSuite (getVendorOpenBills). */
export interface OpenBill {
  id: string;
  number: string | null;
  date: string;
  dueDate: string | null;
  /** What's still open on it. */
  openCents: number;
}

export type CreditLineDraft =
  | { kind: 'account'; accountId: string | null; amount: number; memo?: string }
  | { kind: 'part'; itemId: string | null; quantity: number; rate: number };

export interface AppliedDraft {
  billId: string;
  amount: number;
}

/** What's typed on the page. */
export interface VendorCreditDraft {
  company: string;
  vendorId: string | null;
  /** The vendor's own number for the credit. */
  number: string;
  /** 'YYYY-MM-DD', the date on the vendor's credit. */
  date: string;
  locationId: string | null;
  reason: string;
  lines: CreditLineDraft[];
  applied: AppliedDraft[];
}

/** What the rules check a draft against. */
export interface VendorCreditFacts {
  /** Today in Central time. */
  today: string;
  companies: CreditCompany[];
  accounts: Map<string, CreditAccount>;
  /** The parts the lines name, by NetSuite id. */
  parts: Map<string, CreditPart>;
  /** The vendor picked, from the copy of NetSuite's vendors; null when the copy doesn't have it. */
  vendor: { id: string; name: string } | null;
  /** The vendor's open bills in NetSuite now; null when they couldn't be read, so nothing can be applied. */
  openBills: OpenBill[] | null;
}

export interface WorkedCreditLine {
  lineNo: number;
  kind: 'account' | 'part';
  accountId: string | null;
  accountName: string | null;
  itemId: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  /** Takes stock off O'Fallon's shelf. */
  stock: boolean;
  cents: number;
  memo: string | null;
}

export interface WorkedApplied {
  billId: string;
  billNumber: string | null;
  cents: number;
}

export interface WorkedVendorCredit {
  company: CreditCompany | null;
  lines: WorkedCreditLine[];
  applied: WorkedApplied[];
  totalCents: number;
  appliedCents: number;
  /** What stays open on the vendor, for NetSuite to apply when the vendor is paid. */
  leftCents: number;
  problems: string[];
}

export const accountName = (a: Pick<CreditAccount, 'number' | 'name'>) => [a.number, a.name].filter(Boolean).join(' ');

const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`))
  && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

const billName = (bill: OpenBill | undefined, id: string) => (bill?.number ? `Bill ${bill.number}` : `NetSuite bill ${id}`);

/** The vendor credit a draft makes, and everything that keeps it from being made. */
export function workOutVendorCredit(d: VendorCreditDraft, f: VendorCreditFacts): WorkedVendorCredit {
  const problems: string[] = [];

  const company = f.companies.find((c) => c.code === d.company) ?? null;
  if (!company) problems.push('Pick which company the credit is for.');
  else if (!company.subsidiaryId) problems.push(`${company.name} has no NetSuite subsidiary, so its vendor credits can't be made yet.`);

  if (!d.vendorId) problems.push('Pick the vendor.');
  else if (!f.vendor || f.vendor.id !== d.vendorId) problems.push("That vendor isn't in FleetSuite's copy of NetSuite's vendors. Pick it again.");

  const number = d.number.trim();
  if (!number) problems.push("Enter the vendor's credit number.");
  else if (number.length > CREDIT_NUMBER_MAX) problems.push(`The vendor's credit number can be up to ${CREDIT_NUMBER_MAX} characters.`);

  if (!isDay(d.date)) problems.push("Enter the date on the vendor's credit.");
  else if (d.date > f.today) problems.push("The credit's date can't be after today.");

  if (!d.reason.trim()) problems.push('Say why the vendor gave the credit.');

  if (company && d.locationId && !company.locations.some((l) => l.id === d.locationId)) {
    problems.push(`That location isn't one of ${company.name}'s.`);
  }

  const lines: WorkedCreditLine[] = d.lines.map((l, i): WorkedCreditLine => {
    const lineNo = i + 1;
    if (l.kind === 'account') {
      const account = l.accountId ? f.accounts.get(l.accountId) : undefined;
      if (!l.accountId) problems.push(`Line ${lineNo}: pick the account the money goes back to.`);
      else if (!account) problems.push(`Line ${lineNo}: that account can't take a vendor credit.`);
      else if (company && !account.companies.includes(company.code)) {
        problems.push(`Line ${lineNo}: ${accountName(account)} isn't one of ${company.name}'s accounts.`);
      }
      const cents = Number.isFinite(l.amount) && l.amount > 0 ? centsOf(l.amount) : 0;
      if (cents <= 0) problems.push(`Line ${lineNo}: enter an amount above $0.`);
      return {
        lineNo, kind: 'account', accountId: l.accountId, accountName: account ? accountName(account) : null,
        itemId: null, itemNumber: null, description: null, quantity: null, rate: null, stock: false, cents,
        memo: l.memo?.trim() || null,
      };
    }
    const part = l.itemId ? f.parts.get(l.itemId) : undefined;
    const name = part?.itemNumber || `Line ${lineNo}`;
    if (!l.itemId) problems.push(`Line ${lineNo}: pick the part going back.`);
    else if (!part) problems.push(`Line ${lineNo}: that part isn't in FleetSuite's copy of NetSuite's items.`);
    const quantity = Number.isFinite(l.quantity) && l.quantity > 0 ? l.quantity : 0;
    const rate = Number.isFinite(l.rate) && l.rate > 0 ? l.rate : 0;
    if (quantity <= 0) problems.push(`${name}: enter a quantity above 0.`);
    if (rate <= 0) problems.push(`${name}: enter a rate above $0.`);
    const cents = quantity > 0 && rate > 0 ? centsOf(quantity * rate) : 0;
    if (quantity > 0 && rate > 0 && cents <= 0) problems.push(`${name}: that comes to less than a cent.`);
    return {
      lineNo, kind: 'part', accountId: null, accountName: null, itemId: l.itemId, itemNumber: part?.itemNumber ?? null,
      description: part?.description ?? null, quantity: quantity || null, rate: rate || null, stock: !!part?.stock, cents,
      memo: null,
    };
  });

  if (d.lines.length === 0) problems.push('Add a line: money back to an account, or a part going back.');
  if (d.lines.length > MAX_VENDOR_CREDIT_LINES) problems.push(`A vendor credit can have up to ${MAX_VENDOR_CREDIT_LINES} lines.`);
  if (company && company.code !== PART_COMPANY && lines.some((l) => l.kind === 'part')) {
    problems.push(`Parts go back only on ${PART_COMPANY}'s vendor credits; ${company.name} keeps no stock.`);
  }
  if (lines.some((l) => l.stock) && d.locationId !== STOCK_LOCATION_ID) {
    problems.push("A stock part goes back out of O'Fallon, the only place that keeps stock. Pick O'Fallon as the location.");
  }

  const totalCents = lines.reduce((s, l) => s + l.cents, 0);

  const applied: WorkedApplied[] = [];
  if (d.applied.length > 0 && f.openBills === null) {
    problems.push("Couldn't read the vendor's open bills from NetSuite, so the credit can't be applied to them now. Leave it unapplied, or reload and try again.");
  } else {
    const seen = new Set<string>();
    for (const a of d.applied) {
      const bill = f.openBills?.find((b) => b.id === a.billId);
      const name = billName(bill, a.billId);
      if (seen.has(a.billId)) {
        problems.push(`${name} was picked twice.`);
        continue;
      }
      seen.add(a.billId);
      if (!bill) {
        problems.push(`${name} isn't open in NetSuite any more. Reload and try again.`);
        continue;
      }
      const cents = Number.isFinite(a.amount) && a.amount > 0 ? centsOf(a.amount) : 0;
      if (cents <= 0) problems.push(`${name}: apply more than $0, or leave it unpicked.`);
      else if (cents > bill.openCents) problems.push(`${name} has ${formatCents(bill.openCents)} open, so no more than that can be applied to it.`);
      applied.push({ billId: bill.id, billNumber: bill.number, cents });
    }
  }
  if (d.applied.length > MAX_APPLIED_BILLS) problems.push(`A vendor credit can be applied to up to ${MAX_APPLIED_BILLS} bills.`);
  const appliedCents = applied.reduce((s, a) => s + a.cents, 0);
  if (appliedCents > totalCents) {
    problems.push(`That applies ${formatCents(appliedCents)} to bills, more than the credit's ${formatCents(totalCents)}.`);
  }

  return { company, lines, applied, totalCents, appliedCents, leftCents: Math.max(0, totalCents - appliedCents), problems };
}

/**
 * The credit applied to the vendor's oldest open bills first, as far as it goes: what NetSuite's Auto Apply would
 * pick, for the page's "Apply oldest first".
 */
export function applyOldestFirst(bills: OpenBill[], totalCents: number): AppliedDraft[] {
  const picked: AppliedDraft[] = [];
  let left = totalCents;
  const oldest = [...bills].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  for (const bill of oldest) {
    if (left <= 0) break;
    const cents = Math.min(left, bill.openCents);
    if (cents <= 0) continue;
    picked.push({ billId: bill.id, amount: cents / 100 });
    left -= cents;
  }
  return picked;
}

/** What createVendorCredit sends NetSuite for a worked-out vendor credit with no problems. */
export function netsuiteVendorCredit(w: WorkedVendorCredit, d: VendorCreditDraft) {
  if (w.problems.length > 0 || !w.company?.subsidiaryId || !d.vendorId) throw new Error('The vendor credit has problems; nothing to send.');
  return {
    vendorId: d.vendorId,
    tranId: d.number.trim(),
    tranDate: d.date,
    subsidiaryId: w.company.subsidiaryId,
    locationId: d.locationId,
    memo: d.reason.trim(),
    expenses: w.lines.filter((l) => l.kind === 'account').map((l) => ({
      accountId: l.accountId!, amount: l.cents / 100, ...(l.memo ? { memo: l.memo } : {}),
    })),
    // The amount goes with the quantity and rate, so NetSuite's line comes to the cent FleetSuite worked out.
    items: w.lines.filter((l) => l.kind === 'part').map((l) => ({
      itemId: l.itemId!, quantity: l.quantity!, rate: l.rate!, amount: l.cents / 100,
    })),
    apply: w.applied.map((a) => ({ billId: a.billId, amount: a.cents / 100 })),
  };
}

/** The lines as typed_vendor_credits keeps them. */
export function keptVendorCreditLines(w: WorkedVendorCredit) {
  return w.lines.map((l) => ({
    kind: l.kind, accountId: l.accountId, itemId: l.itemId, itemNumber: l.itemNumber, description: l.description ?? l.memo,
    quantity: l.quantity, rate: l.rate, cents: l.cents,
  }));
}

/** The bills as typed_vendor_credits keeps them. */
export const keptApplied = (w: WorkedVendorCredit) => w.applied.map((a) => ({ billId: a.billId, billNumber: a.billNumber, cents: a.cents }));

// ── Credit all of it ───────────────────────────────────────────────────────

/** One of a bill's posting lines, as NetSuite posted it (getBillPostings in src/lib/netsuite.ts). */
export interface BillPosting {
  accountId: string;
  debitCents: number;
  creditCents: number;
  /** The bill's own line, which posts to payables. */
  payables: boolean;
  memo: string | null;
}

/** The lines of a vendor credit for all of a bill, or why they can't be filled in. */
export interface CreditAllOfBill {
  lines: Array<{ accountId: string; cents: number; memo: string | null }>;
  why: string | null;
}

/**
 * Credit all of it, from a bill's Fix screen (src/lib/bill-fix.ts): the lines of a vendor credit that undoes the bill,
 * account by account the way the bill posted (its posting lines but payables), so a part billed off a purchase order
 * comes back off the account received stock is held against, and no stock moves. Applied to the bill, it takes all of
 * it off what's owed. `name` is how the bill is named ("bill INV-1234"). Pure.
 */
export function creditAllOfBill(postings: BillPosting[], totalCents: number | null, name: string): CreditAllOfBill {
  const byAccount = new Map<string, { cents: number; memo: string | null }>();
  for (const p of postings) {
    if (p.payables) continue;
    const was = byAccount.get(p.accountId) ?? { cents: 0, memo: null };
    byAccount.set(p.accountId, { cents: was.cents + p.debitCents - p.creditCents, memo: was.memo ?? (p.memo?.trim().slice(0, 300) || null) });
  }
  const lines = [...byAccount].map(([accountId, v]) => ({ accountId, cents: v.cents, memo: v.memo })).filter((l) => l.cents !== 0);
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  const byHand = (why: string): CreditAllOfBill => ({ lines: [], why });
  if (lines.length === 0) return byHand(`NetSuite hasn't posted ${name} (it may be waiting for approval), so there's nothing to take back yet.`);
  if (lines.some((l) => l.cents < 0)) {
    return byHand(`${Name} takes money off an account (a discount, say), which a vendor credit's lines can't do, so enter this one by hand.`);
  }
  const sum = lines.reduce((s, l) => s + l.cents, 0);
  if (totalCents !== null && sum !== totalCents) {
    return byHand(`What ${name} posted comes to ${formatCents(sum)}, not its total of ${formatCents(totalCents)}, so enter this one by hand.`);
  }
  if (lines.length > MAX_VENDOR_CREDIT_LINES) return byHand(`${Name} posted to more than ${MAX_VENDOR_CREDIT_LINES} accounts, so enter this one by hand.`);
  return { lines, why: null };
}

/** The number a vendor credit that undoes a bill starts with: VOID- and the bill's number, as long as a credit's can be. */
export const creditAllNumber = (billNumber: string, billId: string) => `VOID-${billNumber.trim() || billId}`.slice(0, CREDIT_NUMBER_MAX);
