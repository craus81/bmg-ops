import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { notify } from '@/lib/notify';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** GET /api/upfit-projects/tasks?projectId=xxx — list tasks for a project */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const projectId = req.nextUrl.searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

  const { data, error } = await supabase
    .from('upfit_project_tasks')
    .select('*, assignee:assigned_to(id, full_name), creator:created_by(full_name)')
    .eq('project_id', projectId)
    .order('completed_at', { ascending: true, nullsFirst: true })
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tasks: data });
}

/** POST /api/upfit-projects/tasks — create a task */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  if (!body.project_id || !body.title) {
    return NextResponse.json({ error: 'project_id and title required' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('upfit_project_tasks')
    .insert({
      project_id: body.project_id,
      title: body.title,
      description: body.description || null,
      assigned_to: body.assigned_to || null,
      due_date: body.due_date || null,
      created_by: auth.user.id,
    })
    .select('*, assignee:assigned_to(id, full_name), creator:created_by(full_name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify assignee if set and not the creator
  if (data?.assigned_to && data.assigned_to !== auth.user.id) {
    const { data: project } = await supabase
      .from('upfit_projects')
      .select('project_name')
      .eq('id', body.project_id)
      .single();
    notify({
      userId: data.assigned_to,
      type: 'assignment',
      title: 'New upfit task',
      body: `${data.title}${project?.project_name ? ` — ${project.project_name}` : ''}`,
      url: `/upfit?id=${body.project_id}`,
    }).catch(err => console.warn('Task assignment notification error:', err));
  }

  await supabase
    .from('upfit_projects')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', body.project_id);

  return NextResponse.json({ success: true, task: data });
}

/** PATCH /api/upfit-projects/tasks — update a task (toggle complete, reassign, etc.) */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  const { id, ...fields } = body;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { data: existing } = await supabase
    .from('upfit_project_tasks')
    .select('assigned_to, completed_at, project_id, title')
    .eq('id', id)
    .single();
  if (!existing) return NextResponse.json({ error: 'task not found' }, { status: 404 });

  // Handle completion toggle via boolean `completed`
  if (typeof fields.completed === 'boolean') {
    if (fields.completed) {
      fields.completed_at = new Date().toISOString();
      fields.completed_by = auth.user.id;
    } else {
      fields.completed_at = null;
      fields.completed_by = null;
    }
    delete fields.completed;
  }

  fields.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('upfit_project_tasks')
    .update(fields)
    .eq('id', id)
    .select('*, assignee:assigned_to(id, full_name), creator:created_by(full_name)')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify new assignee if reassigned to someone different (and not self)
  if (
    fields.assigned_to &&
    fields.assigned_to !== existing.assigned_to &&
    fields.assigned_to !== auth.user.id
  ) {
    const { data: project } = await supabase
      .from('upfit_projects')
      .select('project_name')
      .eq('id', existing.project_id)
      .single();
    notify({
      userId: fields.assigned_to,
      type: 'assignment',
      title: 'Upfit task assigned',
      body: `${existing.title}${project?.project_name ? ` — ${project.project_name}` : ''}`,
      url: `/upfit?id=${existing.project_id}`,
    }).catch(err => console.warn('Task reassignment notification error:', err));
  }

  await supabase
    .from('upfit_projects')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', existing.project_id);

  return NextResponse.json({ success: true, task: data });
}

/** DELETE /api/upfit-projects/tasks — delete a task */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase
    .from('upfit_project_tasks')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
