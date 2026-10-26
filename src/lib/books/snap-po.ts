import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import { canBillPoStatus, computeThreeWayMatch, loadPoMatchFacts, type MatchVerdict, type PoMatchFacts } from '@/lib/three-way-match';
import { poBillLines, toCents } from './own-bills';

/**
 * PO bills (migration 444; owner decision 2026-10-25, thread "Replacing
 * NetSuite with FleetSuite", "Freight line", as Books Previews drew it;
 * docs/books.md "PO bills").
 *
 * A snapped bill that names one of the vendor's open purchase orders bills
 * that PO in NetSuite, the way Parts Mail's Create bill does: NetSuite bills
 * the PO's open lines at its prices, which settles what Receiving booked for
 * them. First the bill is checked against the PO and Receiving with Parts
 * Mail's three-way match (src/lib/three-way-match.ts): the totals, what's been
 * received, and any earlier bill on the PO. A check that didn't pass needs a
 * reason, which goes in the audit log as a Parts Mail bill anyway does. When
 * the bill is more than what's left to bill on the PO (freight, say), the
 * difference goes on the same bill as its own line, to an account picked for
 * it (snap-a-bill.ts). When that's only lines the bill prints that aren't on
 * the PO, the totals are checked without them, so freight needs no reason
 * (owner decision 2026-10-26, "No reason for freight").
 *
 * The PO comes from FleetSuite's copy of NetSuite's POs (netsuite_vendor_pos,
 * every two hours): by its number as read off the bill or typed, else the
 * vendor's PO with the same digits. A bill that names none is offered the
 * vendor's POs that can take a bill. The copy keeps no company, so a PO's
 * bill is BMG's. Every rule here is pure but the readers at the end.
 */

/** A PO as FleetSuite's copy of NetSuite's POs has it, with what the three-way match reads for it. */
export interface SnapPo {
  /** netsuite_vendor_pos.id. */
  copyId: string;
  netsuiteId: string;
  number: string;
  vendorId: string | null;
  vendorName: string | null;
  /** 'YYYY-MM-DD'. */
  date: string | null;
  status: string | null;
  statusLabel: string | null;
  /** The PO's total, else its lines added up, in whole cents. */
  totalCents: number | null;
  facts: PoMatchFacts;
}

/** One of the vendor's POs that can take a bill, offered when the bill names none. */
export interface OpenPo {
  number: string;
  status: string | null;
  /** 'YYYY-MM-DD'. */
  date: string | null;
  totalCents: number | null;
}

export interface PoFacts {
  /** The PO the form names; null when it names none, or the copy has none by that number. */
  found: SnapPo | null;
  /** The vendor's POs that can take a bill, best first, when the form names none. */
  open: OpenPo[];
}

export const NO_PO: PoFacts = { found: null, open: [] };

/** At most this many of the vendor's open POs are offered. */
export const OPEN_POS_SHOWN = 5;

/** What the PO rules read of the form (SnapForm in snap-a-bill.ts). */
export interface PoForm {
  vendorId: string | null;
  totalCents: number | null;
  poNumber: string | null;
  howBilled: 'po' | 'plain' | null;
  extra: { leftOff: boolean } | null;
  /** The bill's own lines, for what it prints beyond the PO. */
  lines: Array<{ description: string; cents: number | null }>;
}

export interface PoLeg {
  title: 'Totals' | 'Received' | 'Earlier bills';
  tone: MatchVerdict;
  text: string;
}

/** A line NetSuite bills from the PO: its open quantity at the PO's price. */
export interface PoViewLine {
  item: string | null;
  description: string | null;
  quantity: number;
  rate: number | null;
  /** Null when the copy has no price for it. */
  cents: number | null;
}

