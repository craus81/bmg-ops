/**
 * Material costing (R6-1): what a graphics job actually burns, priced from
 * the one film catalog (wrap_substrates) instead of guessed from the last
 * line someone typed.
 *
 * The rule that makes the numbers honest: film and laminate are consumed
 * by the ROLL — waste included, because you bought the whole length —
 * while premask and ink are consumed only by the GRAPHIC area, since
 * neither lands on the blank margins the nesting engine left. Pricing all
 * four off roll sqft (the obvious shortcut) overstates ink and premask by
 * exactly the scrap fraction.
 *
 * Rate precedence per line: the film's own catalog rate, then the shop
 * default (quote_settings), then the legacy last-logged heuristic, then
 * unknown. Unknown stays NULL — never $0, so an unpriced job reads as
 * unpriced rather than free.
 */

export type MaterialCategory = 'vinyl' | 'laminate' | 'premask' | 'ink' | 'other';
export type CostSource = 'catalog' | 'settings_default' | 'last_logged' | 'manual' | 'import';

export interface CatalogFilm {
  id: string;
  name: string;
  cost_per_sqft: number | null;
  laminate_name: string | null;
  laminate_cost_per_sqft: number | null;
  premask_name: string | null;
  premask_cost_per_sqft: number | null;
  ink_cost_per_sqft: number | null;
  roll_width_in?: number | null;
  roll_length_ft?: number | null;
}

export interface ShopMaterialDefaults {
  inkCostPerSqft: number | null;
  premaskCostPerSqft: number | null;
}

export interface MaterialLine {
  category: MaterialCategory;
  materialName: string;
  substrateId: string | null;
  quantitySqft: number;
  linearFeet: number | null;
  ratePerSqft: number | null;
  cost: number | null;
  costSource: CostSource | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Match key for free-text film names — case and spacing are not identity. */
export function normalizeFilmName(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Resolve a typed film name against the catalog: exact normalized match
 * first, then a unique prefix/substring hit. Ambiguous matches resolve to
 * null — a wrong film is worse than an unlinked line.
 */
export function matchSubstrate<T extends { id: string; name: string }>(
  name: string | null | undefined,
  substrates: T[],
): T | null {
  if (!name || !name.trim()) return null;
  const key = normalizeFilmName(name);
  const exact = substrates.filter(s => normalizeFilmName(s.name) === key);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = substrates.filter(s => {
    const n = normalizeFilmName(s.name);
    return n.startsWith(key) || key.startsWith(n) || n.includes(key);
  });
  return partial.length === 1 ? partial[0] : null;
}

/** One priced line, or null when there is nothing to charge for. */
function line(
  category: MaterialCategory,
  materialName: string,
  substrateId: string | null,
  sqft: number,
  linearFeet: number | null,
  rate: number | null,
  source: CostSource | null,
): MaterialLine {
  return {
    category,
    materialName,
    substrateId,
    quantitySqft: round1(sqft),
    linearFeet: linearFeet == null ? null : round1(linearFeet),
    ratePerSqft: rate,
    cost: rate == null ? null : round2(rate * sqft),
    costSource: rate == null ? null : source,
  };
}

export interface UsageInput {
  /** Free-text film label from the job (vinyl_type + color). */
  filmLabel: string;
  /** Roll area consumed — film and laminate are billed on this. */
  rollSqft: number;
  /** Printed graphic area — ink and premask are billed on this. */
  graphicSqft: number;
  /** Linear feet of roll pulled, for the film line's second measure. */
  linearFeet: number | null;
  /** Catalog row, when the label resolved to one. */
  substrate: CatalogFilm | null;
  defaults: ShopMaterialDefaults;
  /** The legacy price book: last logged $/ft² for this exact name. */
  lastLoggedFilmRate?: number | null;
}

/**
 * The full consumable set for one roll-plan usage: film, its laminate,
 * premask, and ink. Lines with no resolvable rate are still emitted (with
 * a null cost) so the job shows WHAT it burned even when nobody has
 * priced it — except laminate and premask, which are omitted entirely
 * when the film has no such material configured.
 */
export function buildMaterialLines(input: UsageInput): MaterialLine[] {
  const { filmLabel, rollSqft, graphicSqft, linearFeet, substrate, defaults } = input;
  const out: MaterialLine[] = [];
  const subId = substrate?.id || null;

  // ── Film: the whole roll length pulled, waste included. ──
  const filmRate = substrate?.cost_per_sqft ?? null;
  if (filmRate != null) {
    out.push(line('vinyl', substrate!.name, subId, rollSqft, linearFeet, Number(filmRate), 'catalog'));
  } else if (input.lastLoggedFilmRate != null) {
    out.push(line('vinyl', substrate?.name || filmLabel, subId, rollSqft, linearFeet, Number(input.lastLoggedFilmRate), 'last_logged'));
  } else {
    out.push(line('vinyl', substrate?.name || filmLabel, subId, rollSqft, linearFeet, null, null));
  }

  // ── Laminate: same roll area, only when the film is a laminated pair. ──
  if (substrate?.laminate_name) {
    const lamRate = substrate.laminate_cost_per_sqft;
    out.push(line('laminate', substrate.laminate_name, subId, rollSqft, linearFeet,
      lamRate != null ? Number(lamRate) : null, lamRate != null ? 'catalog' : null));
  }

  // ── Premask: graphic area only — tape never touches the blank margins. ──
  const premaskRate = substrate?.premask_cost_per_sqft ?? defaults.premaskCostPerSqft ?? null;
  const premaskSource: CostSource | null = substrate?.premask_cost_per_sqft != null
    ? 'catalog'
    : defaults.premaskCostPerSqft != null ? 'settings_default' : null;
  if (substrate?.premask_name || premaskRate != null) {
    out.push(line('premask', substrate?.premask_name || 'Application tape', subId, graphicSqft, null,
      premaskRate != null ? Number(premaskRate) : null, premaskSource));
  }

  // ── Ink: graphic area only, for the same reason. ──
  const inkRate = substrate?.ink_cost_per_sqft ?? defaults.inkCostPerSqft ?? null;
  const inkSource: CostSource | null = substrate?.ink_cost_per_sqft != null
    ? 'catalog'
    : defaults.inkCostPerSqft != null ? 'settings_default' : null;
  if (inkRate != null) {
    out.push(line('ink', 'Ink', subId, graphicSqft, null, Number(inkRate), inkSource));
  }

  return out;
}

/** Total of the priced lines, and how many could not be priced. */
export function summarizeLines(lines: MaterialLine[]): { total: number; priced: number; unpriced: number } {
  let total = 0;
  let priced = 0;
  let unpriced = 0;
  for (const l of lines) {
    if (l.cost == null) { unpriced++; continue; }
    total += l.cost;
    priced++;
  }
  return { total: round2(total), priced, unpriced };
}
