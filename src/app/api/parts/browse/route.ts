import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PAGE_SIZE = 48;

const Schema = z.object({
  q: z.string().trim().max(120).optional(),
  categoryId: z.string().uuid().optional(),
  uncategorized: z.enum(['1']).optional(),
  vendor: z.string().trim().max(200).optional(),
  catalog: z.enum(['upfit', 'graphics']).optional(),
  sort: z.enum(['name', 'price_asc', 'price_desc']).optional(),
  page: z.coerce.number().int().min(0).max(500).optional(),
});

/**
 * GET /api/parts/browse — the faceted catalog browser behind the
 * Ranger-style estimate flow (roadmap N4 phase A). Paginated at the
 * database per CLAUDE.md — netsuite_parts is unbounded, so the browser
 * never loads the whole catalog. Also returns the facet option lists
 * (categories with counts, vendors) so the rail reflects live data.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = validateSearchParams(req, Schema);
  if (parsed.error) return parsed.error;
  const { q, categoryId, uncategorized, vendor, catalog, sort, page } = parsed.data;

  try {
    let query = supabase
      .from('netsuite_parts')
      .select('id, netsuite_id, item_number, display_name, description, marketing_description, catalog, item_type, vendor, sales_price, purchase_price, avg_install_cost, labor_hours, quantity_available, product_category_id, image_path', { count: 'exact' })
      .eq('is_active', true);

    if (q) {
      const s = q.replace(/[%_,()]/g, ' ').trim();
      if (s) query = query.or(`item_number.ilike.%${s}%,display_name.ilike.%${s}%,description.ilike.%${s}%`);
    }
    if (categoryId) query = query.eq('product_category_id', categoryId);
    else if (uncategorized) query = query.is('product_category_id', null);
    if (vendor) query = query.eq('vendor', vendor);
    if (catalog) query = query.eq('catalog', catalog);

    // Deterministic order with a unique tiebreaker per CLAUDE.md.
    if (sort === 'price_asc') query = query.order('sales_price', { ascending: true, nullsFirst: false }).order('id');
    else if (sort === 'price_desc') query = query.order('sales_price', { ascending: false, nullsFirst: false }).order('id');
    else query = query.order('item_number').order('id');

    const from = (page || 0) * PAGE_SIZE;
    const { data: parts, count, error } = await query.range(from, from + PAGE_SIZE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Facet rails, built only on the first page (the modal keeps them for
    // the session): active categories in admin-set order, and the distinct
    // vendor list via a capped paged walk — the distinct set is small even
    // though the table isn't.
    let categories: { id: string; name: string; sort_order: number }[] | null = null;
    let vendors: string[] | null = null;
    if (!page) {
      const { data: cats } = await supabase
        .from('product_categories')
        .select('id, name, sort_order')
        .eq('active', true)
        .order('sort_order')
        .order('name');
      categories = cats || [];

      const seen = new Set<string>();
      for (let offset = 0; offset < 20_000; offset += 1000) {
        const { data: rows } = await supabase
          .from('netsuite_parts')
          .select('vendor')
          .eq('is_active', true)
          .not('vendor', 'is', null)
          .order('id')
          .range(offset, offset + 999);
        for (const r of rows || []) if (r.vendor) seen.add(r.vendor);
        if (!rows || rows.length < 1000) break;
      }
      vendors = [...seen].sort((a, b) => a.localeCompare(b));
    }

    return NextResponse.json({
      parts: parts || [],
      total: count ?? 0,
      page: page || 0,
      pageSize: PAGE_SIZE,
      ...(categories ? { categories } : {}),
      ...(vendors ? { vendors } : {}),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Browse failed' }, { status: 500 });
  }
}