/** What the page shows for the PO the form names. */
export interface PoView {
  /** The note under the PO box. */
  tone: MatchVerdict | null;
  text: string | null;
  /** The vendor's open POs to tap, when the bill names none. */
  open: Array<{ number: string; label: string }>;
  /** The PO's vendor, to pick when the form has none yet. */
  vendor: { id: string; name: string } | null;
  /** The PO can take this bill. */
  canBill: boolean;
  /** The bill goes in by billing the PO: someone picked it, or nobody picked and the PO can take it. */
  billing: boolean;
  number: string | null;
  lines: PoViewLine[];
  /** What the bill is more than what's left to bill on the PO, in whole cents, left off or not; 0 when it isn't more. */
  overCents: number;
  /** The extra line's amount: overCents, unless someone left it off. */
  extraCents: number;
  /** What NetSuite bills: the PO's open lines and the extra line; null when a line has no price. */
  billsCents: number | null;
  legs: PoLeg[];
  verdict: MatchVerdict | null;
  /** The match's own sentences for what didn't pass, worst first, as Parts Mail's audit log keeps them. */
  variances: string[];
  /** The match didn't pass: billing the PO takes a reason. */
  needsReason: boolean;
  /** Under the Bill PO / Plain bill buttons. */
  how: { tone: 'amber' | null; text: string } | null;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (iso: string, today: string) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}${iso.slice(0, 4) === today.slice(0, 4) ? '' : `, ${iso.slice(0, 4)}`}`;
/** A quantity as people write it: 4, 2.5, never 2.5000. */
const qty = (n: number) => String(Math.round(n * 10_000) / 10_000);
const units = (n: number) => `${qty(n)} ${n === 1 ? 'unit' : 'units'}`;
const digitsOf = (v: string | null | undefined) => String(v ?? '').replace(/\D/g, '');

/** NetSuite's PO statuses, for a copy that kept only the letter. */
const STATUS_WORDS: Record<string, string> = {
  A: 'Pending Supervisor Approval', B: 'Pending Receipt', C: 'Rejected by Supervisor', D: 'Partially Received',
  E: 'Pending Billing/Partially Received', F: 'Pending Bill', G: 'Fully Billed', H: 'Closed', P: 'Planned',
};

/** "fully billed", from "Purchase Order : Fully Billed" or G. */
export function poStatusWords(po: Pick<SnapPo, 'status' | 'statusLabel'>): string {
  const label = po.statusLabel?.replace(/^Purchase Order\s*:\s*/i, '').trim() || STATUS_WORDS[String(po.status ?? '').toUpperCase()] || 'closed';
  return label.toLowerCase();
}

/** The order the vendor's open POs are offered in, after one for the bill's total: received ones first. */
const STATUS_RANK = ['F', 'E', 'D', 'B'];

/**
 * The vendor's POs to offer a bill that names none: those that can take a bill, one for exactly the bill's total
 * first, then those received, partly received and still to come, newest first in each. Pure.
 */
export function pickOpenPos(pos: OpenPo[], billCents: number | null, most = OPEN_POS_SHOWN): OpenPo[] {
  const rank = (p: OpenPo) => {
    const at = STATUS_RANK.indexOf(String(p.status ?? '').toUpperCase());
    return at < 0 ? STATUS_RANK.length : at;
  };
  const exact = (p: OpenPo) => (billCents !== null && p.totalCents === billCents ? 0 : 1);
  return pos
    .filter((p) => canBillPoStatus(p.status))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => exact(a.p) - exact(b.p) || rank(a.p) - rank(b.p) || (b.p.date ?? '').localeCompare(a.p.date ?? '') || a.i - b.i)
    .slice(0, most)
    .map(({ p }) => p);
}

/** The PO's lines NetSuite bills: each line with some still to bill, its open quantity at the PO's price. Pure. */
export function poLinesBilled(po: SnapPo): { lines: PoViewLine[]; cents: number | null } {
  const { lines, priced } = poBillLines(po.facts.rows);
  return {
    lines: lines.map((l) => ({ item: l.itemNumber, description: l.description, quantity: l.quantity ?? 0, rate: l.rate, cents: l.cents })),
    cents: priced ? lines.reduce((n, l) => n + (l.cents ?? 0), 0) : null,
  };
}

/**
 * What's left to bill on the PO in whole cents: its total less what's billed on its lines, so a second bill on a PO is
 * set against what's left on it. Null when the copy has no total, or no price for a line that's billed. Pure.
 */
export function poLeftCents(po: Pick<SnapPo, 'totalCents' | 'facts'>): number | null {
  if (po.totalCents === null) return null;
  const num = (v: number | string | null) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let billed = 0;
  for (const r of po.facts.rows) {
    const done = num(r.quantity_billed) ?? 0;
    if (!(done > 0)) continue;
    const quantity = num(r.quantity) ?? 0;
    const amount = num(r.amount);
    const rate = num(r.rate) ?? (amount !== null && quantity > 0 ? amount / quantity : null);
    if (rate === null) return null;
    billed += toCents(done * rate);
  }
  return po.totalCents - billed;
}

type BillLine = { description: string; cents: number | null };

/**
 * The bill's own lines that are what it has beyond the PO: of those that aren't on the PO (a line naming one of the
 * PO's items, or for one of its lines' amounts, is on it), the one for exactly the difference, else all of them when
 * they add up to it. Null when the bill's lines don't say. Pure.
 */
export function linesBeyondPo<L extends BillLine>(read: L[], po: Pick<PoViewLine, 'item' | 'cents'>[], extraCents: number): L[] | null {
  if (extraCents <= 0) return null;
  const items = po.map((l) => l.item?.toUpperCase().replace(/[^A-Z0-9]/g, '')).filter((i): i is string => !!i && i.length >= 3);
  const amounts = new Set(po.map((l) => l.cents).filter((c): c is number => c !== null));
  const notOnPo = read.filter((l) => {
    const text = l.description.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return l.cents !== null && !amounts.has(l.cents) && !items.some((i) => text.includes(i));
  });
  const exact = notOnPo.filter((l) => l.cents === extraCents);
  if (exact.length === 1) return exact;
  return notOnPo.reduce((n, l) => n + l.cents!, 0) === extraCents ? notOnPo : null;
}

/** What to call the extra line: the bill's own lines beyond the PO, by what they say. Null when they don't say. Pure. */
export function extraWords(read: BillLine[], po: Pick<PoViewLine, 'item' | 'cents'>[], extraCents: number): string | null {
  const words = (linesBeyondPo(read, po, extraCents) ?? []).map((l) => l.description.trim()).filter(Boolean);
  return words.length ? words.join(', ').slice(0, 300) : null;
}

/** "freight", "freight and fuel surcharge": the bill's lines as a sentence names them. */
const sayLines = (ls: BillLine[]) => {
  const said = ls.map((l) => l.description.trim()).map((d) => (/^[A-Z][a-z]/.test(d) ? d.charAt(0).toLowerCase() + d.slice(1) : d));
  return said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}` : said[0];
};

