import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { sendSMS, sendMMS, getActiveProviderName } from '@/lib/sms-provider';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/customer-threads/[id]/messages
 * Send an outbound message on the thread.
 * Body: { channel: 'sms'|'mms'|'email', body: string, attachments?: [{url,contentType?}] }
 *
 * SMS/MMS dispatch runs through the provider abstraction, which no-ops
 * cleanly when SMS_PROVIDER_ENABLED is off. The customer_messages row is
 * still inserted so the admin inbox shows the attempt with a visible
 * "pending" delivery_status.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  const channel = String(body.channel || '').toLowerCase();
  const messageBody = (body.body || '').trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (!['sms', 'mms', 'email'].includes(channel)) {
    return NextResponse.json({ error: 'channel must be sms|mms|email' }, { status: 400 });
  }
  if (!messageBody && attachments.length === 0) {
    return NextResponse.json({ error: 'body or attachment required' }, { status: 400 });
  }

  // Load thread + contact
  const { data: thread, error: tErr } = await supabase
    .from('customer_threads')
    .select('id, external_contact_id, status')
    .eq('id', params.id)
    .single();
  if (tErr || !thread) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  }
  if (thread.status !== 'open') {
    return NextResponse.json({ error: 'Thread is archived' }, { status: 400 });
  }

  const { data: contact } = await supabase
    .from('external_contacts')
    .select('id, phone, email, name')
    .eq('id', thread.external_contact_id)
    .single();
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  let providerSid: string | null = null;
  let providerName: string | null = null;
  let deliveryStatus: 'pending' | 'sent' | 'failed' = 'pending';
  let dispatchError: string | null = null;
  let actualChannel = channel as 'sms' | 'mms' | 'email';

  if (channel === 'sms' || channel === 'mms') {
    if (!contact.phone) {
      return NextResponse.json({ error: 'Contact has no phone number' }, { status: 400 });
    }
    const result = channel === 'mms' && attachments.length > 0
      ? await sendMMS(contact.phone, messageBody, attachments)
      : await sendSMS(contact.phone, messageBody);
    providerName = result.providerName;
    if (result.skipped) {
      deliveryStatus = 'pending';
      dispatchError = 'SMS provider disabled (SMS_PROVIDER_ENABLED=false)';
    } else if (result.ok && result.sid) {
      providerSid = result.sid;
      deliveryStatus = 'sent';
    } else {
      deliveryStatus = 'failed';
      dispatchError = result.error || 'dispatch failed';
    }
    // Promote sms->mms automatically if attachments supplied
    if (channel === 'sms' && attachments.length > 0) actualChannel = 'mms';
  } else if (channel === 'email') {
    if (!contact.email) {
      return NextResponse.json({ error: 'Contact has no email address' }, { status: 400 });
    }
    try {
      const { sendEmail, buildNotificationEmail } = await import('@/lib/resend');
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || '';
      const html = buildNotificationEmail(
        'Message from BMG Fleet',
        messageBody,
        appUrl,
        'Open'
      );
      const ok = await sendEmail(contact.email, '[BMG Fleet] Message', html);
      deliveryStatus = ok ? 'sent' : 'failed';
      providerName = 'resend';
    } catch (err: any) {
      deliveryStatus = 'failed';
      dispatchError = err?.message || 'email send failed';
    }
  }

  const { data: inserted, error: iErr } = await supabase
    .from('customer_messages')
    .insert({
      thread_id: thread.id,
      direction: 'outbound',
      channel: actualChannel,
      body: messageBody,
      attachments,
      external_provider_sid: providerSid,
      provider_name: providerName || getActiveProviderName(),
      sent_by: auth.user.id,
      delivery_status: deliveryStatus,
    })
    .select()
    .single();

  if (iErr) {
    return NextResponse.json({ error: iErr.message }, { status: 500 });
  }

  return NextResponse.json({
    message: inserted,
    dispatch: { status: deliveryStatus, error: dispatchError },
  });
}
