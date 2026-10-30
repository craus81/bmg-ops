import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole } from '@/lib/api-auth';
import { canSeeRequest } from '@/lib/app-requests';
import { isUuid } from '@/lib/app-requests-server';
import { requestFileResponse } from '@/lib/app-request-file-response';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/** GET /api/requests/files/[id]: one screenshot, for whoever can see its request. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const viewer = { id: auth.user!.id, staff: isInternalStaffRole(auth.profile) };

  const { data: file } = await service.from('app_request_files').select('request_id, storage_path, file_name, content_type').eq('id', params.id).maybeSingle();
  if (!file) return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
  const { data: request } = await service.from('app_requests').select('created_by').eq('id', file.request_id).maybeSingle();
  if (!request || !canSeeRequest(viewer, request)) return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });

  return requestFileResponse(file);
}
