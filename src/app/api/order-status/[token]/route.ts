import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { loadOrderStatus, resolveOrderStatusToken } from '@/lib/order-status-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const supabase = createServiceClient();

/**
 * GET /api/order-status/[token] — the customer's Order status page for one
 * approved estimate (migration 449). No session: the link's token is the
 * credential, like the PO portal. Read-only, rate-limited per IP, and the
 * payload is chosen for the customer: stages, the job's name, and the rep
 * to call. No prices, no internal notes.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'order_status_get', 300)) {
    return NextResponse.json({ status: 'error', error: 'Too many requests. Try again in a little while.' }, { status: 429 });
  }

  const estimate = await resolveOrderStatusToken(supabase, params.token);
  if (!estimate) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const repId = estimate.sent_for_approval_by || estimate.created_by;
  const [view, { data: rep }, { data: settings }] = await Promise.all([
    loadOrderStatus(supabase, estimate),
    repId
      ? supabase.from('profiles').select('full_name, email').eq('id', repId).maybeSingle()
      : Promise.resolve({ data: null as any }),
    supabase.from('wrap_quote_settings').select('company').eq('id', 1).maybeSingle(),
  ]);
  const company = (settings as any)?.company || {};

  return NextResponse.json({
    status: 'ready',
    generatedAt: new Date().toISOString(),
    estimate: {
      number: estimate.estimate_number || null,
      title: estimate.title || null,
      customerName: estimate.customer_name || null,
    },
    rep: rep ? { name: (rep as any).full_name || null, email: (rep as any).email || null } : null,
    company: { name: company.name || 'BMG Fleet Installations', phone: company.phone || null },
    ...view,
  });
}
