/**
 * The company default labor rate: the $/hour a NEW estimate sells labor at.
 *
 * Set in Settings -> Default Labor Rate by a super admin, stored on the
 * singleton `quote_settings` row (migration 330). The estimate builder's
 * Labor Rate box still starts from it and stays editable per estimate; a
 * saved estimate keeps the rate it was quoted at.
 *
 * Not shop_labor_cost_rate (src/lib/shop-labor.ts), which is what an hour
 * COSTS the company.
 */

/** Used only when the settings row can't be read (owner decision: $120). */
export const FALLBACK_LABOR_RATE = 120;

type AnySupabase = {
  from: (table: string) => any;
};

/** null/undefined/''/negative are MISSING, never a silent $0 labor rate. */
export function toLaborRate(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Read the configured default labor rate ($/hour). Never throws. */
export async function getDefaultLaborRate(supabase: AnySupabase): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('quote_settings')
      .select('default_labor_rate')
      .eq('id', 1)
      .maybeSingle();
    if (error) return FALLBACK_LABOR_RATE;
    return toLaborRate(data?.default_labor_rate) ?? FALLBACK_LABOR_RATE;
  } catch {
    return FALLBACK_LABOR_RATE;
  }
}
