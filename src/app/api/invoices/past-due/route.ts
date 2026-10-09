import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireMoney } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { fetchOpenArInvoices } from '@/lib/financials-data';
import { groupPastDue, resolveArSettings, stepFor } from '@/lib/ar-reminders';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * GET /api/invoices/past-due — the Past Due page (A/R reminders).
 *
 * Every customer with past-due open invoices, read live from NetSuite, with
 * what the page needs to remind them: suggested recipients (saved billing
 * emails, then the customer profile's AP/billing contacts, then the main
 * email), the billing workflow (portal customers are flagged — they pay
 * from their portal, not from an emailed statement), when a statement was
 * last emailed, and the reminder step each invoice is at.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMoney(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const [{ invoices }, settingsRes] = await Promise.all([
      fetchOpenArInvoices(),
      service.from('ar_reminder_settings').select('*').eq('id', 1).maybeSingle(),
    ]);
    const settings = resolveArSettings(settingsRes.data);
    const groups = groupPastDue(invoices);
    const entityIds = groups.map(g => g.entityId).filter((id): id is string => !!id);

    const [prospectsRes, customersRes, statementsRes, logRes] = await Promise.all([
      entityIds.length
        ? service.from('prospects').select('id, netsuite_id, billing_emails, email').in('netsuite_id', entityIds)
        : Promise.resolve({ data: [] as any[] }),
      entityIds.length
        ? service.from('customers').select('id, netsuite_id, email, ap_email, billing_contact_email, billing_workflow, billing_portal, billing_notes').in('netsuite_id', entityIds)
        : Promise.resolve({ data: [] as any[] }),
      // Last statement per customer: the statement route logs its sends with
      // the ns-<id> customer deep link as context_url.
      entityIds.length
        ? fetchAllRows<{ context_url: string; created_at: string; recipients: string[]; delivery_status: string }>((from, to) => service
            .from('email_log')
            .select('context_url, created_at, recipients, delivery_status')
            .eq('kind', 'statement')
            .in('context_url', entityIds.map(id => deepLinks.prospect(`ns-${id}`)))
            .order('created_at', { ascending: false })
            .order('id')
            .range(from, to))
        : Promise.resolve({ data: [] as any[], error: null }),
      entityIds.length
        ? fetchAllRows<{ invoice_id: string; step: number; alerted_at: string }>((from, to) => service
            .from('ar_reminder_log')
            .select('invoice_id, step, alerted_at')
            .in('entity_id', entityIds)
            .order('invoice_id')
            .order('step')
            .range(from, to))
        : Promise.resolve({ data: [] as any[], error: null }),
    ]);

    const prospectByNs = new Map<string, any>();
    for (const p of (prospectsRes.data || []) as any[]) if (p.netsuite_id && !prospectByNs.has(String(p.netsuite_id))) prospectByNs.set(String(p.netsuite_id), p);
    const customerByNs = new Map<string, any>();
    for (const c of (customersRes.data || []) as any[]) if (c.netsuite_id) customerByNs.set(String(c.netsuite_id), c);
    const lastStatement = new Map<string, { at: string; recipients: string[]; status: string }>();
    for (const s of (statementsRes.data || []) as any[]) {
      const id = String(s.context_url).split('ns-')[1];
      if (id && !lastStatement.has(id)) lastStatement.set(id, { at: s.created_at, recipients: s.recipients || [], status: s.delivery_status });
    }
    const alertedAt = new Map<string, string>();
    for (const l of (logRes.data || []) as any[]) {
      const prev = alertedAt.get(l.invoice_id);
      if (!prev || l.alerted_at > prev) alertedAt.set(l.invoice_id, l.alerted_at);
    }

    const customers = groups.map(g => {
      const p = g.entityId ? prospectByNs.get(g.entityId) : null;
      const c = g.entityId ? customerByNs.get(g.entityId) : null;
      const saved: string[] = (p?.billing_emails || []).filter((e: string) => EMAIL_RE.test(e));
      const profile = [c?.ap_email, c?.billing_contact_email].filter((e: any): e is string => !!e && EMAIL_RE.test(e));
      const fallback = [p?.email, c?.email].filter((e: any): e is string => !!e && EMAIL_RE.test(e));
      const suggested = [...new Set((saved.length ? saved : profile.length ? profile : fallback.slice(0, 1)).map(e => e.toLowerCase()))];
      const openForCustomer = invoices.filter(i => i.entityId === g.entityId && i.unpaid > 0.005);
      return {
        key: g.key,
        entityId: g.entityId,
        customer: g.customer,
        localCustomerId: c?.id || null,
        prospectId: p?.id || null,
        pastDue: Math.round(g.pastDue * 100) / 100,
        openBalance: Math.round(openForCustomer.reduce((s, i) => s + i.unpaid, 0) * 100) / 100,
        openCount: openForCustomer.length,
        oldestDays: g.oldestDays,
        suggestedRecipients: suggested,
        recipientsSource: saved.length ? 'billing' : profile.length ? 'profile' : suggested.length ? 'main' : 'none',
        billingWorkflow: c?.billing_workflow || null,
        billingPortal: c?.billing_portal || null,
        billingNotes: c?.billing_notes || null,
        lastStatement: g.entityId ? lastStatement.get(g.entityId) || null : null,
        invoices: g.invoices.map(i => ({
          id: i.id,
          tranid: i.tranid,
          date: i.date,
          dueDate: i.dueDate,
          po: i.po,
          unpaid: i.unpaid,
          daysPastDue: i.daysPastDue,
          step: stepFor(i.daysPastDue, settings.stepDays),
          alertedAt: alertedAt.get(i.id) || null,
          nsUrl: i.nsUrl,
        })),
      };
    });

    return NextResponse.json({ customers, settings, asOf: new Date().toISOString() });
  } catch (e: any) {
    console.error('[past-due] failed:', e);
    return NextResponse.json({ error: e?.message || 'Could not load past-due invoices' }, { status: 500 });
  }
}
