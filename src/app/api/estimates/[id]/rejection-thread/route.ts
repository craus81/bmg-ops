import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/estimates/[id]/rejection-thread
 *
 * A customer's "requested changes" rejection used to dead-end: the reason sat
 * in a red box on the estimate and the only possible answer was a whole new
 * estimate. This opens (or finds) the customer thread for the estimate so
 * staff can ask for clarification first — the conversation lives in
 * /admin/inbox with the estimate as its context, and the customer's change
 * request is seeded into the thread as the inbound message being replied to.
 *
 * Contact resolution mirrors openOrCreateVehicleThread, but server-side and
 * customer_id-first: the estimate's customer row → its primary contact,
 * creating one from the customer record (or the approval send's own address —
 * the mailbox the customer actually responded from) when none exists.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) {
    return NextResponse.json({ error: 'Invalid estimate id' }, { status: 400 });
  }

  const { data: estimate, error: estErr } = await supabase
    .from('estimates')
    .select('id, estimate_number, netsuite_estimate_number, customer_id, customer_name, customer_rejected_at, customer_rejection_reason, customer_approved_via, approval_email_to')
    .eq('id', params.id)
    .maybeSingle();
  if (estErr) return NextResponse.json({ error: estErr.message }, { status: 500 });
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (!estimate.customer_rejected_at) {
    return NextResponse.json({ error: 'This estimate has no customer change request to reply to' }, { status: 400 });
  }

  const approvalEmail: string | null =
    Array.isArray(estimate.approval_email_to) && estimate.approval_email_to.length > 0
      ? estimate.approval_email_to[0]
      : null;

  // ── Resolve the customers row ─────────────────────────────────────────
  let customer: { id: string; company_name: string | null; email: string | null; phone: string | null } | null = null;
  if (estimate.customer_id) {
    const { data } = await supabase
      .from('customers')
      .select('id, company_name, email, phone')
      .eq('id', estimate.customer_id)
      .maybeSingle();
    customer = data || null;
  }
  if (!customer && estimate.customer_name) {
    const { data } = await supabase
      .from('customers')
      .select('id, company_name, email, phone')
      .ilike('company_name', estimate.customer_name)
      .maybeSingle();
    customer = data || null;
  }

  // ── Resolve (or create) the contact the thread talks to ──────────────
  let contactId: string | null = null;
  if (customer) {
    const { data: primary } = await supabase
      .from('external_contacts')
      .select('id, email')
      .eq('customer_id', customer.id)
      .eq('is_primary', true)
      .maybeSingle();
    if (primary) {
      contactId = primary.id;
      // The thread's email channel is unusable without an address; the
      // approval send's target is the one the customer actually used, so a
      // blank contact email gets that backfilled — never overwritten.
      if (!primary.email && (customer.email || approvalEmail)) {
        await supabase
          .from('external_contacts')
          .update({ email: customer.email || approvalEmail })
          .eq('id', primary.id)
          .is('email', null);
      }
    } else {
      const { data: created } = await supabase
        .from('external_contacts')
        .insert({
          customer_id: customer.id,
          name: customer.company_name || estimate.customer_name || 'Customer',
          email: customer.email || approvalEmail,
          phone: customer.phone,
          is_primary: true,
          created_by: auth.user.id,
        })
        .select('id')
        .single();
      contactId = created?.id || null;
    }
  } else if (approvalEmail) {
    // Loose estimate (no customers row): key the conversation off the
    // address the approval went to.
    const { data: match } = await supabase
      .from('external_contacts')
      .select('id')
      .eq('email', approvalEmail)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (match) {
      contactId = match.id;
    } else {
      const { data: created } = await supabase
        .from('external_contacts')
        .insert({
          name: estimate.customer_name || approvalEmail,
          email: approvalEmail,
          is_unknown: !estimate.customer_name,
          created_by: auth.user.id,
        })
        .select('id')
        .single();
      contactId = created?.id || null;
    }
  }

  if (!contactId) {
    return NextResponse.json(
      { error: 'No customer contact to message — link the estimate to a customer or add a contact in the inbox first.' },
      { status: 400 },
    );
  }

  // ── Find or create the estimate-context thread ───────────────────────
  let threadId: string | null = null;
  let reused = false;
  const { data: existing } = await supabase
    .from('customer_threads')
    .select('id')
    .eq('external_contact_id', contactId)
    .eq('context_entity_type', 'estimate')
    .eq('context_entity_id', estimate.id)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle();
  if (existing) {
    threadId = existing.id;
    reused = true;
  } else {
    const displayNumber = estimate.netsuite_estimate_number || estimate.estimate_number;
    const { data: createdThread, error: thErr } = await supabase
      .from('customer_threads')
      .insert({
        external_contact_id: contactId,
        customer_id: customer?.id || null,
        context_entity_type: 'estimate',
        context_entity_id: estimate.id,
        subject: `Estimate #${displayNumber} — change request`,
        created_by: auth.user.id,
      })
      .select('id')
      .single();
    if (thErr || !createdThread) {
      return NextResponse.json({ error: thErr?.message || 'Failed to create thread' }, { status: 500 });
    }
    threadId = createdThread.id;
  }

  // ── Seed the customer's change request as the inbound message ────────
  // (so the reply screen shows what's being answered). Reuse-safe: skipped
  // when this exact request already sits in the thread; a later re-rejection
  // with a new reason seeds again. The insert trigger bumps the thread's
  // unread count, so the inbox correctly shows a customer message awaiting
  // a reply.
  let seeded = false;
  const seedBody = (estimate.customer_rejection_reason || '').trim() || '(no reason given)';
  const { data: existingSeed } = await supabase
    .from('customer_messages')
    .select('id')
    .eq('thread_id', threadId)
    .eq('direction', 'inbound')
    .eq('body', seedBody)
    .limit(1)
    .maybeSingle();
  if (!existingSeed) {
    const { error: seedErr } = await supabase.from('customer_messages').insert({
      thread_id: threadId,
      direction: 'inbound',
      // The request arrived through the approval page; file it under the
      // channel the link was delivered on, which is also how staff will
      // most likely answer.
      channel: estimate.customer_approved_via === 'sms_link' ? 'sms' : 'email',
      body: seedBody,
      attachments: [],
      sent_at: estimate.customer_rejected_at,
      delivery_status: 'received',
    });
    if (seedErr) console.error('rejection-thread seed failed:', seedErr.message);
    else seeded = true;
  }

  return NextResponse.json({ threadId, reused, seeded });
}
