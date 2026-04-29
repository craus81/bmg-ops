import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * PATCH /api/install-checklists/[id] — update template (admin only)
 * DELETE /api/install-checklists/[id] — soft-delete by setting is_active=false
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const body = await req.json();
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  if (typeof body.name === 'string' && body.name.trim()) update.name = body.name.trim();
  if (body.install_category && ['upfit', 'graphics', 'mixed'].includes(body.install_category)) {
    update.install_category = body.install_category;
  }
  if (Array.isArray(body.items)) {
    update.items = body.items
      .filter((i: any) => i && typeof i.label === 'string' && i.label.trim())
      .map((i: any) => ({ label: i.label.trim(), required: i.required === true }));
  }
  if (typeof body.is_active === 'boolean') update.is_active = body.is_active;

  const { data, error } = await supabase
    .from('install_checklist_templates')
    .update(update)
    .eq('id', params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ template: data });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { error } = await supabase
    .from('install_checklist_templates')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
