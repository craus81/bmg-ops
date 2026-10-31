import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff, requireAdmin, profileCanSeeMoney, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { getSalesOrderRecord, patchSalesOrder } from '@/lib/netsuite';
import { parseSalesOrderRecord, planSalesOrderEdit, type SalesOrderView } from '@/lib/sales-order-edit';
import { refreshSalesOrderMirror } from '@/lib/sales-order-mirror-refresh';
import { findSoInvoices } from '@/lib/so-invoices';
import { fetchEmailedByNumber, type EmailedInfo } from '@/lib/invoice-emails';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * The FleetSuite sales order page (src/app/(main)/sales-orders/[id]), backed
 * by NetSuite live. NetSuite is the system of record until 2028: GET reads
 * the order from NetSuite, PATCH writes the edit to NetSuite and keeps only
 * a note (audit history, the mirror row, the estimate's "changed" stamp).
 *
 *   GET   (staff)  order + lines + invoices (with when/who/to whom each was
 *                  emailed) + linked estimate/job + history.
 *                  Prices and totals are left out for anyone without
 *                  See prices.
 *   PATCH (admin)  { lastModified, header?, lines?, add? } — planned by
 *                  src/lib/sales-order-edit.ts against a fresh read, so
 *                  shipped/billed rules are checked before NetSuite sees it.
 */

const AUDIT_TABLE = 'netsuite_sales_orders';
const isNsId = (s: string) => /^\d{1,15}$/.test(s);

function stripMoney(view: SalesOrderView): SalesOrderView {
  return {
    header: { ...view.header, subtotal: 0, taxTotal: 0, total: 0 },
    lines: view.lines.map(l => ({ ...l, rate: null, amount: 0 })),
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });

  const rec = await getSalesOrderRecord(params.id);
  if (!rec.success) {
    const notFound = /\b404\b/.test(rec.error);
    return NextResponse.json(
      { error: notFound ? 'NetSuite has no sales order with that id.' : `Couldn't read the sales order from NetSuite: ${rec.error}` },
      { status: notFound ? 404 : 502 },
    );
  }
  const seeMoney = await profileCanSeeMoney(auth.user.id, auth.profile);
  const parsed = parseSalesOrderRecord(rec.record);
  const view = seeMoney ? parsed : stripMoney(parsed);

  const supabase = createServiceClient();
  const [estimateRes, jobRes, historyRes, invoicesRes] = await Promise.all([
    supabase.from('estimates')
      .select('id, estimate_number, so_changed_at, so_changed_by')
      .eq('netsuite_so_id', params.id).limit(1).maybeSingle(),
    supabase.from('upfit_projects')
      .select('id, title').eq('netsuite_so_id', params.id).limit(1).maybeSingle(),
    supabase.from('audit_log')
      .select('id, actor_id, action, detail, created_at')
      .eq('table_name', AUDIT_TABLE).eq('record_id', params.id)
      .order('created_at', { ascending: false }).limit(50),
    findSoInvoices([params.id]).then(r => r.invoices.get(params.id) || []).catch(() => null),
  ]);

  // Has each invoice been emailed to the customer, when, by whom, to whom.
  const invoiceNumbers = (invoicesRes || []).map(inv => inv.tranid).filter(Boolean);
  const [emailed, sentByRes] = invoiceNumbers.length === 0
    ? [{} as Record<string, EmailedInfo>, { data: [] as { invoice_number: string; sent_by: string | null }[] }]
    : await Promise.all([
      fetchEmailedByNumber(supabase, invoiceNumbers).catch((): Record<string, EmailedInfo> => ({})),
      supabase.from('invoice_emails').select('invoice_number, sent_by')
        .in('invoice_number', invoiceNumbers).order('sent_at', { ascending: false }),
    ]);
  const lastSentBy = new Map<string, string | null>();
  for (const r of (sentByRes.data || []) as { invoice_number: string; sent_by: string | null }[]) {
    if (!lastSentBy.has(r.invoice_number)) lastSentBy.set(r.invoice_number, r.sent_by);
  }

  const history = historyRes.data || [];
  const actorIds = [...new Set([
    ...history.map(h => h.actor_id),
    ...lastSentBy.values(),
  ].filter((a): a is string => !!a))];
  const names = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', actorIds);
    for (const p of profs || []) names.set(p.id, p.full_name || 'Unknown');
  }

  return NextResponse.json({
    ...view,
    canEdit: isAdminRole(getProfileRoles(auth.profile)),
    seeMoney,
    estimate: estimateRes.data ? { id: estimateRes.data.id, number: estimateRes.data.estimate_number } : null,
    job: jobRes.data ? { id: jobRes.data.id, title: jobRes.data.title } : null,
    // null = the lookup failed (shown as "couldn't check"), never "none".
    invoices: invoicesRes === null ? null : invoicesRes.map(inv => ({
      id: inv.id, tranid: inv.tranid, trandate: inv.trandate, total: seeMoney ? inv.total : null,
      emailed: emailed[inv.tranid] ? {
        at: emailed[inv.tranid].sent_at,
        by: names.get(lastSentBy.get(inv.tranid) || '') || null,
        to: emailed[inv.tranid].recipients,
        status: emailed[inv.tranid].delivery_status,
      } : null,
    })),
    history: history.map(h => ({
      at: h.created_at,
      by: h.actor_id ? names.get(h.actor_id) || 'Unknown' : null,
      changes: Array.isArray((h.detail as any)?.changes) ? (h.detail as any).changes as string[] : [],
    })),
  });
}

