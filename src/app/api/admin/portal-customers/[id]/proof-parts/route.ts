import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const adminSupabase = createSupabaseAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function assertAdmin() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('id', session.user.id)
    .maybeSingle();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  if (!roles.includes('admin') && !roles.includes('sales')) return null;
  return session.user.id;
}

// GET: list all proof parts for proofs assigned to this portal customer
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Get all proofs assigned to this customer, then their parts
  const { data: assignments } = await adminSupabase
    .from('customer_proof_assignments')
    .select('proof_id')
    .eq('portal_customer_id', params.id);

  const proofIds = (assignments || []).map((a: { proof_id: string }) => a.proof_id);
  if (!proofIds.length) return NextResponse.json([]);

  const { data, error } = await adminSupabase
    .from('proof_parts')
    .select('*')
    .in('proof_id', proofIds)
    .order('proof_id')
    .order('sort_order');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST: create a new proof part
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { proof_id, part_name, part_number, description, unit_price, sort_order } = body;

  if (!proof_id || !part_name) {
    return NextResponse.json({ error: 'proof_id and part_name are required' }, { status: 400 });
  }

  // Verify proof is assigned to this customer
  const { data: assignment } = await adminSupabase
    .from('customer_proof_assignments')
    .select('id')
    .eq('portal_customer_id', params.id)
    .eq('proof_id', proof_id)
    .maybeSingle();

  if (!assignment) {
    return NextResponse.json({ error: 'Proof not assigned to this customer' }, { status: 403 });
  }

  const { data, error } = await adminSupabase
    .from('proof_parts')
    .insert({
      proof_id,
      part_name,
      part_number: part_number || null,
      description: description || null,
      unit_price: unit_price ?? 0,
      sort_order: sort_order ?? 0,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

// PATCH: update a proof part
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const { part_id, ...updates } = body;
  if (!part_id) return NextResponse.json({ error: 'part_id required' }, { status: 400 });

  const allowed = ['part_name', 'part_number', 'description', 'unit_price', 'sort_order'];
  const safeUpdates: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in updates) safeUpdates[key] = updates[key];
  }

  const { data, error } = await adminSupabase
    .from('proof_parts')
    .update(safeUpdates)
    .eq('id', part_id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// DELETE: remove a proof part
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { part_id } = await req.json();
  if (!part_id) return NextResponse.json({ error: 'part_id required' }, { status: 400 });

  const { error } = await adminSupabase
    .from('proof_parts')
    .delete()
    .eq('id', part_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
