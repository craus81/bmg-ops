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
import { deepLinks } from '@/lib/deep-links';

/**
 * The billing users are the approved admins who opted in to invoicing
 * notifications in Settings (notification_preferences.notify_invoicing).
 * Admin detection mirrors api-auth's profileRoles(): the multi-role `roles`
 * array wins when present, else the single `role` column.
 */
export async function getBillingUserIds(supabase: SupabaseClient): Promise<string[]> {
  const [{ data: profiles }, { data: prefs }] = await Promise.all([
    supabase.from('profiles').select('id, role, roles').eq('status', 'approved'),
    supabase.from('notification_preferences').select('user_id').eq('notify_invoicing', true),
  ]);
  const optedIn = new Set((prefs || []).map((p) => p.user_id));
  return (profiles || [])
    .filter((p) => (Array.isArray(p.roles) && p.roles.length > 0 ? p.roles : [p.role]).includes('admin'))
    .map((p) => p.id)
    .filter((id) => optedIn.has(id));
}

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
      // Must match the url the prompt was created with (notify-shipped-invoice).
      .eq('url', deepLinks.createInvoiceForJob(jobId))
      .is('read_at', null);
  } catch (err) {
    console.error('notifyInvoiceCreated: failed to clear prompts:', err);
  }

  // 2. Tell the other billing users it's handled.
  try {
    const recipients = (await getBillingUserIds(supabase)).filter((id) => id !== actorId);
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
      // The job record shows the invoice state; /invoices?invoiceJob= would
      // wrongly re-open the CREATE dialog for an already-invoiced job.
      url: deepLinks.graphicsJob(jobId),
    });
  } catch (err) {
    console.error('notifyInvoiceCreated: failed to notify billing users:', err);
  }
}
