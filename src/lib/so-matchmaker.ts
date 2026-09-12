/**
 * Orphan Sales-Order Matchmaker (R6-13, audit line 424).
 *
 * The SO sync links an order to its estimate only on an exact signal —
 * createdfrom, otherrefnum, or a memo hit. Orders raised by hand in NetSuite
 * carry none of those, so the estimate they came from never learns it
 * converted, and every conversion figure is quietly short.
 *
 * This module is the SCORER, and it is deliberately the whole of the
 * decision logic: pure, weighted, and explainable, so the rationale a
 * reviewer reads is generated from the same numbers the score came from and
 * cannot drift into flattery.
 *
 * Three rules it will not bend:
 *
 *  1. NO CUSTOMER MATCH, NO SUGGESTION. Two unrelated companies whose order
 *     and estimate happen to land on the same total is exactly the mis-link
 *     that misattributes revenue, and nothing downstream would ever flag it.
 *     The customer is matched on the NetSuite internal id, never on name.
 *  2. A suggestion is not a link. Nothing here writes estimate_id; a person
 *     accepts, and the accept does the linking.
 *  3. The rationale names only the signals that actually FIRED. A near miss
 *     is reported as a near miss, and a comparison that did not run is never
 *     described as one that did.
 */

export interface MatchSo {
  id: string;
  tranid: string | null;
  customerNetsuiteId: string | null;
  trandate: string | null;
  total: number | null;
  /** Normalized item numbers on the order's lines. */
  itemNumbers: string[];
}

export interface MatchEstimate {
  id: string;
  number: string;
  customerNetsuiteId: string | null;
  createdAt: string | null;
  total: number | null;
  itemNumbers: string[];
}

export type SignalName = 'customer' | 'total' | 'date' | 'lines';

export interface SignalDetail {
  /** 0..1 — how strongly this signal fired. */
  strength: number;
  /** Points contributed to the score. */
  points: number;
  /** What was compared, for a reviewer who wants to check rather than trust. */
  detail: string;
}

export interface PairScore {
  soId: string;
  estimateId: string;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  signals: Partial<Record<SignalName, SignalDetail>>;
  rationale: string;
  /** True when the numbers alone can't separate this from another candidate. */
  ambiguous: boolean;
}

/** Weights. They sum to 100 and are stated here so a score is readable. */
export const WEIGHTS: Record<SignalName, number> = {
  customer: 40,
  total: 25,
  lines: 20,
  date: 15,
};

/** Totals within this fraction score full marks; beyond 2× it, nothing. */
export const TOTAL_TOLERANCE = 0.02;
/** An estimate this many days before the order still scores full marks. */
export const DATE_WINDOW_DAYS = 45;
/** Below this the pair is not worth a person's attention at all. */
export const MIN_SCORE = 55;
/** Two candidates closer than this are "ambiguous" — the numbers can't choose. */
export const AMBIGUITY_GAP = 8;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/** Item numbers, uppercased and de-duplicated. */
export function normalizeItems(items: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of items) {
    const v = String(raw ?? '').trim().toUpperCase();
    if (v) out.add(v);
  }
  return [...out];
}

/** |a∩b| / |a∪b| — 0 when either side has no items to compare. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  let shared = 0;
  const B = new Set(b);
  for (const v of B) if (A.has(v)) shared++;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : shared / union;
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a.includes('T') ? a : `${a}T00:00:00`);
  const tb = Date.parse(b.includes('T') ? b : `${b}T00:00:00`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((ta - tb) / 86_400_000);
}

/**
 * Score one SO against one estimate. Returns null when the pair is
 * disqualified outright — a different customer, or neither side carrying a
 * customer id to compare.
 */
export function scorePair(so: MatchSo, est: MatchEstimate): PairScore | null {
  const soCust = String(so.customerNetsuiteId ?? '').trim();
  const estCust = String(est.customerNetsuiteId ?? '').trim();
  // Rule 1. An unknown customer on either side is not a match, it is an
  // unknown — and an unknown must never be scored as agreement.
  if (!soCust || !estCust || soCust !== estCust) return null;

  const signals: Partial<Record<SignalName, SignalDetail>> = {
    customer: {
      strength: 1,
      points: WEIGHTS.customer,
      detail: `same NetSuite customer (${soCust})`,
    },
  };

  // Total.
  if (so.total != null && est.total != null && (so.total !== 0 || est.total !== 0)) {
    const base = Math.max(Math.abs(so.total), Math.abs(est.total));
    const diff = Math.abs(so.total - est.total);
    const rel = base === 0 ? 0 : diff / base;
    // Full marks inside the tolerance, sliding to zero at twice it.
    const strength = clamp01(1 - (rel - TOTAL_TOLERANCE) / TOTAL_TOLERANCE);
    if (strength > 0) {
      signals.total = {
        strength,
        points: Math.round(WEIGHTS.total * strength * 100) / 100,
        detail: rel <= TOTAL_TOLERANCE
          ? `totals agree (${money(so.total)} vs ${money(est.total)})`
          : `totals within ${(rel * 100).toFixed(1)}% (${money(so.total)} vs ${money(est.total)})`,
      };
    }
  }

  // Date — the estimate should PRECEDE the order. An estimate written after
  // the order it supposedly produced is not evidence of anything.
  const gap = daysBetween(so.trandate, est.createdAt);
  if (gap != null && gap >= 0) {
    const strength = clamp01(1 - gap / DATE_WINDOW_DAYS);
    if (strength > 0) {
      signals.date = {
        strength,
        points: Math.round(WEIGHTS.date * strength * 100) / 100,
        detail: gap === 0 ? 'estimate written the same day' : `estimate written ${gap} day${gap === 1 ? '' : 's'} earlier`,
      };
    }
  }

  // Lines.
  const overlap = jaccard(so.itemNumbers, est.itemNumbers);
  if (overlap > 0) {
    const shared = so.itemNumbers.filter(i => est.itemNumbers.includes(i)).length;
    signals.lines = {
      strength: overlap,
      points: Math.round(WEIGHTS.lines * overlap * 100) / 100,
      detail: `${shared} of ${new Set([...so.itemNumbers, ...est.itemNumbers]).size} distinct items in common`,
    };
  }

  const score = Math.round(
    Object.values(signals).reduce((s, d) => s + (d?.points || 0), 0) * 100,
  ) / 100;

  return {
    soId: so.id,
    estimateId: est.id,
    score,
    confidence: confidenceOf(score, signals),
    signals,
    rationale: rationaleFor(signals, est.number),
    ambiguous: false,
  };
}

