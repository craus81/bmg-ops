import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireRole } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { logAudit } from '@/lib/audit';
import { escapeIlike } from '@/lib/customer-dupes';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * The ledger customer review queue — GET reads it, POST decides.
 *
 * Owner item 6: QuickBooks names that could not be graded confidently land
 * here to be attached BY HAND. There is no merge tool and nothing is ever
 * inactivated in NetSuite; a decision made here is a link, and it backfills
 * the history that pointed at the QuickBooks row.
 *
 * Reading is the ledger tier (finance/executive, admins auto-pass) so a
 * finance viewer can see the backlog; deciding is requireAdmin.
 */

const postSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('attach'), ledgerCustomerId: z.string().uuid(), customerId: z.string().uuid() }),
  z.object({ action: z.literal('ignore'), ledgerCustomerId: z.string().uuid() }),
  z.object({ action: z.literal('unlink'), ledgerCustomerId: z.string().uuid() }),
]);

const PAGE_SIZE = 50;

export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['finance', 'executive']);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const params = req.nextUrl.searchParams;
  // §2.9 defines exactly three states for this queue. An unknown value is a
  // typo, and answering it with an empty queue would read as "nothing to
  // review" — so it is a 400, and `manual`/`exact`/… are not listable here.
  const QUEUE_STATUSES = ['ambiguous', 'unmatched', 'all'] as const;
  const statusParam = params.get('status') || 'ambiguous';
  if (!(QUEUE_STATUSES as readonly string[]).includes(statusParam)) {
    return NextResponse.json(
      { error: `status must be one of ${QUEUE_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }
  const status = statusParam;
  const q = (params.get('q') || '').trim();
  const page = Math.max(0, Number(params.get('page')) || 0);

  // `?q=` is a customers SEARCH, for the reviewer hunting the right row by
  // hand — a different question from "what is in the queue".
  if (q) {
    const { data } = await service
      .from('customers')
      .select('id, company_name, entity_id, netsuite_id, email, phone')
      .ilike('company_name', `%${escapeIlike(q)}%`)
      .eq('active', true)
      .order('company_name')
      .limit(20);
    return NextResponse.json({ customers: data || [] });
  }

  try {
    let query = service
      .from('ledger_customers')
      .select('id, external_id, display_name, cleaned_name, email, phone, match_status, match_reason, candidates, customer_id, customer_netsuite_id, reviewed_at')
      .eq('source', 'quickbooks')
      .is('deleted_at', null)
      // cleaned_name then id: a deterministic order with a unique tiebreaker,
      // so paging never skips or repeats a row.
      .order('cleaned_name')
      .order('id')
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (status !== 'all') query = query.eq('match_status', status);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data || [];

    // Head counts per row, never a `.in()` row select — that would cap at
    // 1000 and quietly under-count a customer with a decade of invoices.
    const withCounts = await Promise.all(
      rows.map(async row => {
        const [{ count: invoiceCount }, { count: paymentCount }] = await Promise.all([
          service.from('ledger_invoices').select('id', { count: 'exact', head: true }).eq('ledger_customer_id', row.id),
          service.from('ledger_payments').select('id', { count: 'exact', head: true }).eq('ledger_customer_id', row.id),
        ]);
        return { ...row, invoiceCount: invoiceCount ?? null, paymentCount: paymentCount ?? null };
      }),
    );

    return NextResponse.json({ rows: withCounts, page, pageSize: PAGE_SIZE });
  } catch (e: any) {
    const message = String(e?.message || e);
    if (/PGRST205|42P01|does not exist/i.test(message)) {
      return NextResponse.json({ error: 'Ledger schema not deployed yet' }, { status: 503 });
    }
    return NextResponse.json({ error: message.slice(0, 500) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, postSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const service = createServiceClient();

  const { data: before, error: readError } = await service
    .from('ledger_customers')
    .select('id, external_id, display_name, match_status, customer_id, customer_netsuite_id')
    .eq('id', body.ledgerCustomerId)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!before) return NextResponse.json({ error: 'No such ledger customer' }, { status: 404 });

  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  let action: string;

  if (body.action === 'attach') {
    // Re-verify against `customers` before writing: ledger_customers.customer_id
    // is `REFERENCES customers(id)`, so an id that is not there must be a
    // clean 400, never a 23503 surfacing as a 500. (candidatesFor already
    // keeps prospects ids out of the queue; this is the second wall.)
    const { data: customer } = await service
      .from('customers')
      .select('id, netsuite_id')
      .eq('id', body.customerId)
      .maybeSingle();
    if (!customer) return NextResponse.json({ error: 'unknown_customer' }, { status: 400 });

    patch = {
      match_status: 'manual',
      customer_id: customer.id,
      customer_netsuite_id: customer.netsuite_id != null ? String(customer.netsuite_id) : null,
      match_reason: 'attached by hand in the review queue',
      matched_at: now,
      reviewed_by: auth.user.id,
      reviewed_at: now,
    };
    action = 'ledger_customer_linked';
  } else if (body.action === 'ignore') {
    // 'ignored' is a HUMAN's decision — no import ever overwrites it, and
    // the row leaves the queue for good.
    patch = {
      match_status: 'ignored',
      customer_id: null,
      customer_netsuite_id: null,
      match_reason: 'marked as not needing a FleetSuite customer',
      matched_at: null,
      reviewed_by: auth.user.id,
      reviewed_at: now,
    };
    action = 'ledger_customer_ignored';
  } else {
    patch = {
      match_status: 'unmatched',
      customer_id: null,
      customer_netsuite_id: null,
      match_reason: 'link removed in the review queue',
      matched_at: null,
      reviewed_by: auth.user.id,
      reviewed_at: now,
    };
    action = 'ledger_customer_unlinked';
  }

  const { error: writeError } = await service.from('ledger_customers').update(patch).eq('id', body.ledgerCustomerId);
  if (writeError) return NextResponse.json({ error: writeError.message }, { status: 500 });

  // Every attach (and every unlink) carries the decision through the history
  // that pointed at this QuickBooks customer — that is the whole point of
  // the queue.
  for (const table of ['ledger_invoices', 'ledger_payments']) {
    const { error } = await service
      .from(table)
      .update({ customer_id: patch.customer_id, customer_netsuite_id: patch.customer_netsuite_id })
      .eq('ledger_customer_id', body.ledgerCustomerId);
    if (error) console.error(`[ledger] ${table} backfill after ${action} failed:`, error.message);
  }

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'ledger_customers',
    recordId: body.ledgerCustomerId,
    action,
    detail: {
      before: { matchStatus: before.match_status, customerId: before.customer_id },
      after: { matchStatus: patch.match_status, customerId: patch.customer_id },
    },
  });

  return NextResponse.json({ ok: true, ledgerCustomerId: body.ledgerCustomerId, matchStatus: patch.match_status });
}
