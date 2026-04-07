import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** GET /api/prospects — list all prospects */
export async function GET() {
  const { data, error } = await supabase
    .from('prospects')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ prospects: data });
}

/** POST /api/prospects — create a new prospect */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { data, error } = await supabase
    .from('prospects')
    .insert({
      company_name: body.company_name,
      contact_name: body.contact_name || null,
      title: body.title || null,
      email: body.email || null,
      phone: body.phone || null,
      address: body.address || null,
      city: body.city || null,
      state: body.state || null,
      zip: body.zip || null,
      website: body.website || null,
      notes: body.notes || null,
      source: body.source || 'manual',
      created_by: body.created_by || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, prospect: data });
}

/** PUT /api/prospects — update a prospect */
export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, ...fields } = body;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { data, error } = await supabase
    .from('prospects')
    .update(fields)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, prospect: data });
}

/** DELETE /api/prospects — delete a prospect */
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await supabase.from('prospects').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