/**
 * High needs the customer AND corroboration from two of the other three —
 * a customer plus a date proximity alone is just "they were a customer that
 * month", which is not a match.
 */
export function confidenceOf(score: number, signals: Partial<Record<SignalName, SignalDetail>>): 'high' | 'medium' | 'low' {
  const strong = (['total', 'lines'] as SignalName[]).filter(k => (signals[k]?.strength ?? 0) >= 0.6).length;
  const any = (['total', 'lines', 'date'] as SignalName[]).filter(k => (signals[k]?.strength ?? 0) > 0).length;
  if (score >= 85 && strong >= 2) return 'high';
  if (score >= 70 && strong >= 1) return 'medium';
  if (score >= MIN_SCORE && any >= 1) return 'low';
  return 'low';
}

/** One line, naming only what fired. */
export function rationaleFor(signals: Partial<Record<SignalName, SignalDetail>>, estimateNumber: string): string {
  const order: SignalName[] = ['customer', 'total', 'lines', 'date'];
  const parts = order.map(k => signals[k]?.detail).filter(Boolean) as string[];
  const missing = order.filter(k => !signals[k]);
  const tail = missing.length
    ? ` No signal from: ${missing.map(m => (m === 'lines' ? 'line items' : m)).join(', ')}.`
    : '';
  return `${estimateNumber}: ${parts.join('; ')}.${tail}`;
}

/**
 * Rank an order's candidates, keep the ones worth showing, and mark the
 * top pair ambiguous when a runner-up is within AMBIGUITY_GAP. Ambiguity is
 * surfaced, not resolved by rounding — it is the flag that says "a person,
 * or a text comparison, has to look at this".
 */
export function rankCandidates(so: MatchSo, estimates: MatchEstimate[]): PairScore[] {
  const scored = estimates
    .map(e => scorePair(so, e))
    .filter((p): p is PairScore => p != null && p.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  if (scored.length >= 2 && scored[0].score - scored[1].score < AMBIGUITY_GAP) {
    scored[0].ambiguous = true;
    scored[1].ambiguous = true;
  }
  return scored;
}

/** The prompt for the tie-break. Free-text descriptions only — never totals. */
export const TIEBREAK_SYSTEM_PROMPT = `You are comparing a NetSuite sales order against candidate estimates from the same customer, to help a person decide which estimate the order came from. You see only the free-text line descriptions — no totals, no dates, no scores.

Answer with a single JSON object and nothing else:
{"pick": "<estimate number or null>", "why": "<one short sentence>"}

Rules:
- Pick an estimate ONLY if its line descriptions clearly describe the same work as the order's. Wording will differ; the WORK has to be the same.
- If two candidates describe the same work, or none clearly does, return {"pick": null, "why": "..."} saying which way it was ambiguous. A null is a useful answer here; a guess is not.
- Never mention or infer money, dates, quantities you were not given, or customer identity.`;

export interface TiebreakCandidate { number: string; descriptions: string[] }

export function buildTiebreakPrompt(soDescriptions: string[], candidates: TiebreakCandidate[]): string {
  const lines = (xs: string[]) => (xs.length ? xs.map(d => `  - ${d}`).join('\n') : '  (no line descriptions)');
  return [
    'Sales order lines:',
    lines(soDescriptions),
    '',
    'Candidate estimates:',
    ...candidates.flatMap(c => [`${c.number}:`, lines(c.descriptions), '']),
    'Which estimate did this order come from?',
  ].join('\n');
}

/** Parse the tie-break reply. Anything unparseable is "no verdict", never a pick. */
export function parseTiebreak(text: string, candidateNumbers: string[]): { pick: string | null; why: string } | null {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  let obj: any;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const why = typeof obj.why === 'string' ? obj.why.slice(0, 300) : '';
  const raw = obj.pick == null ? null : String(obj.pick).trim();
  // A pick has to be one of the candidates we asked about. A hallucinated
  // estimate number reads as no verdict, not as a match — and the reply's
  // own reasoning is DISCARDED with it, because "looks right" was written
  // about an estimate that isn't in play and would read as support for the
  // null it is not.
  if (raw && !candidateNumbers.includes(raw)) {
    return { pick: null, why: 'the reply named an estimate that was not a candidate' };
  }
  return { pick: raw || null, why };
}
