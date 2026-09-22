import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { resolvePortalCustomer } from '@/lib/portal-token';
import { sendFreshApprovalLink } from '@/lib/approval-relink';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { z, validateBody } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  kind: z.enum(['estimate', 'quote', 'proof']),
  id: z.string().uuid(),
});

/**
 * POST /api/portal/[token]/fresh-link (R6-11) — "Send me a fresh link".
 *
 * The customer names a record whose approval link has lapsed; a new token
 * is minted and emailed to the address already on the record. The response
 * carries a masked destination and never the link: the approval token's
 * whole security model is that it reached a mailbox we already associate
 * with this customer, and this page's own footer asks them not to forward
 * the portal link — printing a live approval token on it would quietly
 * trade the email-verified channel for the shared one.
 *
 * Ownership is re-verified against each record inside
 * src/lib/approval-relink.ts. The portal token proves WHICH customer is
 * asking; the record id arrives in the body, so it is checked against that
 * customer by id (never by company name) before anything is minted.
 *
 * Rate-limited twice over: per IP here, and per record (a 15-minute
 * cooldown) in the lib, because a shared portal link means the IP limit
 * alone would not stop one team hammering an approval contact's inbox.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'po_portal_fresh_link', 12)) {
    return NextResponse.json({ error: 'Too many requests — try again later.' }, { status: 429 });
  }
  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { kind, id } = parsed.data;

  try {
    // The proofs a customer may relink are the ones reachable through
    // their own purchase orders as well as by netsuite id — the same two
    // id hops the Action Center listed them by, so the two can't disagree.
    let poIds: string[] = [];
    if (kind === 'proof') {
      const { data: pos } = await service
        .from('purchase_orders')
        .select('id')
        .eq('customer_netsuite_id', customer.netsuite_id)
        .limit(500);
      poIds = (pos || []).map(p => String(p.id));
    }

    const result = await sendFreshApprovalLink(service, kind, id, customer, poIds);

    // Tell the rep either way — a customer who had to ask for their link
    // back is a customer we nearly lost to a dead end, and the referred
    // and no-recipient outcomes are things only a human can finish.
    const repIds = [...new Set((result.repRecipients || []).filter(Boolean) as string[])];
    if (repIds.length > 0 && result.outcome !== 'cooldown' && result.outcome !== 'already_live') {
      const company = customer.company_name || 'A customer';
      const what = result.label || 'an approval';
      const title = result.outcome === 'sent'
        ? `${company} requested a fresh approval link for ${what}`
        : result.outcome === 'referred_to_rep'
          ? `${company} wants ${what} — it changed since we sent it`
          : `${company} could not be sent a fresh link for ${what}`;
      const body = result.outcome === 'sent'
        ? `They opened the portal, found the link expired, and asked for a new one. It went to ${result.maskedTo || 'the address on file'} and is good for 14 days.`
        : result.outcome === 'referred_to_rep'
          ? 'The portal refused to self-serve a new link because the estimate no longer matches what they were sent. Re-send it from the estimate so the current version is what they sign.'
          : `The portal could not issue one: ${result.message}`;
      const url = kind === 'estimate'
        ? deepLinks.estimate(id)
        : kind === 'quote'
          ? deepLinks.wrapQuote(id)
          : deepLinks.graphicsJob(id);
      notifyMany(repIds, {
        type: 'approval_relink_requested',
        title: title.slice(0, 200),
        body: body.slice(0, 900),
        url,
        channels: ['in_app', 'push'],
      }).catch(err => console.error('relink notify failed:', err));
    }

    const status = result.outcome === 'not_found' ? 404
      : result.outcome === 'cooldown' ? 429
        : result.outcome === 'error' ? 500
          : 200;
    // `message` is the only customer-facing text, and every outcome carries
    // a true one — including the ones where nothing was sent.
    return NextResponse.json({ outcome: result.outcome, message: result.message }, { status });
  } catch (e: any) {
    console.error('portal fresh-link failed:', e);
    return NextResponse.json({ outcome: 'error', message: 'We could not issue a new link just now — please try again shortly.' }, { status: 500 });
  }
}
