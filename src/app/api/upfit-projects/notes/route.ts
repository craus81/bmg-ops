import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** GET /api/upfit-projects/notes?projectId=xxx — list notes for a project */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

  const { data, error } = await supabase
    .from('upfit_project_notes')
    .select('*, profiles:created_by(full_name)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notes: data });
}

/** POST /api/upfit-projects/notes — add a note */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  if (!body.project_id || !body.content) {
    return NextResponse.json({ error: 'project_id and content required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('upfit_project_notes')
    .insert({
      project_id: body.project_id,
      note_type: body.note_type || 'note',
      content: body.content,
      created_by: auth.user.id,
    })
    .select('*, profiles:created_by(full_name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Touch the project's updated_at
  await supabase
    .from('upfit_projects')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', body.project_id);

  return NextResponse.json({ success: true, note: data });
}

/** DELETE /api/upfit-projects/notes — delete a note */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase
    .from('upfit_project_notes')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
