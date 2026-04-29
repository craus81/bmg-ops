import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parseInbound, verifyWebhookSignature, normalizePhone, getActiveProviderName } from '@/lib/sms-provider';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/messages/sms-webhook
 *
 * Provider-agnostic inbound SMS/MMS webhook. Routing:
 *   1. Match sender phone to profiles.phone_number -> internal user.
 *      Forward to the existing internal-chat pathway.
 *   2. Match to external_contacts.phone -> append to the most recent
 *      open customer_threads thread for that contact, or create a new
 *      'general' thread.
 *   3. No match -> auto-create an external_contacts row flagged is_unknown,
 *      then create a new thread in the unassigned queue.
 *
 * Twilio-side note: Twilio's webhook expects a TwiML response. We return
 * an empty <Response/> so no auto-reply is sent; the actual reply-to-user
 * feedback is handled in the web app inbox. Non-Twilio providers simply
 * get 200 OK JSON; most accept either.
 */
export async function POST(req: NextRequest) {
  const provider = getActiveProviderName();
  try {
    const contentType = req.headers.get('content-type') || '';
    const form: Record<string, any> = {};

    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const fd = await req.formData();
      fd.forEach((value, key) => { form[key] = value; });
    } else {
      try {
        const json = await req.json();
        Object.assign(form, json);
      } catch {
        // Empty body — fall through to no-op
      }
    }

    // Optional signature verification (currently only Twilio enforces)
    const headerRecord: Record<string, string> = {};
    req.headers.forEach((v, k) => { headerRecord[k] = v; });
    const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL || ''}/api/messages/sms-webhook`;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(form)) params[k] = String(v);
    if (!verifyWebhookSignature(webhookUrl, params, headerRecord)) {
      console.warn(`[sms-webhook] signature rejected (provider=${provider})`);
      return twimlResponse('Unauthorized');
    }

    const inbound = parseInbound(form);
    if (!inbound) {
      return twimlResponse('Missing from or body');
    }

    // 1. Internal profile match -> route to legacy internal conversation flow
    const { data: profileMatch } = await supabase
      .from('profiles')
      .select('id')
      .eq('phone_number', inbound.from)
      .maybeSingle();

    if (profileMatch) {
      await deliverInternalReply(profileMatch.id, inbound);
      return twimlResponse('');
    }

    // 2. External contact match
    const { data: contactMatch } = await supabase
      .from('external_contacts')
      .select('id, customer_id')
      .eq('phone', inbound.from)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let contactId = contactMatch?.id || null;
    let customerId = contactMatch?.customer_id || null;
    let isUnknownContact = false;

    // 3. Unknown sender — auto-create contact
    if (!contactId) {
      const { data: created } = await supabase
        .from('external_contacts')
        .insert({
          phone: inbound.from,
          name: `Unknown — ${inbound.from}`,
          is_unknown: true,
        })
        .select('id, customer_id')
        .single();
      if (created) {
        contactId = created.id;
        customerId = created.customer_id;
        isUnknownContact = true;
      }
    }

    if (!contactId) {
      console.error('[sms-webhook] failed to resolve/create external_contact for', inbound.from);
      return twimlResponse('');
    }

    // Find or create an open general thread for this contact
    const { data: openThread } = await supabase
      .from('customer_threads')
      .select('id')
      .eq('external_contact_id', contactId)
      .eq('status', 'open')
      .order('last_message_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let threadId = openThread?.id || null;
    if (!threadId) {
      const { data: createdThread } = await supabase
        .from('customer_threads')
        .insert({
          external_contact_id: contactId,
          customer_id: customerId,
          context_entity_type: 'general',
          subject: isUnknownContact ? `Unknown sender ${inbound.from}` : null,
        })
        .select('id')
        .single();
      threadId = createdThread?.id || null;
    }

    if (!threadId) {
      console.error('[sms-webhook] failed to resolve/create thread for contact', contactId);
      return twimlResponse('');
    }

    // Persist the inbound message (trigger will bump thread last_message_at + unread)
    await supabase.from('customer_messages').insert({
      thread_id: threadId,
      direction: 'inbound',
      channel: (inbound.attachments && inbound.attachments.length > 0) ? 'mms' : 'sms',
      body: inbound.body,
      attachments: inbound.attachments || [],
      external_provider_sid: inbound.providerSid,
      provider_name: inbound.providerName,
      delivery_status: 'received',
    });

    return twimlResponse('');
  } catch (err: any) {
    console.error('[sms-webhook] error:', err);
    return twimlResponse('');
  }
}

/**
 * Backfill the legacy internal-chat reply when the sender is a staff user.
 * Mirrors the original twilio-webhook logic so existing staff SMS keeps
 * working when they reply on the same company number.
 */
async function deliverInternalReply(senderId: string, inbound: { body: string; providerSid: string }) {
  const { data: recentSmsMsg } = await supabase
    .from('messages')
    .select('conversation_id, sender_id')
    .neq('sender_id', senderId)
    .not('sms_sid', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10);

  let targetConvoId: string | null = null;

  if (recentSmsMsg && recentSmsMsg.length > 0) {
    const { data: userConvos } = await supabase
      .from('conversations')
      .select('id')
      .or(`participant_1.eq.${senderId},participant_2.eq.${senderId}`);
    const userConvoIds = new Set((userConvos || []).map(c => c.id));
    for (const msg of recentSmsMsg) {
      if (userConvoIds.has(msg.conversation_id)) {
        targetConvoId = msg.conversation_id;
        break;
      }
    }
  }

  if (!targetConvoId) {
    const { data: latestConvo } = await supabase
      .from('conversations')
      .select('id')
      .or(`participant_1.eq.${senderId},participant_2.eq.${senderId}`)
      .order('last_message_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestConvo) targetConvoId = latestConvo.id;
  }

  if (!targetConvoId) return;

  await supabase.from('messages').insert({
    conversation_id: targetConvoId,
    sender_id: senderId,
    body: inbound.body,
    via_sms: true,
    sms_sid: inbound.providerSid,
  });

  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', targetConvoId);
}

function twimlResponse(message: string) {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new NextResponse(xml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Suppress unused import warning — kept for future tracing.
void normalizePhone;
