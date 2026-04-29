import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, requireAdmin } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/install-checklists — list all templates (readable by any staff)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
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

  const body = await req.json();
  const { name, install_category, items, is_active } = body || {};
  if (!name || !install_category || !Array.isArray(items)) {
    return NextResponse.json({ error: 'name, install_category, and items[] required' }, { status: 400 });
  }
  if (!['upfit', 'graphics', 'mixed'].includes(install_category)) {
    return NextResponse.json({ error: 'install_category must be upfit|graphics|mixed' }, { status: 400 });
  }

  const cleaned = items
    .filter((i: any) => i && typeof i.label === 'string' && i.label.trim())
    .map((i: any) => ({ label: i.label.trim(), required: i.required === true }));

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
