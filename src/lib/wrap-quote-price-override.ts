// Manual final price on a wrap quote. The rep types the pre-tax price they
// want; every money figure the customer sees (shape lines, roll material
// rows, install and labor rows, the kit rollup) is scaled by the same
// factor so the quote reads like a normal one and still adds up to the
// subtotal. The overrides themselves live in wrap_quotes.pricing_overrides
// (migration 356), never in the customer-facing snapshot.

export interface WrapPricingOverrides {
  /** Pre-tax price typed by the rep; null = calculated. */
  final_price: number | null;
  /** Vinyl $/ft² per film id for this quote. */
  vinyl_rates: Record<string, number>;
  /** Install labor $/ft² per film id for this quote (unscaled). */
  labor_rates: Record<string, number>;
  /** The Qty Discount field as typed ('' = auto from the settings tiers). */
  discount_pct: string;
}

const n = (v: unknown) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : 0;
};

/** Typed rate/price fields → numbers, dropping blanks and junk. */
export function parseRateMap(map: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(map)) {
    if (v == null || String(v).trim() === '') continue;
    const x = parseFloat(String(v));
    if (Number.isFinite(x) && x >= 0) out[id] = x;
  }
  return out;
}

/** The final price field, or null when it's blank / not a positive number. */
export function parseFinalPrice(text: string): number | null {
  if (text.trim() === '') return null;
  const x = parseFloat(text);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** Read a saved quote's overrides, tolerating rows saved before migration 356. */
export function readPricingOverrides(raw: any): WrapPricingOverrides | null {
  if (!raw || typeof raw !== 'object') return null;
  const rates = (m: any) => (m && typeof m === 'object'
    ? Object.fromEntries(Object.entries(m).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]))
    : {});
  const fp = Number(raw.final_price);
  return {
    final_price: raw.final_price != null && Number.isFinite(fp) && fp > 0 ? fp : null,
    vinyl_rates: rates(raw.vinyl_rates),
    labor_rates: rates(raw.labor_rates),
    discount_pct: typeof raw.discount_pct === 'string' ? raw.discount_pct : '',
  };
}

/**
 * Scale the customer-visible money in a wrap quote snapshot by `k`
 * (final price ÷ calculated subtotal). Sizes, quantities and the stored
 * materials_total / labor_total / subtotal / tax / total are left alone —
 * the caller already computed those from the final price.
 */
export function scaleQuoteSnapshot<T extends Record<string, any>>(snap: T, k: number): T {
  if (!(k > 0) || Math.abs(k - 1) < 1e-9) return snap;
  const s = (v: unknown) => (v == null ? v : n(v) * k);
  const out: any = { ...snap };
  out.measurements = (snap.measurements || []).map((l: any) => ({
    ...l,
    unit_price: s(l.unit_price),
    line_total: s(l.line_total),
    substrate: l.substrate ? { ...l.substrate, price_per_sqft: s(l.substrate.price_per_sqft) } : l.substrate,
  }));
  if (snap.nesting) {
    out.nesting = {
      ...snap.nesting,
      films: (snap.nesting.films || []).map((f: any) => ({
        ...f, rate_per_sqft: s(f.rate_per_sqft), material_total: s(f.material_total),
      })),
    };
  }
  if (snap.labor) {
    const sec = (x: any) => (x ? { ...x, total: s(x.total) } : x);
    out.labor = {
      ...snap.labor,
      design: sec(snap.labor.design),
      preparation: sec(snap.labor.preparation),
      installation: sec(snap.labor.installation),
      films: (snap.labor.films || []).map((f: any) => ({ ...f, rate: s(f.rate), total: s(f.total) })),
    };
  }
  if (snap.adjustments) {
    const a = snap.adjustments;
    out.adjustments = {
      ...a,
      kit_materials: s(a.kit_materials),
      pre_materials: s(a.pre_materials),
      pre_labor: s(a.pre_labor),
      pre_subtotal: s(a.pre_subtotal),
    };
  }
  return out as T;
}
