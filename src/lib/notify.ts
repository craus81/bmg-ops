import { createClient } from '@supabase/supabase-js';
import { sendSMS } from '@/lib/twilio';
import { sendEmail, buildNotificationEmail } from '@/lib/resend';
import webpush from 'web-push';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Configure web-push VAPID keys (only if configured)
if (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'admin@bluemoongraphics.com'}`,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

export type NotifyChannel = 'in_app' | 'sms' | 'email' | 'push';

export interface NotifyPayload {
  /** The user to notify */
  userId: string;
  /** Notification type for categorization (e.g. 'graphics_new', 'message', 'graphics_status') */
  type: string;
  /** Short title shown in bell and email subject */
  title: string;
  /** Longer body text */
  body: string;
  /** Which channels to send on. If omitted, checks user preferences. */
  channels?: NotifyChannel[];
  /** Optional deep link URL (used in email CTA) */
  url?: string;
  /** Optional: skip preference check and force these channels */
  forceChannels?: boolean;
  /** For message notifications: the message context */
  messageContext?: {
    senderName: string;
    messageBody: string;
    messageId: string;
  };
}

export interface NotifyResult {
  inApp: boolean;
  sms: boolean;
  email: boolean;
  push: boolean;
}

/**
 * Unified notification dispatcher.
 * Sends notifications across in-app, SMS, and email based on user preferences
 * or explicit channel selection.
 */
export async function notify(payload: NotifyPayload): Promise<NotifyResult> {
  const result: NotifyResult = { inApp: false, sms: false, email: false, push: false };

  let channels = payload.channels;

  // If no explicit channels, determine from user preferences
  if (!channels || (!payload.forceChannels && !channels)) {
    channels = await getPreferredChannels(payload.userId, payload.type);
  }

  // Execute all channels in parallel
  const promises: Promise<void>[] = [];

  if (channels.includes('in_app')) {
    promises.push(
      sendInApp(payload).then((ok) => { result.inApp = ok; })
    );
  }

  // SMS disabled — only in-app, email, and push active

  if (channels.includes('email')) {
    promises.push(
      sendViaEmail(payload).then((ok) => { result.email = ok; })
    );
  }

  if (channels.includes('push')) {
    promises.push(
      sendViaPush(payload).then((ok) => { result.push = ok; })
    );
  }

  await Promise.allSettled(promises);
  return result;
}

/**
 * Notify multiple users at once (e.g. all production team on new graphics job)
 */
export async function notifyMany(
  userIds: string[],
  payload: Omit<NotifyPayload, 'userId'>
): Promise<void> {
  await Promise.allSettled(
    userIds.map((userId) => notify({ ...payload, userId }))
  );
}

/**
 * Determine which channels a user wants based on their notification preferences
 */
async function getPreferredChannels(userId: string, type: string): Promise<NotifyChannel[]> {
  const { data: prefs } = await supabase
    .from('notification_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const channels: NotifyChannel[] = [];

  if (type === 'message') {
    // For direct messages, use the messaging-specific preferences
    // In-app is always on for messages (they appear in the chat)
    channels.push('in_app');
    if (prefs?.email_messages) {
      channels.push('email');
    }
    return channels;
  }

  // For all other notification types (graphics, PO, etc.)
  if (!prefs) {
    // Default: in-app + push + email for assignments, in-app + push for others
    const defaults: NotifyChannel[] = type === 'assignment' ? ['in_app', 'push', 'email'] : ['in_app', 'push'];
    return defaults;
  }

  // Assignments always get in-app + email + push regardless of preferences
  if (type === 'assignment') {
    return ['in_app', 'email', 'push'];
  }

  // Check if this type of notification is enabled
  const typeEnabled = isTypeEnabled(prefs, type);
  if (!typeEnabled) return [];

  if (prefs.notify_in_app) channels.push('in_app');
  if (prefs.notify_email) channels.push('email');
  // Push notifications are sent whenever in-app is enabled (separate devices get browser push)
  if (prefs.notify_in_app) channels.push('push');

  return channels;
}

/**
 * Check if a specific notification type is enabled in user preferences
 */
function isTypeEnabled(prefs: any, type: string): boolean {
  if (type.includes('new') || type.includes('flagged')) return prefs.notify_new_job !== false;
  if (type.includes('status')) {
    if (!prefs.notify_status_change) return false;
    // Check custom status filter if set
    if (prefs.custom_statuses && prefs.custom_statuses.length > 0) {
      // This would need the actual status to check — for now allow all if status_change is on
      return true;
    }
    return true;
  }
  // graphics_ready_for_install is dispatched only to a pre-targeted user set
  // (assigned installers, admins, explicit opt-ins). Skip the per-user type
  // gate here — channel preferences (in_app/email/push) still apply below.
  if (type === 'graphics_ready_for_install') return true;
  if (type.includes('ready')) return prefs.notify_ready !== false;
  if (type.includes('shipped')) return prefs.notify_shipped !== false;
  // Default: allow
  return true;
}

// ═══════════ CHANNEL IMPLEMENTATIONS ═══════════

async function sendInApp(payload: NotifyPayload): Promise<boolean> {
  try {
    const { error } = await supabase.from('notifications').insert({
      user_id: payload.userId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      url: payload.url || null,
    });
    if (error) console.error('sendInApp insert failed:', error.message, error.details, error.hint);
    return !error;
  } catch (err) {
    console.error('sendInApp exception:', err);
    return false;
  }
}

async function sendViaSMS(payload: NotifyPayload): Promise<boolean> {
  try {
    // Get user's phone number
    const { data: prefs } = await supabase
      .from('notification_preferences')
      .select('phone_number')
      .eq('user_id', payload.userId)
      .maybeSingle();

    if (!prefs?.phone_number) return false;

    // Format SMS body — keep it concise
    let smsBody: string;
    if (payload.messageContext) {
      const msgPreview = payload.messageContext.messageBody.length > 140
        ? payload.messageContext.messageBody.substring(0, 140) + '...'
        : payload.messageContext.messageBody;
      smsBody = `[BMG Fleet] ${payload.messageContext.senderName}: ${msgPreview}`;
    } else {
      smsBody = `[BMG Fleet] ${payload.title}\n${payload.body}`;
      if (smsBody.length > 160) {
        smsBody = smsBody.substring(0, 157) + '...';
      }
    }

    const sid = await sendSMS(prefs.phone_number, smsBody);

    // If this is a message notification, store the SMS SID
    if (sid && payload.messageContext?.messageId) {
      await supabase
        .from('messages')
        .update({ sms_sid: sid })
        .eq('id', payload.messageContext.messageId);
    }

    return !!sid;
  } catch {
    return false;
  }
}

async function sendViaPush(payload: NotifyPayload): Promise<boolean> {
  // Skip if VAPID keys aren't configured
  if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return false;
  }

  try {
    // Get all push subscriptions for this user
    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('user_id', payload.userId);

    if (!subscriptions?.length) return false;

    const pushPayload = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || '/',
      tag: payload.type || 'bmg-notification',
    });

    const staleIds: string[] = [];
    let sent = false;

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            pushPayload
          );
          sent = true;
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            staleIds.push(sub.id);
          }
        }
      })
    );

    // Clean up expired subscriptions
    if (staleIds.length > 0) {
      await supabase.from('push_subscriptions').delete().in('id', staleIds);
    }

    return sent;
  } catch (err) {
    console.error('sendViaPush error:', err);
    return false;
  }
}

async function sendViaEmail(payload: NotifyPayload): Promise<boolean> {
  try {
    // Get user's email
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', payload.userId)
      .single();

    if (!profile?.email) return false;

    const subject = `[BMG Fleet] ${payload.title}`;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
    const ctaUrl = payload.url ? `${appUrl}${payload.url}` : appUrl;

    const html = buildNotificationEmail(
      payload.title,
      payload.body,
      ctaUrl,
      payload.messageContext ? 'Open Chat' : 'Open in App'
    );

    return await sendEmail(profile.email, subject, html);
  } catch {
    return false;
  }
}