/** Up to four lines as "RACK-48 2 of 4, CLAMP-ACX 1 of 4", and how many more. */
const someLines = (ls: Array<{ itemNumber: string; ordered: number; received: number }>) => {
  const shown = ls.slice(0, 4).map((l) => `${l.itemNumber} ${qty(Math.min(l.received, l.ordered))} of ${qty(l.ordered)}`).join(', ');
  return ls.length > 4 ? `${shown}, and ${ls.length - 4} more` : shown;
};

/** What the page shows for the PO the form names: whether it can take the bill, and the checks against it. Pure. */
export function viewPo(form: PoForm, facts: PoFacts | null, who: string, today: string): PoView {
  const none: PoView = {
    tone: null, text: null, open: [], vendor: null, canBill: false, billing: false, number: null, lines: [], overCents: 0,
    extraCents: 0, billsCents: null, legs: [], verdict: null, variances: [], needsReason: false, how: null,
  };
  const named = form.poNumber?.trim() ?? '';
  if (!named) {
    return {
      ...none,
      open: (facts?.open ?? []).map((p) => ({ number: p.number, label: p.totalCents === null ? p.number : `${p.number} · ${dollars(p.totalCents)}` })),
    };
  }
  const po = facts?.found ?? null;
  if (!po) {
    return {
      ...none,
      tone: 'amber',
      text: `No ${named} in FleetSuite's copy of NetSuite's POs, which catches up every two hours. Check the number, or enter it as a plain bill.`,
    };
  }

  const billed = poLinesBilled(po);
  const base: PoView = { ...none, number: po.number, lines: billed.lines, billsCents: billed.cents };
  if (!form.vendorId) {
    return {
      ...base,
      tone: 'amber',
      text: `${po.number} is ${po.vendorName ?? 'a vendor'}'s PO. Pick the vendor to bill it.`,
      vendor: po.vendorId ? { id: po.vendorId, name: po.vendorName ?? `NetSuite vendor ${po.vendorId}` } : null,
    };
  }
  if (po.vendorId && po.vendorId !== form.vendorId) {
    return { ...base, tone: 'red', text: `${po.number} is ${po.vendorName ?? 'another vendor'}'s PO, not ${who}'s. Check the PO number or the vendor.` };
  }
  if (!po.facts.poIsOpen) {
    return { ...base, tone: 'red', text: `${po.number} is ${poStatusWords(po)} in NetSuite, so it can't take another bill. If this is an extra charge, enter it as a plain bill.` };
  }
  if (!billed.lines.length) {
    return { ...base, tone: 'red', text: `Everything on ${po.number} is billed already. If this is an extra charge, enter it as a plain bill.` };
  }

  const ordered = po.date ? `, ordered ${shortDay(po.date, today)}` : '';
  const text = `${po.number} is open in NetSuite: ${po.vendorName ?? who}, ${po.totalCents === null ? 'no total' : dollars(po.totalCents)}${ordered}.`;
  if (form.howBilled === 'plain') {
    return {
      ...base, tone: 'green', text, canBill: true,
      how: { tone: 'amber', text: `A plain bill leaves ${po.number} open, and what Receiving booked for it stays unsettled. Bill the PO unless this is a separate charge.` },
    };
  }

  const bill = form.totalCents;
  const leftCents = poLeftCents(po) ?? po.totalCents;
  const overCents = bill !== null && leftCents !== null && bill > leftCents ? bill - leftCents : 0;
  const extraCents = form.extra?.leftOff ? 0 : overCents;
  const billsCents = billed.cents === null ? null : billed.cents + extraCents;
  // A PO with nothing billed on it yet, on a bill beyond it only by lines it prints that aren't on the PO, each saying
  // what it is: the totals are checked without them.
  const beyond = leftCents === po.totalCents ? linesBeyondPo(form.lines, billed.lines, extraCents) : null;
  const printed = beyond?.every((l) => l.description.trim()) ? beyond : null;

  // The checks, as Parts Mail's Create bill runs them.
  const match = computeThreeWayMatch({
    invoiceTotal: bill === null ? null : (bill - (printed ? extraCents : 0)) / 100,
    poTotal: po.facts.poTotal,
    lines: po.facts.lines,
    priorBills: po.facts.priorBills,
    poIsOpen: po.facts.poIsOpen,
    poStatusLabel: po.facts.poStatusLabel,
  });

  let totals: string;
  if (bill === null) totals = "Fill in the bill's total to check it against the PO.";
  else if (po.totalCents === null) totals = `The copy of ${po.number} has no total, so compare the amounts by hand.`;
  else if (printed) totals = `The bill is the PO's ${dollars(po.totalCents)} plus ${dollars(extraCents)} for ${sayLines(printed)}, which goes on its own line.`;
  else if (bill === po.totalCents) totals = `The bill's ${dollars(bill)} is the PO's total.`;
  else {
    const diff = bill - po.totalCents;
    const allowed = match.allowed === null ? null : toCents(match.allowed);
    const within = allowed !== null && Math.abs(diff) <= allowed ? `, within the ${dollars(allowed)} let through` : '';
    totals = `The bill is ${dollars(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than the PO's ${dollars(po.totalCents)}${within}.`;
  }
  if (extraCents > 0) {
    // Lines the bill prints are said above.
    if (!printed) {
      totals += leftCents !== null && po.totalCents !== null && leftCents < po.totalCents
        ? ` ${dollars(leftCents)} of the PO is left to bill, so the other ${dollars(extraCents)} goes on its own line.`
        : ` The ${dollars(extraCents)} goes on its own line.`;
    }
  }
  else if (bill !== null && billsCents !== null && billsCents !== bill) totals += ` Billing the PO enters ${dollars(billsCents)}, not the bill's ${dollars(bill)}.`;

  const lines = po.facts.lines;
  const orderedUnits = lines.reduce((n, l) => n + l.ordered, 0);
  const inUnits = lines.reduce((n, l) => n + Math.min(l.received, l.ordered), 0);
  const short = lines.filter((l) => l.received < l.ordered);
  const received = !lines.length
    ? `Nothing on ${po.number} to check against Receiving.`
    : inUnits === 0
      ? `Nothing on ${po.number} has been received yet.`
      : short.length
        ? `${qty(inUnits)} of ${units(orderedUnits)} are in so far (${someLines(short)}). Billing the PO bills all ${qty(orderedUnits)}.`
        : orderedUnits === 1 ? 'The 1 unit is in.' : `All ${units(orderedUnits)} are in.`;

  const names = po.facts.earlierBills;
  const aBill = names.length === 1 ? 'a bill' : `${names.length} bills`;
  const billedUnits = po.facts.billedUnits;
  const earlier = names.length && billedUnits > 0
    ? `${po.number} already has ${aBill} (${names.join(', ')}), and NetSuite shows ${units(billedUnits)} billed on it. Billing it again pays twice.`
    : names.length
      ? `${po.number} already has ${aBill}: ${names.join(', ')}. Billing it again pays twice.`
      : billedUnits > 0
        ? `NetSuite shows ${units(billedUnits)} on ${po.number} billed already. Check this bill isn't one of them.`
        : `None on ${po.number}.`;

  return {
    ...base,
    tone: 'green',
    text,
    canBill: true,
    billing: true,
    overCents,
    extraCents,
    billsCents,
    legs: [
      { title: 'Totals', tone: match.legs.totals, text: totals },
      { title: 'Received', tone: match.legs.received, text: received },
      { title: 'Earlier bills', tone: match.legs.earlier, text: earlier },
    ],
    verdict: match.verdict,
    variances: match.variances,
    needsReason: match.verdict !== 'green',
    how: {
      tone: null,
      text: `NetSuite bills the PO's open lines at its prices. That settles what Receiving booked for them, and the PO shows billed.${extraCents > 0 ? ' What the bill has beyond them goes on its own line.' : ''}`,
    },
  };
}

