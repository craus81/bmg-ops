import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { sendEmail } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { validateBody, z } from '@/lib/validate';
import { r2Get, r2PublicUrl } from '@/lib/r2';
import { getNetSuitePdf } from '@/lib/netsuite';
import { generateToken, validateExpiry } from '@/lib/magic-link-approval';
import { getEmailSignature } from '@/lib/email-signature';
import { renderQuoteDocument } from '@/lib/quote-document';
import { wrapQuoteDocModel, wrapDocTitle } from '@/lib/wrap-quote-document';
import { generateWrapQuotePdf, wrapQuotePdfFilename } from '@/lib/wrap-quote-pdf-server';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SendSchema = z.object({
  quoteId: z.string().uuid(),
  // Legacy single-select: what the email contains. Superseded by `include`
  // (independent checkboxes) but still accepted — older clients and any
  // queued requests keep working; `include` wins when both are present.
  mode: z.enum(['full', 'quote_only', 'coverage_only', 'netsuite_pdf']).optional().default('full'),
  // Independent content flags. pricing = money in the body (totals block);
  // lineItems = the itemized rows (only meaningful with pricing);
  // diagram = the coverage picture; netsuitePdf = attach the NetSuite
  // quote PDF. This is what lets "picture + total, no line items" exist —
  // the modes were all-or-nothing.
  include: z.object({
    pricing: z.boolean().optional(),
    lineItems: z.boolean().optional(),
    diagram: z.boolean().optional(),
    netsuitePdf: z.boolean().optional(),
  }).optional(),
  // Personal note rendered at the top of the email body (plain text,
  // newlines preserved).
  message: z.string().trim().max(5000).optional(),
  // Standard compose fields (docs/customer-email-standard.md): recipient
  // overrides (win over the quote's stored customer email + cc) and
  // bcc-the-sender.
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  // Subset of the quote's stored attachments to send, by path. Omitted =
  // send them all (the pre-selection behavior).
  attachmentPaths: z.array(z.string().min(1).max(500)).max(50).optional(),
  // Dry run: return { subject, to, html, attachments } without sending or
  // marking the quote sent — powers the preview modal.
  preview: z.boolean().optional().default(false),
});
type SendMode = 'full' | 'quote_only' | 'coverage_only' | 'netsuite_pdf';
type SendFlags = { pricing: boolean; lineItems: boolean; diagram: boolean; netsuitePdf: boolean };

const MODE_FLAGS: Record<SendMode, SendFlags> = {
  full: { pricing: true, lineItems: true, diagram: true, netsuitePdf: false },
  quote_only: { pricing: true, lineItems: true, diagram: false, netsuitePdf: false },
  coverage_only: { pricing: false, lineItems: false, diagram: true, netsuitePdf: false },
  netsuite_pdf: { pricing: false, lineItems: false, diagram: true, netsuitePdf: true },
};

// The email body comes from the shared quote-document renderer
// (src/lib/quote-document.ts) via the wrap adapter — the SAME document the
// acceptance snapshot freezes, so what's sent and what's signed can't drift.

