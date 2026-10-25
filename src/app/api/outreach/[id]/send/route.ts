import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { sendEmailDetailed, repFromName } from '@/lib/resend';
import { getEmailSignature, renderSignatureHtml } from '@/lib/email-signature';
import { deepLinks } from '@/lib/deep-links';
import {
  loadUnsubscribed, unsubscribeTokenFor, marketingFooterHtml, marketingFooterText, listUnsubscribeHeaders, normalizeEmail,
} from '@/lib/email-unsubscribe';
import { renderOutreachHtml, ensureProspect, TARGET_COLS, OPEN_STATUSES } from '@/lib/outreach-send';
import { mintMeetToken, meetButtonsHtml, meetButtonsText } from '@/lib/outreach-meet';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const Schema = z.object({
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(20_000),
  emails: z.array(z.string().trim().email()).min(1).max(5),
  cc: z.array(z.string()).optional(),
  bccSelf: z.boolean().optional(),
  preview: z.boolean().optional(),
});

/**
 * Send one Outreach email (migration 439) from the standard compose screen
 * (docs/customer-email-standard.md). Only the rep whose list it is can send
 * it, under their own name: From "<rep> via BMG Fleet", Reply-To the rep.
 * Each To address gets its own copy with its own unsubscribe link. The
 * first send adds the company to Prospects (source Outreach, the rep's) and
 * the email lands on its timeline. Every copy carries the company's Pick a
 * time / Call me buttons (migration 440, src/lib/outreach-meet.ts).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { subject, message, cc, bccSelf, preview } = parsed.data;
  const emails = [...new Set(parsed.data.emails.map(normalizeEmail))];

  const { data: t } = await service.from('outreach_targets').select(TARGET_COLS).eq('id', params.id).maybeSingle();
  if (!t) return NextResponse.json({ error: 'That company is no longer on the list.' }, { status: 404 });
  const target = t as any;
  if (target.rep_id !== auth.user.id) {
    return NextResponse.json({ error: 'Only the rep whose list this is can send it, so it goes out under their name.' }, { status: 403 });
  }
  if (!OPEN_STATUSES.includes(target.status)) {
    return NextResponse.json({ error: 'This one has already been emailed.' }, { status: 409 });
  }

  let unsub: Set<string>;
  try {
    unsub = await loadUnsubscribed(service, emails);
  } catch (err: any) {
    return NextResponse.json({ error: `${err.message}. Nothing was sent.` }, { status: 503 });
  }
  const blocked = emails.filter(e => unsub.has(e));

  const signatureHtml = renderSignatureHtml(await getEmailSignature(service, auth.user.id));

  if (preview) {
    return NextResponse.json({
      preview: {
        to: emails,
        subject,
        // A sample link: the real one is minted per address at send time.
        html: renderOutreachHtml(message, signatureHtml, marketingFooterHtml('0'.repeat(48)),
          meetButtonsHtml(target.booking_token || '0'.repeat(40), auth.profile?.full_name)),
      },
      ...(blocked.length ? { warning: `${blocked.join(', ')} unsubscribed from BMG email and can't be sent to.` } : {}),
    });
  }

  if (blocked.length > 0) {
    return NextResponse.json({ error: `${blocked.join(', ')} unsubscribed from BMG email. Remove ${blocked.length === 1 ? 'it' : 'them'} from To.` }, { status: 400 });
  }

  let prospectId: string;
  try {
    prospectId = await ensureProspect(service, target, emails[0]);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }

  // One booking link per company, kept across sends and follow-ups.
  let meetToken: string = target.booking_token;
  if (!meetToken) {
    meetToken = mintMeetToken();
    const { error: tokErr } = await service.from('outreach_targets').update({ booking_token: meetToken }).eq('id', target.id);
    if (tokErr) return NextResponse.json({ error: `Could not make the booking link: ${tokErr.message}. Nothing was sent.` }, { status: 500 });
  }
  const buttonsHtml = meetButtonsHtml(meetToken, auth.profile?.full_name);
  const buttonsText = meetButtonsText(meetToken, auth.profile?.full_name);

  const sent: string[] = [];
  const failed: string[] = [];
  for (const email of emails) {
    let token: string;
    try {
      token = await unsubscribeTokenFor(service, email);
    } catch {
      failed.push(email);
      continue;
    }
    const { ok } = await sendEmailDetailed(
      email,
      subject,
      renderOutreachHtml(message, signatureHtml, marketingFooterHtml(token), buttonsHtml),
      message + buttonsText + marketingFooterText(token),
      undefined,
      auth.user.email || undefined,
      bccSelf ? (auth.user.email || undefined) : undefined,
      {
        kind: 'outreach',
        sentBy: auth.user.id,
        prospectId,
        contextUrl: deepLinks.prospect(prospectId),
        fromName: repFromName(auth.profile?.full_name),
        cc: cc || [],
        headers: listUnsubscribeHeaders(token),
      },
    );
    (ok ? sent : failed).push(email);
  }

  if (sent.length > 0) {
    await service.from('outreach_targets').update({
      status: 'sent',
      status_changed_at: new Date().toISOString(),
      sent_at: new Date().toISOString(),
      sent_subject: subject,
      prospect_id: prospectId,
      email: target.email || sent[0],
      draft_subject: subject,
      draft_body: message,
    }).eq('id', target.id);
  } else {
    await service.from('outreach_targets').update({ prospect_id: prospectId }).eq('id', target.id);
  }

  if (sent.length === 0) {
    return NextResponse.json({ error: `The email didn't go out to ${failed.join(', ')}. Try again in a minute.`, prospectId }, { status: 502 });
  }
  return NextResponse.json({ success: true, sent, failed, prospectId });
}