// ── Reading what the rules read ────────────────────────────────────────────

/** A netsuite_vendor_pos row, as the readers take it. */
interface PoRow {
  id: string;
  netsuite_id: string | number;
  tranid: string | null;
  vendor_netsuite_id: string | null;
  vendor_name: string | null;
  trandate: string | null;
  status: string | null;
  status_label: string | null;
  total: string | number | null;
}

const PO_COLUMNS = 'id, netsuite_id, tranid, vendor_netsuite_id, vendor_name, trandate, status, status_label, total';
/** A PO number as typed that can go in a LIKE as it is: none of its wildcards, nor PostgREST's *. */
const LIKE_SAFE = /^[A-Za-z0-9][A-Za-z0-9 #./-]*$/;
const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const centsOf = (v: string | number | null) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : toCents(Number(v)));
/** The newest PO first, by its date then NetSuite's id. */
const newestFirst = (a: PoRow, b: PoRow) => (b.trandate ?? '').localeCompare(a.trandate ?? '') || Number(b.netsuite_id) - Number(a.netsuite_id);

/**
 * The PO a number read off a bill or typed is, from FleetSuite's copy of NetSuite's POs: the one with that number
 * (case aside), else the vendor's newest with the same digits ("453" or "P.O. #453" for PO453-ACME), else the one PO
 * anyone has with them. Null when none is.
 */
