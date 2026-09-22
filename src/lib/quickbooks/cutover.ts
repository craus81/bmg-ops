import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery } from '@/lib/netsuite';
import { isoDate } from '@/lib/financials-data';

/**
 * The QuickBooks → NetSuite cutover window.
 *
 * QuickBooks ran until NetSuite went live, and the date is not in this repo
 * (owner item 5). It is DERIVED from both sides — the last QuickBooks
 * transaction versus the first NetSuite invoice — shown in the dry-run
 * report, and CONFIRMED by the owner before anything is imported. Rows on or
 * after the confirmed date are kept and flagged `post_cutover`, never
 * dropped: a QuickBooks row inside the overlap is real history, it is just
 * also in NetSuite.
 */

export interface CutoverSummary {
  qboLastTxnDate: string | null;
  qboLastByType: Record<string, string | null>;
  orderByTxnDateSupported: boolean;
  netsuiteFirstTrandate: string | null;
  netsuiteSource: 'suiteql' | 'so_mirror' | 'none';
  proposedCutoverDate: string | null;
  overlapDays: number | null;
  postCutoverCounts: Record<string, number | null>;
}

const DAY_MS = 86_400_000;

/**
 * Fold the two sides into a proposal.
 *
 * The PROPOSAL is the NetSuite first-invoice date: that is the day the new
 * system started being the book of record. The overlap is how long both were
 * running, and it is NULL when either side is unknown — a number computed
 * from one side would look like a measurement and be a guess.
 */
export function deriveCutover(i: {
  qboLastByType: Record<string, string | null>;
  netsuiteFirstTrandate: string | null;
  orderByTxnDateSupported?: boolean;
  netsuiteSource?: CutoverSummary['netsuiteSource'];
  postCutoverCounts?: Record<string, number | null>;
}): CutoverSummary {
  const dates = Object.values(i.qboLastByType).filter((d): d is string => !!d);
  const qboLastTxnDate = dates.length > 0 ? dates.slice().sort().at(-1)! : null;
  const proposed = i.netsuiteFirstTrandate;

  let overlapDays: number | null = null;
  if (qboLastTxnDate && proposed) {
    const a = Date.parse(`${qboLastTxnDate}T00:00:00Z`);
    const b = Date.parse(`${proposed}T00:00:00Z`);
    if (Number.isFinite(a) && Number.isFinite(b)) overlapDays = Math.round((a - b) / DAY_MS);
  }

  return {
    qboLastTxnDate,
    qboLastByType: i.qboLastByType,
    orderByTxnDateSupported: i.orderByTxnDateSupported ?? true,
    netsuiteFirstTrandate: proposed,
    netsuiteSource: i.netsuiteSource ?? (proposed ? 'suiteql' : 'none'),
    proposedCutoverDate: proposed,
    overlapDays,
    postCutoverCounts: i.postCutoverCounts ?? {},
  };
}

/**
 * The NetSuite side of the window.
 *
 * SuiteQL first, because the transaction table is authoritative. When the
 * role cannot read it (or SuiteQL is down), fall back to the sales-order
 * mirror already in Postgres and RECORD WHICH — a first-SO date is not a
 * first-invoice date, and the report has to say so rather than presenting a
 * weaker number as the same fact.
 */
export async function netsuiteFirstInvoiceDate(
  service: SupabaseClient,
): Promise<{ date: string | null; source: CutoverSummary['netsuiteSource']; warning?: string }> {
  try {
    const result = await suiteqlQuery(
      "SELECT MIN(t.trandate) AS d FROM transaction t WHERE t.type = 'CustInvc'",
      1,
      0,
      { retries: 2 },
    );
    // SuiteQL answers in the account's date format ('1/7/2024'), and this
    // date is spliced into a QuickBooks `TxnDate >= '…'` query, which only
    // accepts ISO — so normalize, never slice.
    const date = isoDate(result?.items?.[0]?.d);
    if (date) return { date, source: 'suiteql' };
  } catch (e: any) {
    console.error('[ledger] SuiteQL cutover probe failed, falling back to the SO mirror:', e?.message || e);
  }

  const { data, error } = await service
    .from('netsuite_sales_orders')
    .select('trandate')
    .not('trandate', 'is', null)
    .order('trandate', { ascending: true })
    .limit(1)
    .maybeSingle();
  const mirrorDate = isoDate(data?.trandate);
  if (error || !mirrorDate) {
    return {
      date: null,
      source: 'none',
      warning: 'Neither SuiteQL nor the sales-order mirror could give a first NetSuite transaction date — confirm the cutover by hand.',
    };
  }
  return {
    date: mirrorDate,
    source: 'so_mirror',
    warning: 'The NetSuite date came from the sales-order mirror, not from invoices — the first INVOICE may be later.',
  };
}
