/**
 * "Enter this invoice in the customer's portal" alerts.
 *
 * Some customers only pay invoices that someone at BMG keys into the
 * customer's own AP portal — Bodewell first (owner ask 2026-10-05: "that's
 * the only way we get paid"). Each such customer lists its portal invoice
 * contacts on Admin → Customer Notifications
 * (customers.portal_invoice_contact_ids, migration 346). Every path that
 * creates an invoice in FleetSuite calls notifyPortalInvoice() once the
 * invoice exists:
 *
 *   graphics job      /api/graphics/create-invoice
 *   Scan Log          /api/netsuite/invoice-vehicles (also the Invoices hub)
 *   vehicle complete  /api/vehicle-tracking/invoice
 *   PO page           /api/netsuite/create-invoice
 *
 * The contacts get it immediately on every channel (registry type
 * portal_invoice_entry is alwaysOn + emailNow), the person who created the
 * invoice included — the alert is their to-do too. The email carries the
 * NetSuite invoice PDF so it can be uploaded straight into the portal.
 *
 * Matching is by NetSuite customer id, never by name, and a sub-customer
 * ("Bodewell : Some Site") counts for its parent so a job billed to a child
 * record isn't missed. Best-effort throughout: nothing here may fail the
 * invoice call that already succeeded.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { getNetSuitePdf, suiteqlQuery } from '@/lib/netsuite';

export interface PortalCustomer {
  id: string;
  company_name: string;
  netsuite_id: string | null;
  portal_invoice_contact_ids: string[];
}

export interface PortalInvoiceEvent {
  /** NetSuite internal id of the new invoice (for the PDF + header lookup). */
  invoiceId?: string | number | null;
  invoiceNumber?: string | null;
  /** The invoice's NetSuite customer id, when the caller already knows it —
   *  saves a NetSuite round trip for every non-portal customer. */
  customerNsId?: string | number | null;
  amount?: number | null;
  poNumber?: string | null;
  /** Where the invoice came from, e.g. 'a graphics job', 'the Scan Log'. */
  source: string;
  /** What was billed, e.g. the job title or VIN. */
  detail?: string | null;
  /** Who created the invoice. */
  actorId?: string | null;
}

/**
 * The portal customer this invoice belongs to: its own NetSuite customer,
 * or that customer's parent. Pure, so the match rule is testable.
 */