export async function findPo(service: SupabaseClient, typed: string, vendorId: string | null): Promise<PoRow | null> {
  const want = typed.trim();
  if (!want) return null;
  if (LIKE_SAFE.test(want)) {
    const res = await service.from('netsuite_vendor_pos').select(PO_COLUMNS).ilike('tranid', want).order('id').limit(5);
    if (res.error) throw new Error(`couldn't look for PO ${want} (${res.error.message})`);
    const rows = (res.data ?? []) as PoRow[];
    const hit = rows.find((r) => r.vendor_netsuite_id === vendorId) ?? rows[0];
    if (hit) return hit;
  }
  const digits = digitsOf(want);
  if (!digits) return null;
  const withDigits = async (vendor: string | null) => {
    const res = await fetchAllRows<PoRow>((from, to) => {
      const q = service.from('netsuite_vendor_pos').select(PO_COLUMNS).ilike('tranid', `%${digits}%`);
      return (vendor ? q.eq('vendor_netsuite_id', vendor) : q).order('id').range(from, to);
    });
    if (res.error) throw new Error(`couldn't look for PO ${want} (${res.error.message})`);
    return res.data.filter((r) => digitsOf(r.tranid) === digits).sort(newestFirst);
  };
  if (vendorId) {
    const theirs = await withDigits(vendorId);
    if (theirs.length) return theirs[0];
  }
  const anyone = await withDigits(null);
  return anyone.length === 1 ? anyone[0] : null;
}

