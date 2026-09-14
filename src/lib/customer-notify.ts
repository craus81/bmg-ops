/**
 * Customer-facing outbound notifications, factored from the vehicle
 * completion flow so every customer touchpoint (complete, shipped, digest)
 * resolves recipients and threads the same way: match the free-text
 * customer name to the synced customers row, use the primary external
 * contact (auto-seeded from the customer row), thread the message into
 * customer_threads/customer_messages, and respect the customer's
 * notify_status_emails subscription — automatic sends are opt-IN per
 * customer (migration 171); only on-demand sends bypass the flag.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmailDetailed } from './resend';
import { sendSMS } from './sms-provider';
import { mayReceive, type ContactPrefs } from './notification-prefs';

type Service = SupabaseClient<any, any, any>;

export interface CustomerNotifyInput {
  contextEntityType: string;
  contextEntityId: string;
  threadSubject: string;
  emailSubject: string;
  emailHtml: string;
  /** Plain-text summary threaded into customer_messages. */
  messageBody: string;
  smsBody?: string;
  /** Skip when the customer has opted out of status emails (default true).
   *  On-demand sends (staff confirmed the send) pass false. */
  respectOptOut?: boolean;
  /** Staff-edited recipient for this one send — replaces the resolved
   *  primary-contact email without touching the contact record. */
  overrideEmail?: string | null;
  /** The compose screen's full To list. Wins over `overrideEmail` and the
   *  resolved contact: a staff member who edited the recipients gets
   *  exactly the recipients they typed. Empty/absent → the old behavior. */
  overrideEmails?: string[] | null;
  /** BMG teammates cc'd from the compose screen. */
  cc?: string[] | null;
  /** Bcc for this send — the sender's own address when they ticked Bcc me. */
  bcc?: string[] | null;
  /** email_log kind. Defaults to 'customer_notify' (the automated shape);
   *  staff-composed flows pass their own so the log can tell them apart. */
  emailKind?: string;
  /** The staff user who composed this send — bounce alerts go to them. */
  sentBy?: string | null;
  /** Deep link to the record the email is about (deep-links.ts). */
  contextUrl?: string | null;
  /** Reply-To for the email — the staff user who triggered the send.
   *  Omit for automated sends (falls back to RESEND_REPLY_TO_EMAIL). */
  replyTo?: string | null;
}

export interface CustomerNotifyResult {
  emailed: boolean;
  smsSent: boolean;
  skipped: 'no_customer' | 'no_channel' | 'opted_out' | null;
}

/** The synced customers row + primary contact for a free-text company name. */
export async function resolveCustomerContact(service: Service, customerName: string): Promise<{
  customer: { id: string; email: string | null; phone: string | null; notify_status_emails?: boolean | null; weekly_digest?: boolean | null } | null;
  contactId: string | null;
  email: string | null;
  phone: string | null;
  /** The resolved primary contact's own preference overrides (migration
   *  306), so a caller can ask whether THIS person wants THIS email rather
   *  than only what the company agreed to. */
  contactPrefs: ContactPrefs | null;
}> {
  const { data: customer } = await service
    .from('customers')
    .select('id, email, phone, notify_status_emails, weekly_digest')
    .ilike('company_name', customerName)
    .maybeSingle();
  if (!customer) return { customer: null, contactId: null, email: null, phone: null, contactPrefs: null };

  let contactId: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;
  let contactPrefs: ContactPrefs | null = null;
  const { data: primary } = await service
    .from('external_contacts')
    .select('id, email, phone, notify_status_emails, weekly_digest')
    .eq('customer_id', customer.id)
    .eq('is_primary', true)
    .maybeSingle();
  if (primary) {
    contactPrefs = primary as ContactPrefs;
    contactId = primary.id;
    email = primary.email || customer.email || null;
    phone = primary.phone || customer.phone || null;
  } else if (customer.email || customer.phone) {
    const { data: created } = await service
      .from('external_contacts')
      .insert({
        customer_id: customer.id,
        name: customerName,
        email: customer.email || null,
        phone: customer.phone || null,
        is_primary: true,
      })
      .select('id')
      .single();
    contactId = created?.id || null;
    email = customer.email || null;
    phone = customer.phone || null;
  }
  return { customer, contactId, email, phone, contactPrefs };
}

