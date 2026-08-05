/**
 * NetSuite → FleetSuite vendor-bill payment sync.
 *
 * CNI vendor invoices sit at status 'billed' ("Awaiting Payment") after the
 * NetSuite vendor bill is created; the actual payment happens in NetSuite.
 * This sweep asks NetSuite which of those bills are now Paid In Full and
 * flips the matching invoices to 'paid' — so the AP queue stays truthful
 * without anyone clicking "Mark Paid" — then notifies the submitter (often
 * the installer waiting on the check) and the finance team.
 *
 * netsuite_bill_id holds whatever the bill was recorded with: the internal
 * id (numeric) from the one-click create, or a hand-pasted bill number
 * (tranid) from "Record Bill" — the lookup matches on either.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery } from '@/lib/netsuite';
import { normalizeNsInvoiceStatus } from '@/lib/po-invoice-sync';
import { fetchAllRows } from '@/lib/fetch-all';
import { financeUserIds, apSubmitterUrl } from '@/lib/ap';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { logAudit } from '@/lib/audit';
import { findBillForRef, type NsBill } from '@/lib/vendor-bill-match';

type Service = SupabaseClient<any, any, any>;

interface BilledInvoice {
  id: string;
  vendor_name: string;
  invoice_number: string | null;
  total_amount: number | null;
  netsuite_bill_id: string;
  submitted_by: string | null;
  lines: { amount: number | null }[];
}

const CHUNK = 100;

export async function syncVendorBillPayments(service: Service): Promise<{
  checked: number;
  paid: number;
  errors: string[];
}> {
  const { data: invoices, error } = await fetchAllRows<BilledInvoice>((from, to) =>
    service
      .from('vendor_invoices')
      .select('id, vendor_name, invoice_number, total_amount, netsuite_bill_id, submitted_by, lines:vendor_invoice_lines(amount)')
      .eq('status', 'billed')
      .not('netsuite_bill_id', 'is', null)
      .order('id')
      .range(from, to),
  );
  if (error) return { checked: 0, paid: 0, errors: [`load billed invoices: ${error.message}`] };

  const withRef = (invoices || []).filter(i => (i.netsuite_bill_id || '').trim());
  if (withRef.length === 0) return { checked: 0, paid: 0, errors: [] };

  const errors: string[] = [];
  let paidCount = 0;

  for (let i = 0; i < withRef.length; i += CHUNK) {
    const chunk = withRef.slice(i, i + CHUNK);
    const refs = [...new Set(chunk.map(inv => inv.netsuite_bill_id.trim()))];
    const idRefs = refs.filter(r => /^\d+$/.test(r));
    // Escape single quotes; tranids are staff-entered free text.
    const tranRefs = refs.map(r => r.replace(/'/g, "''").toUpperCase());

    const clauses = [
      ...(idRefs.length > 0 ? [`t.id IN (${idRefs.join(', ')})`] : []),
      `UPPER(t.tranid) IN (${tranRefs.map(r => `'${r}'`).join(', ')})`,
    ];
    let bills: NsBill[] = [];
    try {
      const result = await suiteqlQuery(`
        SELECT t.id, t.tranid, t.status
        FROM transaction t
        WHERE t.type = 'VendBill' AND (${clauses.join(' OR ')})
      `);
      bills = result?.items || [];
    } catch (e: any) {
      errors.push(`SuiteQL bill lookup: ${e.message}`);
      continue;
    }

    for (const inv of chunk) {
      const bill = findBillForRef(inv.netsuite_bill_id, bills);
      if (!bill || normalizeNsInvoiceStatus(bill.status) !== 'paid') continue;

      const now = new Date().toISOString();
      // Guarded transition: only flip invoices still 'billed', so a
      // concurrent manual Mark Paid (or reject) never gets clobbered.
      const { data: updated, error: upErr } = await service
        .from('vendor_invoices')
        .update({ status: 'paid', paid_by: null, paid_at: now })
        .eq('id', inv.id)
        .eq('status', 'billed')
        .select('id');
      if (upErr) { errors.push(`${inv.vendor_name} #${inv.invoice_number || inv.id.slice(0, 8)}: ${upErr.message}`); continue; }
      if (!updated || updated.length === 0) continue; // someone beat us to it

      paidCount++;
      const label = `${inv.vendor_name}${inv.invoice_number ? ` #${inv.invoice_number}` : ''}`;
      const amount = inv.total_amount != null
        ? Number(inv.total_amount)
        : (inv.lines || []).reduce((s, l) => s + (l.amount != null ? Number(l.amount) : 0), 0);

      await logAudit(service, {
        actorId: null,
        table: 'vendor_invoices',
        recordId: inv.id,
        action: 'mark_paid',
        detail: { vendor: inv.vendor_name, amount, netsuite_bill_id: inv.netsuite_bill_id, source: 'netsuite_sync', ns_status: String(bill.status) },
      });

      // The submitter (often the installer) hears their money moved; the
      // finance team hears the queue shrank — minus the submitter so
      // staff-recorded invoices don't ping the same person twice.
      if (inv.submitted_by) {
        await notifyMany([inv.submitted_by], {
          type: 'ap_decision',
          title: `Paid: ${label}`,
          body: `Payment of $${amount.toFixed(2)} has been sent (bill paid in NetSuite).`,
          url: await apSubmitterUrl(service, inv.submitted_by, inv.id),
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
      }
      const finance = (await financeUserIds(service)).filter(id => id !== inv.submitted_by);
      if (finance.length > 0) {
        await notifyMany(finance, {
          type: 'ap_paid',
          title: `Bill paid: ${label}`,
          body: `NetSuite shows bill ${inv.netsuite_bill_id} paid in full ($${amount.toFixed(2)}) — the invoice moved to Paid.`,
          url: deepLinks.apInvoice(inv.id),
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
      }
    }
  }

  return { checked: withRef.length, paid: paidCount, errors };
}
