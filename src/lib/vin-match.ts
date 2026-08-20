/**
 * Same-vehicle VIN matching.
 *
 * Vehicles enter the system with inconsistent VIN precision: handheld/camera
 * scans capture all 17 characters, while bulk and worksheet entry is usually
 * just the last 8 an installer read off the door jamb (sometimes fewer).
 * Exact string equality therefore misses real duplicates — a van bulk-entered
 * by its last 8 and later re-scanned in full are two different strings for the
 * same vehicle.
 *
 * Two entries are treated as the same vehicle when the shorter entry's
 * trailing characters (capped at the last 8) are a suffix of the other. The
 * last 8 of a VIN carry the model year, plant, and serial number — for one
 * fleet's scan history they are unique per vehicle for practical purposes,
 * which is the same assumption the fleet check-in "last 8" lookup makes.
 *
 * Client-safe: pure helpers plus a query that works with any Supabase client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { partNumberPattern } from './part-number';

/** Normalized match key: uppercase alphanumerics only, last 8 characters. */
export function vinTail(vin: string): string {
  return vin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-8);
}

/** True when two VIN entries (full, last-8, or shorter partials) refer to the same vehicle. */
export function sameVehicleVin(a: string, b: string): boolean {
  const ta = vinTail(a);
  const tb = vinTail(b);
  if (!ta || !tb) return false;
  return ta.length <= tb.length ? tb.endsWith(ta) : ta.endsWith(tb);
}

/**
 * PostgREST `.or()` disjunction matching scan_logs rows for the same vehicle:
 * rows whose vin ends with this vin's tail (full VINs and last-8 entries),
 * plus shorter partial entries (5–7 chars) that are a suffix of this vin.
 * Returns '' when the vin is too short to match safely — callers must skip.
 */
export function vinMatchOrFilter(vin: string): string {
  const cleaned = vin.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tail = cleaned.slice(-8);
  if (tail.length < 5) return '';
  const clauses = [`vin.like.%${tail}`];
  const shorterLens = [5, 6, 7].filter(n => n < Math.min(8, cleaned.length));
  if (shorterLens.length > 0) {
    clauses.push(`vin.in.(${shorterLens.map(n => cleaned.slice(-n)).join(',')})`);
  }
  return clauses.join(',');
}

/**
 * Fetch existing scan_logs VINs that refer to any of the given vehicles,
 * optionally scoped to one part number. Queries in chunks so a large pasted
 * batch stays within URL limits. Callers decide what "duplicate" means by
 * comparing results with sameVehicleVin.
 */
export async function findExistingScanVins(
  client: Pick<SupabaseClient, 'from'>,
  vins: string[],
  partNumber?: string | null,
): Promise<string[]> {
  const filters = [...new Set(vins.map(vinMatchOrFilter).filter(Boolean))];
  const out: string[] = [];
  for (let i = 0; i < filters.length; i += 25) {
    let q = client.from('scan_logs').select('vin').or(filters.slice(i, i + 25).join(','));
    // Case-insensitive: a scan logged as 06u166 is the same part as 06U166.
    if (partNumber) q = q.ilike('part_number', partNumberPattern(partNumber));
    const { data } = await q;
    for (const s of (data || []) as { vin: string }[]) out.push(s.vin);
  }
  return out;
}

/**
 * Fetch full scan_logs rows matching any of the given vehicles (same
 * chunked same-vehicle query as findExistingScanVins, but returning the
 * columns the caller asks for), newest scan first.
 */
export async function fetchScansMatchingVins<T extends { vin: string }>(
  client: Pick<SupabaseClient, 'from'>,
  vins: string[],
  columns: string,
): Promise<T[]> {
  const filters = [...new Set(vins.map(vinMatchOrFilter).filter(Boolean))];
  const out: T[] = [];
  for (let i = 0; i < filters.length; i += 25) {
    const { data } = await client
      .from('scan_logs')
      .select(columns)
      .or(filters.slice(i, i + 25).join(','))
      .order('scanned_at', { ascending: false });
    out.push(...((data || []) as unknown as T[]));
  }
  return out;
}

/**
 * Which existing scan (if any) a vendor-invoice line for (vin, partNumber)
 * belongs to. Same-vehicle candidates only; a line WITH a part number
 * attaches to a scan carrying that part, or one with no part yet — never a
 * scan for a DIFFERENT part, because that's a separate install on the same
 * vehicle and deserves its own scan row. A line with no part attaches to
 * the newest same-vehicle scan. Candidates must be sorted newest first.
 */
export function pickScanForLine<T extends { vin: string; part_number: string | null }>(
  candidates: T[],
  vin: string,
  partNumber: string | null,
): T | null {
  const sameVehicle = candidates.filter(s => sameVehicleVin(s.vin, vin));
  if (!partNumber) return sameVehicle[0] || null;
  const upper = partNumber.toUpperCase();
  return (
    sameVehicle.find(s => (s.part_number || '').toUpperCase() === upper) ||
    sameVehicle.find(s => !s.part_number) ||
    null
  );
}
