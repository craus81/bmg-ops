import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { validateBody, z } from '@/lib/validate';
import { notifyMany, getSuperAdminIds } from '@/lib/notify';
import { sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { QC_LINK_LOOKBACK_DAYS, QC_MAX_PHOTOS, normalizeLast6, qcLinkUrl, qcPublicPhotoUrl } from '@/lib/qc-fixes';
import { buildQcReportedEmail, matchVinLast6, resolveQcCustomer } from '@/lib/qc-fixes-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/qc/[token] — a customer's QC fix link (migration 381).
 *
 * No session: the link's token is the credential, like the PO-status
 * portal. Returns the customer's name and their team's reports from the
 * last QC_LINK_LOOKBACK_DAYS with status, fix-by date and photo ids.
 * `?vin=<last 6>` instead answers "do you have this vehicle?" with its
 * year/make/model, for the form's check line.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  if (!await checkRateLimit(getRequestIp(req), 'qc_link_get', 300)) {
    return NextResponse.json({ status: 'error', error: 'Too many requests. Try again in a little while.' }, { status: 429 });
  }
  const customer = await resolveQcCustomer(supabase, params.token);
  if (!customer) return NextResponse.json({ status: 'invalid' }, { status: 404 });

  const vinParam = req.nextUrl.searchParams.get('vin');
  if (vinParam !== null) {
    const last6 = normalizeLast6(vinParam);
    if (!last6) return NextResponse.json({ status: 'ready', match: null });
    const match = await matchVinLast6(supabase, last6);
    return NextResponse.json({ status: 'ready', match: match ? { label: match.label } : null });
  }

  const since = new Date(Date.now() - QC_LINK_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data: reports, error } = await supabase
    .from('qc_fix_reports')
    .select('id, vin_last6, vehicle_label, reported_by_name, comments, status, fix_by, note_to_customer, fixed_at, created_at')
    .eq('customer_id', customer.id)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .order('id')
    .limit(300);
  if (error) return NextResponse.json({ status: 'error', error: 'Could not load reports' }, { status: 500 });

  const ids = (reports || []).map(r => r.id);
  const { data: photos } = ids.length
    ? await supabase.from('qc_fix_photos').select('id, report_id, kind, created_at').in('report_id', ids).order('created_at').order('id')
    : { data: [] as any[] };
  const byReport = new Map<string, Array<{ id: string; kind: string }>>();
  for (const p of photos || []) {
    const list = byReport.get(p.report_id) || [];
    list.push({ id: p.id, kind: p.kind });
    byReport.set(p.report_id, list);
  }

  return NextResponse.json({
    status: 'ready',
    customerName: customer.company_name,
    reports: (reports || []).map(r => ({ ...r, photos: byReport.get(r.id) || [] })),
  });
}

const SubmitSchema = z.object({
  vinLast6: z.string().trim().min(6).max(40),
  name: z.string().trim().min(1).max(80),
  comments: z.string().trim().max(4000).optional().default(''),
  vinPhotoId: z.string().uuid(),
  issuePhotoIds: z.array(z.string().uuid()).min(1).max(QC_MAX_PHOTOS - 1),
});

/**
 * POST /api/qc/[token] — report a QC fix. The photos were uploaded first
 * (POST ./photo) and are claimed here by id; each must be this customer's,
 * unclaimed, and of the right kind. Then: super admins get a bell + push,
 * and the customer's QC contacts (customers.qc_notify_emails) get an email
 * — it answers their own team's report, so it is not a scheduled send.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!await checkRateLimit(ip, 'qc_link_submit', 40)) {
    return NextResponse.json({ error: 'Too many reports from here. Try again in a little while.' }, { status: 429 });
  }
  const customer = await resolveQcCustomer(supabase, params.token);
  if (!customer) return NextResponse.json({ error: 'This link no longer works. Ask BMG for a new one.' }, { status: 404 });

  const parsed = await validateBody(req, SubmitSchema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;
  const last6 = normalizeLast6(p.vinLast6);
  if (!last6) return NextResponse.json({ error: 'Enter the last 6 of the VIN.' }, { status: 400 });

  const photoIds = [p.vinPhotoId, ...p.issuePhotoIds];
  const { data: photos } = await supabase
    .from('qc_fix_photos').select('id, kind, report_id, customer_id').in('id', photoIds);
  const ok = (photos || []).length === new Set(photoIds).size && (photos || []).every(ph =>
    ph.customer_id === customer.id && !ph.report_id
    && (ph.id === p.vinPhotoId ? ph.kind === 'vin' : ph.kind === 'issue'));
  if (!ok) return NextResponse.json({ error: 'Some photos did not upload. Add them again and resend.' }, { status: 400 });

  const match = await matchVinLast6(supabase, last6);
  const { data: report, error } = await supabase.from('qc_fix_reports').insert({
    customer_id: customer.id,
    vin_last6: last6,
    checkin_id: match?.checkinId || null,
    vin: match?.vin || null,
    vehicle_label: match?.label || null,
    reported_by_name: p.name,
    comments: p.comments || null,
    submit_ip: ip,
  }).select('id, vin_last6, vin, vehicle_label, reported_by_name, comments, created_at').single();
  if (error || !report) return NextResponse.json({ error: 'Could not save the report. Try again.' }, { status: 500 });

  const { error: claimErr } = await supabase.from('qc_fix_photos')
    .update({ report_id: report.id }).in('id', photoIds).eq('customer_id', customer.id).is('report_id', null);
  if (claimErr) console.error('qc photo claim failed:', claimErr);

  const company = customer.company_name || 'A customer';
  const admins = await getSuperAdminIds();
  await notifyMany(admins, {
    type: 'qc_fix_reported',
    title: `QC fix reported: VIN …${last6}`,
    body: `${company} · ${p.name}${match?.label ? ` · ${match.label}` : ''}${p.comments ? `: ${p.comments.slice(0, 140)}` : ''}`,
    url: deepLinks.qcFix(report.id),
    channels: ['in_app', 'push'],
  });

  let emailed: string[] = [];
  if (customer.qc_notify_emails.length) {
    const { subject, html } = buildQcReportedEmail({
      customerName: company,
      report,
      photoUrls: photoIds.map(id => qcPublicPhotoUrl(customer.qc_token, id)),
      linkUrl: qcLinkUrl(customer.qc_token) + `?report=${report.id}`,
    });
    const sent = await sendEmailDetailed(customer.qc_notify_emails, subject, html, undefined, undefined, undefined, undefined, {
      kind: 'qc_fix_reported',
      contextUrl: deepLinks.qcFix(report.id),
      customerId: customer.id,
    });
    if (sent.ok) emailed = customer.qc_notify_emails;
  }

  return NextResponse.json({ ok: true, id: report.id, emailed });
}
