import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** GET /api/upfit-projects — list all projects, optionally filtered by status */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const status = req.nextUrl.searchParams.get('status');

  let query = supabase
    .from('upfit_projects')
    .select('*, upfit_project_notes(id, note_type, content, created_by, created_at), upfit_project_tasks(id, completed_at)')
    .order('updated_at', { ascending: false });

  if (status && status !== 'all') {
    query = query.eq('status', status);
  }

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ projects: data });
}

/** POST /api/upfit-projects — create a new project */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();

  const { data, error } = await supabase
    .from('upfit_projects')
    .insert({
      project_name: body.project_name,
      status: body.status || 'opportunity',
      prospect_id: body.prospect_id || null,
      customer_name: body.customer_name || null,
      customer_netsuite_id: body.customer_netsuite_id || null,
      estimate_id: body.estimate_id || null,
      estimate_number: body.estimate_number || null,
      netsuite_so_id: body.netsuite_so_id || null,
      netsuite_so_number: body.netsuite_so_number || null,
      scheduled_date: body.scheduled_date || null,
      scheduled_end_date: body.scheduled_end_date || null,
      estimated_total: body.estimated_total || null,
      assigned_to: body.assigned_to || null,
      created_by: auth.user.id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Add an initial note
  if (data) {
    await supabase.from('upfit_project_notes').insert({
      project_id: data.id,
      note_type: 'note',
      content: 'Project created',
      created_by: auth.user.id,
    });
  }

  return NextResponse.json({ success: true, project: data });
}

/** PUT /api/upfit-projects — update a project */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  const { id, ...fields } = body;

  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  // If status is changing, log it as a note
  if (fields.status) {
    const { data: existing } = await supabase
      .from('upfit_projects')
      .select('status')
      .eq('id', id)
      .single();

    if (existing && existing.status !== fields.status) {
      await supabase.from('upfit_project_notes').insert({
        project_id: id,
        note_type: 'status_change',
        content: `Status changed from ${existing.status} to ${fields.status}`,
        created_by: auth.user.id,
      });
    }
  }

  fields.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('upfit_projects')
    .update(fields)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, project: data });
}

/** DELETE /api/upfit-projects — delete a project */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase
    .from('upfit_projects')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
