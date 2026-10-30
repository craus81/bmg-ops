import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole } from '@/lib/api-auth';
import { canSeeRequest } from '@/lib/app-requests';
import { isRequestsOwner, isUuid, loadRequestDetail } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * GET /api/requests/[id]: one request with its conversation, screenshots
 * and Me too list. Opening your own request clears its red dot.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const viewer = { id: auth.user!.id, staff: isInternalStaffRole(auth.profile) };

  const detail = await loadRequestDetail(service, params.id, { fileUrl: id => `/api/requests/files/${id}` });
  if (!detail || !canSeeRequest(viewer, detail.request)) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

  if (detail.request.created_by === viewer.id && detail.request.submitter_unread) {
    await service.from('app_requests').update({ submitter_unread: false }).eq('id', params.id);
    detail.request.submitter_unread = false;
  }

  return NextResponse.json({
    ...detail,
    staff: viewer.staff,
    mine: detail.request.created_by === viewer.id,
    i_me_too: detail.me_too.some(m => m.user_id === viewer.id),
    can_wont: await isRequestsOwner(service, auth.profile),
  });
}
