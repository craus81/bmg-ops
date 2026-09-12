import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { stripFrontmatter, type HelpDoc } from '@/lib/help-center';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * The Help Center library (R6-13, audit line 431).
 *
 * Served on the SERVICE role and filtered to category 'help' — never
 * anything else in knowledge_docs. That table's own RLS is admin / sales /
 * production, which is right for the pricing guides and SOPs in it and
 * wrong for the app's own documentation: the guide written for shop techs
 * was unreadable by shop techs. requireStaff is the gate; the category
 * filter is the wall, and it is applied here rather than trusted from a
 * query param.
 *
 * ?index=1 returns titles and slugs only, for the "?" affordance deciding
 * whether it has anywhere to point.
 */

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const indexOnly = req.nextUrl.searchParams.get('index') === '1';
  const columns = indexOnly
    ? 'id, title, tags, source_path'
    : 'id, title, tags, source_path, content, updated_at';

  const { data, error } = await fetchAllRows<any>((from, to) =>
    service
      .from('knowledge_docs')
      .select(columns)
      .eq('category', 'help')
      .order('title')
      .order('id')
      .range(from, to));

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data || [];
  const docs: HelpDoc[] = rows.map(r => ({
    id: r.id,
    // Pre-312 rows have no source_path. They still render; they just can't
    // be deep-linked, and the id stands in so nothing collides.
    slug: r.source_path
      ? String(r.source_path).replace(/^docs\/help\//, '').replace(/\.md$/, '')
      : `id:${r.id}`,
    title: r.title || '(untitled guide)',
    tags: Array.isArray(r.tags) ? r.tags : [],
    content: indexOnly ? '' : stripFrontmatter(r.content || ''),
  }));

  return NextResponse.json({
    docs,
    // Named so the page can tell "nobody has synced the guides yet" from
    // "your search found nothing" — two very different problems.
    synced: rows.length > 0,
    /** Rows that predate migration 312 and so have no stable slug. */
    unlinkable: docs.filter(d => d.slug.startsWith('id:')).length,
  });
}
