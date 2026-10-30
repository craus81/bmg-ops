import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canSeeRequest, isClosed } from '@/lib/app-requests';
import { REQUEST_SELECT, alertRequestUpdate, isUuid, type RequestRow } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const Schema = z.object({ body: z.string().trim().min(1).max(10000) });

/**
 * POST /api/requests/[id]/messages: a person replies under a request (the
 * person who sent it adding detail, Craig, or anyone on staff). It goes back
 * in Claude's queue, and a closed request reopens as New.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const viewer = { id: auth.user!.id, staff: isInternalStaffRole(auth.profile) };
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const { data: found } = await service.from('app_requests').select(REQUEST_SELECT).eq('id', params.id).maybeSingle();
  const request = found as RequestRow | null;
  if (!request || !canSeeRequest(viewer, request)) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

  const { data: message, error } = await service.from('app_request_messages').insert({
    request_id: request.id, author_kind: 'person', author_id: viewer.id, body: parsed.data.body,
  }).select('id, author_kind, author_id, body, created_at').single();
  if (error || !message) return NextResponse.json({ error: error?.message || 'Could not save the reply' }, { status: 500 });

  const reopened = isClosed(request.status);
  const mine = request.created_by === viewer.id;
  const { data: updated } = await service.from('app_requests').update({
    needs_claude: true,
    updated_at: new Date().toISOString(),
    ...(reopened ? { status: 'new' } : {}),
    // Someone else answered the person who sent it: their row gets the dot.
    ...(!mine ? { submitter_unread: true } : {}),
  }).eq('id', request.id).select(REQUEST_SELECT).single();

  await alertRequestUpdate(service, {
    request: (updated as RequestRow) || request,
    authorName: auth.profile?.full_name || 'Someone',
    actorId: viewer.id,
    message: parsed.data.body,
    status: reopened ? 'new' : request.status,
    statusChanged: reopened,
  });

  return NextResponse.json({ message: { ...message, author_name: auth.profile?.full_name || 'You' }, status: reopened ? 'new' : request.status });
}
