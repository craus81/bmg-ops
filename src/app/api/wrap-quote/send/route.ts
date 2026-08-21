import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { sendEmail } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { validateBody, z } from '@/lib/validate';
import { r2Get, r2PublicUrl } from '@/lib/r2';
import { getNetSuitePdf } from '@/lib/netsuite';
import { generateToken, validateExpiry } from '@/lib/magic-link-approval';
import { getEmailSignature, renderSignatureHtml } from '@/lib/email-signature';

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

const esc = (s: any) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n: any) =>
  (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Light-themed printable quote document (customers print/forward these, so
// no dark chrome like the internal notification template).
function buildQuoteHtml(quote: any, company: any, diagramUrl: string | null, logoUrl: string | null, flags: SendFlags, message?: string, approveUrl?: string | null, signature?: string | null): string {
  const pricing = flags.pricing;
  const lineItems = flags.pricing && flags.lineItems;
  const showDiagram = flags.diagram && !!diagramUrl;
  const docTitle = pricing || flags.netsuitePdf ? 'Wrap Quote' : 'Wrap Coverage';
  const cust = quote.customer || {};
  const rows: string[] = [];
  const cell = (v: string, right = false) =>
    `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;${right ? 'text-align:right;' : ''}">${v}</td>`;

  // Kit-quantity jobs: the measurement lines price ONE kit; a bold rollup
  // row shows kits × per-kit materials, and the totals block shows the
  // quantity discount / shop minimum that produced the final subtotal.
  // Roll-nested quotes instead price materials as vinyl cut off each film's
  // roll: the shape lines carry no prices (sizes only, unit_price null) and
  // per-film "Material" rows carry the roll totals.
  const adj = quote.adjustments || null;
  const kits = Math.max(1, parseInt(quote.package_qty, 10) || 1);
  const nest = quote.nesting?.enabled ? quote.nesting : null;
  for (const l of quote.measurements || []) {
    const detail = `${money(l.billed_area_sqft)} ft²${l.substrate?.name ? ` · ${esc(l.substrate.name)}` : ''}${kits > 1 ? ' · per kit' : ''}`;
    rows.push(`<tr>${cell(`${esc(l.name)} <span style="color:#6b7280;font-size:11px;">${detail}</span>`)}${cell(String(l.qty || 1), true)}${cell(l.unit_price == null ? '—' : money(l.unit_price), true)}${cell(l.line_total == null ? '—' : money(l.line_total), true)}</tr>`);
  }
  if (nest) {
    for (const f of nest.films || []) {
      if (!((parseFloat(f.material_total) || 0) > 0.005)) continue;
      const usedIn = (f.rolls || []).reduce((s: number, r: any) => s + (parseFloat(r.used_length_in) || 0), 0);
      const extra = parseFloat(f.extra_area_sqft) || 0;
      const detail = [
        (parseFloat(f.roll_sqft) || 0) > 0.005 ? `${money(f.roll_sqft)} ft² · ${(usedIn / 12).toFixed(1)} ft of ${money(nest.roll_width_in)}" roll` : '',
        extra > 0.005 ? `${money(extra)} ft² billed by area` : '',
      ].filter(Boolean).join(' + ') + ((nest.sets || 1) > 1 ? ` · ${nest.sets} sets` : '');
      rows.push(`<tr>${cell(`<b>Material — ${esc(f.label)}</b> <span style="color:#6b7280;font-size:11px;">${detail}</span>`)}${cell('1', true)}${cell(money(f.material_total), true)}${cell(`<b>${money(f.material_total)}</b>`, true)}</tr>`);
    }
  }
  if (kits > 1 && adj && !nest) {
    rows.push(`<tr>${cell(`<b>Materials — ${kits} kits</b> <span style="color:#6b7280;font-size:11px;">${money(adj.kit_area_sqft)} ft² per kit</span>`)}${cell(`<b>${kits}</b>`, true)}${cell(money(adj.kit_materials), true)}${cell(`<b>${money(adj.pre_materials)}</b>`, true)}</tr>`);
  }
  for (const f of quote.labor?.films || []) {
    if (!(parseFloat(f.total) || 0)) continue;
    rows.push(`<tr>${cell(`Install — ${esc(f.label)} <span style="color:#6b7280;font-size:11px;">${money(f.sqft)} ft² @ $${money(f.rate)}/ft²</span>`)}${cell('1', true)}${cell(money(f.total), true)}${cell(money(f.total), true)}</tr>`);
  }
  const laborLabels: Record<string, string> = { design: 'Design', preparation: 'Preparation', installation: 'Installation' };
  for (const key of Object.keys(laborLabels)) {
    const sec = quote.labor?.[key];
    if (!sec || !(parseFloat(sec.total) || 0)) continue;
    rows.push(`<tr>${cell(laborLabels[key])}${cell('1', true)}${cell(money(sec.total), true)}${cell(money(sec.total), true)}</tr>`);
  }

  const companyLines = [
    company?.name, company?.address,
    [company?.city, company?.state, company?.zip].filter(Boolean).join(', '),
    company?.phone, company?.email,
  ].filter(Boolean).map(l => esc(l)).join('<br>');
  const customerLines = [
    cust.name, cust.address,
    [cust.city, cust.state, cust.zip].filter(Boolean).join(', '),
    cust.phone, cust.email,
  ].filter(Boolean).map(l => esc(l)).join('<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr>
          <td style="vertical-align:top;">
            ${logoUrl ? `<img src="${esc(logoUrl)}" alt="${esc(company?.name || 'Company logo')}" height="44" style="height:44px;max-width:220px;display:block;margin-bottom:10px;">` : ''}
            <div style="font-size:22px;font-weight:800;color:#111827;">${docTitle}</div>
            <div style="font-size:12px;color:#6b7280;">${esc(quote.quote_number)} · ${new Date(quote.created_at || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
          </td>
        </tr>
      </table>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr>
          <td style="vertical-align:top;font-size:12px;color:#374151;line-height:1.5;">${companyLines || ''}</td>
          <td style="vertical-align:top;font-size:12px;color:#374151;line-height:1.5;text-align:right;"><b style="color:#111827;">Customer</b><br>${customerLines || ''}</td>
        </tr>
      </table>
      ${message ? `<div style="font-size:13px;color:#374151;margin:0 0 16px;white-space:pre-wrap;line-height:1.5;">${esc(message)}</div>` : ''}
      ${quote.project_type ? `<div style="font-size:12px;color:#374151;margin-bottom:4px;"><b>Project Type:</b> ${esc(quote.project_type)}</div>` : ''}
      ${quote.vehicle_description ? `<div style="font-size:12px;color:#374151;margin-bottom:14px;"><b>Vehicle:</b> ${esc(quote.vehicle_description)}</div>` : ''}
      ${showDiagram ? `<div style="margin:0 0 14px;"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;font-weight:700;margin-bottom:4px;">Coverage Areas</div><img src="${esc(diagramUrl)}" alt="Wrap coverage diagram" width="584" style="width:100%;max-width:584px;display:block;border:1px solid #e5e7eb;border-radius:8px;"></div>` : ''}
      ${flags.netsuitePdf && !pricing ? `<div style="font-size:13px;color:#374151;margin:0 0 14px;">Your quote is attached as a PDF.</div>` : ''}
      ${lineItems ? `<table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Item</th>
            <th style="text-align:right;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Qty</th>
            <th style="text-align:right;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Price</th>
            <th style="text-align:right;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Total</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>` : ''}
      ${pricing ? `<table style="width:100%;border-collapse:collapse;margin-top:14px;">
        ${adj && ((parseFloat(adj.discount_amount) || 0) > 0.005 || (parseFloat(adj.min_bump) || 0) > 0.005) ? `<tr><td style="text-align:right;font-size:13px;color:#6b7280;padding:2px 10px;">Subtotal before adjustments</td><td style="text-align:right;font-size:13px;color:#6b7280;padding:2px 10px;width:110px;">$${money(adj.pre_subtotal)}</td></tr>` : ''}
        ${adj && (parseFloat(adj.discount_amount) || 0) > 0.005 ? `<tr><td style="text-align:right;font-size:13px;color:#7c3aed;padding:2px 10px;">Quantity discount (${money(adj.discount_pct)}%)</td><td style="text-align:right;font-size:13px;color:#7c3aed;padding:2px 10px;">−$${money(adj.discount_amount)}</td></tr>` : ''}
        ${adj && (parseFloat(adj.min_bump) || 0) > 0.005 ? `<tr><td style="text-align:right;font-size:13px;color:#b45309;padding:2px 10px;">Shop minimum</td><td style="text-align:right;font-size:13px;color:#b45309;padding:2px 10px;">+$${money(adj.min_bump)}</td></tr>` : ''}
        <tr><td style="text-align:right;font-size:13px;color:#374151;padding:2px 10px;">Subtotal</td><td style="text-align:right;font-size:13px;color:#111827;padding:2px 10px;width:110px;">$${money(quote.subtotal)}</td></tr>
        <tr><td style="text-align:right;font-size:13px;color:#374151;padding:2px 10px;">Tax (${money(quote.tax_rate)}%)</td><td style="text-align:right;font-size:13px;color:#111827;padding:2px 10px;">$${money(quote.tax_amount)}</td></tr>
        <tr><td style="text-align:right;font-size:16px;font-weight:800;color:#111827;padding:6px 10px;">Total</td><td style="text-align:right;font-size:16px;font-weight:800;color:#059669;padding:6px 10px;">$${money(quote.total)}</td></tr>
      </table>` : ''}
      ${lineItems && (quote.labor?.films || []).length ? `<div style="margin-top:12px;font-size:11px;color:#6b7280;"><b style="color:#374151;">Film usage:</b> ${(quote.labor.films as any[]).map((f: any) => `${esc(f.label)} — ${money(f.sqft)} ft²`).join(' &middot; ')}</div>` : ''}
      ${nest && lineItems ? `<div style="margin-top:4px;font-size:11px;color:#6b7280;"><b style="color:#374151;">Materials priced from nested roll layout:</b> ${money((nest.films || []).reduce((s: number, f: any) => s + (parseFloat(f.roll_sqft) || 0), 0))} ft² of ${money(nest.roll_width_in)}&quot; roll${(nest.sets || 1) > 1 ? ` &middot; ${nest.sets} sets nested together` : ''}</div>` : ''}
      ${quote.project_notes ? `<div style="margin-top:16px;font-size:12px;color:#374151;"><b>Project Notes:</b> ${esc(quote.project_notes)}</div>` : ''}
      ${approveUrl ? `
      <div style="margin-top:22px;padding:18px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;text-align:center;">
        <a href="${esc(approveUrl)}" style="display:inline-block;background:#16a34a;color:#ffffff;font-size:15px;font-weight:700;padding:13px 28px;border-radius:10px;text-decoration:none;">Review &amp; Accept This Quote</a>
        <div style="font-size:12px;color:#374151;margin-top:10px;line-height:1.5;">Accept online with a dated, legally binding signature — or use the same link to request changes.<br>No account needed. The link expires in 30 days.</div>
      </div>` : ''}
      ${renderSignatureHtml(signature, 'light')}
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Sent by ${esc(company?.name || 'BMG Fleet')}</div>
  </div>
</body>
</html>`;
}

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

  const docWord = carriesQuote ? 'Wrap Quote' : 'Wrap Coverage';
  const subject = `${docWord} ${quote.quote_number}${company?.name ? ` from ${company.name}` : ''}`;

  // Preview: return what would go out without touching R2/NetSuite or
  // marking anything sent.
  if (parsed.data.preview) {
    const names = selectedMeta.map((a: any) => a.name || a.path.split('/').pop() || 'attachment');
    if (flags.netsuitePdf) {
      names.unshift(`Quote_${quote.netsuite_estimate_number || quote.netsuite_estimate_id}.pdf`);
    }
    return NextResponse.json({
      preview: true,
      to: Array.isArray(to) ? to : [to],
      subject,
      html: buildQuoteHtml(quote, company, diagramUrl, logoUrl, flags, message, approveUrl, signature),
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
  }

  // Replies route to the staff member who sent the quote — the from
  // address has no mailbox, so without this a customer reply bounces.
  const bcc = parsed.data.bccSelf && auth.user?.email ? [auth.user.email] : undefined;
  const ok = await sendEmail(
    to, subject, buildQuoteHtml(quote, company, diagramUrl, logoUrl, flags, message, approveUrl, signature), undefined, attachments, auth.user?.email || undefined, bcc,
    { kind: 'wrap_quote', sentBy: auth.user?.id, contextUrl: deepLinks.wrapQuote(quote.id) },
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
