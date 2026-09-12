import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isAdminRole, getProfileRoles } from '@/lib/api-auth';
import { resolveFeatures } from '@/lib/features';
import { cachedBadges, visibleQueues, ATTENTION_QUEUES } from '@/lib/attention-queues';
import type { FeatureKey } from '@/lib/features';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createServiceClient();

/**
 * GET /api/badges (R6-13) — every attention queue this caller can act on,
 * counted once, cached about a minute.
 *
 * requireAuth on purpose, with the real gate inside: the caller's own
 * features decide which queues are computed at all, so a customer login
 * gets an empty set rather than a 403 (they have no queues, which is a
 * true answer, not an error).
 *
 * A count that failed comes back as null and is named in `unknown`. It is
 * never 0: a badge is read as "nothing needs you", and rendering that from
 * a query that errored is a lie the user cannot detect.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  // Same resolution requireFeature performs, including the legacy
  // 'production' → 'graphics_production' normalisation: a badge set that
  // disagreed with the server's own gate would send people to pages that
  // then 403.
  const roles = getProfileRoles(auth.profile).map(r => (r === 'production' ? 'graphics_production' : r));
  const isAdmin = isAdminRole(roles);
  const { data: overrides } = await service
    .from('user_feature_overrides')
    .select('feature, granted')
    .eq('user_id', auth.user.id);
  const features = resolveFeatures(roles, overrides || []);
  const access = { isAdmin, hasFeature: (k: FeatureKey) => features.has(k) };

  try {
    const result = await cachedBadges(service, access);
    return NextResponse.json({
      ...result,
      // The queues themselves, so a client renders labels and links from
      // the same registry rather than keeping its own copy that drifts.
      queues: visibleQueues(access).map(q => ({ key: q.key, label: q.label, path: q.path })),
      registered: ATTENTION_QUEUES.length,
    });
  } catch (e: any) {
    console.error('badges failed:', e);
    return NextResponse.json({ error: 'Could not load badge counts.' }, { status: 500 });
  }
}
