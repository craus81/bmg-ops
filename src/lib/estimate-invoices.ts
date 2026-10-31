import { findSoInvoices, isFullyBilledSoStatus, isoDay, stampVehicleInvoice, type SoInvoice, type SoInvoiceLookup } from '@/lib/so-invoices';

/**
 * The invoices billed from an estimate's sales order (migration 461).
 *
 * Owner decision 2026-10-31 (thread "Auto-link invoice when linking a sales
 * order", option C): an existing NetSuite SO linked to an estimate brings its
 * invoices with it, on the estimate and on the estimate's vehicles, partly
 * billed orders included, and estimates already linked fill in once.
 *
 * NetSuite already knows which invoice came from which SO; findSoInvoices
 * (src/lib/so-invoices.ts) reads that. This saves the answer per estimate
 * and passes it on to the estimate's vehicles:
 *
 *   - estimate_invoices replaced whole for the estimate (a voided invoice
 *     drops off), estimates.so_billing / invoices_checked_at stamped.
 *   - each vehicle made from the estimate (source_estimate_id, or the
 *     estimate's fleet_checkin_id) gets the SO on its sales-order list if it
 *     isn't there yet, the same link the completion modal makes when it
 *     converts an estimate, so its record shows the invoices and its Invoice
 *     SO button bills the right order.
 *   - a FULLY billed SO is stamped onto those vehicles with stampVehicleInvoice
 *     (the board's Invoiced badge, the never-invoiced list). A partly billed
 *     one is not: the stamp would lock the rest of the order out of the
 *     completion flow, so it shows as "Partly billed" instead.
 *
 * Nothing is written to NetSuite.
 */

export type SoBilling = 'none' | 'partial' | 'full';

export interface EstimateSoLink {
  id: string;
  netsuite_so_id: string | null;
  netsuite_so_number?: string | null;
  fleet_checkin_id?: string | null;
}

export interface EstimateInvoiceResult {
  invoices: SoInvoice[];
  billing: SoBilling;
  /** Vehicles that got the SO added to their list by this call. */
  vehiclesLinked: number;
  /** Vehicles stamped Invoiced by this call. */
  vehiclesStamped: number;
  /** Labels (year make model, VIN tail) of the estimate's vehicles. */
  vehicleLabels: string[];
}

export function soBilling(invoices: SoInvoice[], soStatus: string | undefined): SoBilling {
  if (invoices.length === 0) return 'none';
  return isFullyBilledSoStatus(soStatus) ? 'full' : 'partial';
}

function vehicleLabel(v: any): string {
  const name = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ');
  const vin = String(v.vin || '');
  return [name, vin ? `VIN …${vin.slice(-4)}` : ''].filter(Boolean).join(' ') || 'a vehicle';
}

/**
 * Save one estimate's invoices from a lookup that already covers its SO and
 * pass them on to its vehicles. Throws when a write fails, so the caller can
 * leave invoices_checked_at alone and retry.
 */
export async function applyEstimateInvoices(
  supabase: any,
  estimate: EstimateSoLink,
  lookup: Pick<SoInvoiceLookup, 'invoices' | 'soStatus'>,
): Promise<EstimateInvoiceResult> {
  const soId = String(estimate.netsuite_so_id || '');
  const invoices = lookup.invoices.get(soId) || [];
  const soStatus = lookup.soStatus.get(soId);
  const billing = soBilling(invoices, soStatus);

  // Replace whole: the ones NetSuite still has, minus anything voided or
  // left over from before.
  const { error: delErr } = await supabase.from('estimate_invoices').delete().eq('estimate_id', estimate.id);
  if (delErr) throw new Error(`estimate_invoices: ${delErr.message}`);
  if (invoices.length > 0) {
    const { error: insErr } = await supabase.from('estimate_invoices').insert(invoices.map(inv => ({
      estimate_id: estimate.id,
      netsuite_so_id: soId,
      netsuite_invoice_id: inv.id,
      invoice_number: inv.tranid,
      invoice_date: isoDay(inv.trandate),
      total: inv.total,
      status: inv.status,
    })));
    if (insErr) throw new Error(`estimate_invoices: ${insErr.message}`);
  }
  const { error: estErr } = await supabase
    .from('estimates')
    .update({ so_billing: billing, invoices_checked_at: new Date().toISOString() })
    .eq('id', estimate.id);
  if (estErr) throw new Error(`estimates: ${estErr.message}`);

  // The estimate's vehicles.
  const or = estimate.fleet_checkin_id
    ? `source_estimate_id.eq.${estimate.id},id.eq.${estimate.fleet_checkin_id}`
    : `source_estimate_id.eq.${estimate.id}`;
  const { data: vehicles, error: vErr } = await supabase
    .from('fleet_checkins')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model')
    .or(or);
  if (vErr) throw new Error(`fleet_checkins: ${vErr.message}`);

  let vehiclesLinked = 0;
  let vehiclesStamped = 0;
  for (const v of vehicles || []) {
    const { data: added, error: linkErr } = await supabase
      .from('fleet_checkin_sales_orders')
      .upsert({
        checkin_id: v.id,
        netsuite_sales_order_id: soId,
        sales_order_number: estimate.netsuite_so_number || null,
      }, { onConflict: 'checkin_id,netsuite_sales_order_id', ignoreDuplicates: true })
      .select('id');
    if (linkErr) console.warn('[estimate-invoices] vehicle SO link failed:', linkErr.message);
    else if ((added || []).length > 0) vehiclesLinked++;

    if (billing === 'full') {
      const out = await stampVehicleInvoice(supabase, v.id, soId, invoices, soStatus);
      if (out.stamped) vehiclesStamped++;
    }
  }

  return { invoices, billing, vehiclesLinked, vehiclesStamped, vehicleLabels: (vehicles || []).map(vehicleLabel) };
}