/**
 * POST /api/wrap-quote/send
 *
 * Emails a saved wrap quote to the customer email stored on the quote
 * (plus the CC address if present) and marks it sent.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SendSchema);
  if (parsed.error) return parsed.error;

  // include-flags win over the legacy mode when both arrive.
  const inc = parsed.data.include;
  const flags: SendFlags = inc
    ? {
        pricing: inc.pricing ?? false,
        lineItems: (inc.pricing ?? false) && (inc.lineItems ?? false),
        diagram: inc.diagram ?? false,
        netsuitePdf: inc.netsuitePdf ?? false,
      }
    : MODE_FLAGS[parsed.data.mode];
  // A quote email needs money somewhere — body pricing or the NetSuite PDF.
  const carriesQuote = flags.pricing || flags.netsuitePdf;

  const { data: quote, error: qErr } = await supabase
    .from('wrap_quotes')
    .select('*')
    .eq('id', parsed.data.quoteId)
    .single();
  if (qErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }
  if (!carriesQuote && !flags.diagram) {
    return NextResponse.json({ error: 'Nothing selected to send — pick pricing, the coverage picture, or the NetSuite PDF.' }, { status: 400 });
  }
  if (!carriesQuote && flags.diagram && !quote.diagram_path) {
    return NextResponse.json({ error: 'This quote has no coverage drawing — save it from the estimator first.' }, { status: 400 });
  }
  if (flags.netsuitePdf && !quote.netsuite_estimate_id) {
    return NextResponse.json({ error: 'This quote isn\'t in NetSuite yet — use "Create Quote in NetSuite" first.' }, { status: 400 });
  }

  // Compose-screen recipients win; the quote's stored customer email + cc
  // are the default.
  const overrideEmails = (parsed.data.emails || []).map(e => e.trim()).filter(Boolean);
  const email = overrideEmails[0] || (quote.customer?.email || '').trim();
  if (!email) {
    return NextResponse.json({ error: 'Quote has no customer email' }, { status: 400 });
  }
  const cc = (quote.customer?.email_cc || '').trim();
  const to = overrideEmails.length > 0 ? overrideEmails : (cc ? [email, cc] : email);

  // Tokenized "Review & Accept" link — same magic-link machinery as estimate
  // approval. Coverage-only sends carry no pricing, so nothing to accept.
  // A mint failure (e.g. migration not applied yet) degrades to a quote
  // email without the button rather than blocking the send.
  let approveUrl: string | null = null;
  if (carriesQuote) {
    let token: string | null = quote.approval_token || null;
    if (!token || !validateExpiry(quote.approval_token_expires_at).ok) {
      const minted = generateToken();
      const { error: tokErr } = await supabase
        .from('wrap_quotes')
        .update({ approval_token: minted.token, approval_token_expires_at: minted.expiresAt })
        .eq('id', quote.id);
      token = tokErr ? null : minted.token;
    }
    if (token) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
      approveUrl = `${appUrl}/approve/quote/${token}?via=email&to=${encodeURIComponent(email)}`;
    }
  }

  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};

  // Coverage diagram / logo / attachments live in R2, not Supabase storage —
  // lib/storage (the client uploader) is an R2 shim, so URLs and reads here
  // must go through lib/r2 with the bucket name as the key prefix.
  const diagramUrl = quote.diagram_path
    ? r2PublicUrl('vehicle-templates', quote.diagram_path)
    : null;
  const logoUrl = company?.logo_path
    ? r2PublicUrl('vehicle-templates', company.logo_path)
    : null;

  const message = parsed.data.message || undefined;
  // Sender's signature — in the preview too, so what she sees is what goes.
  const signature = await getEmailSignature(supabase, auth.user?.id);

  // Which of the quote's stored attachments ride along: all of them unless
  // the sender narrowed the set in the preview modal (e.g. "just the
  // NetSuite PDF and the coverage photo").
  const wanted = parsed.data.attachmentPaths ? new Set(parsed.data.attachmentPaths) : null;
  const selectedMeta = (Array.isArray(quote.attachments) ? quote.attachments : [])
    .filter((a: any) => a?.path && (!wanted || wanted.has(a.path)));

  const docWord = wrapDocTitle(flags.pricing, flags.netsuitePdf);
  const subject = `${docWord} ${quote.quote_number}${company?.name ? ` from ${company.name}` : ''}`;

  const html = renderQuoteDocument(
    wrapQuoteDocModel(quote, {
      pricing: flags.pricing,
      lineItems: flags.lineItems,
      diagramUrl: flags.diagram ? diagramUrl : null,
      pdfAttachedNote: flags.netsuitePdf,
    }),
    {
      company,
      logoUrl,
      message,
      ctaUrl: approveUrl,
      ctaLabel: 'Review & Accept This Quote',
      ctaNote: 'Accept online with a dated, legally binding signature — or use the same link to request changes. No account needed. The link expires in 30 days.',
      ctaPanel: true,
      signature,
    },
  );

  // Every quote email carries a PDF copy of the quote (CLAUDE.md domain
  // note), so the customer can save or forward it without the original
  // email. With the NetSuite PDF checked, NetSuite's document is that copy
  // (its totals and tax are the record); otherwise the FleetSuite wrap-quote
  // PDF — the same bytes GET /api/wrap-quote/[id]/pdf hands out — rides
  // first, itemized exactly as the email body is. A coverage-only send has
  // no pricing to copy, so it carries no quote PDF.
  const attachFleetSuitePdf = flags.pricing && !flags.netsuitePdf;

  // Preview: return what would go out without touching R2/NetSuite or
  // marking anything sent.
  if (parsed.data.preview) {
    const names = selectedMeta.map((a: any) => a.name || a.path.split('/').pop() || 'attachment');
    if (flags.netsuitePdf) {
      names.unshift(`Quote_${quote.netsuite_estimate_number || quote.netsuite_estimate_id}.pdf`);
    } else if (attachFleetSuitePdf) {
      names.unshift(wrapQuotePdfFilename(quote));
    }
    return NextResponse.json({
      preview: true,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      attachments: names,
    });
  }

  // Files the sender attached to this quote (proofs, vinyl specs, …).
  // A missing file is a hard error — silently sending a quote without its
  // proof is worse than asking the sender to re-attach it.
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  for (const a of selectedMeta) {
    const result = await r2Get('vehicle-templates', a.path);
    if (!result.success || !result.body) {
      return NextResponse.json({ error: `Attachment "${a.name || a.path}" could not be loaded — remove and re-attach it.` }, { status: 502 });
    }
    // r2Get returns a Node.js Readable stream from @aws-sdk/client-s3.
    const chunks: Buffer[] = [];
    for await (const chunk of result.body as any) {
      chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
    }
    attachments.push({
      filename: a.name || a.path.split('/').pop() || 'attachment',
      content: Buffer.concat(chunks),
      contentType: a.type || undefined,
    });
  }

  // The NetSuite quote PDF rides along as the first attachment — it's the
  // document of record (NetSuite's own totals and tax), so a fetch failure
  // fails the send rather than emailing a body that promises an attachment.
  if (flags.netsuitePdf) {
    const pdf = await getNetSuitePdf('estimate', quote.netsuite_estimate_id);
    if (!pdf.success || !pdf.pdfBase64) {
      return NextResponse.json({
        error: `Could not fetch the NetSuite quote PDF: ${pdf.error || 'unknown error'}. If this says "Missing parameter", the updated PDF RESTlet (scripts/netsuite-pdf-restlet.js) needs to be redeployed in NetSuite.`,
      }, { status: 502 });
    }
    attachments.unshift({
      filename: pdf.filename || `Quote_${quote.netsuite_estimate_number || quote.netsuite_estimate_id}.pdf`,
      content: Buffer.from(pdf.pdfBase64, 'base64'),
      contentType: 'application/pdf',
    });
  } else if (attachFleetSuitePdf) {
    // The FleetSuite PDF copy — a render failure fails the send rather than
    // emailing a body that promises an attachment.
    let pdf: Awaited<ReturnType<typeof generateWrapQuotePdf>>;
    try {
      pdf = await generateWrapQuotePdf(supabase, quote.id, { quote, lineItems: flags.lineItems });
    } catch (err: any) {
      console.error('[wrap-quote/send] quote PDF failed:', err?.message || err);
      pdf = { ok: false, status: 500, error: err?.message || 'PDF render failed' };
    }
    if (!pdf.ok) {
      return NextResponse.json({ error: `Could not generate the quote PDF (${pdf.error}). Nothing was sent — try again.` }, { status: 502 });
    }
    attachments.unshift({ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' });
  }

  // Replies route to the staff member who sent the quote — the from
  // address has no mailbox, so without this a customer reply bounces.
  const bcc = parsed.data.bccSelf && auth.user?.email ? [auth.user.email] : undefined;
  const ok = await sendEmail(
    to, subject, html, undefined, attachments, auth.user?.email || undefined, bcc,
    { kind: 'wrap_quote', cc: parsed.data.cc, sentBy: auth.user?.id, contextUrl: deepLinks.wrapQuote(quote.id), customerId: quote.customer_id || null },
  );
  if (!ok) {
    return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });
  }

  // Only a real quote send marks the quote 'sent' — mailing just the
  // coverage drawing doesn't put pricing in front of the customer. The
  // itemization choice is persisted so the acceptance page and the signed
  // snapshot present exactly what this send did (hide_line_items strips
  // line data server-side on the public route).
  if (carriesQuote) {
    await supabase
      .from('wrap_quotes')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_to: email,
        hide_line_items: !flags.lineItems,
        updated_at: new Date().toISOString(),
      })
      .eq('id', quote.id);
  }

  return NextResponse.json({ success: true });
}
