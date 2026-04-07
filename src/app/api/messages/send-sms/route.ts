import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notify } from '@/lib/notify';
import { requireAuth } from '@/lib/api-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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

  try {
    const { messageId, conversationId, senderId, body } = await req.json();

    if (!messageId || !conversationId || !senderId || !body) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get conversation to find the recipient
    const { data: convo, error: convoErr } = await supabase
      .from('conversations')
      .select('participant_1, participant_2')
      .eq('id', conversationId)
      .single();

    if (convoErr || !convo) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
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
      url: `/messages`,
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
