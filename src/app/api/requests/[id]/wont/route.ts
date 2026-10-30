import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { REQUEST_SELECT, alertRequestUpdate, isRequestsOwner, isUuid, type RequestRow } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const Schema = z.object({ reason: z.string().trim().min(1).max(5000) });

/**
 * POST /api/requests/[id]/wont: close a request as Won't do, with the
 * reason the person sees. Craig's alone ("just me", 2026-10-30). A reply
 * from the person afterwards reopens it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  if (!(await isRequestsOwner(service, auth.profile))) {
    return NextResponse.json({ error: "Only Craig can mark a request Won't do." }, { status: 403 });
  }
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const { data: found } = await service.from('app_requests').select(REQUEST_SELECT).eq('id', params.id).maybeSingle();
  if (!found) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  const request = found as RequestRow;

  const text = `Won't do: ${parsed.data.reason}`;
  const { data: message, error } = await service.from('app_request_messages').insert({
    request_id: request.id, author_kind: 'person', author_id: auth.user!.id, body: text,
  }).select('id, author_kind, author_id, body, created_at').single();
  if (error || !message) return NextResponse.json({ error: error?.message || 'Could not save the reason' }, { status: 500 });

  const { data: updated } = await service.from('app_requests').update({
    status: 'wont',
    needs_claude: false,
    submitter_unread: request.created_by !== auth.user!.id,
    updated_at: new Date().toISOString(),
  }).eq('id', request.id).select(REQUEST_SELECT).single();

  await alertRequestUpdate(service, {
    request: (updated as RequestRow) || request,
    authorName: auth.profile?.full_name || 'Craig',
    actorId: auth.user!.id,
    message: text,
    status: 'wont',
    statusChanged: true,
  });

  return NextResponse.json({ message: { ...message, author_name: auth.profile?.full_name || 'You' }, status: 'wont' });
}
