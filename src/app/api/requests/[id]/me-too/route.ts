import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canSeeRequest } from '@/lib/app-requests';
import { isUuid } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const Schema = z.object({ on: z.boolean() });

/**
 * POST /api/requests/[id]/me-too: back up someone else's request instead of
 * sending the same thing again ({ on: true }), or take it back. Backers
 * hear when it's answered.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const viewer = { id: auth.user!.id, staff: isInternalStaffRole(auth.profile) };
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const { data: request } = await service.from('app_requests').select('id, created_by').eq('id', params.id).maybeSingle();
  if (!request || !canSeeRequest(viewer, request)) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  if (request.created_by === viewer.id) return NextResponse.json({ error: 'This is your own request.' }, { status: 400 });

  const { error } = parsed.data.on
    ? await service.from('app_request_me_too').upsert({ request_id: params.id, user_id: viewer.id }, { onConflict: 'request_id,user_id', ignoreDuplicates: true })
    : await service.from('app_request_me_too').delete().eq('request_id', params.id).eq('user_id', viewer.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: rows } = await service.from('app_request_me_too').select('user_id').eq('request_id', params.id);
  return NextResponse.json({ on: parsed.data.on, count: (rows || []).length });
}
