/**
 * Masterack pricing requests (migration 352, owner ask 2026-10-08).
 *
 * A request is the email Masterack sends asking what BMG would charge to
 * make and install graphics for one of their customers ("Orkin", plus a
 * picture or proof). Its pricing is an ordinary estimate marked with
 * estimates.pricing_request_id, sent through the normal approval flow and
 * never pushed to NetSuite. When Masterack's PO arrives with new 02 / 06
 * numbers, an admin links the PO to the request on the PO page and both
 * numbers become catalog items at the quoted prices.
 *
 * Client-safe: pure helpers shared by the page, the PO page and the API.
 */

import { INSTALL_PREFIX, PART_PREFIX } from '@/lib/po-install-parts';

export type PricingRequestStatus = 'open' | 'declined' | 'closed';

export interface PricingRequest {
  id: string;
  request_number: string;
  customer_name: string;
  customer_netsuite_id: string | null;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  received_date: string;
  description: string | null;
  vehicle: string | null;
  status: PricingRequestStatus;
  part_number: string | null;
  install_part_number: string | null;
  part_id: string | null;
  install_part_id: string | null;
  part_price: number | null;
  install_price: number | null;
  po_id: string | null;
  linked_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The slice of the price-sheet estimate the request page reads. */
export interface PriceSheetSummary {
  id: string;
  estimate_number: string | null;
  status: string | null;
  customer_approved: boolean | null;
  customer_rejected_at: string | null;
  customer_rejection_reason: string | null;
  grand_total: number | null;
  lines: { item_number: string | null; description: string | null; quantity: number; unit_price: number }[];
}

/** Customers that send pricing requests. Masterack today; Reading Truck
 *  Equipment may follow (owner, 2026-10-08). */
export const PRICING_REQUEST_CUSTOMERS = ['Masterack', 'Reading Truck Equipment'] as const;
export const DEFAULT_PRICING_REQUEST_CUSTOMER = PRICING_REQUEST_CUSTOMERS[0];

export type PricingRequestStage =
  | 'new' | 'pricing' | 'sent' | 'changes_requested' | 'approved' | 'on_po' | 'declined' | 'closed';

export const STAGE_META: Record<PricingRequestStage, { label: string; color: string }> = {
  new: { label: 'New', color: '#60a5fa' },
  pricing: { label: 'Pricing', color: '#a78bfa' },
  sent: { label: 'Sent', color: '#fbbf24' },
  changes_requested: { label: 'Changes requested', color: '#f97316' },
  approved: { label: 'Approved', color: '#4ade80' },
  on_po: { label: 'On PO', color: '#22d3ee' },
  declined: { label: 'Declined', color: '#9ca3af' },
  closed: { label: 'Closed', color: '#94a3b8' },
};

/** Ordered for the list's filter chips. */
export const STAGE_ORDER: PricingRequestStage[] = ['new', 'pricing', 'sent', 'changes_requested', 'approved', 'on_po', 'declined', 'closed'];

/**
 * Where a request stands. Only Declined / Closed are typed by a person; the
 * rest are read off the price sheet and the PO link so they can never drift
 * from what actually happened.
 */
export function pricingRequestStage(
  request: Pick<PricingRequest, 'status' | 'po_id'>,
  sheet: Pick<PriceSheetSummary, 'status' | 'customer_approved' | 'grand_total'> | null,
): PricingRequestStage {
  if (request.status === 'declined') return 'declined';
  if (request.status === 'closed') return 'closed';
  if (request.po_id) return 'on_po';
  if (!sheet) return 'new';
  if (sheet.customer_approved || sheet.status === 'accepted') return 'approved';
  if (sheet.status === 'rejected') return 'changes_requested';
  if (sheet.status === 'sent') return 'sent';
  return 'pricing';
}

const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};

/** The two starting lines of a new price sheet: the graphic (becomes the
 *  02 number) and its install (the 06 number). Prices start blank. */
export function defaultPriceSheetLines(companyName: string) {
  const who = companyName.trim();
  return [
    { item_number: null, description: `Graphics: ${who}`, quantity: 1, unit_price: 0, labor_hours: null, is_custom: true },
    { item_number: null, description: `Install: ${who}`, quantity: 1, unit_price: 0, labor_hours: null, is_custom: true },
  ];
}

const isInstallLine = (l: { item_number?: string | null; description?: string | null }) =>
  /\binstall/i.test(l.description || '') || String(l.item_number || '').toUpperCase().startsWith(INSTALL_PREFIX);

