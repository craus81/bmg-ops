import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { sendEmail } from '@/lib/resend';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SendSchema = z.object({
  quoteId: z.string().uuid(),
});

const esc = (s: any) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n: any) =>
  (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Light-themed printable quote document (customers print/forward these, so
// no dark chrome like the internal notification template).
function buildQuoteHtml(quote: any, company: any): string {
  const cust = quote.customer || {};
  const rows: string[] = [];
  const cell = (v: string, right = false) =>
    `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;${right ? 'text-align:right;' : ''}">${v}</td>`;

  for (const l of quote.measurements || []) {
    const detail = `${money(l.billed_area_sqft)} ft²${l.substrate?.name ? ` · ${esc(l.substrate.name)}` : ''}`;
    rows.push(`<tr>${cell(`${esc(l.name)} <span style="color:#6b7280;font-size:11px;">${detail}</span>`)}${cell(String(l.qty || 1), true)}${cell(money(l.unit_price), true)}${cell(money(l.line_total), true)}</tr>`);
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
            <div style="font-size:22px;font-weight:800;color:#111827;">Wrap Quote</div>
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
      ${quote.project_type ? `<div style="font-size:12px;color:#374151;margin-bottom:4px;"><b>Project Type:</b> ${esc(quote.project_type)}</div>` : ''}
      ${quote.vehicle_description ? `<div style="font-size:12px;color:#374151;margin-bottom:14px;"><b>Vehicle:</b> ${esc(quote.vehicle_description)}</div>` : ''}
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Item</th>
            <th style="text-align:right;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Qty</th>
            <th style="text-align:right;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Price</th>
            <th style="text-align:right;padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;">Total</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;">
        <tr><td style="text-align:right;font-size:13px;color:#374151;padding:2px 10px;">Subtotal</td><td style="text-align:right;font-size:13px;color:#111827;padding:2px 10px;width:110px;">$${money(quote.subtotal)}</td></tr>
        <tr><td style="text-align:right;font-size:13px;color:#374151;padding:2px 10px;">Tax (${money(quote.tax_rate)}%)</td><td style="text-align:right;font-size:13px;color:#111827;padding:2px 10px;">$${money(quote.tax_amount)}</td></tr>
        <tr><td style="text-align:right;font-size:16px;font-weight:800;color:#111827;padding:6px 10px;">Total</td><td style="text-align:right;font-size:16px;font-weight:800;color:#059669;padding:6px 10px;">$${money(quote.total)}</td></tr>
      </table>
      ${(quote.film_totals || []).length ? `<div style="margin-top:12px;font-size:11px;color:#6b7280;"><b style="color:#374151;">Film usage:</b> ${(quote.film_totals as any[]).map((f: any) => `${esc(f.label)} — ${money(f.sqft)} ft²`).join(' &middot; ')}</div>` : ''}
      ${quote.project_notes ? `<div style="margin-top:16px;font-size:12px;color:#374151;"><b>Project Notes:</b> ${esc(quote.project_notes)}</div>` : ''}
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

  const { data: quote, error: qErr } = await supabase
    .from('wrap_quotes')
    .select('*')
    .eq('id', parsed.data.quoteId)
    .single();
  if (qErr || !quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  const email = (quote.customer?.email || '').trim();
  if (!email) {
    return NextResponse.json({ error: 'Quote has no customer email' }, { status: 400 });
  }
  const cc = (quote.customer?.email_cc || '').trim();
  const to = cc ? [email, cc] : email;

  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};

  const subject = `Wrap Quote ${quote.quote_number}${company?.name ? ` from ${company.name}` : ''}`;
  const ok = await sendEmail(to, subject, buildQuoteHtml(quote, company));
  if (!ok) {
    return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });
  }

  await supabase
    .from('wrap_quotes')
    .update({ status: 'sent', sent_at: new Date().toISOString(), sent_to: email, updated_at: new Date().toISOString() })
    .eq('id', quote.id);

  return NextResponse.json({ success: true });
}
