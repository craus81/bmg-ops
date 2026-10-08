import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NoteSchema = z.object({ body: z.string().trim().min(1).max(5000) });

/**
 * POST /api/pricing-requests/[id]/notes: add an internal note to a pricing
 * request (migration 352). Staff only; never shown to the customer.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  if (!UUID_RE.test(params.id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const parsed = await validateBody(req, NoteSchema);
  if (parsed.error) return parsed.error;

  const { data: request } = await service.from('pricing_requests').select('id').eq('id', params.id).maybeSingle();
  if (!request) return NextResponse.json({ error: 'Pricing request not found' }, { status: 404 });

  const { data, error } = await service.from('pricing_request_notes').insert({
    pricing_request_id: params.id,
    body: parsed.data.body,
    author_id: auth.user?.id || null,
  }).select('id, body, created_at').single();
  if (error || !data) return NextResponse.json({ error: error?.message || 'Could not save the note' }, { status: 500 });

  await service.from('pricing_requests').update({ updated_at: new Date().toISOString() }).eq('id', params.id);
  return NextResponse.json({ note: { ...data, author_name: auth.profile?.full_name || null } });
}
