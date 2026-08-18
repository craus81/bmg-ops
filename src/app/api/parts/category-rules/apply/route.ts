import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { runCategorySweep } from '@/lib/part-category-sweep';
import { CANDIDATE_RULE_ID, MATCH_FIELDS, MATCH_TYPES, MAX_PATTERN_LENGTH, patternError } from '@/lib/part-category-rules';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/parts/category-rules/apply — run the tagging rules over the
 * catalog (migration 209).
 *
 * `dryRun` returns the same counts without writing; the admin page always
 * previews first, because one loose keyword across an unbounded catalog is
 * tedious to undo. `candidate` previews an unsaved rule (dry run only) so
 * the editor can show "this would claim 47 parts" before you save it.
 */
const Schema = z.object({
  dryRun: z.boolean().optional(),
  candidate: z.object({
    id: z.string().uuid().optional(),
    vendor: z.string().trim().max(200).optional().nullable(),
    matchType: z.enum(MATCH_TYPES),
    pattern: z.string().trim().min(1).max(MAX_PATTERN_LENGTH),
    matchFields: z.array(z.enum(MATCH_FIELDS)).min(1).max(MATCH_FIELDS.length),
    categoryId: z.string().uuid(),
    priority: z.coerce.number().int().min(0).max(10_000).optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { dryRun, candidate } = parsed.data;

  if (candidate && dryRun === false) {
    return NextResponse.json({ error: 'A candidate rule can only be previewed — save it first' }, { status: 400 });
  }
  if (candidate) {
    const patErr = patternError(candidate.matchType, candidate.pattern);
    if (patErr) return NextResponse.json({ error: patErr }, { status: 400 });
  }

  try {
    const result = await runCategorySweep(supabase, {
      dryRun: candidate ? true : dryRun !== false,
      candidate: candidate ? {
        id: candidate.id || CANDIDATE_RULE_ID,
        vendor: candidate.vendor?.trim() || null,
        match_type: candidate.matchType,
        pattern: candidate.pattern,
        match_fields: candidate.matchFields,
        category_id: candidate.categoryId,
        priority: candidate.priority ?? 100,
        active: true,
        // Sorts last among equal priorities so a preview can't jump ahead
        // of an existing rule that already earned its place.
        created_at: '9999-12-31T00:00:00Z',
      } : undefined,
    });
    return NextResponse.json({
      ...result,
      // The preview headline: what a real run would write.
      wouldChange: result.assignments.length,
      // Full assignment list is internal bookkeeping, not payload.
      assignments: undefined,
      candidateRuleId: candidate ? (candidate.id || CANDIDATE_RULE_ID) : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Sweep failed' }, { status: 500 });
  }
}
