import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { financeUserIds } from '@/lib/ap';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Resend signs webhooks with the Svix scheme: HMAC-SHA256 over
// "{svix-id}.{svix-timestamp}.{raw body}" using the base64 secret after the
// "whsec_" prefix; the svix-signature header carries space-separated
// "v1,<base64sig>" entries. Verified manually — no extra dependency.
function verifySvixSignature(req: NextRequest, rawBody: string): { ok: boolean; reason?: string } {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'RESEND_WEBHOOK_SECRET not configured' };

  const msgId = req.headers.get('svix-id');
  const timestamp = req.headers.get('svix-timestamp');
  const signatures = req.headers.get('svix-signature');
  if (!msgId || !timestamp || !signatures) return { ok: false, reason: 'missing svix headers' };

  // Reject stale/future timestamps (replay protection, ±5 minutes).
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(`${msgId}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');
  const expectedBuf = Buffer.from(expected);

  for (const part of signatures.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}

// Later events must never be overwritten by earlier ones arriving out of
// order — a bounce outranks a delivery which outranks the initial send.
const STATUS_RANK: Record<string, number> = {
  sent: 0,
  delivery_delayed: 1,
  delivered: 2,
  complained: 3,
  failed: 3,
  bounced: 3,
};

const EVENT_TO_STATUS: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
};

/**
 * POST /api/webhooks/resend — delivery events from Resend (configure the
 * endpoint in the Resend dashboard with email.* events enabled). Updates
 * invoice_emails rows by Resend message id; a bounce/failure pushes an
 * alert to finance so a dead invoice email surfaces today, not at 60-day
 * AR review. Events for non-invoice emails match zero rows and are
 * acknowledged silently.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const verified = verifySvixSignature(req, rawBody);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason || 'Unauthorized' }, { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const status = EVENT_TO_STATUS[event?.type];
  const emailId: string | undefined = event?.data?.email_id;
  if (!status || !emailId) {
    // Unknown event type or shape — acknowledge so Resend doesn't retry.
    return NextResponse.json({ received: true, ignored: true });
  }

  try {
    const { data: rows } = await service
      .from('invoice_emails')
      .select('id, invoice_number, customer_name, recipients, delivery_status')
      .eq('source_id', emailId);
    if (!rows || rows.length === 0) return NextResponse.json({ received: true, matched: 0 });

    const detail = [
      event?.data?.bounce?.type || event?.data?.bounce?.subType || null,
      event?.data?.bounce?.message || event?.data?.failed?.reason || null,
    ].filter(Boolean).join(': ') || null;

    const toUpdate = rows.filter(r => (STATUS_RANK[status] ?? 0) >= (STATUS_RANK[r.delivery_status] ?? 0));
    if (toUpdate.length > 0) {
      await service
        .from('invoice_emails')
        .update({
          delivery_status: status,
          delivery_detail: detail,
          delivery_updated_at: new Date().toISOString(),
        })
        .in('id', toUpdate.map(r => r.id));
    }

    // A bounced/failed invoice email is an AR problem RIGHT NOW — tell
    // finance while the send is fresh, once per transition into a bad state.
    if (['bounced', 'failed', 'complained'].includes(status)) {
      const fresh = toUpdate.filter(r => !['bounced', 'failed', 'complained'].includes(r.delivery_status));
      if (fresh.length > 0) {
        const recipients = await financeUserIds(service);
        if (recipients.length > 0) {
          const first = fresh[0];
          const invoiceList = [...new Set(fresh.map(r => r.invoice_number))].join(', ');
          await notifyMany(recipients, {
            type: 'invoice_email_bounced',
            title: `⚠ Invoice email ${status}: ${invoiceList}`,
            body: `The invoice email to ${(first.recipients || []).join(', ') || 'the customer'}${first.customer_name ? ` (${first.customer_name})` : ''} ${status === 'complained' ? 'was marked as spam' : status}. ${detail ? `Reason: ${detail}. ` : ''}Resend it from the Invoices page.`,
            // Sent tab, prefiltered to the first bounced invoice (the body
            // lists the rest when one event covers several).
            url: deepLinks.invoicesSent(first.invoice_number),
            channels: ['in_app', 'push'],
            forceChannels: true,
          });
        }
      }
    }

    return NextResponse.json({ received: true, matched: rows.length, updated: toUpdate.length });
  } catch (e: any) {
    console.error('Resend webhook processing failed:', e);
    return NextResponse.json({ error: e.message || 'processing failed' }, { status: 500 });
  }
}