/** Look up and save one estimate's invoices (Link SO). */
export async function refreshEstimateInvoices(supabase: any, estimate: EstimateSoLink): Promise<EstimateInvoiceResult> {
  const lookup = await findSoInvoices([String(estimate.netsuite_so_id || '')]);
  return applyEstimateInvoices(supabase, estimate, lookup);
}

export interface EstimateInvoiceSyncResult {
  checkedEstimates: number;
  withInvoices: number;
  vehiclesLinked: number;
  vehiclesStamped: number;
  failed: number;
  stoppedEarly: boolean;
}

/** Linked estimates checked per sync run (about five writes each). */
const SYNC_CAP = 60;

/**
 * Background sweep (netsuite-sync): linked estimates not yet fully billed,
 * never-checked first, then oldest-checked, capped per run. That fills in
 * the estimates linked before migration 461 over a few runs, and keeps
 * picking up invoices made later (in NetSuite or with Fulfill & Invoice).
 * A fully billed one is done and isn't swept again; opening the estimate
 * still checks it (/api/estimates/[id]/invoices).
 */
export async function syncEstimateInvoices(
  supabase: any,
  opts: { deadline?: number; cap?: number } = {},
): Promise<EstimateInvoiceSyncResult> {
  const deadline = opts.deadline ?? Date.now() + 15_000;
  const { data: rows, error } = await supabase
    .from('estimates')
    .select('id, netsuite_so_id, netsuite_so_number, fleet_checkin_id')
    .not('netsuite_so_id', 'is', null)
    .or('so_billing.is.null,so_billing.neq.full')
    .order('invoices_checked_at', { ascending: true, nullsFirst: true })
    .order('id')
    .range(0, (opts.cap ?? SYNC_CAP) - 1);
  if (error) throw new Error(`estimates: ${error.message}`);

  const estimates = ((rows || []) as EstimateSoLink[]).filter(e => /^\d{1,15}$/.test(String(e.netsuite_so_id || '')));
  const result: EstimateInvoiceSyncResult = {
    checkedEstimates: 0, withInvoices: 0, vehiclesLinked: 0, vehiclesStamped: 0, failed: 0, stoppedEarly: false,
  };
  if (estimates.length === 0) return result;
  if (Date.now() >= deadline) return { ...result, stoppedEarly: true };

  const lookup = await findSoInvoices(estimates.map(e => String(e.netsuite_so_id)));
  for (const est of estimates) {
    if (Date.now() >= deadline) { result.stoppedEarly = true; break; }
    try {
      const out = await applyEstimateInvoices(supabase, est, lookup);
      result.checkedEstimates++;
      if (out.invoices.length > 0) result.withInvoices++;
      result.vehiclesLinked += out.vehiclesLinked;
      result.vehiclesStamped += out.vehiclesStamped;
    } catch (err) {
      result.failed++;
      console.warn('[estimate-invoices] estimate', est.id, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

/** What the person sees after Link SO, invoices and vehicles included. */
export function linkMessage(soNumber: string, inv: EstimateInvoiceResult | null): string {
  const lines = [`Linked SO #${soNumber} to this estimate.`];
  if (!inv) {
    lines.push("Couldn't check NetSuite for invoices just now. The next sync (within 2 hours) will add any.");
    return lines.join('\n\n');
  }
  const n = inv.invoices.length;
  const numbers = inv.invoices.map(i => i.tranid);
  const list = numbers.length <= 1 ? numbers.join('') : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;
  if (n === 0) lines.push('Nothing has been billed from it yet. Invoices will show up on the estimate by themselves once they are made.');
  else lines.push(`Found ${n} invoice${n === 1 ? '' : 's'} billed from it: ${list}.${inv.billing === 'partial' ? ' The order is partly billed.' : ''} They're on the estimate now.`);
  const v = inv.vehicleLabels.length;
  if (v > 0) lines.push(`Added to ${v} vehicle${v === 1 ? '' : 's'} from this estimate (${inv.vehicleLabels.join(', ')}).`);
  return lines.join('\n\n');
}
