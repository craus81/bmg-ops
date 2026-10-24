import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { sendEmailDetailed, buildNotificationEmail, repFromName } from '@/lib/resend';
import { getEmailSignature } from '@/lib/email-signature';
import { deepLinks } from '@/lib/deep-links';
import { buildInstallConfirmation, repForJob } from '@/lib/install-scheduling';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const Schema = z.object({
  // Standard compose fields (docs/customer-email-standard.md)
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  message: z.string().trim().max(5000).optional(),
  preview: z.boolean().optional().default(false),
});

/**
 * POST /api/graphics-jobs/[id]/install-confirmation
 *
 * "Send install confirmation" on the job page (Valarie's chain, Craig's
 * pick 2026-10-24): the client and the rep hear the install date, time and
 * place, with a calendar file. Only ever sent by a person from the
 * standard compose screen; nothing calls this on a schedule.
 *
 * preview: true renders the exact email and also returns the suggested
 * recipients (the customer's primary contact, else the customer email) and
 * the rep's email for the Cc row. No side effects.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data: job, error: readErr } = await supabase
    .from('graphics_jobs')
    .select('id, job_number, title, customer, status, delivery_method, ship_to, scheduled_install_date, install_arrival_time, delivery_contact_name, delivery_contact_phone, estimate_id, created_by')
    .eq('id', params.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (!job.scheduled_install_date) {
    return NextResponse.json({ error: 'Set the install date first, then send the confirmation.' }, { status: 400 });
  }

  // Suggested recipients: same lookup the proof email uses.
  let customerId: string | null = null;
  let suggestedTo: string | null = null;
  if (job.customer) {
    const { data: cust } = await supabase
      .from('customers')
      .select('id, email')
      .ilike('company_name', job.customer)
      .maybeSingle();
    if (cust) {
      customerId = cust.id;
      const { data: primary } = await supabase
        .from('external_contacts')
        .select('email')
        .eq('customer_id', cust.id)
        .eq('is_primary', true)
        .maybeSingle();
      suggestedTo = primary?.email || cust.email || null;
    }
  }
  const rep = await repForJob(supabase, job);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com';
  const built = buildInstallConfirmation(job, appUrl);
  const html = buildNotificationEmail(built.title, built.body, built.googleUrl, 'Add to Google Calendar', {
    note: body.message,
    attachmentNames: [built.ics.filename],
    ctaNote: 'Using Outlook or an iPhone? Open the attached install.ics file to add it to your calendar.',
    signature: await getEmailSignature(supabase, auth.user.id),
  });

  const emails = (body.emails || []).map(e => e.trim()).filter(Boolean);
  if (body.preview) {
    return NextResponse.json({
      preview: true,
      to: emails.length > 0 ? emails.join(', ') : suggestedTo,
      subject: built.subject,
      html,
      repEmail: rep?.email || null,
      repName: rep?.name || null,
      customerId,
    });
  }

  if (emails.length === 0) {
    return NextResponse.json({ error: 'Add at least one email address in the To line.' }, { status: 400 });
  }
  const cc = (body.cc || []).map(e => e.trim()).filter(Boolean);
  const bcc = body.bccSelf && auth.user.email ? [auth.user.email] : undefined;

  let result: { ok: boolean; id: string | null };
  try {
    result = await sendEmailDetailed(
      emails, built.subject, html, undefined,
      [built.ics],
      auth.user.email || undefined,
      bcc,
      {
        kind: 'install_confirmation',
        sentBy: auth.user.id,
        contextUrl: deepLinks.graphicsJob(job.id),
        customerId,
        cc: cc.length > 0 ? cc : null,
        fromName: repFromName((auth.profile as any)?.full_name),
      },
    );
  } catch (err: any) {
    return NextResponse.json({ error: `Email failed: ${err?.message || 'send error'}` }, { status: 502 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: 'Email failed to send. Check the addresses and try again.' }, { status: 502 });
  }

  const now = new Date().toISOString();
  await supabase
    .from('graphics_jobs')
    .update({ install_confirmation_sent_at: now, install_confirmation_sent_by: auth.user.id })
    .eq('id', job.id);
  const everyone = [...emails, ...cc];
  await supabase.from('graphics_status_history').insert({
    job_id: job.id,
    from_status: job.status,
    to_status: job.status,
    changed_by: auth.user.id,
    note: `Install confirmation sent to ${everyone.join(', ')}`,
  });

  return NextResponse.json({
    status: 'sent',
    sentAt: now,
    dispatch: { email: { ok: true, target: emails.join(', '), cc: cc.join(', ') || undefined, bcc: bcc?.join(', ') } },
  });
}
