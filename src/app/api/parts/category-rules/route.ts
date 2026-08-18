import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { MATCH_FIELDS, MATCH_TYPES, MAX_PATTERN_LENGTH, patternError } from '@/lib/part-category-rules';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Part category tagging rules (migration 209) — CRUD. The sweep that
 * applies them lives at ./apply. Admin-only; the table is RLS-locked to
 * the service role.
 */

const RULE_FIELDS =
  'id, name, vendor, match_type, pattern, match_fields, category_id, priority, active, last_run_at, last_matched_count, created_at';

const SaveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().max(120).optional().nullable(),
  vendor: z.string().trim().max(200).optional().nullable(),
  matchType: z.enum(MATCH_TYPES),
  pattern: z.string().trim().min(1).max(MAX_PATTERN_LENGTH),
  matchFields: z.array(z.enum(MATCH_FIELDS)).min(1).max(MATCH_FIELDS.length),
  categoryId: z.string().uuid(),
  priority: z.coerce.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

/** GET — rules plus the two vocabularies the editor needs (categories,
 *  vendors), so the admin page loads in one round trip. */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const [{ data: rules, error }, { data: categories }] = await Promise.all([
    supabase.from('part_category_rules').select(RULE_FIELDS).order('priority').order('created_at'),
    supabase.from('product_categories').select('id, name, sort_order').eq('active', true).order('sort_order').order('name'),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Distinct vendors via a capped paged walk (netsuite_parts is unbounded
  // per CLAUDE.md, but the distinct vendor set is small).
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

  return NextResponse.json({
    rules: rules || [],
    categories: categories || [],
    vendors: [...seen].sort((a, b) => a.localeCompare(b)),
  });
}

/** POST — create a rule, or update one when `id` is given. */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, SaveSchema);
  if (parsed.error) return parsed.error;
  const b = parsed.data;

  // A pattern that can't compile would silently match nothing, so reject it
  // here rather than letting it sit in the list looking functional.
  const patErr = patternError(b.matchType, b.pattern);
  if (patErr) return NextResponse.json({ error: patErr }, { status: 400 });

  const row = {
    name: b.name?.trim() || null,
    vendor: b.vendor?.trim() || null,
    match_type: b.matchType,
    pattern: b.pattern,
    match_fields: b.matchFields,
    category_id: b.categoryId,
    priority: b.priority ?? 100,
    active: b.active ?? true,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = b.id
    ? await supabase.from('part_category_rules').update(row).eq('id', b.id).select(RULE_FIELDS).single()
    : await supabase.from('part_category_rules').insert(row).select(RULE_FIELDS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rule: data });
}

/**
 * DELETE — drop a rule and release the parts it owned in the same breath.
 * The FK is ON DELETE SET NULL, so without this the parts would keep the
 * category with no rule behind it until someone re-ran the sweep.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, z.object({ id: z.string().uuid() }));
  if (parsed.error) return parsed.error;

  const { count: released, error: relErr } = await supabase
    .from('netsuite_parts')
    .update({ product_category_id: null, category_source: null, category_rule_id: null }, { count: 'exact' })
    .eq('category_rule_id', parsed.data.id);
  if (relErr) return NextResponse.json({ error: relErr.message }, { status: 500 });

  const { error } = await supabase.from('part_category_rules').delete().eq('id', parsed.data.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, released: released ?? 0 });
}
