import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { AGENT_STATUSES } from '@/lib/app-requests';
import { REQUEST_SELECT, alertRequestUpdate, authenticateRequestsAgent, isUuid, type RequestRow } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

const Schema = z.object({
  /** Claude's answer, shown under the request as "Claude". */
  reply: z.string().trim().min(1).max(20000).optional(),
  /** New / Looking into it / Waiting on Craig / Done. Never Won't do. */
  status: z.enum(AGENT_STATUSES as [string, ...string[]]).optional(),
  /** Leave it in the queue for the next check (default: taken out). */
  keep_in_queue: z.boolean().optional(),
  /** Change the status without alerting anyone (e.g. New → Looking into it). */
  quiet: z.boolean().optional(),
}).refine(b => b.reply || b.status || b.keep_in_queue !== undefined, { message: 'Send a reply, a status, or keep_in_queue' });

/**
 * POST /api/requests/agent/[id]: Claude answers a request and/or moves its
 * status, which takes it out of the queue until a person replies. The
 * person who sent it, the Me too people and Craig hear about a reply or a
 * Done (customer and installer accounts in the app only).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const agent = authenticateRequestsAgent(req);
  if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data: found } = await service.from('app_requests').select(REQUEST_SELECT).eq('id', params.id).maybeSingle();
  if (!found) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  const request = found as RequestRow;
  if (request.status === 'wont' && body.status) {
    return NextResponse.json({ error: "Craig closed this one as Won't do; only a reply from a person reopens it." }, { status: 409 });
  }

  let message = null;
  if (body.reply) {
    const { data, error } = await service.from('app_request_messages').insert({
      request_id: request.id, author_kind: 'claude', author_id: null, body: body.reply,
    }).select('id, author_kind, body, created_at').single();
    if (error || !data) return NextResponse.json({ error: error?.message || 'Could not save the reply' }, { status: 500 });
    message = data;
  }

  const status = (body.status as RequestRow['status'] | undefined) || request.status;
  const statusChanged = status !== request.status;
  const { data: updated, error: upErr } = await service.from('app_requests').update({
    status,
    needs_claude: body.keep_in_queue === true,
    ...(body.reply || statusChanged ? { updated_at: new Date().toISOString() } : {}),
    ...(body.reply ? { submitter_unread: true } : {}),
  }).eq('id', request.id).select(REQUEST_SELECT).single();
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const tell = !body.quiet && (!!body.reply || (statusChanged && (status === 'done' || status === 'waiting')));
  if (tell) {
    await alertRequestUpdate(service, {
      request: (updated as RequestRow) || request,
      authorName: 'Claude',
      actorId: null,
      message: body.reply || null,
      status,
      statusChanged,
    });
  }

  return NextResponse.json({ request: updated, message, alerted: tell });
}
