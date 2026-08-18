/**
 * Part category tagging rules (migration 209).
 *
 * Craig 2026-08-18: "all parts from Legend Fleet that have 'liner' in the
 * name should be categorized as Wall Liners." Migration 197 gave parts a
 * browse category but only a per-card dropdown to set it — one click per
 * part, redone every time the NetSuite sync brings new parts in.
 *
 * A rule is (vendor scope, text match, target category, priority). This
 * module is the pure half: compile a rule to a matcher, pick the winning
 * rule for a part, and diff a whole catalog into the minimum set of
 * writes. The API route (/api/parts/category-rules/apply) does the IO, so
 * every precedence decision below is unit-testable.
 *
 * Two rules of the road, both load-bearing:
 *
 *  1. **Manual always wins.** A part whose category_source is 'manual' is
 *     never touched — including one a human deliberately cleared to NULL.
 *     "No, this part has no category" is an answer, not a gap to fill.
 *  2. **Rules are authoritative over their own work.** A part carrying
 *     category_source='rule' is recomputed from scratch on every sweep, so
 *     editing or deleting a rule moves (or clears) the parts it claimed
 *     instead of leaving stale categories behind.
 */

/** Part text a rule may be matched against. */
export const MATCH_FIELDS = ['item_number', 'display_name', 'description', 'marketing_description'] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

