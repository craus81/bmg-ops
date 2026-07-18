import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createVendorBill, findLocation } from '@/lib/netsuite';
import { logAudit } from '@/lib/audit';
import { notifyMany } from '@/lib/notify';

export const dynamic = 'force-dynamic';
// NetSuite bill creation is slow.
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Same NetSuite internal ids as the CNI payout flow (docs/cni-vendor-bills.md):
// Subcontractors GL #53000 and the BMG Fleet Installations subsidiary.
const SUBCONTRACTOR_ACCT_ID = process.env.NETSUITE_SUBCONTRACTOR_ACCOUNT_ID || '223';
const BILL_SUBSIDIARY_ID = process.env.NETSUITE_SUBSIDIARY_ID || '2';
const BILL_LOCATIONS = ['Wentzville', 'Kansas City', "O'Fallon", 'Social Circle'] as const;

const PostSchema = z.union([
  z.object({ action: z.literal('submit'), id: z.string().uuid() }),
  z.object({ action: z.literal('approve'), id: z.string().uuid() }),
  z.object({ action: z.literal('reject'), id: z.string().uuid(), reason: z.string().trim().min(1).max(500) }),
  z.object({ action: z.literal('create_bill'), id: z.string().uuid(), location: z.enum(BILL_LOCATIONS) }),
  z.object({ action: z.literal('record_bill'), id: z.string().uuid(), netsuiteBillId: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal('mark_paid'), id: z.string().uuid() }),
]);

/** Everyone who should see AP notifications: finance users, falling back to admins. */
async function financeUserIds(excludeId?: string): Promise<string[]> {
  const { data } = await service
    .from('profiles')
    .select('id, role, roles')
    .or('role.eq.finance,roles.cs.{finance},role.eq.admin,roles.cs.{admin}')
    .eq('status', 'approved');
  const all = (data || []);
  const finance = all.filter(p => p.role === 'finance' || (p.roles || []).includes('finance'));
  const pool = finance.length > 0 ? finance : all;
  return pool.map(p => p.id).filter(id => id !== excludeId);
}

