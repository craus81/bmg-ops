import { describe, it, expect } from 'vitest';
import {
  scorePair, rankCandidates, confidenceOf, rationaleFor, jaccard, normalizeItems,
  buildTiebreakPrompt, parseTiebreak, TIEBREAK_SYSTEM_PROMPT,
  WEIGHTS, MIN_SCORE, AMBIGUITY_GAP,
  type MatchSo, type MatchEstimate,
} from './so-matchmaker';

const so = (over: Partial<MatchSo> = {}): MatchSo => ({
  id: 'so1', tranid: 'SO1001', customerNetsuiteId: '48210',
  trandate: '2026-09-10', total: 10_000, itemNumbers: ['A', 'B', 'C'],
  ...over,
});

const est = (over: Partial<MatchEstimate> = {}): MatchEstimate => ({
  id: 'e1', number: 'EST-1', customerNetsuiteId: '48210',
  createdAt: '2026-09-08T00:00:00Z', total: 10_000, itemNumbers: ['A', 'B', 'C'],
  ...over,
});

describe('scorePair — the customer rule', () => {
  it('refuses a pair from a different customer however well everything else fits', () => {
    expect(scorePair(so(), est({ customerNetsuiteId: '99999' }))).toBeNull();
  });

  it('refuses when either side has no customer id — unknown is never agreement', () => {
    expect(scorePair(so({ customerNetsuiteId: null }), est())).toBeNull();
    expect(scorePair(so(), est({ customerNetsuiteId: '' }))).toBeNull();
    expect(scorePair(so({ customerNetsuiteId: '  ' }), est({ customerNetsuiteId: '  ' }))).toBeNull();
  });
});

describe('scorePair — signals', () => {
  it('scores a same-day, same-total, same-lines pair at 100 with every signal named', () => {
    const p = scorePair(so(), est({ createdAt: '2026-09-10T00:00:00Z' }))!;
    expect(p.score).toBe(100);
    expect(p.confidence).toBe('high');
    expect(Object.keys(p.signals).sort()).toEqual(['customer', 'date', 'lines', 'total']);
    expect(p.rationale).toContain('same NetSuite customer (48210)');
    expect(p.rationale).toContain('totals agree');
    expect(p.rationale).toContain('estimate written the same day');
    expect(p.rationale).not.toContain('No signal from');
  });

  it('decays the date signal with the gap rather than treating any month as equal', () => {
    const near = scorePair(so(), est({ createdAt: '2026-09-08T00:00:00Z' }))!;
    const far = scorePair(so(), est({ createdAt: '2026-08-15T00:00:00Z' }))!;
    expect(near.signals.date!.detail).toBe('estimate written 2 days earlier');
    expect(near.score).toBeGreaterThan(far.score);
    expect(far.signals.date!.strength).toBeLessThan(near.signals.date!.strength);
  });

  it('reports a near-miss total as a near miss, with the percentage', () => {
    const p = scorePair(so({ total: 10_400 }), est({ total: 10_000 }))!;
    expect(p.signals.total!.detail).toMatch(/totals within 3\.8%/);
    expect(p.signals.total!.strength).toBeLessThan(1);
    expect(p.score).toBeLessThan(100);
  });

  it('drops the total signal entirely once the gap is too wide to mean anything', () => {
    const p = scorePair(so({ total: 25_000 }), est({ total: 10_000 }))!;
    expect(p.signals.total).toBeUndefined();
    expect(p.rationale).toContain('No signal from: total');
  });

  it('ignores an estimate written AFTER the order it supposedly produced', () => {
    const p = scorePair(so({ trandate: '2026-09-01' }), est({ createdAt: '2026-09-08T00:00:00Z' }))!;
    expect(p.signals.date).toBeUndefined();
  });

  it('scores partial line overlap proportionally and counts it honestly', () => {
    const p = scorePair(so({ itemNumbers: ['A', 'B'] }), est({ itemNumbers: ['B', 'C'] }))!;
    // 1 shared of 3 distinct.
    expect(p.signals.lines!.detail).toBe('1 of 3 distinct items in common');
    expect(p.signals.lines!.points).toBeCloseTo(WEIGHTS.lines / 3, 1);
  });

  it('names what did not fire so a thin match cannot read as a thorough one', () => {
    const p = scorePair(
      so({ total: null, itemNumbers: [] }),
      est({ total: null, itemNumbers: [] }),
    )!;
    expect(p.rationale).toContain('No signal from: total, line items');
    // Customer + a two-day date and nothing else — the whole score is the
    // customer weight plus a decayed date, and it lands BELOW the floor, so
    // "they were a customer that week" never reaches a person as a suggestion.
    expect(p.score).toBeLessThan(MIN_SCORE);
    expect(p.score).toBeGreaterThan(WEIGHTS.customer);
    expect(rankCandidates(so({ total: null, itemNumbers: [] }), [est({ total: null, itemNumbers: [] })])).toEqual([]);
  });
});

