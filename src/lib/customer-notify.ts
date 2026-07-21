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
import { sendEmail } from './resend';
import { sendSMS } from './sms-provider';

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
}> {
  const { data: customer } = await service
    .from('customers')
    .select('id, email, phone, notify_status_emails, weekly_digest')
    .ilike('company_name', customerName)
    .maybeSingle();
  if (!customer) return { customer: null, contactId: null, email: null, phone: null };

  let contactId: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;
  const { data: primary } = await service
    .from('external_contacts')
    .select('id, email, phone')
    .eq('customer_id', customer.id)
    .eq('is_primary', true)
    .maybeSingle();
  if (primary) {
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
  return { customer, contactId, email, phone };
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
  const email = input.overrideEmail || resolved.email;
  const phone = resolved.phone;
  if (!customer) return { ...none, skipped: 'no_customer' };
  if ((input.respectOptOut ?? true) && customer.notify_status_emails !== true) {
    return { ...none, skipped: 'opted_out' };
  }
  if (!email && !phone) return { ...none, skipped: 'no_channel' };

  const threadId = contactId ? await findOrCreateThread(service, contactId, customer.id, input) : null;

  let emailed = false;
  if (email) {
    try {
      emailed = await sendEmail(email, input.emailSubject, input.emailHtml);
      if (threadId) {
        await service.from('customer_messages').insert({
          thread_id: threadId,
          direction: 'outbound',
          channel: 'email',
          body: input.messageBody,
          provider_name: 'resend',
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
