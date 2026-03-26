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

// GET: list assigned proofs + their parts for a portal customer
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await adminSupabase
    .from('customer_proof_assignments')
    .select(`
      id,
      proof_id,
      created_at,
      proof:graphics_proofs (
        id, customer_name, vehicle_type, file_name, storage_path, thumbnail_path, created_at
      )
    `)
    .eq('portal_customer_id', params.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST: assign a proof to a portal customer
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { proof_id } = await req.json();
  if (!proof_id) return NextResponse.json({ error: 'proof_id required' }, { status: 400 });

  const { data, error } = await adminSupabase
    .from('customer_proof_assignments')
    .insert({ portal_customer_id: params.id, proof_id })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'This proof is already assigned to this customer' }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data, { status: 201 });
}

// DELETE: remove a proof assignment (pass assignmentId in body)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const uid = await assertAdmin();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { assignment_id } = await req.json();
  if (!assignment_id) return NextResponse.json({ error: 'assignment_id required' }, { status: 400 });

  const { error } = await adminSupabase
    .from('customer_proof_assignments')
    .delete()
    .eq('id', assignment_id)
    .eq('portal_customer_id', params.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
