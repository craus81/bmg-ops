import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAuth, isInternalStaffRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { REQUEST_KINDS } from '@/lib/app-requests';
import { REQUEST_SELECT, alertNewRequest, listRequests, type RequestRow } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * GET /api/requests: the Requests list (migration 453), most recently
 * active first. Staff see every request; customer and installer accounts
 * only their own.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const viewer = { id: auth.user!.id, staff: isInternalStaffRole(auth.profile) };
  try {
    return NextResponse.json({ requests: await listRequests(service, viewer), staff: viewer.staff });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Could not load requests' }, { status: 500 });
  }
}

const CreateSchema = z.object({
  kind: z.enum(REQUEST_KINDS as [string, ...string[]]),
  body: z.string().trim().min(1).max(10000),
  from_page: z.string().trim().max(300).nullable().optional(),
  device: z.string().trim().max(120).nullable().optional(),
});

/**
 * POST /api/requests: send a request. Any approved login. Screenshots
 * follow through /api/requests/[id]/files, a moment behind the alert.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, CreateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data, error } = await service.from('app_requests').insert({
    kind: body.kind,
    body: body.body,
    from_page: body.from_page || null,
    device: body.device || null,
    created_by: auth.user!.id,
  }).select(REQUEST_SELECT).single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Could not save the request' }, { status: 500 });

  await alertNewRequest(service, data as RequestRow, auth.profile?.full_name || null);
  return NextResponse.json({ request: data });
}
