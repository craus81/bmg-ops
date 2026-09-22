import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { buildCustomerDigestEmail, sendEmailDetailed } from '@/lib/resend';
import { getEmailSignature } from '@/lib/email-signature';
import { resolveCustomerContact } from '@/lib/customer-notify';
import { mayReceive } from '@/lib/notification-prefs';
import { loadDigestForCustomer, digestSections, digestSubject, bucketSize } from '@/lib/customer-digest';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  /** The free-text customer name the vehicles carry — the only linkage. */
  customerName: z.string().min(1).max(200),
  emails: z.array(z.string().email()).max(20).optional(),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  bccSelf: z.boolean().optional(),
  message: z.string().max(4000).optional(),
  preview: z.boolean().optional(),
});

/**
 * POST /api/customers/digest/email — send one customer their weekly
 * vehicle update, through the standard compose contract
 * (docs/customer-email-standard.md): emails[] / cc / bccSelf / message /
 * preview, Reply-To the sender.
 *
 * The Monday cron used to send every one of these itself; it now only
 * counts who has one and tells the admins (owner decision 2026-09-14 — no
 * customer email without a person sending it). Content comes from the same
 * builders the cron counts with, so the preview, the count and the email
 * all describe the same week.
 *
 * Deliberately NOT gated on the digest subscription: an admin who opened
 * this screen and pressed send has decided, and the switch governs what we
 * mail people unasked. The subscription still decides who the cron offers.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { customerName, cc, bccSelf, message, preview } = parsed.data;

  let bucket;
  try {
    bucket = await loadDigestForCustomer(service, customerName);
  } catch (e: any) {
    // A short week reads to the customer as "nothing happening" — never
    // send one built on a failed read.
    return NextResponse.json({ error: `${e?.message || 'Could not load this week'}. Nothing was sent.` }, { status: 502 });
  }
  if (bucketSize(bucket) === 0) {
    return NextResponse.json({ error: `No vehicle activity this week for ${customerName} — there is nothing to send.` }, { status: 400 });
  }

  const resolved = await resolveCustomerContact(service, customerName);
  const composeEmails = (parsed.data.emails || []).map(e => e.trim()).filter(Boolean);
  const emailList = composeEmails.length > 0
    ? composeEmails
    : [resolved.email].filter(Boolean) as string[];

  const signature = await getEmailSignature(service, auth.user?.id);
  const subject = digestSubject(bucket);
  const note = message?.trim();
  const html = buildCustomerDigestEmail(
    customerName,
    digestSections(bucket),
    undefined,
    { note, signature },
  );

  if (preview) {
    // Shown to the sender, never enforced — see the note above.
    const optedOut = !!resolved.customer && !mayReceive('weekly_digest', resolved.customer, resolved.contactPrefs);
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject, html, optedOut });
  }

  if (emailList.length === 0) {
    return NextResponse.json({ error: 'No email on file for this customer. Add a recipient first.' }, { status: 400 });
  }

  const senderEmail = auth.user?.email || undefined;
  const { ok } = await sendEmailDetailed(
    emailList,
    subject,
    html,
    undefined,
    undefined,
    senderEmail,
    bccSelf && senderEmail ? [senderEmail] : undefined,
    {
      kind: 'customer_digest',
      cc,
      sentBy: auth.user?.id,
      customerId: resolved.customer?.id || null,
    },
  );
  if (!ok) {
    return NextResponse.json({ error: 'The update could not be sent. Check the address and try again.' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, dispatch: { emailed: true, to: emailList } });
}