/**
 * The quoted graphic and install unit prices off a price sheet: install =
 * the lines that say "install" (or carry an 06 number), graphic = the rest,
 * each summed per unit. Used to prefill the PO link, where an admin can
 * still correct them.
 */
export function quotedPrices(lines: PriceSheetSummary['lines']): { part: number; install: number } {
  let part = 0;
  let install = 0;
  for (const l of lines) {
    const amount = money(l.unit_price) * (Number(l.quantity) || 0);
    if (isInstallLine(l)) install += amount;
    else part += amount;
  }
  return { part: money(part), install: money(install) };
}

/** A PO line the link dialog works with. */
export interface PoLineForLink {
  id: string;
  part_number: string;
  description: string | null;
  unit_price: number | null;
  part_id: string | null;
  /** The catalog row's netsuite_id, when the line has a part. */
  part_netsuite_id: string | null;
}

/** A catalog row created by PO import has a placeholder id, not a real
 *  NetSuite internal id: the part is new to us. */
export const isRealNetsuiteId = (id: string | null | undefined) => !!id && !/^(LOCAL-|bmg-)/i.test(id);

export interface NewPartPair {
  /** The shared suffix: 02T278 / 06T278 → T278. */
  suffix: string;
  partLine: PoLineForLink | null;
  installLine: PoLineForLink | null;
}

/**
 * The 02 / 06 lines on a PO that aren't real NetSuite items yet, paired by
 * suffix (02T278 is the graphic, 06T278 its install). Numbers already linked
 * to a request are left out.
 */
export function newPartPairs(lines: PoLineForLink[], alreadyLinked: Iterable<string> = []): NewPartPair[] {
  const linked = new Set(Array.from(alreadyLinked, n => n.toUpperCase()));
  const pairs = new Map<string, NewPartPair>();
  for (const line of lines) {
    const pn = String(line.part_number || '').trim().toUpperCase();
    const prefix = pn.slice(0, 2);
    if (prefix !== PART_PREFIX && prefix !== INSTALL_PREFIX) continue;
    if (pn.length <= 2 || linked.has(pn)) continue;
    if (isRealNetsuiteId(line.part_netsuite_id)) continue;
    const suffix = pn.slice(2);
    const pair = pairs.get(suffix) || { suffix, partLine: null, installLine: null };
    if (prefix === PART_PREFIX) pair.partLine = pair.partLine || line;
    else pair.installLine = pair.installLine || line;
    pairs.set(suffix, pair);
  }
  return Array.from(pairs.values());
}

const words = (s: string | null | undefined) =>
  new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3));

/**
 * How well a request fits a pair of PO lines: the share of the request's
 * company-name words found in the PO lines' descriptions (Masterack's line
 * text usually names the end company). 0 when nothing overlaps.
 */
export function matchScore(request: Pick<PricingRequest, 'company_name'>, pair: NewPartPair): number {
  const want = words(request.company_name);
  if (want.size === 0) return 0;
  const have = words([pair.partLine?.description, pair.installLine?.description].join(' '));
  let hit = 0;
  want.forEach(w => { if (have.has(w)) hit++; });
  return hit / want.size;
}

/**
 * Requests worth offering for a pair, best first: any not yet on a PO and not
 * declined or closed, ranked by company-name match, then approved ones, then
 * newest. (Masterack sometimes sends the PO before clicking Approve.)
 */
export function rankRequestsForPair<T extends Pick<PricingRequest, 'company_name' | 'po_id' | 'received_date'> & { stage: PricingRequestStage }>(
  requests: T[],
  pair: NewPartPair,
): T[] {
  const eligible = requests.filter(r => !r.po_id && r.stage !== 'declined' && r.stage !== 'closed' && r.stage !== 'on_po');
  const stageRank = (s: PricingRequestStage) => (s === 'approved' ? 0 : 1);
  return eligible
    .map(r => ({ r, score: matchScore(r, pair) }))
    .sort((a, b) =>
      b.score - a.score
      || stageRank(a.r.stage) - stageRank(b.r.stage)
      || String(b.r.received_date).localeCompare(String(a.r.received_date)))
    .map(x => x.r);
}

/** Refusal shown when someone tries to push a pricing-request estimate. */
export const PRICING_REQUEST_PUSH_BLOCKED =
  'This estimate is the price sheet for a pricing request. Masterack is billed from their PO, so it is never pushed to NetSuite. Link the PO on the PO page instead.';
