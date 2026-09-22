import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { reviewUrl } from '@/lib/review-request';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const Schema = z.object({
  // Empty string clears it, which switches the whole feature off — the
  // completion email then carries no review block at all.
  url: z.string().trim().max(500),
});

/**
 * GET/POST /api/admin/review-link (R6-13) — the company-wide Google review
 * URL that the completion email's "How did we do?" block points at.
 *
 * Admin: it changes what every customer receives after a job.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  return NextResponse.json({ url: await reviewUrl(service) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const url = parsed.data.url.trim();

  // Reject anything that is not an absolute http(s) URL rather than
  // storing it: a broken CTA in a customer's inbox is the failure mode.
  if (url && !/^https?:\/\/\S+$/i.test(url)) {
    return NextResponse.json({ error: 'Enter a full https:// link, or clear the field to switch review requests off.' }, { status: 400 });
  }

  const { error } = await service
    .from('app_settings')
    .upsert({ key: 'google_review', value: { url }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'app_settings',
    recordId: 'google_review',
    action: url ? 'review_link_set' : 'review_link_cleared',
    detail: { url: url || null },
  }).catch(() => undefined);

  return NextResponse.json({ success: true, url: url || null });
}
