import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { sendEmailDetailed } from '@/lib/resend';
import { getEmailSignature, renderSignatureHtml } from '@/lib/email-signature';
import { deepLinks } from '@/lib/deep-links';
import {
  buildAudience, applyMerge, unknownMergeTokens, MAX_RECIPIENTS,
  type BlastRecipientSource,
} from '@/lib/segment-blast';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  /** The filtered CRM segment, as the list currently shows it. */
  ids: z.array(z.string().uuid()).min(1).max(1000),
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(20_000),
  /** Recipients the sender kept in the To field. Omit to send to the whole
   *  sendable audience. Addresses outside the segment are refused. */
  emails: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bccSelf: z.boolean().optional(),
  preview: z.boolean().optional(),
});

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The sender's words, merged, on the house shell. Paragraphs, not raw HTML. */
function renderBody(messageForRecipient: string, signatureHtml: string): string {
  const paragraphs = messageForRecipient
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 14px;line-height:1.55;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`)
    .join('');
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#1f2937;">
      ${paragraphs}
      ${signatureHtml}
    </div>`;
}

/**
 * POST /api/prospects/segment-email — one individually-addressed send per
 * recipient in a filtered CRM segment (R6-9).
 *
 * Individual sends, never one email with many recipients: a shared To line
 * shows every customer who else we quoted, and a shared Bcc still lands as
 * obvious bulk mail. It also means merge fields can differ per recipient,
 * which is the whole point.
 *
 * The compose screen (docs/customer-email-standard.md) owns To, Cc, Bcc-me
 * and the live preview; this route owns the audience rules and the fan-out.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { ids, subject, message, emails, cc, bccSelf, preview } = parsed.data;

  // A token that looks like a merge field but is not one would reach the
  // customer verbatim. Refuse before anything is sent OR previewed, so the
  // sender fixes the typo rather than discovering it in a reply.
  const unknown = unknownMergeTokens(`${subject}\n${message}`);
  if (unknown.length > 0) {
    return NextResponse.json({
      error: `Unknown merge field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Fix or remove ${unknown.length === 1 ? 'it' : 'them'} — they would be sent to the customer exactly as typed.`,
    }, { status: 400 });
  }

  const { data: rows } = await service
    .from('prospects')
    .select('id, company_name, contact_name, email, email_campaign')
    .in('id', ids);

  // Keep the caller's ordering: the sender is looking at their own sort.
  const byId = new Map((rows || []).map((r: any) => [r.id, r as BlastRecipientSource]));
  const ordered = ids.map(id => byId.get(id)).filter(Boolean) as BlastRecipientSource[];

  const audience = buildAudience(ordered, `${subject}\n${message}`);

  // The To field NARROWS the audience — removing an address drops that
  // recipient. It cannot widen it: an address with no record behind it has
  // nothing to merge from, so adding one here would send a half-filled
  // template to a stranger.
  let sendable = audience.sendable;
  let refusedAdditions: string[] = [];
  if (emails && emails.length > 0) {
    const kept = new Set(emails.map(e => String(e).trim().toLowerCase()).filter(Boolean));
    const known = new Set(audience.sendable.map(s => s.email));
    refusedAdditions = [...kept].filter(e => !known.has(e));
    sendable = audience.sendable.filter(s => kept.has(s.email));
  }

  const signature = await getEmailSignature(service, auth.user?.id);
  const signatureHtml = renderSignatureHtml(signature);

  if (preview) {
    const sample = sendable[0] || audience.sendable[0] || null;
    const source = sample ? byId.get(sample.id) || null : null;
    return NextResponse.json({
      preview: {
        to: sendable.map(s => s.email),
        subject: source ? applyMerge(subject, source) : subject,
        html: renderBody(source ? applyMerge(message, source) : message, signatureHtml),
      },
      audience: {
        sendableCount: sendable.length,
        skipped: audience.skipped,
        overCap: sendable.length > MAX_RECIPIENTS,
        maxRecipients: MAX_RECIPIENTS,
        // Named so the preview can say whose copy it is showing rather than
        // implying every recipient gets this exact text.
        sampleCompany: sample?.companyName || null,
        refusedAdditions,
      },
    });
  }

  if (refusedAdditions.length > 0) {
    return NextResponse.json({
      error: `These addresses are not in the segment, so there is no record to personalise from: ${refusedAdditions.join(', ')}. Add them to the CRM first, or remove them from To.`,
    }, { status: 400 });
  }
  if (sendable.length === 0) {
    return NextResponse.json({ error: 'Nobody in this segment can be emailed — see the skipped list.' }, { status: 400 });
  }
  if (sendable.length > MAX_RECIPIENTS) {
    return NextResponse.json({
      error: `${sendable.length} recipients is more than one send can handle (${MAX_RECIPIENTS}). Narrow the filter and send in batches — a run that times out halfway would leave you guessing who got it.`,
    }, { status: 400 });
  }

  const senderEmail = bccSelf ? (auth.user?.email || null) : null;
  const sent: string[] = [];
  const failed: { email: string; company: string }[] = [];
  const activities: any[] = [];

  for (const r of sendable) {
    const source = byId.get(r.id)!;
    const { ok } = await sendEmailDetailed(
      r.email,
      applyMerge(subject, source),
      renderBody(applyMerge(message, source), signatureHtml),
      applyMerge(message, source),
      undefined,
      auth.user?.email || undefined,
      senderEmail || undefined,
      { kind: 'segment_blast', contextUrl: deepLinks.prospect(r.id) },
    );
    if (ok) {
      sent.push(r.email);
      activities.push({
        prospect_id: r.id,
        type: 'email',
        summary: `Campaign email sent — ${applyMerge(subject, source)}`.slice(0, 500),
        created_by: auth.user.id,
      });
    } else {
      failed.push({ email: r.email, company: r.companyName });
    }
  }

  if (activities.length > 0) {
    // Best-effort timeline write: the mail is already out, and a failed log
    // must not report the send as failed.
    await service.from('prospect_activities').insert(activities);
  }

  return NextResponse.json({
    success: true,
    sent: sent.length,
    // Named, not counted: "3 failed" with no addresses leaves nobody able to
    // follow up on the three.
    failed,
    skipped: audience.skipped,
    cc: cc || [],
  });
}