export function matchPortalCustomer(
  entityId: string | number | null | undefined,
  parentId: string | number | null | undefined,
  portalCustomers: PortalCustomer[],
): PortalCustomer | null {
  const ids = [entityId, parentId]
    .filter(v => v !== null && v !== undefined && String(v).trim() !== '')
    .map(v => String(v).trim());
  for (const id of ids) {
    const hit = portalCustomers.find(c => c.netsuite_id && String(c.netsuite_id).trim() === id);
    if (hit) return hit;
  }
  return null;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Title + body for the alert. Pure, so the wording is testable. */
export function buildPortalInvoiceMessage(opts: {
  customerName: string;
  invoiceNumber: string;
  amount?: number | null;
  poNumber?: string | null;
  source: string;
  detail?: string | null;
  actorName?: string | null;
}): { title: string; body: string } {
  const { customerName, invoiceNumber, amount, poNumber, source, detail, actorName } = opts;
  const facts = [
    typeof amount === 'number' && Number.isFinite(amount) ? money(amount) : null,
    poNumber ? `PO ${poNumber}` : null,
    detail || null,
  ].filter(Boolean);
  return {
    title: `Enter invoice ${invoiceNumber} in ${customerName}'s portal`,
    body: [
      `${actorName || 'Someone'} created invoice ${invoiceNumber} for ${customerName} from ${source}.`,
      facts.length ? facts.join(' · ') + '.' : null,
      `${customerName} only pays invoices entered in their portal.`,
    ].filter(Boolean).join(' '),
  };
}

async function loadPortalCustomers(supabase: SupabaseClient): Promise<PortalCustomer[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('id, company_name, netsuite_id, portal_invoice_contact_ids')
    .neq('portal_invoice_contact_ids', '{}');
  // Column missing (migration 346 not applied yet) or read failed → no alerts.
  if (error) {
    console.warn('portal-invoice-notify: could not read portal customers:', error.message);
    return [];
  }
  return ((data || []) as PortalCustomer[]).filter(c =>
    c.netsuite_id && Array.isArray(c.portal_invoice_contact_ids) && c.portal_invoice_contact_ids.length > 0);
}

async function parentOf(supabase: SupabaseClient, entityId: string): Promise<string | null> {
  const { data } = await supabase
    .from('customers')
    .select('netsuite_parent_id')
    .eq('netsuite_id', entityId)
    .maybeSingle();
  return (data as { netsuite_parent_id?: string | number | null } | null)?.netsuite_parent_id != null
    ? String((data as any).netsuite_parent_id)
    : null;
}

interface InvoiceHeader { tranid?: string; entity?: string; total?: number; po?: string }

async function invoiceHeader(invoiceId: string | number): Promise<InvoiceHeader | null> {
  const id = Number(invoiceId);
  if (!Number.isFinite(id) || id <= 0) return null;
  try {
    const res = await suiteqlQuery(
      `SELECT t.tranid, t.entity, t.foreigntotal, t.otherrefnum FROM transaction t WHERE t.id = ${id}`,
      1,
    );
    const row = res?.items?.[0];
    if (!row) return null;
    const total = row.foreigntotal != null ? Number(row.foreigntotal) : undefined;
    return {
      tranid: row.tranid || undefined,
      entity: row.entity != null ? String(row.entity) : undefined,
      total: Number.isFinite(total) ? total : undefined,
      po: row.otherrefnum || undefined,
    };
  } catch (err) {
    console.error('portal-invoice-notify: invoice header lookup failed:', err);
    return null;
  }
}

export async function notifyPortalInvoice(supabase: SupabaseClient, ev: PortalInvoiceEvent): Promise<void> {
  try {
    const portalCustomers = await loadPortalCustomers(supabase);
    if (portalCustomers.length === 0) return;

    // Known customer: check it before touching NetSuite. Unknown (an SO
    // transform): the invoice header names it.
    let header: InvoiceHeader | null = null;
    let entity = ev.customerNsId != null && String(ev.customerNsId).trim() ? String(ev.customerNsId).trim() : null;
    if (!entity) {
      if (ev.invoiceId == null) return;
      header = await invoiceHeader(ev.invoiceId);
      entity = header?.entity || null;
      if (!entity) return;
    }

    let customer = matchPortalCustomer(entity, null, portalCustomers);
    if (!customer) customer = matchPortalCustomer(null, await parentOf(supabase, entity), portalCustomers);
    if (!customer) return;

    if (!header && ev.invoiceId != null) header = await invoiceHeader(ev.invoiceId);

    // Only live staff accounts.
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, status, deactivated')
      .in('id', customer.portal_invoice_contact_ids);
    const recipients = ((profiles || []) as { id: string; status?: string; deactivated?: boolean }[])
      .filter(p => p.status === 'approved' && !p.deactivated)
      .map(p => p.id);
    if (recipients.length === 0) return;

    let actorName: string | null = null;
    if (ev.actorId) {
      const { data: actor } = await supabase.from('profiles').select('full_name, email').eq('id', ev.actorId).maybeSingle();
      actorName = (actor as any)?.full_name || (actor as any)?.email || null;
    }

    const invoiceNumber = ev.invoiceNumber || header?.tranid || (ev.invoiceId != null ? String(ev.invoiceId) : 'unknown');
    const { title, body } = buildPortalInvoiceMessage({
      customerName: customer.company_name,
      invoiceNumber,
      amount: header?.total ?? ev.amount ?? null,
      poNumber: ev.poNumber || header?.po || null,
      source: ev.source,
      detail: ev.detail,
      actorName,
    });

    // The PDF is what gets uploaded to the portal. A failed render still
    // sends the alert — the link opens the invoice in the app.
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    if (ev.invoiceId != null) {
      try {
        const pdf = await getNetSuitePdf('invoice', String(ev.invoiceId), { timeoutMs: 20000 });
        if (pdf.success && pdf.pdfBase64) {
          attachments.push({
            filename: pdf.filename || `Invoice_${invoiceNumber}.pdf`,
            content: Buffer.from(pdf.pdfBase64, 'base64'),
            contentType: 'application/pdf',
          });
        }
      } catch (err) {
        console.error('portal-invoice-notify: invoice PDF failed:', err);
      }
    }

    await notifyMany(recipients, {
      type: 'portal_invoice_entry',
      title,
      body,
      url: deepLinks.invoicesSent(invoiceNumber),
      ...(attachments.length ? { emailAttachments: attachments } : {}),
    });
  } catch (err) {
    console.error('notifyPortalInvoice failed:', err);
  }
}
