import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { authenticateRequestsAgent, isUuid } from '@/lib/app-requests-server';
import { requestFileResponse } from '@/lib/app-request-file-response';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/** GET /api/requests/agent/files/[id]: one screenshot, for Claude's scheduled check. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const agent = authenticateRequestsAgent(req);
  if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });
  if (!isUuid(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const { data: file } = await service.from('app_request_files').select('storage_path, file_name, content_type').eq('id', params.id).maybeSingle();
  if (!file) return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
  return requestFileResponse(file);
}
