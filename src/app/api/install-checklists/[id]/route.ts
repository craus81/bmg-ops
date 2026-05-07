import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const PatchSchema = z.object({
  name: z.string().trim().max(200).optional(),
  install_category: z.enum(['upfit', 'graphics', 'mixed']).optional(),
  items: z
    .array(
      z.object({
        label: z.string().trim().max(300),
        required: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
  is_active: z.boolean().optional(),
});

/**
 * PATCH /api/install-checklists/[id] — update template (admin only)
 * DELETE /api/install-checklists/[id] — soft-delete by setting is_active=false
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const update: Record<string, any> = { updated_at: new Date().toISOString() };
  if (body.name && body.name.trim()) update.name = body.name.trim();
  if (body.install_category) update.install_category = body.install_category;
  if (body.items) {
    update.items = body.items.map((i) => ({ label: i.label.trim(), required: i.required === true }));
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
