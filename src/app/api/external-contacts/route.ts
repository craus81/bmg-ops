import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/external-contacts?customerId=...&q=...
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const url = new URL(req.url);
  const customerId = url.searchParams.get('customerId');
  const q = url.searchParams.get('q');

  let query = supabase
    .from('external_contacts')
    .select('*')
    .order('is_primary', { ascending: false })
    .order('name', { ascending: true })
    .limit(200);
  if (customerId) query = query.eq('customer_id', customerId);
  if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ contacts: data || [] });
}

/**
 * POST /api/external-contacts
 * Body: { customerId?, name, phone?, email?, title?, is_primary?, channel_pref?, notes? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  if (!body.name && !body.phone && !body.email) {
    return NextResponse.json({ error: 'name, phone, or email required' }, { status: 400 });
  }

  // If this contact is being marked as primary for a customer, clear
  // any existing primary flag for that customer first.
  if (body.is_primary && body.customerId) {
    await supabase
      .from('external_contacts')
      .update({ is_primary: false })
      .eq('customer_id', body.customerId);
  }

  const insert = {
    customer_id: body.customerId || null,
    name: body.name || null,
    phone: body.phone || null,
    email: body.email || null,
    title: body.title || null,
    is_primary: body.is_primary === true,
    channel_pref: body.channel_pref || null,
    notes: body.notes || null,
    is_unknown: false,
    created_by: auth.user.id,
  };

  const { data, error } = await supabase.from('external_contacts').insert(insert).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ contact: data });
}