/**
 * Vendor-invoice payment lifecycle:
 *   recorded → submitted → approved → billed → paid
 * with rejected (back to the submitter, resubmittable) as the off-ramp.
 * Finance and admin operate this; every step stamps who + when, writes the
 * audit log, and notifies the relevant person.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['finance']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PostSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const actorId = auth.user!.id;
  const now = new Date().toISOString();

  const { data: invoice } = await service
    .from('vendor_invoices')
    .select('*, company:companies(id, name, netsuite_vendor_id), lines:vendor_invoice_lines(amount)')
    .eq('id', body.id)
    .maybeSingle();
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const label = `${invoice.vendor_name}${invoice.invoice_number ? ` #${invoice.invoice_number}` : ''}`;
  const amount = invoice.total_amount != null
    ? Number(invoice.total_amount)
    : (invoice.lines || []).reduce((s: number, l: { amount: number | null }) => s + (l.amount != null ? Number(l.amount) : 0), 0);

  const fail = (msg: string, status = 400) => NextResponse.json({ error: msg }, { status });
  const transition = async (expected: string[], patch: Record<string, unknown>) => {
    if (!expected.includes(invoice.status)) {
      return { error: fail(`Invoice is ${invoice.status} — expected ${expected.join(' or ')}`) };
    }
    const { error } = await service.from('vendor_invoices').update(patch).eq('id', invoice.id);
    if (error) return { error: fail(`Failed to update invoice: ${error.message}`, 500) };
    return { error: null };
  };

  try {
    if (body.action === 'submit') {
      const t = await transition(['recorded', 'rejected'], {
        status: 'submitted', submitted_by: actorId, submitted_at: now,
        rejected_by: null, rejected_at: null, rejection_reason: null,
      });
      if (t.error) return t.error;
      const recipients = await financeUserIds(actorId);
      if (recipients.length > 0) {
        await notifyMany(recipients, {
          type: 'ap_submitted',
          title: `Payment request: ${label}`,
          body: `${invoice.vendor_name} invoice${invoice.invoice_number ? ` #${invoice.invoice_number}` : ''} for $${amount.toFixed(2)} is awaiting approval.`,
          url: '/admin/ap',
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
      }
      await logAudit(service, { actorId, table: 'vendor_invoices', recordId: invoice.id, action: 'submit', detail: { vendor: invoice.vendor_name, amount } });
      return NextResponse.json({ success: true });
    }

    if (body.action === 'approve') {
      const t = await transition(['submitted'], { status: 'approved', approved_by: actorId, approved_at: now });
      if (t.error) return t.error;
      if (invoice.submitted_by && invoice.submitted_by !== actorId) {
        await notifyMany([invoice.submitted_by], {
          type: 'ap_decision',
          title: `Approved: ${label}`,
          body: `Payment of $${amount.toFixed(2)} was approved.`,
          url: '/admin/ap',
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
      }
      await logAudit(service, { actorId, table: 'vendor_invoices', recordId: invoice.id, action: 'approve', detail: { vendor: invoice.vendor_name, amount } });
      return NextResponse.json({ success: true });
    }

    if (body.action === 'reject') {
      const t = await transition(['submitted', 'approved'], {
        status: 'rejected', rejected_by: actorId, rejected_at: now, rejection_reason: body.reason,
      });
      if (t.error) return t.error;
      if (invoice.submitted_by && invoice.submitted_by !== actorId) {
        await notifyMany([invoice.submitted_by], {
          type: 'ap_decision',
          title: `Rejected: ${label}`,
          body: body.reason,
          url: '/admin/scans?tab=vendor',
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
      }
      await logAudit(service, { actorId, table: 'vendor_invoices', recordId: invoice.id, action: 'reject', detail: { vendor: invoice.vendor_name, amount, reason: body.reason } });
      return NextResponse.json({ success: true });
    }

    if (body.action === 'create_bill') {
      if (invoice.status !== 'approved') return fail(`Invoice is ${invoice.status} — only approved invoices can be billed`);
      if (!(amount > 0)) return fail('Invoice has no amount to bill — set the invoice total or per-VIN amounts first');
      const company = Array.isArray(invoice.company) ? invoice.company[0] : invoice.company;
      const vendorId = company?.netsuite_vendor_id?.trim();
      if (!vendorId) {
        return fail(`${invoice.vendor_name} isn't linked to a NetSuite vendor — link or create one from the Vendor Invoices tab (or the company page) first`);
      }
      if (!/^\d+$/.test(vendorId)) {
        return fail(`${invoice.vendor_name}'s NetSuite vendor ID is "${vendorId}", which isn't a numeric internal id — fix it on the company page`);
      }

      const location = await findLocation(body.location);
      if (!location) return fail(`Could not find the "${body.location}" location in NetSuite`);

      const memo = `CNI vendor invoice — ${label}`;
      // Reference No. (tranId) — required by NetSuite when bills aren't
      // auto-numbered; the installer's own invoice number keeps statements
      // reconcilable.
      const referenceNo = (invoice.invoice_number ? `VI-${invoice.invoice_number}` : `VI-${invoice.id.slice(0, 8)}`).slice(0, 40);

      const bill = await createVendorBill({
        vendorId,
        accountId: SUBCONTRACTOR_ACCT_ID,
        amount: Math.round(amount * 100) / 100,
        referenceNo,
        subsidiaryId: BILL_SUBSIDIARY_ID,
        locationId: location.id,
        memo,
        lineMemo: memo,
      });
      if (!bill.success) return NextResponse.json({ error: bill.error || 'Failed to create vendor bill' }, { status: 502 });
      const billRef = bill.billNumber || bill.billId || '';

      const { error } = await service
        .from('vendor_invoices')
        .update({ status: 'billed', netsuite_bill_id: billRef, billed_by: actorId, billed_at: now })
        .eq('id', invoice.id);
      if (error) return fail(`Bill created in NetSuite but failed to update the invoice: ${error.message}`, 500);
      await logAudit(service, { actorId, table: 'vendor_invoices', recordId: invoice.id, action: 'create_bill', detail: { vendor: invoice.vendor_name, amount, netsuite_bill_id: billRef, location: body.location } });
      return NextResponse.json({ success: true, netsuiteBillId: billRef });
    }

    if (body.action === 'record_bill') {
      const t = await transition(['approved'], {
        status: 'billed', netsuite_bill_id: body.netsuiteBillId, billed_by: actorId, billed_at: now,
      });
      if (t.error) return t.error;
      await logAudit(service, { actorId, table: 'vendor_invoices', recordId: invoice.id, action: 'record_bill', detail: { vendor: invoice.vendor_name, amount, netsuite_bill_id: body.netsuiteBillId } });
      return NextResponse.json({ success: true });
    }

    // mark_paid
    const t = await transition(['billed'], { status: 'paid', paid_by: actorId, paid_at: now });
    if (t.error) return t.error;
    await logAudit(service, { actorId, table: 'vendor_invoices', recordId: invoice.id, action: 'mark_paid', detail: { vendor: invoice.vendor_name, amount, netsuite_bill_id: invoice.netsuite_bill_id } });
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Payment action failed' }, { status: 500 });
  }
}
