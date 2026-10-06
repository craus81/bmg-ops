import type { SupabaseClient } from '@supabase/supabase-js';
import { fmtInches } from '@/lib/format';

/**
 * Graphics job ↔ estimate ↔ wrap quote: what a job carries over from the
 * records it was made from, and keeping the three links joined up.
 *
 * Each "create from" path used to set only the link it was created from,
 * so a job made from a wrap quote never learned the quote's estimate/SO
 * (invoicing and the estimate approval couldn't reach it), and a job made
 * from an estimate never learned the estimate's wrap quote (no films, no
 * coverage). These helpers are shared by every path so they fill a job
 * the same way.
 */

/** The estimate columns the helpers below read. */
export const ESTIMATE_LINK_COLUMNS =
  'id, estimate_number, customer_id, customer_name, customer_netsuite_id, title, notes, vin, unit_number, vehicle_year, vehicle_other, po_number, netsuite_so_number, created_by, vehicle_platforms(label)';

/** The wrap quote columns the helpers below read. */
export const WRAP_QUOTE_LINK_COLUMNS =
  'id, quote_number, vehicle_description, customer_id, customer, project_type, project_notes, measurements, total_area_sqft, estimate_id, created_by';

/** "2025 Transit · Unit 12 · VIN 1FTBR3X8XRKA12345" — null when the estimate names no vehicle. */
export function estimateVehicleLine(est: any): string | null {
  if (!est) return null;
  const model = est.vehicle_platforms?.label || est.vehicle_other || null;
  const ymm = [est.vehicle_year, model].filter(Boolean).join(' ');
  const parts = [
    ymm || null,
    est.unit_number ? `Unit ${est.unit_number}` : null,
    est.vin ? `VIN ${est.vin}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The job's PO # from its estimate. The job's PO # becomes the PO field on
 * the job's NetSuite invoice, so the customer's own PO wins; the SO # is
 * the fallback (the PR #1040 behavior) for estimates that have none.
 * soNote says the SO # out loud when it didn't make the PO field.
 */
export function estimateJobPo(est: any): { poNumber: string | null; soNote: string | null } {
  const customerPo = String(est?.po_number || '').trim();
  const so = String(est?.netsuite_so_number || '').trim();
  if (customerPo) return { poNumber: customerPo, soNote: so ? `SO #${so}` : null };
  return { poNumber: so || null, soNote: null };
}

/** What a wrap quote puts on a graphics job: films, laminate, coverage areas. */
export function wrapQuoteJobFields(quote: any): {
  content: string | null;
  vinylType: string | null;
  laminate: string | null;
  notes: string | null;
} {
  const measurements: any[] = Array.isArray(quote?.measurements) ? quote.measurements : [];
  const filmNames = [...new Set(measurements.map(m => m.substrate?.film_name || m.substrate?.name).filter(Boolean))];
  const laminateNames = [...new Set(measurements.map(m => m.substrate?.laminate_name).filter(Boolean))];
  const areaLines = measurements.map(m => {
    const qty = Math.max(1, Number(m.qty) || 1);
    const dims = `${fmtInches(m.dim1_in)}" × ${fmtInches(m.dim2_in)}"`;
    const film = m.substrate?.name ? ` — ${m.substrate.name}` : '';
    return `${m.name || 'Area'}: ${qty > 1 ? `${qty}× ` : ''}${dims}${film}`;
  });
  const totalSqft = Number(quote?.total_area_sqft) || 0;
  const content = [
    ...areaLines,
    totalSqft > 0 ? `Total coverage: ${totalSqft.toFixed(1)} ft²` : null,
  ].filter(Boolean).join('\n') || null;
  return {
    content,
    vinylType: filmNames.length > 0 ? filmNames.join(', ') : null,
    laminate: laminateNames.length > 0 ? laminateNames.join(', ') : null,
    notes: [quote?.project_type, quote?.project_notes].filter(Boolean).join(' — ') || null,
  };
}

/** Join non-empty blocks with a blank line between them. */
export function joinBlocks(...blocks: (string | null | undefined)[]): string | null {
  const kept = blocks.map(b => (b || '').trim()).filter(Boolean);
  return kept.length > 0 ? kept.join('\n\n') : null;
}

/**
 * The wrap quote a job made from this estimate should link to: the one
 * unarchived quote added to the estimate that no live job holds yet.
 * Null when there is none, or more than one (the person links by hand
 * rather than us guessing).
 */
export async function findEstimateWrapQuote(supabase: SupabaseClient, estimateId: string): Promise<any | null> {
  const { data: quotes } = await supabase
    .from('wrap_quotes')
    .select(WRAP_QUOTE_LINK_COLUMNS)
    .eq('estimate_id', estimateId)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
    .limit(20);
  const list = (quotes || []) as any[];
  if (list.length === 0) return null;

  const { data: taken } = await supabase
    .from('graphics_jobs')
    .select('wrap_quote_id')
    .in('wrap_quote_id', list.map(q => q.id))
    .neq('status', 'cancelled');
  const takenIds = new Set(((taken || []) as any[]).map(j => j.wrap_quote_id));
  const free = list.filter(q => !takenIds.has(q.id));
  return free.length === 1 ? free[0] : null;
}

/**
 * A wrap quote just landed on an estimate: any graphics job made from the
 * quote that has no estimate yet now points at it too.
 */
export async function linkQuoteJobsToEstimate(supabase: SupabaseClient, wrapQuoteId: string, estimateId: string) {
  await supabase
    .from('graphics_jobs')
    .update({ estimate_id: estimateId, updated_at: new Date().toISOString() })
    .eq('wrap_quote_id', wrapQuoteId)
    .is('estimate_id', null);
}