/** The vendor's POs in the copy that can take a bill, newest first. */
export async function readOpenPos(service: SupabaseClient, vendorId: string): Promise<OpenPo[]> {
  const res = await service
    .from('netsuite_vendor_pos')
    .select(PO_COLUMNS)
    .eq('vendor_netsuite_id', vendorId)
    .not('status', 'in', '(A,C,G,H,P)')
    .order('trandate', { ascending: false })
    .order('id')
    .limit(50);
  if (res.error) throw new Error(`couldn't read the vendor's open POs (${res.error.message})`);
  return ((res.data ?? []) as PoRow[])
    .filter((r) => r.tranid)
    .map((r) => ({ number: r.tranid!, status: r.status, date: day(r.trandate), totalCents: centsOf(r.total) }));
}

/**
 * What the PO rules read for a form: the PO it names, with what the three-way match reads for it (leaving out the
 * snapped bill itself as an earlier bill), else the vendor's POs that can take a bill.
 */
export async function readPoFacts(
  service: SupabaseClient,
  form: Pick<PoForm, 'poNumber' | 'vendorId' | 'totalCents'>,
  snappedId: string | null,
): Promise<PoFacts> {
  const named = form.poNumber?.trim() ?? '';
  if (!named) return { found: null, open: form.vendorId ? pickOpenPos(await readOpenPos(service, form.vendorId), form.totalCents) : [] };
  const row = await findPo(service, named, form.vendorId);
  if (!row) return NO_PO;
  const facts = await loadPoMatchFacts(service, row.id, snappedId ? { snappedId } : {});
  return {
    found: {
      copyId: row.id,
      netsuiteId: String(row.netsuite_id),
      number: row.tranid ?? named,
      vendorId: row.vendor_netsuite_id,
      vendorName: row.vendor_name,
      date: day(row.trandate),
      status: row.status,
      statusLabel: row.status_label,
      totalCents: facts.poTotal === null ? null : toCents(facts.poTotal),
      facts,
    },
    open: [],
  };
}
