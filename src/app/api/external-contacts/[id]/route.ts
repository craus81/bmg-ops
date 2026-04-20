import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  const assignable = ['customer_id', 'name', 'phone', 'email', 'title', 'is_primary', 'channel_pref', 'notes', 'is_unknown'];
  for (const k of assignable) {
    if (k in body) (update as any)[k] = body[k];
  }

  // If promoting to primary, demote siblings first
  if (update.is_primary === true && (update.customer_id || body.customerId)) {
    const cid = update.customer_id || body.customerId;
    await supabase
      .from('external_contacts')
      .update({ is_primary: false })
      .eq('customer_id', cid)
      .neq('id', params.id);
  }

  const { data, error } = await supabase
    .from('external_contacts')
    .update(update)
    .eq('id', params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ contact: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { error } = await supabase.from('external_contacts').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
