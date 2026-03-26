import { NextRequest, NextResponse } from 'next/server';
import { createClient as createSupabaseAdmin } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const adminSupabase = createSupabaseAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Public endpoint: returns safe branding info for a portal customer by slug.
// Used by the login page to show the customer's logo and colors before auth.
export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const { data, error } = await adminSupabase
    .from('portal_customers')
    .select('id, company_name, slug, logo_url, primary_color')
    .eq('slug', params.slug)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Portal not found' }, { status: 404 });

  return NextResponse.json(data);
}
