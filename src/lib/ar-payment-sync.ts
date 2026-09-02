/**
 * AR payment sync-back.
 *
 * fleet_checkins.is_paid and scan_logs.is_paid were hand-ticked checkboxes —
 * so the Ops dashboard's "Vehicles invoiced, awaiting payment" tile inflated
 * forever unless someone bookkept by hand, the exact double-entry the NetSuite
 * integration exists to kill. The AP side already reconciles vendor-bill
 * payments (syncVendorBillPayments); this is the receivables mirror.
 *
 * For every invoice number recorded on an unpaid fleet_checkin or scan_log,
 * ask NetSuite whether that customer invoice is Paid In Full, and flip is_paid
 * when it is. The manual checkbox stays a valid override for the reverse
 * direction (marking paid before NetSuite catches up); this only ever flips
 * false → true, never back.
 */

import { suiteqlQuery } from '@/lib/netsuite';
import { safeStringLiteral } from '@/lib/sql-safe';
import { fetchAllRows } from '@/lib/fetch-all';

export interface ArPaymentSyncResult {
  checkedInvoices: number;
  paidInvoices: number;
  fleetCheckinsUpdated: number;
  scanLogsUpdated: number;
}

// NetSuite SuiteQL returns invoice status as 'B' (Paid In Full) / 'A' (Open);
// some environments return the text label. Accept both (mirrors invoices-list).
function isPaidStatus(raw: unknown): boolean {
  const s = String(raw ?? '');
  return s === 'B' || /paid/i.test(s);
}

/** Collect distinct non-empty invoice numbers from an unpaid-rows read. */
async function unpaidInvoiceNumbers(
  supabase: any,
  table: 'fleet_checkins' | 'scan_logs',
): Promise<Set<string>> {
  const { data } = await fetchAllRows<{ invoice_number: string | null }>((from, to) =>
    supabase
      .from(table)
      .select('invoice_number')
      .not('invoice_number', 'is', null)
      .eq('is_paid', false)
      .order('invoice_number')
      .order('id')
      .range(from, to),
  );
  const set = new Set<string>();
  for (const r of data || []) {
    const n = (r.invoice_number || '').trim();
    if (n) set.add(n);
  }
  return set;
}

/**
 * Ask NetSuite which of these invoice numbers are Paid In Full.
 * Batched IN queries keep the SuiteQL statement bounded.
 *
 * Stored numbers are matched two ways (Round 3 §7.2.8): as tranids — the
 * normal case — and, for digit-only values, as internal ids too. The
 * invoice routes stamp the internal id when NetSuite's tranid lookup
 * fails, and those rows could never be marked paid while this matched
 * tranid alone. An id-match also reports the real tranid so the caller
 * can backfill the stored number.
 */
async function fetchPaidInvoiceNumbers(numbers: string[]): Promise<{
  paid: Set<string>;
  /** stored internal id (digit-only) → real tranid, for paid id-matches */
  tranidByStoredId: Map<string, string>;
}> {
  const paid = new Set<string>();
  const tranidByStoredId = new Map<string, string>();
  const BATCH = 150;
  for (let i = 0; i < numbers.length; i += BATCH) {
    const batch = numbers.slice(i, i + BATCH);
    const inList = batch.map((n) => `'${safeStringLiteral(n, 60)}'`).join(', ');
    const idCandidates = batch.filter((n) => /^\d{1,15}$/.test(n));
    const idList = idCandidates.join(', ');
    const query = `
      SELECT t.id, t.tranid, t.status
      FROM transaction t
      WHERE t.type = 'CustInvc'
        AND (t.tranid IN (${inList})${idList ? ` OR t.id IN (${idList})` : ''})
    `;
    const res = await suiteqlQuery(query, (BATCH * 2) + 50, 0);
    // Resolve each stored value with the TRANID interpretation winning: a
    // digit-only tranid must never be flipped on the strength of some other
    // invoice that happens to carry that number as its internal id.
    const byTranid = new Map<string, any>();
    const byId = new Map<string, any>();
    for (const row of res?.items || []) {
      const tranid = String(row.tranid ?? '').trim();
      const internalId = String(row.id ?? '').trim();
      if (tranid && !byTranid.has(tranid)) byTranid.set(tranid, row);
      if (internalId && !byId.has(internalId)) byId.set(internalId, row);
    }
    for (const n of batch) {
      const row = byTranid.get(n) ?? byId.get(n);
      if (!row || !isPaidStatus(row.status)) continue;
      paid.add(n);
      if (!byTranid.has(n)) {
        const tranid = String(row.tranid ?? '').trim();
        if (tranid) tranidByStoredId.set(n, tranid);
      }
    }
  }
  return { paid, tranidByStoredId };
}

export async function syncArInvoicePayments(supabase: any): Promise<ArPaymentSyncResult> {
  // Distinct invoice numbers still marked unpaid across both AR tables.
  const [fleetNums, scanNums] = await Promise.all([
    unpaidInvoiceNumbers(supabase, 'fleet_checkins'),
    unpaidInvoiceNumbers(supabase, 'scan_logs'),
  ]);
  const allNumbers = Array.from(new Set<string>([...fleetNums, ...scanNums]));

  const result: ArPaymentSyncResult = {
    checkedInvoices: allNumbers.length,
    paidInvoices: 0,
    fleetCheckinsUpdated: 0,
    scanLogsUpdated: 0,
  };
  if (allNumbers.length === 0) return result;

  const { paid: paidNumbers, tranidByStoredId } = await fetchPaidInvoiceNumbers(allNumbers);
  result.paidInvoices = paidNumbers.size;
  if (paidNumbers.size === 0) return result;

  // Flip is_paid true for the now-paid invoices. Chunk the IN list on the
  // update filter too so a large paid batch doesn't blow the URL length.
  const paidList = Array.from(paidNumbers);
  const UPDATE_BATCH = 100;
  for (let i = 0; i < paidList.length; i += UPDATE_BATCH) {
    const batch = paidList.slice(i, i + UPDATE_BATCH);
    const [fleetRes, scanRes] = await Promise.all([
      supabase
        .from('fleet_checkins')
        .update({ is_paid: true })
        .in('invoice_number', batch)
        .eq('is_paid', false)
        .select('id'),
      supabase
        .from('scan_logs')
        .update({ is_paid: true })
        .in('invoice_number', batch)
        .eq('is_paid', false)
        .select('id'),
    ]);
    result.fleetCheckinsUpdated += (fleetRes.data || []).length;
    result.scanLogsUpdated += (scanRes.data || []).length;
  }

  // Rows that matched by INTERNAL id were stamped by an invoice route whose
  // tranid lookup failed — now that NetSuite told us the real tranid,
  // backfill it so the row displays (and future-matches) like every other.
  // Exact-equality filter: hand-typed numbers are never touched.
  for (const [storedId, tranid] of tranidByStoredId) {
    if (!tranid || tranid === storedId) continue;
    await Promise.all([
      supabase.from('fleet_checkins').update({ invoice_number: tranid }).eq('invoice_number', storedId),
      supabase.from('scan_logs').update({ invoice_number: tranid }).eq('invoice_number', storedId),
    ]);
  }

  return result;
}