async function findOrCreateThread(
  service: Service,
  contactId: string,
  customerId: string,
  input: CustomerNotifyInput,
): Promise<string | null> {
  const { data: openThread } = await service
    .from('customer_threads')
    .select('id')
    .eq('external_contact_id', contactId)
    .eq('context_entity_type', input.contextEntityType)
    .eq('context_entity_id', input.contextEntityId)
    .eq('status', 'open')
    .maybeSingle();
  if (openThread) return openThread.id;
  const { data: createdThread } = await service
    .from('customer_threads')
    .insert({
      external_contact_id: contactId,
      customer_id: customerId,
      context_entity_type: input.contextEntityType,
      context_entity_id: input.contextEntityId,
      subject: input.threadSubject,
    })
    .select('id')
    .single();
  return createdThread?.id || null;
}

export async function notifyCustomerByName(
  service: Service,
  customerName: string | null | undefined,
  input: CustomerNotifyInput,
): Promise<CustomerNotifyResult> {
  const none: CustomerNotifyResult = { emailed: false, smsSent: false, skipped: null };
  if (!customerName) return { ...none, skipped: 'no_customer' };

  const resolved = await resolveCustomerContact(service, customerName);
  const { customer, contactId } = resolved;
  const composed = (input.overrideEmails || []).map(e => String(e).trim()).filter(Boolean);
  // One value feeds both the send and the "did anyone get this" checks, so
  // a composed list and a resolved address can't disagree about who was
  // emailed. `to` is empty exactly when there is nobody to email.
  const to: string[] = composed.length > 0
    ? composed
    : [input.overrideEmail || resolved.email].filter(Boolean) as string[];
  const email = to[0] || null;
  const phone = resolved.phone;
  if (!customer) return { ...none, skipped: 'no_customer' };
  // Company gate AND the resolved person's own override (migration 306):
  // an opt-out belongs to whoever set it, at whichever layer.
  if ((input.respectOptOut ?? true) && !mayReceive('status_emails', customer, resolved.contactPrefs)) {
    return { ...none, skipped: 'opted_out' };
  }
  if (!email && !phone) return { ...none, skipped: 'no_channel' };

  const threadId = contactId ? await findOrCreateThread(service, contactId, customer.id, input) : null;

  let emailed = false;
  if (email) {
    try {
      const { ok, id: resendId } = await sendEmailDetailed(
        to, input.emailSubject, input.emailHtml, undefined, undefined, input.replyTo || undefined,
        (input.bcc || []).filter(Boolean),
        {
          kind: input.emailKind || 'customer_notify',
          cc: (input.cc || []).filter(Boolean),
          sentBy: input.sentBy || null,
          contextUrl: input.contextUrl || null,
          customerId: customer.id,
        },
      );
      emailed = ok;
      if (threadId) {
        await service.from('customer_messages').insert({
          thread_id: threadId,
          direction: 'outbound',
          channel: 'email',
          body: input.messageBody,
          provider_name: 'resend',
          // The Resend id lets the delivery webhook flip this thread
          // message to delivered/failed.
          external_provider_sid: ok ? resendId : null,
          delivery_status: emailed ? 'sent' : 'failed',
        });
      }
    } catch (err) {
      console.error('customer notify email failed:', err);
    }
  }

  let smsSent = false;
  if (phone && input.smsBody) {
    try {
      const result = await sendSMS(phone, input.smsBody);
      smsSent = !!result.ok;
      if (threadId) {
        await service.from('customer_messages').insert({
          thread_id: threadId,
          direction: 'outbound',
          channel: 'sms',
          body: input.smsBody,
          provider_name: result.providerName,
          external_provider_sid: result.sid || null,
          delivery_status: result.ok ? 'sent' : (result.skipped ? 'pending' : 'failed'),
        });
      }
    } catch (err) {
      console.error('customer notify SMS failed:', err);
    }
  }

  return { emailed, smsSent, skipped: null };
}
