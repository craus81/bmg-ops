import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { sendEmail } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { validateBody, z } from '@/lib/validate';
import { r2Get, r2PublicUrl } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SendSchema = z.object({
  guideId: z.string().uuid(),
  // Standard compose fields (docs/customer-email-standard.md).
  emails: z.array(z.string().email().max(254)).max(20).default([]),
  bccSelf: z.boolean().optional().default(false),
  message: z.string().trim().max(5000).optional(),
  // The generated guide PDF(s), staged to R2 by the editor right before
  // this call. Paths are pinned under install-guides/ so this route can't
  // be used to read arbitrary bucket keys.
  attachments: z
    .array(
      z.object({
        path: z.string().regex(/^install-guides\//).max(500),
        name: z.string().min(1).max(200),
      }),
    )
    .min(1)
    .max(5),
  // Dry run for the live preview — render without sending.
  preview: z.boolean().optional().default(false),
});

const esc = (s: any) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Light-themed printable body (installers print these), modeled on the
// wrap-quote send document.
function buildGuideHtml(
  guide: any,
  company: any,
  logoUrl: string | null,
  attachmentNames: string[],
  message?: string,
): string {
  const companyLines = [
    company?.name,
    company?.address,
    [company?.city, company?.state, company?.zip].filter(Boolean).join(', '),
    company?.phone,
    company?.email,
  ].filter(Boolean).map(l => esc(l)).join('<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      ${logoUrl ? `<img src="${esc(logoUrl)}" alt="${esc(company?.name || 'Company logo')}" height="44" style="height:44px;max-width:220px;display:block;margin-bottom:10px;">` : ''}
      <div style="font-size:22px;font-weight:800;color:#111827;">Graphics Install Guide</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:16px;">
        ${esc(guide.title || 'Install guide')}${guide.customer_name ? ` · ${esc(guide.customer_name)}` : ''}
      </div>
      ${guide.vehicle_desc ? `<div style="font-size:12px;color:#374151;margin-bottom:14px;"><b>Vehicle:</b> ${esc(guide.vehicle_desc)}</div>` : ''}
      ${message ? `<div style="font-size:13px;color:#374151;margin:0 0 16px;white-space:pre-wrap;line-height:1.5;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;">${esc(message)}</div>` : ''}
      <div style="font-size:13px;color:#374151;line-height:1.6;">
        The attached install guide shows exactly where every graphic goes — dimension lines are
        actual vehicle dimensions in inches, measured from the body features they touch.
        Read every section before opening material, and contact us through your job in the
        installer portal before deviating from anything in the guide.
      </div>
      <div style="margin-top:14px;font-size:12px;color:#6b7280;">
        <b style="color:#374151;">Attached:</b> ${attachmentNames.map(n => esc(n)).join(', ')}
      </div>
      <div style="margin-top:20px;font-size:12px;color:#374151;line-height:1.5;">${companyLines}</div>
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Sent by ${esc(company?.name || 'BMG Fleet')}</div>
  </div>
</body>
</html>`;
}

/**
 * POST /api/install-guides/send
 *
 * Emails an install guide PDF (staged to R2 by the editor) to CNI
 * installers through the standard compose flow. `preview: true` returns
 * the exact HTML/subject/recipients without sending.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SendSchema);
  if (parsed.error) return parsed.error;

  const { data: guide, error: gErr } = await supabase
    .from('install_guides')
    .select('id, title, customer_name, vehicle_desc')
    .eq('id', parsed.data.guideId)
    .single();
  if (gErr || !guide) {
    return NextResponse.json({ error: 'Install guide not found' }, { status: 404 });
  }

  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};
  const logoUrl = company?.logo_path ? r2PublicUrl('vehicle-templates', company.logo_path) : null;

  const attachmentNames = parsed.data.attachments.map(a => a.name);
  const subject = `Install Guide — ${guide.title || guide.vehicle_desc || guide.customer_name || 'vehicle graphics'}${company?.name ? ` from ${company.name}` : ''}`;
  const html = buildGuideHtml(guide, company, logoUrl, attachmentNames, parsed.data.message);

  if (parsed.data.preview) {
    return NextResponse.json({
      preview: true,
      to: parsed.data.emails,
      subject,
      html,
      attachments: attachmentNames,
    });
  }

  if (parsed.data.emails.length === 0) {
    return NextResponse.json({ error: 'Enter at least one recipient email address.' }, { status: 400 });
  }

  // A missing file is a hard error — an install guide email without the
  // guide is worse than asking the sender to re-export it.
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  for (const a of parsed.data.attachments) {
    const result = await r2Get('vehicle-templates', a.path);
    if (!result.success || !result.body) {
      return NextResponse.json(
        { error: `Attachment "${a.name}" could not be loaded — close this dialog and try again (the export may not have finished uploading).` },
        { status: 502 },
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of result.body as any) {
      chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
    }
    attachments.push({ filename: a.name, content: Buffer.concat(chunks), contentType: 'application/pdf' });
  }

  // Replies route to the staff member who sent the guide — the from
  // address has no mailbox, so without this an installer reply bounces.
  const bcc = parsed.data.bccSelf && auth.user?.email ? [auth.user.email] : undefined;
  const ok = await sendEmail(
    parsed.data.emails,
    subject,
    html,
    undefined,
    attachments,
    auth.user?.email || undefined,
    bcc,
    { kind: 'install_guide', sentBy: auth.user?.id, contextUrl: deepLinks.installGuide(guide.id) },
  );
  if (!ok) {
    return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });
  }

  return NextResponse.json({ success: true });
}