export const MATCH_TYPES = ['contains', 'word', 'regex'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

/** A regex longer than this is rejected at save time — a hand-written
 *  pattern is never this long, and the sweep runs it over every active
 *  part, where a pathological one costs real time. */
export const MAX_PATTERN_LENGTH = 200;

/** Stand-in id for an unsaved rule being previewed in the editor. Never
 *  written to a part — a candidate is dry-run only. */
export const CANDIDATE_RULE_ID = '00000000-0000-0000-0000-000000000000';

export interface CategoryRule {
  id: string;
  name?: string | null;
  /** Case-insensitive substring of the part's vendor; null = any vendor. */
  vendor: string | null;
  match_type: MatchType;
  pattern: string;
  match_fields: string[];
  category_id: string;
  priority: number;
  active?: boolean;
  created_at?: string | null;
}

export interface RulePart {
  id: string;
  item_number?: string | null;
  display_name?: string | null;
  description?: string | null;
  marketing_description?: string | null;
  vendor?: string | null;
  product_category_id?: string | null;
  category_source?: string | null;
  category_rule_id?: string | null;
}

/** One write the sweep wants to make. categoryId/ruleId null = clear. */
export interface CategoryAssignment {
  partId: string;
  categoryId: string | null;
  ruleId: string | null;
}

export interface SweepPlan {
  /** Parts whose category the sweep would change. */
  assignments: CategoryAssignment[];
  /** Parts a rule claims, by rule id — the count a preview shows. */
  matchedByRule: Record<string, number>;
  /** Up to `sampleSize` item numbers per rule, so a preview can show its work. */
  samplesByRule: Record<string, string[]>;
  /** Parts skipped because a human set (or deliberately cleared) their category. */
  protectedManual: number;
  /** Parts a rule used to own that no rule claims any more — these get cleared. */
  cleared: number;
  scanned: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a rule's pattern to a case-insensitive RegExp, or null when the
 * pattern is unusable (empty, over-long, or an invalid regex). Callers
 * treat null as "this rule matches nothing" — a typo'd regex must not
 * throw mid-sweep and it must not quietly match everything.
 */
export function compilePattern(matchType: MatchType, pattern: string): RegExp | null {
  const p = (pattern || '').trim();
  if (!p || p.length > MAX_PATTERN_LENGTH) return null;
  try {
    if (matchType === 'regex') return new RegExp(p, 'i');
    const esc = escapeRegExp(p);
    // Whole-word: bounded by a non-alphanumeric or the ends of the string.
    // Written with plain groups rather than \b or lookbehind so patterns
    // that start/end with punctuation (e.g. "3/4\"") still behave, and so
    // the expression stays portable to every browser the admin UI runs in.
    if (matchType === 'word') return new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?:[^A-Za-z0-9]|$)`, 'i');
    return new RegExp(esc, 'i');
  } catch {
    return null;
  }
}

/** Validate a pattern the way the API route does, for a friendly error. */
export function patternError(matchType: MatchType, pattern: string): string | null {
  const p = (pattern || '').trim();
  if (!p) return 'Pattern is required';
  if (p.length > MAX_PATTERN_LENGTH) return `Pattern must be ${MAX_PATTERN_LENGTH} characters or fewer`;
  if (compilePattern(matchType, p)) return null;
  return matchType === 'regex' ? 'Not a valid regular expression' : 'Pattern could not be compiled';
}

function normalizeFields(fields: string[] | null | undefined): MatchField[] {
  const valid = (fields || []).filter((f): f is MatchField => (MATCH_FIELDS as readonly string[]).includes(f));
  // An empty/garbage field list would match every part on an empty string,
  // which is exactly the runaway a preview is supposed to prevent — fall
  // back to the name fields the UI defaults to.
  return valid.length ? valid : ['item_number', 'display_name'];
}

/** Does this part fall inside the rule's vendor scope? */
export function vendorMatches(rule: CategoryRule, part: RulePart): boolean {
  const scope = (rule.vendor || '').trim();
  if (!scope) return true;
  return (part.vendor || '').toLowerCase().includes(scope.toLowerCase());
}

/** Does the rule match this part (vendor scope AND text pattern)? */
export function ruleMatches(rule: CategoryRule, part: RulePart, regex?: RegExp | null): boolean {
  if (rule.active === false) return false;
  if (!vendorMatches(rule, part)) return false;
  const re = regex !== undefined ? regex : compilePattern(rule.match_type, rule.pattern);
  if (!re) return false;
  for (const field of normalizeFields(rule.match_fields)) {
    const value = part[field];
    // Reset lastIndex-free: compilePattern never sets the g flag, so
    // .test() is stateless and safe to reuse across every part.
    if (value && re.test(String(value))) return true;
  }
  return false;
}

/** Priority order: lower priority first, then oldest, then id — a total
 *  order, so "first match wins" is stable across runs. */
export function sortRules(rules: CategoryRule[]): CategoryRule[] {
  return [...rules].sort((a, b) =>
    a.priority - b.priority ||
    String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
    a.id.localeCompare(b.id));
}

/**
 * Diff a catalog against the rule set. Pure — the caller decides whether
 * to write `assignments` (apply) or just show the counts (preview).
 */
export function planSweep(parts: RulePart[], rules: CategoryRule[], sampleSize = 5): SweepPlan {
  const ordered = sortRules(rules.filter(r => r.active !== false));
  // Compile once per rule, not once per (rule, part) — the sweep runs over
  // the whole active catalog.
  const compiled = ordered.map(r => ({ rule: r, regex: compilePattern(r.match_type, r.pattern) }));

  const plan: SweepPlan = {
    assignments: [], matchedByRule: {}, samplesByRule: {},
    protectedManual: 0, cleared: 0, scanned: parts.length,
  };
  for (const r of ordered) { plan.matchedByRule[r.id] = 0; plan.samplesByRule[r.id] = []; }

  for (const part of parts) {
    if (part.category_source === 'manual') { plan.protectedManual++; continue; }

    const hit = compiled.find(({ rule, regex }) => ruleMatches(rule, part, regex));
    if (hit) {
      plan.matchedByRule[hit.rule.id]++;
      const samples = plan.samplesByRule[hit.rule.id];
      if (samples.length < sampleSize) samples.push(part.item_number || part.id);
    }

    const wantCategory = hit ? hit.rule.category_id : null;
    const wantRule = hit ? hit.rule.id : null;
    const hasCategory = part.product_category_id || null;
    const hasRule = part.category_rule_id || null;
    // An uncategorized part with no match is already where it should be.
    if (wantCategory === hasCategory && wantRule === hasRule) continue;
    // Never claim a category a human left alone but didn't set: only parts
    // that are uncategorized, or already rule-owned, are ours to move.
    if (hasCategory && part.category_source !== 'rule') { plan.protectedManual++; continue; }

    if (!wantCategory) plan.cleared++;
    plan.assignments.push({ partId: part.id, categoryId: wantCategory, ruleId: wantRule });
  }
  return plan;
}

/** Group assignments so the writer issues one UPDATE ... WHERE id IN (…)
 *  per distinct (category, rule) pair instead of one per part. */
export function groupAssignments(
  assignments: CategoryAssignment[],
): { categoryId: string | null; ruleId: string | null; partIds: string[] }[] {
  const groups = new Map<string, { categoryId: string | null; ruleId: string | null; partIds: string[] }>();
  for (const a of assignments) {
    const key = `${a.categoryId || ''}|${a.ruleId || ''}`;
    if (!groups.has(key)) groups.set(key, { categoryId: a.categoryId, ruleId: a.ruleId, partIds: [] });
    groups.get(key)!.partIds.push(a.partId);
  }
  return [...groups.values()];
}
