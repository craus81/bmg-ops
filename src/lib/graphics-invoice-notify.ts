/**
 * Post-invoice notification housekeeping for graphics jobs.
 *
 * When a job gets invoiced (in FleetSuite or marked externally), two things
 * should happen for the billing-trusted users:
 *   1. The "Graphics shipped — create invoice?" prompts for that job are
 *      marked read for EVERYONE — the ask is resolved, so it shouldn't keep
 *      sitting in anyone's "New for you" strip or bell.
 *   2. Everyone on the billing list EXCEPT the person who did it gets an
 *      "invoice created" notification, so nobody duplicates the work.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';

// Hardcoded user UUIDs for now. Survives name/email changes. Swap to a
// `notify_invoice_prompts` boolean on profiles once the recipient list
// needs self-serve management.
export const INVOICE_PROMPT_USER_IDS = [
  'f9f8a88c-1049-4bd5-95db-888787677ac9', // Craig George
  '13c993b2-bb84-4539-8bbc-6c85395f558c', // Jessie Whittington
];

export async function notifyInvoiceCreated(
  supabase: SupabaseClient,
  opts: {
    jobId: string;
    jobLabel: string;
    customer?: string | null;
    invoiceNumber?: string | null;
    actorId: string;
    /** e.g. 'created in FleetSuite' vs 'marked invoiced externally' */
    how?: string;
  },
) {
  const { jobId, jobLabel, customer, invoiceNumber, actorId, how } = opts;

  // 1. Resolve outstanding "create invoice?" prompts for this job — for all
  // recipients, including the actor. Failing here must never fail the
  // invoice call, so both steps are best-effort.
  try {
    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('type', 'graphics_invoice_prompt')
      .eq('url', `/invoices?invoiceJob=${jobId}`)
      .is('read_at', null);
  } catch (err) {
    console.error('notifyInvoiceCreated: failed to clear prompts:', err);
  }

  // 2. Tell the other billing users it's handled.
  try {
    const recipients = INVOICE_PROMPT_USER_IDS.filter((id) => id !== actorId);
    if (recipients.length === 0) return;

    const { data: actor } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('id', actorId)
      .maybeSingle();
    const actorName = actor?.full_name || actor?.email || 'Someone';

    await notifyMany(recipients, {
      type: 'graphics_invoice_created',
      title: `Invoice ${invoiceNumber ? `${invoiceNumber} ` : ''}created`,
      body: `${actorName} invoiced ${jobLabel}${customer ? ` for ${customer}` : ''}${how ? ` (${how})` : ''}.`,
      url: '/invoices',
    });
  } catch (err) {
    console.error('notifyInvoiceCreated: failed to notify billing users:', err);
  }
}
