import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { authenticateRequestsAgent, loadRequestDetail, REQUEST_SELECT } from '@/lib/app-requests-server';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * GET /api/requests/agent: Claude's scheduled Requests check (Bearer
 * REQUESTS_AGENT_TOKEN). Default ?scope=queue is every request waiting on
 * Claude (new, or a person replied), oldest first; ?scope=open is every
 * request not Done or Won't do. Each comes with its conversation, the
 * sender's name, email and roles, and screenshot links on
 * /api/requests/agent/files/[id] (same token).
 */
export async function GET(req: NextRequest) {
  const agent = authenticateRequestsAgent(req);
  if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });

  const scope = req.nextUrl.searchParams.get('scope') === 'open' ? 'open' : 'queue';
  let q = service.from('app_requests').select(REQUEST_SELECT);
  q = scope === 'queue' ? q.eq('needs_claude', true) : q.not('status', 'in', '(done,wont)');
  const { data, error } = await q.order('created_at').order('id').limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const requests = [];
  for (const row of data || []) {
    const detail = await loadRequestDetail(service, (row as any).id, {
      fileUrl: id => `/api/requests/agent/files/${id}`,
      withContact: true,
    });
    if (detail) requests.push(detail);
  }
  return NextResponse.json({
    scope,
    requests,
    app_url: process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com',
  });
}
