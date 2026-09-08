/**
 * Material yield & scrap (R6-6). The roll plan has always computed two
 * numbers — the roll area pulled and the graphic area printed on it — and
 * only ever stored the first. The difference is waste, and waste per film
 * is the number that tells a shop whether its nesting is any good.
 *
 * The honesty rule here is the same one the costing lib follows: a line
 * with no recorded graphic area is UNKNOWN, not 100% waste. Reporting a
 * hand-typed line as total scrap would make every film look terrible and
 * bury the ones that actually are.
 */

export interface YieldLine {
  materialName: string;
  substrateId: string | null;
  /** Roll area consumed. */
  rollSqft: number | null;
  /** Printed area. Null when nobody recorded it. */
  graphicSqft: number | null;
  cost: number | null;
}

export interface FilmYield {
  key: string;
  materialName: string;
  substrateId: string | null;
  /** Lines that carry BOTH measurements — the only ones yield can use. */
  measuredLines: number;
  unmeasuredLines: number;
  rollSqft: number;
  graphicSqft: number;
  wasteSqft: number;
  /** graphic ÷ roll, 0-1. Null when nothing was measurable. */
  utilization: number | null;
  /** Cost attributable to the waste, when the measured lines carry cost. */
  wasteCost: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const key = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

/**
 * Roll up yield per film. Only lines with both a roll and a graphic
 * measurement contribute to utilization; the rest are counted and
 * reported so the coverage is visible.
 */
export function summarizeYield(lines: YieldLine[]): FilmYield[] {
  const by = new Map<string, FilmYield & { measuredCost: number }>();
  for (const l of lines) {
    const k = l.substrateId ? `sub:${l.substrateId}` : `name:${key(l.materialName)}`;
    const row = by.get(k) || {
      key: k, materialName: l.materialName, substrateId: l.substrateId,
      measuredLines: 0, unmeasuredLines: 0, rollSqft: 0, graphicSqft: 0,
      wasteSqft: 0, utilization: null, wasteCost: null, measuredCost: 0,
    };
    const measurable = l.rollSqft != null && l.rollSqft > 0 && l.graphicSqft != null;
    if (measurable) {
      row.measuredLines += 1;
      row.rollSqft = round1(row.rollSqft + l.rollSqft!);
      row.graphicSqft = round1(row.graphicSqft + l.graphicSqft!);
      if (l.cost != null) row.measuredCost = round2(row.measuredCost + l.cost);
    } else {
      row.unmeasuredLines += 1;
    }
    by.set(k, row);
  }

  return [...by.values()]
    .map(({ measuredCost, ...row }) => {
      const waste = round1(Math.max(row.rollSqft - row.graphicSqft, 0));
      const utilization = row.rollSqft > 0 ? Math.round((row.graphicSqft / row.rollSqft) * 1000) / 1000 : null;
      return {
        ...row,
        wasteSqft: waste,
        utilization,
        // What the scrap cost, at the blended rate those measured lines
        // actually billed at.
        wasteCost: row.rollSqft > 0 && measuredCost > 0
          ? round2((waste / row.rollSqft) * measuredCost)
          : null,
      };
    })
    .sort((a, b) => (b.wasteSqft) - (a.wasteSqft));
}

export interface YieldTotals {
  rollSqft: number;
  graphicSqft: number;
  wasteSqft: number;
  utilization: number | null;
  wasteCost: number | null;
  measuredLines: number;
  unmeasuredLines: number;
}

export function yieldTotals(films: FilmYield[]): YieldTotals {
  const t = films.reduce(
    (acc, f) => ({
      rollSqft: acc.rollSqft + f.rollSqft,
      graphicSqft: acc.graphicSqft + f.graphicSqft,
      wasteSqft: acc.wasteSqft + f.wasteSqft,
      wasteCost: acc.wasteCost + (f.wasteCost || 0),
      measuredLines: acc.measuredLines + f.measuredLines,
      unmeasuredLines: acc.unmeasuredLines + f.unmeasuredLines,
    }),
    { rollSqft: 0, graphicSqft: 0, wasteSqft: 0, wasteCost: 0, measuredLines: 0, unmeasuredLines: 0 },
  );
  return {
    rollSqft: round1(t.rollSqft),
    graphicSqft: round1(t.graphicSqft),
    wasteSqft: round1(t.wasteSqft),
    utilization: t.rollSqft > 0 ? Math.round((t.graphicSqft / t.rollSqft) * 1000) / 1000 : null,
    wasteCost: t.wasteCost > 0 ? round2(t.wasteCost) : null,
    measuredLines: t.measuredLines,
    unmeasuredLines: t.unmeasuredLines,
  };
}

/**
 * Yield straight from a saved roll-plan snapshot — the back-computation
 * that gives history without anyone re-logging anything. Snapshots live as
 * JSONB on graphics_jobs.nesting (m266) and wrap_quotes.nesting (m180).
 */
export function yieldFromSnapshot(
  snapshot: any,
  computeUsage: (pieces: any[], placements: any, config: any) => { films: { filmKey: string; rollSqft: number; graphicSqft: number }[] },
  buildPieces: (snapshot: any) => any[],
): { rollSqft: number; graphicSqft: number } | null {
  if (!snapshot || !snapshot.config || !snapshot.placements) return null;
  try {
    const usage = computeUsage(buildPieces(snapshot), snapshot.placements, snapshot.config);
    const rollSqft = usage.films.reduce((s, f) => s + f.rollSqft, 0);
    const graphicSqft = usage.films.reduce((s, f) => s + f.graphicSqft, 0);
    if (rollSqft <= 0) return null;
    return { rollSqft: round1(rollSqft), graphicSqft: round1(graphicSqft) };
  } catch {
    return null;
  }
}
