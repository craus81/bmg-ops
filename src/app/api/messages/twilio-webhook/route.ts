import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizePhoneNumber, validateTwilioSignature } from '@/lib/twilio';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/messages/twilio-webhook
 * Twilio sends a POST here when someone replies to an SMS.
 * We match the sender's phone number to a user and insert the reply into their most recent conversation.
 *
 * Twilio sends form-encoded data with fields like:
 * - From: the sender's phone number
 * - Body: the message text
 * - MessageSid: Twilio's message ID
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const from = formData.get('From') as string;
    const body = formData.get('Body') as string;
    const messageSid = formData.get('MessageSid') as string;

    if (!from || !body) {
      return twimlResponse('Missing from or body');
    }

    // Optional: Validate Twilio signature for security
    const signature = req.headers.get('x-twilio-signature') || '';
    if (process.env.TWILIO_VALIDATE_SIGNATURE === 'true') {
      const params: Record<string, string> = {};
      formData.forEach((value, key) => { params[key] = value as string; });
      const webhookUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/messages/twilio-webhook`;
      const valid = validateTwilioSignature(webhookUrl, params, signature);
      if (!valid) {
        console.warn('Invalid Twilio signature from', from);
        return twimlResponse('Unauthorized');
      }
    }

    // Normalize the incoming phone number
    const normalizedFrom = normalizePhoneNumber(from);

    // Find the user with this phone number
    // Check both profiles.phone_number and notification_preferences.phone_number
    let senderId: string | null = null;

    // First check profiles table
    const { data: profileMatch } = await supabase
      .from('profiles')
      .select('id')
      .eq('phone_number', normalizedFrom)
      .maybeSingle();

    if (profileMatch) {
      senderId = profileMatch.id;
    } else {
      // Try notification_preferences (user may have set phone there)
      // We need to try a few formats since the stored format might differ
      const phonesToTry = [normalizedFrom, from, from.replace(/[^\d]/g, '')];
      for (const phone of phonesToTry) {
        const { data: prefMatch } = await supabase
          .from('notification_preferences')
          .select('user_id')
          .eq('phone_number', phone)
          .maybeSingle();
        if (prefMatch) {
          senderId = prefMatch.user_id;
          // Also save the normalized phone to profiles for faster future lookups
          await supabase
            .from('profiles')
            .update({ phone_number: normalizedFrom })
            .eq('id', prefMatch.user_id);
          break;
        }
      }
    }

    if (!senderId) {
      console.warn('No user found for phone number:', normalizedFrom);
      return twimlResponse('Reply not delivered — your phone number is not linked to a BMG Fleet account. Please update your phone number in app settings.');
    }

    // Find the most recent conversation this user has
    // We route the reply to whatever conversation they last received an SMS from
    // by checking the most recent message with an sms_sid sent TO this user
    const { data: recentSmsMsg } = await supabase
      .from('messages')
      .select('conversation_id, sender_id')
      .neq('sender_id', senderId)
      .not('sms_sid', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10);

    // Filter to conversations this user is actually in
    let targetConvoId: string | null = null;

    if (recentSmsMsg && recentSmsMsg.length > 0) {
      // Get conversations for this user
      const { data: userConvos } = await supabase
        .from('conversations')
        .select('id')
        .or(`participant_1.eq.${senderId},participant_2.eq.${senderId}`);

      const userConvoIds = new Set((userConvos || []).map(c => c.id));

      // Find the most recent SMS message that was in one of this user's conversations
      for (const msg of recentSmsMsg) {
        if (userConvoIds.has(msg.conversation_id)) {
          targetConvoId = msg.conversation_id;
          break;
        }
      }
    }

    // Fallback: use the most recently active conversation
    if (!targetConvoId) {
      const { data: latestConvo } = await supabase
        .from('conversations')
        .select('id')
        .or(`participant_1.eq.${senderId},participant_2.eq.${senderId}`)
        .order('last_message_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (latestConvo) {
        targetConvoId = latestConvo.id;
      }
    }

    if (!targetConvoId) {
      return twimlResponse('Reply not delivered — no active conversation found. Please start a conversation in the BMG Fleet app first.');
    }

    // Insert the message
    const { error: insertErr } = await supabase
      .from('messages')
      .insert({
        conversation_id: targetConvoId,
        sender_id: senderId,
        body: body.trim(),
        via_sms: true,
        sms_sid: messageSid,
      });

    if (insertErr) {
      console.error('Failed to insert SMS reply:', insertErr);
      return twimlResponse('Failed to deliver your reply. Please try again.');
    }

    // Update conversation last_message_at
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', targetConvoId);

    // Return empty TwiML (no auto-reply needed — the message is now in the app)
    return twimlResponse('');
  } catch (err: any) {
    console.error('Twilio webhook error:', err);
    return twimlResponse('An error occurred processing your reply.');
  }
}

/**
 * Return a TwiML XML response
 * If message is empty, returns empty response (no auto-reply)
 */
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
