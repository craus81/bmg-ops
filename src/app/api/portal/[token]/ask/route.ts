import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { resolvePortalCustomer } from '@/lib/portal-token';
import { invoiceBelongsToCustomer } from '@/lib/portal-billing';
import { z, validateBody } from '@/lib/validate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const AskSchema = z.object({
  invoiceId: z.string().regex(/^\d{1,15}$/),
  invoiceNumber: z.string().trim().min(1).max(60),
  message: z.string().trim().min(3).max(1500),
});

/**
 * POST /api/portal/[token]/ask (R5-14): "question about this invoice?" —
 * opens (or reuses) a customer_thread keyed to the invoice
 * (context_entity_type 'invoice', context_ref = tranid; migration 278) and
 * seeds the customer's message as inbound, so the question lands in
 * /admin/inbox with the unread badge raised. The invoice id is verified
 * against the token customer's own open set — no cross-customer keying.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'po_portal_ask', 10)) {
    return NextResponse.json({ error: 'Too many requests — try again later.' }, { status: 429 });
  }
  const customer = await resolvePortalCustomer(service, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const parsed = await validateBody(req, AskSchema);
  if (parsed.error) return parsed.error;
  const { invoiceId, invoiceNumber, message } = parsed.data;

  try {
    if (!await invoiceBelongsToCustomer(customer.netsuite_id, invoiceId)) {
      return NextResponse.json({ status: 'invalid' }, { status: 404 });
    }

    // The conversation needs an external contact: the customer's primary,
    // else one created from the customer record (mirrors customer-notify).
    let contactId: string | null = null;
    const { data: primary } = await service
      .from('external_contacts')
      .select('id')
      .eq('customer_id', customer.id)
      .eq('is_primary', true)
      .maybeSingle();
    if (primary) {
      contactId = primary.id;
    } else {
      const { data: created } = await service
        .from('external_contacts')
        .insert({
          customer_id: customer.id,
          name: customer.company_name || 'Portal customer',
          email: customer.email || null,
          is_primary: true,
          is_unknown: !customer.email,
        })
        .select('id')
        .single();
      contactId = created?.id || null;
    }
    if (!contactId) {
      return NextResponse.json({ error: 'Could not start the conversation — contact your BMG representative directly.' }, { status: 500 });
    }

    // Find or create the invoice-keyed thread (context_ref carries the
    // tranid — context_entity_id is a UUID and NetSuite ids are text).
    let threadId: string | null = null;
    let reused = false;
    const { data: existing } = await service
      .from('customer_threads')
      .select('id')
      .eq('external_contact_id', contactId)
      .eq('context_entity_type', 'invoice')
      .eq('context_ref', invoiceNumber)
      .eq('status', 'open')
      .limit(1)
      .maybeSingle();
    if (existing) {
      threadId = existing.id;
      reused = true;
    } else {
      const { data: createdThread, error: thErr } = await service
        .from('customer_threads')
        .insert({
          external_contact_id: contactId,
          customer_id: customer.id,
          context_entity_type: 'invoice',
          context_ref: invoiceNumber,
          subject: `Invoice ${invoiceNumber} — question from the billing portal`,
        })
        .select('id')
        .single();
      if (thErr || !createdThread) {
        return NextResponse.json({ error: 'Could not start the conversation — try again shortly.' }, { status: 500 });
      }
      threadId = createdThread.id;
    }

    // Seed the question as inbound — the insert trigger raises the thread's
    // unread count, which is what makes it show up as needing a reply.
    const { error: seedErr } = await service.from('customer_messages').insert({
      thread_id: threadId,
      direction: 'inbound',
      channel: 'email',
      body: message,
      attachments: [],
      sent_at: new Date().toISOString(),
      delivery_status: 'received',
    });
    if (seedErr) {
      return NextResponse.json({ error: 'Could not record your question — try again shortly.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, reused });
  } catch (e: any) {
    console.error('portal ask failed:', e);
    return NextResponse.json({ error: 'Could not record your question — try again shortly.' }, { status: 500 });
  }
}
