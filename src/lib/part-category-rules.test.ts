import { describe, it, expect } from 'vitest';
import {
  compilePattern, patternError, ruleMatches, vendorMatches, sortRules,
  planSweep, groupAssignments, MAX_PATTERN_LENGTH,
  type CategoryRule, type RulePart,
} from './part-category-rules';

const rule = (over: Partial<CategoryRule> = {}): CategoryRule => ({
  id: 'r1', vendor: 'Legend Fleet', match_type: 'contains', pattern: 'liner',
  match_fields: ['item_number', 'display_name'], category_id: 'cat-wall-liners',
  priority: 100, active: true, created_at: '2026-08-18T00:00:00Z', ...over,
});

const part = (over: Partial<RulePart> = {}): RulePart => ({
  id: 'p1', item_number: 'LF-WL-101', display_name: 'Wall Liner Kit',
  vendor: 'Legend Fleet', product_category_id: null, category_source: null,
  category_rule_id: null, ...over,
});

describe('compilePattern', () => {
  it('matches a substring case-insensitively for contains', () => {
    const re = compilePattern('contains', 'liner')!;
    expect(re.test('Wall LINER Kit')).toBe(true);
    expect(re.test('Headliner Panel')).toBe(true);
  });

  it('requires a whole word for word', () => {
    const re = compilePattern('word', 'liner')!;
    expect(re.test('Wall Liner Kit')).toBe(true);
    expect(re.test('LINER')).toBe(true);
    expect(re.test('Liner, gray')).toBe(true);
    expect(re.test('Headliner Panel')).toBe(false);
    expect(re.test('Linerless Roll')).toBe(false);
  });

  it('escapes regex metacharacters in contains/word patterns', () => {
    expect(compilePattern('contains', '3/4"')!.test('PLY 3/4" PANEL')).toBe(true);
    expect(compilePattern('contains', 'a.c')!.test('abc')).toBe(false);
    expect(compilePattern('contains', 'a.c')!.test('a.c')).toBe(true);
  });

  it('compiles a real regex and returns null for a broken one', () => {
    expect(compilePattern('regex', '^LF-\\d+')!.test('lf-1234')).toBe(true);
    expect(compilePattern('regex', '([unclosed')).toBeNull();
  });

  it('rejects empty and over-long patterns', () => {
    expect(compilePattern('contains', '   ')).toBeNull();
    expect(compilePattern('contains', 'x'.repeat(MAX_PATTERN_LENGTH + 1))).toBeNull();
    expect(patternError('regex', '([unclosed')).toMatch(/valid regular expression/);
    expect(patternError('contains', 'liner')).toBeNull();
  });

  it('is stateless across repeated tests (no g flag)', () => {
    const re = compilePattern('contains', 'liner')!;
    expect(re.test('liner')).toBe(true);
    expect(re.test('liner')).toBe(true);
  });
});

describe('vendorMatches', () => {
  it('is a case-insensitive substring, and null scope matches everything', () => {
    expect(vendorMatches(rule({ vendor: 'legend' }), part({ vendor: 'Legend Fleet Solutions' }))).toBe(true);
    expect(vendorMatches(rule({ vendor: 'Legend Fleet' }), part({ vendor: 'Ranger Design' }))).toBe(false);
    expect(vendorMatches(rule({ vendor: null }), part({ vendor: null }))).toBe(true);
    expect(vendorMatches(rule({ vendor: 'Legend' }), part({ vendor: null }))).toBe(false);
  });
});

describe('ruleMatches', () => {
  it('needs both the vendor scope and the pattern', () => {
    expect(ruleMatches(rule(), part())).toBe(true);
    expect(ruleMatches(rule(), part({ vendor: 'Ranger Design' }))).toBe(false);
    expect(ruleMatches(rule(), part({ item_number: 'LF-99', display_name: 'Shelf Unit' }))).toBe(false);
  });

  it('only reads the fields the rule names', () => {
    const descOnly = part({ item_number: 'LF-99', display_name: 'Panel', description: 'vinyl liner' });
    expect(ruleMatches(rule(), descOnly)).toBe(false);
    expect(ruleMatches(rule({ match_fields: ['description'] }), descOnly)).toBe(true);
  });

  it('falls back to the name fields when match_fields is empty or garbage', () => {
    expect(ruleMatches(rule({ match_fields: [] }), part())).toBe(true);
    expect(ruleMatches(rule({ match_fields: ['sales_price'] }), part())).toBe(true);
  });

  it('never matches when inactive or when the pattern is broken', () => {
    expect(ruleMatches(rule({ active: false }), part())).toBe(false);
    expect(ruleMatches(rule({ match_type: 'regex', pattern: '([bad' }), part())).toBe(false);
  });
});

