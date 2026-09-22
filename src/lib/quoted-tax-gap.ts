import { computeTotals } from './estimate-totals';
import { deepLinks } from './deep-links';

/**
 * Quoted Tax Shortfall: which saved estimates carry less tax than today's
 * math gives.
 *
 * Between migration 252 and 2026-09-22 the quote builder skipped any line
 * whose NetSuite item had the Taxable box unticked. That checkbox is not
 * maintained in this account, so ordinary parts fell out of the tax base and
 * quotes went out charging less tax than the invoice that follows (PR #984
 * removed the rule). This re-runs `computeTotals` over each estimate's own
 * stored lines and reports the ones whose saved `tax_amount` is below it.
 *
 * Deliberately evidence-based, not date-based: a row is listed because its
 * own numbers disagree, so the list stays correct whatever anyone believes
 * about when the bug shipped, and empties by itself as rows are fixed.
 *
 * The comparison runs through `computeTotals` rather than reimplementing the
 * tax sum, so this report cannot drift from what the save path stores —
 * including the per-line half-even cent rounding, where taxing the combined
 * base in one go differs by a cent or two.
 */

/** Below this, a difference is float dust from summing cents, not money. */
export const MATERIAL_CENTS = 0.01;

export interface TaxGapEstimate {
  id: string;
  estimate_number: string | null;
  customer_name: string | null;
  status: string | null;
  tax_rate: number | null;
  tax_exempt: boolean | null;
  tax_amount: number | null;
  vehicle_count: number | null;
  labor_rate: number | null;
  labor_hours_override: number | null;
  customer_approved: boolean | null;
  customer_approved_at: string | null;
  sent_for_approval_at: string | null;
  netsuite_estimate_number: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface TaxGapLine {
  estimate_id: string;
  quantity: number | null;
  unit_price: number | null;
}

/**
 * What someone has to DO about a row, which is the only useful way to group
 * them. A signed estimate is frozen and the customer has already agreed to
 * the lower number, so it is a conversation. Anything unsigned is still ours
 * to correct by re-saving; the two unsigned buckets differ in urgency, since
 * a quote already sitting in a customer's inbox can be signed at the old
 * figure at any moment and a draft cannot.
 */
export type TaxGapBucket = 'signed' | 'sent' | 'open';

export interface TaxGapRow {
  id: string;
  estimate_number: string | null;
  customer_name: string | null;
  status: string | null;
  bucket: TaxGapBucket;
  tax_rate: number;
  quoted_tax: number;
  correct_tax: number;
  gap: number;
  lines: number;
  vehicle_count: number;
  netsuite_estimate_number: string | null;
  signed_at: string | null;
  sent_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  url: string;
}

export interface TaxGapReport {
  examined: number;
  skippedExempt: number;
  skippedNoLines: number;
  totalEstimates: number;
  totalGap: number;
  buckets: Record<TaxGapBucket, { count: number; gap: number }>;
  /** The opposite error, counted but not listed — see summarizeTaxGap. */
  overQuoted: { count: number; gap: number };
  rows: TaxGapRow[];
}

export function bucketFor(e: Pick<TaxGapEstimate, 'customer_approved' | 'sent_for_approval_at'>): TaxGapBucket {
  if (e.customer_approved) return 'signed';
  if (e.sent_for_approval_at) return 'sent';
  return 'open';
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function summarizeTaxGap(estimates: TaxGapEstimate[], lines: TaxGapLine[]): TaxGapReport {
  const byEstimate = new Map<string, TaxGapLine[]>();
  for (const l of lines) {
    const own = byEstimate.get(l.estimate_id);
    if (own) own.push(l);
    else byEstimate.set(l.estimate_id, [l]);
  }

  const rows: TaxGapRow[] = [];
  let overCount = 0, overTotal = 0, examined = 0, skippedExempt = 0, skippedNoLines = 0;

  for (const e of estimates) {
    // A tax-exempt customer's zero is correct, and a zero rate has nothing
    // to under-charge. Neither belongs in a list of things to chase.
    const rate = Number(e.tax_rate || 0);
    if (e.tax_exempt || !(rate > 0)) { skippedExempt++; continue; }

    const own = byEstimate.get(e.id);
    if (!own || own.length === 0) { skippedNoLines++; continue; }

    examined++;
    const correct = computeTotals(
      own,
      rate,
      false,
      Number(e.labor_rate || 0),
      e.labor_hours_override === null || e.labor_hours_override === undefined
        ? null
        : Number(e.labor_hours_override),
      e.vehicle_count ?? 1,
    ).tax_amount;

    const quoted = Number(e.tax_amount || 0);
    const gap = cents(correct - quoted);

    if (gap >= MATERIAL_CENTS) {
      rows.push({
        id: e.id,
        estimate_number: e.estimate_number,
        customer_name: e.customer_name,
        status: e.status,
        bucket: bucketFor(e),
        tax_rate: rate,
        quoted_tax: quoted,
        correct_tax: correct,
        gap,
        lines: own.length,
        vehicle_count: e.vehicle_count ?? 1,
        netsuite_estimate_number: e.netsuite_estimate_number,
        signed_at: e.customer_approved_at,
        sent_at: e.sent_for_approval_at,
        created_at: e.created_at,
        updated_at: e.updated_at,
        url: deepLinks.estimate(e.id),
      });
    } else if (gap <= -MATERIAL_CENTS) {
      // A quote that charged MORE tax than today's math does — the old
      // freight case, and whatever else. Counted rather than listed: it is
      // the direction that corrects itself at invoicing, and mixing it in
      // would bury the list that actually needs chasing. Reported so nobody
      // assumes the report simply missed them.
      overCount++;
      overTotal += -gap;
    }
  }

  rows.sort((a, b) => b.gap - a.gap || String(a.estimate_number).localeCompare(String(b.estimate_number)));

  const of = (b: TaxGapBucket) => rows.filter(r => r.bucket === b);
  return {
    examined,
    skippedExempt,
    skippedNoLines,
    totalEstimates: estimates.length,
    totalGap: cents(rows.reduce((s, r) => s + r.gap, 0)),
    buckets: {
      signed: { count: of('signed').length, gap: cents(of('signed').reduce((s, r) => s + r.gap, 0)) },
      sent: { count: of('sent').length, gap: cents(of('sent').reduce((s, r) => s + r.gap, 0)) },
      open: { count: of('open').length, gap: cents(of('open').reduce((s, r) => s + r.gap, 0)) },
    },
    overQuoted: { count: overCount, gap: cents(overTotal) },
    rows,
  };
}
