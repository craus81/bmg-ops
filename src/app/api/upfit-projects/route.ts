import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { syncShopInboundForUpfitProject } from '@/lib/shop-inbound';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ProjectFields = {
  project_name: z.string().trim().max(200),
  status: z.string().max(40).optional(),
  prospect_id: z.string().uuid().optional().nullable(),
  customer_name: z.string().max(200).optional().nullable(),
  customer_netsuite_id: z.string().max(40).optional().nullable(),
  estimate_id: z.string().uuid().optional().nullable(),
  estimate_number: z.string().max(60).optional().nullable(),
  netsuite_so_id: z.string().max(40).optional().nullable(),
  netsuite_so_number: z.string().max(60).optional().nullable(),
  scheduled_date: z.string().max(40).optional().nullable(),
  scheduled_end_date: z.string().max(40).optional().nullable(),
  parts_ordered_date: z.string().max(40).optional().nullable(),
  parts_eta: z.string().max(40).optional().nullable(),
  customer_dropoff_date: z.string().max(40).optional().nullable(),
  need_back_date: z.string().max(40).optional().nullable(),
  estimated_total: z.number().optional().nullable(),
  assigned_to: z.string().uuid().optional().nullable(),
} as const;

const CreateSchema = z.object(ProjectFields);
const UpdateSchema = z
  .object({
    id: z.string().uuid(),
    project_name: ProjectFields.project_name.optional(),
    status: ProjectFields.status,
    prospect_id: ProjectFields.prospect_id,
    customer_name: ProjectFields.customer_name,
    customer_netsuite_id: ProjectFields.customer_netsuite_id,
    estimate_id: ProjectFields.estimate_id,
    estimate_number: ProjectFields.estimate_number,
    netsuite_so_id: ProjectFields.netsuite_so_id,
    netsuite_so_number: ProjectFields.netsuite_so_number,
    scheduled_date: ProjectFields.scheduled_date,
    scheduled_end_date: ProjectFields.scheduled_end_date,
    parts_ordered_date: ProjectFields.parts_ordered_date,
    parts_eta: ProjectFields.parts_eta,
    customer_dropoff_date: ProjectFields.customer_dropoff_date,
    need_back_date: ProjectFields.need_back_date,
    estimated_total: ProjectFields.estimated_total,
    assigned_to: ProjectFields.assigned_to,
  })
  .passthrough();
const DeleteSchema = z.object({ id: z.string().uuid() });

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

  const parsed = await validateBody(req, CreateSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

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

  const parsed = await validateBody(req, UpdateSchema);
  if (parsed.error) return parsed.error;
  const { id, ...fields } = parsed.data as { id: string; [k: string]: any };

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

  // Keep the shop arrival schedule in step with drop-off dates / status.
  try { await syncShopInboundForUpfitProject(supabase, id); } catch { /* best-effort */ }

  return NextResponse.json({ success: true, project: data });
}

/** DELETE /api/upfit-projects — delete a project */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DeleteSchema);
  if (parsed.error) return parsed.error;
  const { id } = parsed.data;

  const { error } = await supabase
    .from('upfit_projects')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
