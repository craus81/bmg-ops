/**
 * Runs the part category tagging rules against the catalog (migration
 * 209). The matching itself is pure and lives in part-category-rules.ts;
 * this is the IO half — read every active part, plan the diff, write it —
 * shared by the admin sweep endpoint (/api/parts/category-rules/apply) and
 * the incremental NetSuite parts sync, so parts arriving overnight are
 * categorized without anyone pressing a button.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  planSweep, groupAssignments,
  type CategoryRule, type RulePart, type SweepPlan,
} from '@/lib/part-category-rules';

const PART_COLUMNS =
  'id, item_number, display_name, description, marketing_description, vendor, product_category_id, category_source, category_rule_id';

/** Ids per UPDATE … WHERE id IN (…) — keeps the URL under PostgREST's limit. */
const WRITE_CHUNK = 200;

export interface SweepResult extends SweepPlan {
  /** Parts actually written (0 on a dry run). */
  applied: number;
  dryRun: boolean;
}

/**
 * Plan — and unless `dryRun`, apply — the whole rule set.
 *
 * `candidate` folds an unsaved rule into the evaluation so the editor can
 * answer "how many parts would this claim?" before anything is written; it
 * is only honored on a dry run, since an unsaved rule has no id to record
 * on the parts it would win.
 */
export async function runCategorySweep(
  service: SupabaseClient,
  opts: { dryRun?: boolean; candidate?: CategoryRule } = {},
): Promise<SweepResult> {
  // Default is a real run; a candidate rule forces (and is only valid on)
  // a dry run, since an unsaved rule has no id to stamp onto parts.
  const dryRun = opts.dryRun ?? !!opts.candidate;
  if (opts.candidate && !dryRun) throw new Error('A candidate rule can only be previewed');

  const { data: saved, error: rulesError } = await service
    .from('part_category_rules')
    .select('id, name, vendor, match_type, pattern, match_fields, category_id, priority, active, created_at')
    .eq('active', true);
  if (rulesError) throw new Error(`Rules read failed: ${rulesError.message}`);

  const rules = [...((saved || []) as CategoryRule[])];
  if (opts.candidate) {
    // Replace the saved copy when previewing an edit, so the candidate
    // doesn't compete with its own older self.
    const i = rules.findIndex(r => r.id === opts.candidate!.id);
    if (i >= 0) rules[i] = opts.candidate;
    else rules.push(opts.candidate);
  }

  // Unbounded table — paginate with a unique sort key per CLAUDE.md.
  const { data: parts, error: partsError } = await fetchAllRows<RulePart>((from, to) => service
    .from('netsuite_parts')
    .select(PART_COLUMNS)
    .eq('is_active', true)
    .order('id')
    .range(from, to));
  // A partial read would look like "no rule matches these parts any more"
  // and clear categories that are actually fine — never write on one.
  if (partsError) throw new Error(`Parts read failed: ${partsError.message}`);

  const plan = planSweep(parts, rules);
  if (dryRun) return { ...plan, applied: 0, dryRun: true };

  let applied = 0;
  for (const group of groupAssignments(plan.assignments)) {
    const patch = {
      product_category_id: group.categoryId,
      category_rule_id: group.ruleId,
      category_source: group.categoryId ? 'rule' : null,
    };
    for (let i = 0; i < group.partIds.length; i += WRITE_CHUNK) {
      const ids = group.partIds.slice(i, i + WRITE_CHUNK);
      const { error } = await service.from('netsuite_parts').update(patch).in('id', ids);
      if (error) throw new Error(`Category write failed: ${error.message}`);
      applied += ids.length;
    }
  }

  // Stamp each saved rule with what it owns now, so the admin list shows
  // live counts without re-running the sweep.
  const now = new Date().toISOString();
  for (const rule of (saved || []) as CategoryRule[]) {
    await service
      .from('part_category_rules')
      .update({ last_run_at: now, last_matched_count: plan.matchedByRule[rule.id] ?? 0 })
      .eq('id', rule.id);
  }

  return { ...plan, applied, dryRun: false };
}
