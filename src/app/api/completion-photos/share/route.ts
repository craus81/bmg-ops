import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { isCompletionPhotoId } from '@/lib/completion-photos';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  ids: z.array(z.string()).min(1).max(200),
  /** Heading on the customer's page, e.g. the customer's name. */
  title: z.string().trim().max(120).optional(),
});

/**
 * POST /api/completion-photos/share — one link to the picked photos.
 *
 * Returns a public page URL (/shared-photos/<token>) that a customer can
 * open without a FleetSuite login to view and download exactly these
 * photos. The token is the credential, like an estimate approval link;
 * the ids are pinned at share time so later photos never appear on it.
 * Staff paste the link into their own email or text: nothing is sent
 * from here.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const ids = [...new Set(parsed.data.ids)];
  if (!ids.every(isCompletionPhotoId)) {
    return NextResponse.json({ error: 'Unknown photo' }, { status: 400 });
  }

  // Only photos that exist (and that the view still shows) go on the link.
  const { data: found, error: readErr } = await supabase
    .from('completion_photos')
    .select('id')
    .in('id', ids);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  const known = new Set((found || []).map((r: any) => r.id));
  const keep = ids.filter(id => known.has(id));
  if (keep.length === 0) return NextResponse.json({ error: 'None of those photos exist any more' }, { status: 404 });

  const token = randomBytes(24).toString('base64url');
  const { error } = await supabase.from('photo_shares').insert({
    token,
    photo_ids: keep,
    title: parsed.data.title || null,
    created_by: auth.user.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    success: true,
    url: `${(process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com').replace(/\/$/, '')}${deepLinks.sharedPhotos(token)}`,
    count: keep.length,
  });
}