describe('confidenceOf', () => {
  const sig = (strengths: Partial<Record<'total' | 'lines' | 'date', number>>) =>
    Object.fromEntries(Object.entries(strengths).map(([k, v]) => [k, { strength: v!, points: 0, detail: '' }]));

  it('needs two strong corroborating signals for high', () => {
    expect(confidenceOf(100, sig({ total: 1, lines: 1, date: 1 }) as any)).toBe('high');
    expect(confidenceOf(90, sig({ total: 1, lines: 0.3, date: 1 }) as any)).toBe('medium');
  });

  it('never calls customer-plus-date-alone anything but low', () => {
    // "They were a customer that month" is not a match.
    expect(confidenceOf(55, sig({ date: 1 }) as any)).toBe('low');
  });
});

describe('rankCandidates', () => {
  it('drops anything below the floor', () => {
    const weak = est({ id: 'e2', number: 'EST-2', total: 40_000, itemNumbers: [], createdAt: '2026-01-01T00:00:00Z' });
    const ranked = rankCandidates(so(), [est(), weak]);
    expect(ranked.map(r => r.estimateId)).toEqual(['e1']);
    expect(ranked[0].score).toBeGreaterThanOrEqual(MIN_SCORE);
  });

  it('flags a near-tie as ambiguous instead of silently picking the winner', () => {
    const a = est({ id: 'e1', number: 'EST-1' });
    const b = est({ id: 'e2', number: 'EST-2', total: 10_050 });
    const ranked = rankCandidates(so(), [a, b]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].score - ranked[1].score).toBeLessThan(AMBIGUITY_GAP);
    expect(ranked[0].ambiguous).toBe(true);
    expect(ranked[1].ambiguous).toBe(true);
  });

  it('does not flag a clear winner as ambiguous', () => {
    const a = est({ id: 'e1', number: 'EST-1' });
    const b = est({ id: 'e2', number: 'EST-2', total: 10_300, itemNumbers: ['Z'], createdAt: '2026-08-20T00:00:00Z' });
    const ranked = rankCandidates(so(), [a, b]);
    expect(ranked[0].estimateId).toBe('e1');
    expect(ranked[0].ambiguous).toBe(false);
  });

  it('returns nothing when no candidate shares the customer', () => {
    expect(rankCandidates(so(), [est({ customerNetsuiteId: '1' }), est({ id: 'e2', customerNetsuiteId: '2' })])).toEqual([]);
  });
});

describe('helpers', () => {
  it('normalizes and de-duplicates item numbers', () => {
    expect(normalizeItems([' a ', 'A', null, '', 'b'])).toEqual(['A', 'B']);
  });

  it('scores an empty side as no overlap rather than a perfect one', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['A'], [])).toBe(0);
    expect(jaccard(['A'], ['A'])).toBe(1);
  });

  it('builds a rationale that leads with the estimate number', () => {
    expect(rationaleFor({ customer: { strength: 1, points: 40, detail: 'same customer' } }, 'EST-9'))
      .toBe('EST-9: same customer. No signal from: total, line items, date.');
  });
});

describe('tie-break', () => {
  it('shows the model descriptions only — no money, dates or customer', () => {
    const p = buildTiebreakPrompt(['Shelving install'], [{ number: 'EST-1', descriptions: ['Install shelf kit'] }]);
    expect(p).toContain('Install shelf kit');
    expect(p).not.toMatch(/\$|48210|2026-/);
    expect(TIEBREAK_SYSTEM_PROMPT).toMatch(/A null is a useful answer here; a guess is not/);
  });

  it('accepts a pick that is one of the candidates', () => {
    expect(parseTiebreak('{"pick":"EST-1","why":"same shelving work"}', ['EST-1', 'EST-2']))
      .toEqual({ pick: 'EST-1', why: 'same shelving work' });
  });

  it('treats a hallucinated estimate number as no verdict', () => {
    const r = parseTiebreak('{"pick":"EST-999","why":"looks right"}', ['EST-1']);
    expect(r).toEqual({ pick: null, why: 'the reply named an estimate that was not a candidate' });
  });

  it('carries an explicit null through as a real answer', () => {
    expect(parseTiebreak('{"pick":null,"why":"both describe the same work"}', ['EST-1']))
      .toEqual({ pick: null, why: 'both describe the same work' });
  });

  it('returns null for anything unparseable rather than guessing', () => {
    expect(parseTiebreak('I think it is EST-1', ['EST-1'])).toBeNull();
    expect(parseTiebreak('{broken', ['EST-1'])).toBeNull();
    expect(parseTiebreak('', ['EST-1'])).toBeNull();
  });
});
