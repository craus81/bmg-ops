import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PatchSchema = z.object({
  partId: z.string().uuid(),
  /** null clears the category. Omit to leave unchanged. */
  productCategoryId: z.string().uuid().optional().nullable(),
  /** R2 path (photos bucket) of an already-uploaded product photo. null clears. */
  imagePath: z.string().trim().max(1000).optional().nullable(),
});

const CategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

/**
 * PATCH /api/parts/categorize — stock the catalog shelf (roadmap N4-A):
 * assign a part's browse category and/or product photo. Both columns are
 * FleetSuite-owned, so the parts sync never undoes an assignment.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, PatchSchema);
  if (parsed.error) return parsed.error;
  const { partId, productCategoryId, imagePath } = parsed.data;

  const updates: Record<string, unknown> = {};
  if (productCategoryId !== undefined) updates.product_category_id = productCategoryId;
  if (imagePath !== undefined) updates.image_path = imagePath || null;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const { error } = await supabase.from('netsuite_parts').update(updates).eq('id', partId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

/** POST — add a category to the vocabulary (appends to the end of the rail). */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, CategorySchema);
  if (parsed.error) return parsed.error;

  const { data: maxRow } = await supabase
    .from('product_categories')
    .select('sort_order')
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from('product_categories')
    .insert({ name: parsed.data.name, sort_order: ((maxRow?.sort_order as number | undefined) ?? 0) + 10 })
    .select('id, name, sort_order')
    .single();
  if (error) {
    const status = error.code === '23505' ? 409 : 500;
    return NextResponse.json({ error: error.code === '23505' ? 'That category already exists' : error.message }, { status });
  }
  return NextResponse.json({ success: true, category: data });
}
