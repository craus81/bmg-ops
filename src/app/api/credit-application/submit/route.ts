import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { checkRateLimit } from '@/lib/magic-link-approval';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * PUBLIC submit endpoint for the /credit-application form (audit Stage 1
 * CRITICAL: the form used to insert straight from the browser with the anon
 * key — no server validation, no rate limit, no notification, and nothing
 * ever read the table). Migration 237 dropped the anon INSERT policy, so
 * this service-role route is now the only write path.
 *
 * Abuse posture for an unauthenticated PII endpoint:
 *  - honeypot field ("website") — bots that fill it get a fake success and
 *    no row;
 *  - per-IP rate limit on a TRUSTED ip (see trustedIp below — the shared
 *    getRequestIp takes the leftmost X-Forwarded-For hop, which the sender
 *    controls; Vercel appends the real client IP on the right);
 *  - a global ceiling so rotating IPs still can't flood the queue or spam
 *    the reviewers' notifications.
 */

/** Empty string -> null, else coerce; the form's optional numeric boxes submit ''. */
const optionalNumber = (int: boolean) =>
  z.preprocess(
    v => (v === '' || v == null ? null : v),
    (int ? z.coerce.number().int() : z.coerce.number()).min(0).nullable(),
  );

const optionalStr = (max: number) =>
  z.string().trim().max(max).optional().default('');

const Schema = z.object({
  company_name: z.string().trim().min(1).max(200),
  dba_name: optionalStr(200),
  business_type: optionalStr(50),
  tax_id: optionalStr(20),
  years_in_business: optionalNumber(true),
  contact_name: z.string().trim().min(1).max(200),
  contact_title: optionalStr(100),
  contact_email: z.string().trim().toLowerCase().email().max(254),
  contact_phone: optionalStr(30),
  address: optionalStr(200),
  city: optionalStr(100),
  state: optionalStr(50),
  zip: optionalStr(20),
  ap_contact_name: optionalStr(200),
  ap_contact_email: z.union([z.literal(''), z.string().trim().toLowerCase().email().max(254)]).optional().default(''),
  ap_contact_phone: optionalStr(30),
  requested_terms: z.enum(['net_15', 'net_30', 'net_45', 'net_60']).optional().default('net_30'),
  estimated_monthly_volume: optionalNumber(false),
  trade_ref_1_company: optionalStr(200), trade_ref_1_contact: optionalStr(200), trade_ref_1_phone: optionalStr(30),
  trade_ref_2_company: optionalStr(200), trade_ref_2_contact: optionalStr(200), trade_ref_2_phone: optionalStr(30),
  trade_ref_3_company: optionalStr(200), trade_ref_3_contact: optionalStr(200), trade_ref_3_phone: optionalStr(30),
  bank_name: optionalStr(200),
  bank_contact: optionalStr(200),
  bank_phone: optionalStr(30),
  bank_account_type: optionalStr(50),
  /** Honeypot — humans never see it; anything non-empty is a bot. */
  website: z.string().optional().default(''),
});

/**
 * Client IP from sources the platform controls. Vercel sets x-real-ip to
 * the true client and APPENDS the client to x-forwarded-for — so the
 * rightmost entry is trustworthy and the leftmost is attacker-supplied.
 * (Deliberately not the shared getRequestIp, which reads the leftmost hop;
 * changing that helper would alter the approval routes' behavior.)
 */
function trustedIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return 'unknown';
}

/** Reviewers can't be flooded even from rotating IPs. */
const GLOBAL_HOURLY_CEILING = 30;

export async function POST(req: NextRequest) {
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { website, ...form } = parsed.data;

  try {
    // Honeypot: pretend success so the bot doesn't adapt.
    if (website.trim() !== '') {
      return NextResponse.json({ success: true });
    }

    const ip = trustedIp(req);
    const allowed = await checkRateLimit(ip, 'credit_application');
    if (!allowed) {
      return NextResponse.json(
        { error: 'Too many submissions. Please try again later.' }, { status: 429 },
      );
    }

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { count: recent } = await service
      .from('credit_applications')
      .select('id', { count: 'exact', head: true })
      .gte('submitted_at', hourAgo);
    if ((recent ?? 0) >= GLOBAL_HOURLY_CEILING) {
      return NextResponse.json(
        { error: 'We are receiving a high volume of applications. Please try again later.' }, { status: 429 },
      );
    }

    const { data: inserted, error } = await service
      .from('credit_applications')
      .insert({
        ...form,
        status: 'pending',
        ip_address: ip === 'unknown' ? null : ip,
      })
      .select('id')
      .single();
    if (error || !inserted) {
      console.error('credit application insert failed:', error);
      return NextResponse.json({ error: 'Failed to submit. Please try again.' }, { status: 500 });
    }

    // Notify the roles that hold the credit_applications feature — resolved
    // server-side (the #684 pattern; notification_preferences RLS makes
    // browser-side recipient lists silently empty). No channels key: user
    // delivery preferences apply. Body carries the company name only —
    // never the EIN, bank fields, or volume (notifications are readable
    // beyond this table's own denylist).
    try {
      const REVIEWER_ROLES = ['finance', 'admin', 'super_admin'];
      const { data: staff } = await service
        .from('profiles')
        .select('id, role, roles, status, deactivated')
        .eq('status', 'approved');
      const reviewerIds = (staff || [])
        .filter((p: any) => {
          if (p.deactivated) return false;
          const roles = p.roles?.length ? p.roles : [p.role];
          return roles.some((r: string) => REVIEWER_ROLES.includes(r));
        })
        .map((p: any) => p.id);
      if (reviewerIds.length > 0) {
        await notifyMany(reviewerIds, {
          type: 'credit_app_submitted',
          title: `New credit application: ${form.company_name}`,
          body: `${form.contact_name} submitted a credit application for ${form.company_name}. Requested terms: ${form.requested_terms.replace('_', ' ')}.`,
          url: deepLinks.creditApplication(inserted.id),
        });
      }
    } catch (err) {
      console.error('credit_app_submitted notify failed:', err);
    }

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('credit application submit failed:', e);
    return NextResponse.json({ error: 'Failed to submit. Please try again.' }, { status: 500 });
  }
}