describe('sortRules', () => {
  it('orders by priority, then created_at, then id', () => {
    const rules = [
      rule({ id: 'c', priority: 100, created_at: '2026-01-02T00:00:00Z' }),
      rule({ id: 'a', priority: 10 }),
      rule({ id: 'b', priority: 100, created_at: '2026-01-01T00:00:00Z' }),
    ];
    expect(sortRules(rules).map(r => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('planSweep', () => {
  const wallLiners = rule({ id: 'r-wall', category_id: 'cat-wall' });

  it('assigns a matching uncategorized part', () => {
    const plan = planSweep([part()], [wallLiners]);
    expect(plan.assignments).toEqual([{ partId: 'p1', categoryId: 'cat-wall', ruleId: 'r-wall' }]);
    expect(plan.matchedByRule['r-wall']).toBe(1);
    expect(plan.samplesByRule['r-wall']).toEqual(['LF-WL-101']);
    expect(plan.scanned).toBe(1);
  });

  it('leaves a part already sitting on the right rule alone', () => {
    const settled = part({ product_category_id: 'cat-wall', category_source: 'rule', category_rule_id: 'r-wall' });
    const plan = planSweep([settled], [wallLiners]);
    expect(plan.assignments).toEqual([]);
    expect(plan.matchedByRule['r-wall']).toBe(1);
  });

  it('never touches a human assignment', () => {
    const manual = part({ product_category_id: 'cat-flooring', category_source: 'manual' });
    const plan = planSweep([manual], [wallLiners]);
    expect(plan.assignments).toEqual([]);
    expect(plan.protectedManual).toBe(1);
  });

  it('never re-fills a category a human deliberately cleared', () => {
    const cleared = part({ product_category_id: null, category_source: 'manual' });
    expect(planSweep([cleared], [wallLiners]).assignments).toEqual([]);
  });

  it('leaves a categorized part with an unknown provenance alone', () => {
    // Pre-migration rows are backfilled to 'manual', but belt and braces:
    // an unlabeled category is somebody's work, not ours to move.
    const legacy = part({ product_category_id: 'cat-flooring', category_source: null });
    const plan = planSweep([legacy], [wallLiners]);
    expect(plan.assignments).toEqual([]);
    expect(plan.protectedManual).toBe(1);
  });

  it('clears a part its rule no longer claims', () => {
    const orphan = part({
      item_number: 'LF-SHELF-1', display_name: 'Shelf Unit',
      product_category_id: 'cat-wall', category_source: 'rule', category_rule_id: 'r-wall',
    });
    const plan = planSweep([orphan], [wallLiners]);
    expect(plan.assignments).toEqual([{ partId: 'p1', categoryId: null, ruleId: null }]);
    expect(plan.cleared).toBe(1);
  });

  it('moves a part when a higher-priority rule claims it', () => {
    const specific = rule({ id: 'r-spec', priority: 10, pattern: 'WL', match_type: 'word', category_id: 'cat-spec' });
    const held = part({ item_number: 'LF WL 101', product_category_id: 'cat-wall', category_source: 'rule', category_rule_id: 'r-wall' });
    const plan = planSweep([held], [wallLiners, specific]);
    expect(plan.assignments).toEqual([{ partId: 'p1', categoryId: 'cat-spec', ruleId: 'r-spec' }]);
    expect(plan.matchedByRule['r-spec']).toBe(1);
    expect(plan.matchedByRule['r-wall']).toBe(0);
  });

  it('gives a part to exactly one rule — the first match wins', () => {
    const broad = rule({ id: 'r-broad', priority: 50, vendor: null, pattern: 'kit', category_id: 'cat-kits' });
    const plan = planSweep([part()], [wallLiners, broad]);
    expect(plan.assignments).toEqual([{ partId: 'p1', categoryId: 'cat-kits', ruleId: 'r-broad' }]);
    expect(plan.matchedByRule['r-wall']).toBe(0);
  });

  it('ignores inactive rules entirely', () => {
    const plan = planSweep([part()], [rule({ id: 'r-off', active: false })]);
    expect(plan.assignments).toEqual([]);
    expect(plan.matchedByRule['r-off']).toBeUndefined();
  });

  it('caps the per-rule sample list', () => {
    const parts = Array.from({ length: 9 }, (_, i) => part({ id: `p${i}`, item_number: `LF-LINER-${i}` }));
    expect(planSweep(parts, [wallLiners], 3).samplesByRule['r-wall']).toEqual(['LF-LINER-0', 'LF-LINER-1', 'LF-LINER-2']);
    expect(planSweep(parts, [wallLiners], 3).matchedByRule['r-wall']).toBe(9);
  });

  it('is idempotent — applying a plan leaves nothing to do', () => {
    const parts = [part(), part({ id: 'p2', item_number: 'LF-SHELF', display_name: 'Shelf' })];
    const first = planSweep(parts, [wallLiners]);
    const applied = parts.map(p => {
      const a = first.assignments.find(x => x.partId === p.id);
      return a ? { ...p, product_category_id: a.categoryId, category_rule_id: a.ruleId, category_source: a.categoryId ? 'rule' : null } : p;
    });
    expect(planSweep(applied, [wallLiners]).assignments).toEqual([]);
  });
});

describe('groupAssignments', () => {
  it('collapses assignments into one write per (category, rule)', () => {
    const groups = groupAssignments([
      { partId: 'a', categoryId: 'c1', ruleId: 'r1' },
      { partId: 'b', categoryId: 'c1', ruleId: 'r1' },
      { partId: 'c', categoryId: null, ruleId: null },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ categoryId: 'c1', ruleId: 'r1', partIds: ['a', 'b'] });
    expect(groups[1]).toEqual({ categoryId: null, ruleId: null, partIds: ['c'] });
  });
});
