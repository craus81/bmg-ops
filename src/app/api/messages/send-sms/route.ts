import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notify } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  senderId: z.string().uuid(),
  body: z.string().trim().min(1).max(10_000),
});

/**
 * POST /api/messages/send-sms
 * Called after a message is inserted in the app.
 * Uses the unified notification dispatcher to send via SMS and/or email
 * based on the recipient's preferences.
 *
 * Body: { messageId: string, conversationId: string, senderId: string, body: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { messageId, conversationId, body } = parsed.data;

  // The sender is the authenticated caller — never a client-supplied id. The
  // route previously trusted body.senderId with no participant check, so any
  // approved account could send a spoofed "Message from <victim>" SMS/email to
  // any conversation's other participant.
  const senderId = auth.user!.id;

  try {

    // Get conversation to find the recipient
    const { data: convo, error: convoErr } = await supabase
      .from('conversations')
      .select('participant_1, participant_2')
      .eq('id', conversationId)
      .single();

    if (convoErr || !convo) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // The caller must be a participant of the conversation they're notifying.
    if (convo.participant_1 !== senderId && convo.participant_2 !== senderId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const recipientId = convo.participant_1 === senderId ? convo.participant_2 : convo.participant_1;

    // Get sender's name
    const { data: senderProfile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', senderId)
      .single();

    const senderName = senderProfile?.full_name || senderProfile?.email || 'Someone';

    // Use unified dispatcher — it checks the recipient's preferences
    // and sends via whichever channels they have enabled (SMS, email, or both)
    // Note: in-app is handled by the realtime subscription, not notifications table for messages
    const result = await notify({
      userId: recipientId,
      type: 'message',
      title: `Message from ${senderName}`,
      body,
      url: deepLinks.conversation(conversationId),
      messageContext: {
        senderName,
        messageBody: body,
        messageId,
      },
    });

    return NextResponse.json({
      sent: result.sms || result.email,
      sms: result.sms,
      email: result.email,
    });
  } catch (err: any) {
    console.error('Message notify error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
