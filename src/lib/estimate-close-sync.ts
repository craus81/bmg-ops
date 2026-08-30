/**
 * Drain the backlog of converted-but-still-open NetSuite estimates
 * (audit Round 2 item 10).
 *
 * Every estimate pushed to NetSuite and later converted to an SO stayed
 * Open forever: FleetSuite creates standalone SOs, so NetSuite's own
 * estimate->Processed transition (which only fires on transform linkage)
 * never ran. convert-to-so now closes the estimate at conversion time;
 * this sweep, run from the netsuite-sync cron, retires the ones converted
 * before that fix — and catches any conversion whose best-effort close
 * failed.
 *
 * Idempotent with no local state: a closed estimate leaves NetSuite's open
 * set ('A','B','E','X' — the same set the app's open-transaction search
 * uses), so it simply stops matching the SuiteQL probe on the next run.
 * CAP bounds each run's PATCH volume; the 2-hourly cron drains any real
 * backlog within days.
 */
import { suiteqlQuery, closeNetSuiteEstimate } from '@/lib/netsuite';
import { fetchAllRows } from '@/lib/fetch-all';

export interface EstimateCloseSyncResult {
  converted: number;
  stillOpen: number;
  closed: number;
  errors: number;
  firstError?: string;
}

/** Most NetSuite PATCHes per run — keeps the cron phase bounded. */
const CAP = 25;

export async function closeConvertedEstimates(supabase: any): Promise<EstimateCloseSyncResult> {
  // Every FS estimate that has BOTH a NetSuite estimate and a NetSuite SO —
  // i.e. pushed, then converted. Deterministic order + id tiebreaker per
  // the fetchAllRows contract.
  const { data: rows } = await fetchAllRows<{ id: string; netsuite_estimate_id: string }>((from, to) =>
    supabase
      .from('estimates')
      .select('id, netsuite_estimate_id')
      .not('netsuite_estimate_id', 'is', null)
      .not('netsuite_so_id', 'is', null)
      .order('id')
      .range(from, to),
  );

  const result: EstimateCloseSyncResult = {
    converted: rows?.length || 0, stillOpen: 0, closed: 0, errors: 0,
  };
  if (!rows || rows.length === 0) return result;

  // Ask NetSuite which of them are still open. Numeric ids only — they come
  // from NetSuite itself, but never trust a stored string into SQL.
  const ids = rows
    .map(r => String(r.netsuite_estimate_id).trim())
    .filter(id => /^\d+$/.test(id));
  const open: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const inList = ids.slice(i, i + BATCH).join(', ');
    const res = await suiteqlQuery(
      `SELECT t.id FROM transaction t
       WHERE t.type = 'Estimate' AND t.status IN ('A', 'B', 'E', 'X') AND t.id IN (${inList})`,
      BATCH + 50, 0,
    );
    for (const row of res?.items || []) {
      if (row?.id != null) open.push(String(row.id));
    }
  }
  result.stillOpen = open.length;

  for (const nsId of open.slice(0, CAP)) {
    const closed = await closeNetSuiteEstimate(nsId);
    if (closed.success) {
      result.closed++;
    } else {
      result.errors++;
      if (!result.firstError) result.firstError = closed.error;
      console.warn(`[estimate-close] NS estimate ${nsId} close failed:`, closed.error);
    }
  }
  if (open.length > CAP) {
    console.log(`[estimate-close] ${open.length - CAP} still-open estimates deferred to the next run (cap ${CAP})`);
  }

  return result;
}
