import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PatchSchema = z.object({
  customer_id: z.string().uuid().optional().nullable(),
  customerId: z.string().uuid().optional().nullable(),
  name: z.string().trim().max(120).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  email: z.string().email().max(254).optional().nullable(),
  title: z.string().max(120).optional().nullable(),
  is_primary: z.boolean().optional(),
  // Matches the DB CHECK (078): 'both'/'none' were accepted here but always
  // failed the constraint with a 500.
  channel_pref: z.enum(['email', 'sms', 'phone']).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  is_unknown: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  const assignable = ['customer_id', 'name', 'phone', 'email', 'title', 'is_primary', 'channel_pref', 'notes', 'is_unknown'] as const;
  for (const k of assignable) {
    if (k in body) (update as any)[k] = (body as any)[k];
  }

  // If promoting to primary, demote siblings first. The customer id comes
  // from the body when provided, otherwise from the row itself — a bare
  // {is_primary: true} PATCH used to skip demotion and leave two primaries,
  // which every .eq('is_primary', true).maybeSingle() consumer then threw on.
  if (update.is_primary === true) {
    let cid = update.customer_id || body.customerId || null;
    if (!cid) {
      const { data: row } = await supabase
        .from('external_contacts')
        .select('customer_id')
        .eq('id', params.id)
        .maybeSingle();
      cid = row?.customer_id || null;
    }
    if (cid) {
      await supabase
        .from('external_contacts')
        .update({ is_primary: false })
        .eq('customer_id', cid)
        .neq('id', params.id);
    }
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
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { error } = await supabase.from('external_contacts').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
