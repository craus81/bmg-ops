import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireRole, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { draftTarget, TARGET_COLS, OPEN_STATUSES } from '@/lib/outreach-send';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Write or rewrite one Outreach email draft (migration 439). Saves the
 * draft only; sending is the rep's, from the compose screen.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;
  const { data: t } = await service.from('outreach_targets').select(TARGET_COLS).eq('id', params.id).maybeSingle();
  if (!t) return NextResponse.json({ error: 'That company is no longer on the list.' }, { status: 404 });
  if ((t as any).rep_id !== auth.user.id && !isAdminRole(getProfileRoles(auth.profile))) {
    return NextResponse.json({ error: 'That company is on another rep\'s list.' }, { status: 403 });
  }
  if (!OPEN_STATUSES.includes((t as any).status)) {
    return NextResponse.json({ error: 'This one has already been emailed.' }, { status: 409 });
  }
  const result = await draftTarget(service, t);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ success: true, target: result.row });
}
