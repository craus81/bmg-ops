import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const TemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  install_category: z.enum(['upfit', 'graphics', 'mixed']),
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(300),
        required: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(200),
  is_active: z.boolean().optional(),
});

/**
 * GET /api/install-checklists — list all templates (readable by any staff)
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const { data, error } = await supabase
    .from('install_checklist_templates')
    .select('*')
    .order('install_category')
    .order('created_at');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ templates: data || [] });
}

/**
 * POST /api/install-checklists — create a new template (admin only)
 * Body: { name, install_category, items: [{label, required}], is_active? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, TemplateSchema);
  if (parsed.error) return parsed.error;
  const { name, install_category, items, is_active } = parsed.data;

  const cleaned = items.map((i) => ({ label: i.label.trim(), required: i.required === true }));

  const { data, error } = await supabase
    .from('install_checklist_templates')
    .insert({
      name: name.trim(),
      install_category,
      items: cleaned,
      is_active: is_active !== false,
      created_by: auth.user.id,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ template: data });
}