const LineEdit = z.object({
  line: z.number().int().nonnegative(),
  quantity: z.number().finite().optional(),
  rate: z.number().finite().optional(),
  close: z.boolean().optional(),
  reopen: z.boolean().optional(),
  remove: z.boolean().optional(),
});
const NewLine = z.object({
  itemId: z.string().regex(/^\d{1,15}$/),
  itemNumber: z.string().max(120),
  description: z.string().max(999).optional(),
  quantity: z.number().finite(),
  rate: z.number().finite(),
});
const Schema = z.object({
  /** lastModified from the GET this edit was made on. */
  lastModified: z.string().nullable(),
  header: z.object({
    poNumber: z.string().max(100).optional(),
    memo: z.string().max(2000).optional(),
    vin: z.string().max(30).optional(),
    shipDate: z.string().max(10).nullable().optional(),
  }).optional(),
  lines: z.array(LineEdit).max(500).optional(),
  add: z.array(NewLine).max(100).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const edit = parsed.data;

  // Plan against what NetSuite has right now.
  const before = await getSalesOrderRecord(params.id);
  if (!before.success) {
    return NextResponse.json({ error: `Couldn't read the sales order from NetSuite: ${before.error}. Nothing was changed.` }, { status: 502 });
  }
  const view = parseSalesOrderRecord(before.record);
  if (edit.lastModified && view.header.lastModified && edit.lastModified !== view.header.lastModified) {
    return NextResponse.json({
      error: 'This sales order changed in NetSuite after you opened it. Reload to see the latest, then make your change again. Nothing was changed.',
      step: 'stale',
    }, { status: 409 });
  }

  const plan = planSalesOrderEdit(view, edit);
  if (!plan.ok) {
    return NextResponse.json({ error: plan.errors.join(' '), errors: plan.errors }, { status: 400 });
  }

  const result = await patchSalesOrder(params.id, plan.body, { replace: plan.replace });
  if (!result.success) {
    return NextResponse.json({ error: `NetSuite refused the change: ${result.error}. The sales order was not changed.`, step: 'netsuite' }, { status: 502 });
  }

  const supabase = createServiceClient();
  const who = auth.profile?.full_name || auth.user.email || 'Someone';
  const now = new Date().toISOString();

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: AUDIT_TABLE,
    recordId: params.id,
    action: 'so_edit',
    detail: {
      so_number: view.header.tranId,
      changes: plan.changes,
      replace: plan.replace,
      body: plan.body,
    },
  });

  // The estimate keeps the customer-approved lines; it only says the order changed.
  await supabase.from('estimates')
    .update({ so_changed_at: now, so_changed_by: who })
    .eq('netsuite_so_id', params.id);

  // Parts demand and search read the mirror: bring this order up to date now
  // rather than at the next 2-hour sync. Best effort.
  const mirror = await refreshSalesOrderMirror(supabase, params.id).catch((e: any) => ({ ok: false, error: e?.message || String(e) }));
  if (!mirror.ok) console.warn(`sales order ${params.id}: mirror refresh failed: ${'error' in mirror ? mirror.error : ''}`);

  return NextResponse.json({ success: true, changes: plan.changes });
}
