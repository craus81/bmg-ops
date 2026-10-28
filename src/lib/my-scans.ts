// "My scans" on the Scan screen (Craig, 2026-10-20): the person's own scans
// and the photos they took, so a tech — outside installers included — can
// look back at their work. Pure grouping, shared by the route and its test.

export interface MyScanRow {
  id: string;
  vin: string;
  part_number: string | null;
  unit_number: string | null;
  stock_number?: string | null;
  billable_customer: string | null;
  location_name: string | null;
  vehicle_year: number | string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  scanned_at: string;
}

export interface MyScanPhotoRow {
  scan_log_id: string;
  storage_path: string;
  created_at: string;
}

export interface MyScanGroup {
  /** The first scan's id: stable key for the list. */
  id: string;
  vin: string;
  vehicle: string | null;
  parts: string[];
  unitNumber: string | null;
  stockNumber: string | null;
  customer: string | null;
  location: string | null;
  /** Earliest scan time in the group. */
  scannedAt: string;
  /** Storage paths, oldest first, each once. */
  photoPaths: string[];
}

/** Days back the list can look. */
export const MY_SCANS_RANGES = [1, 7, 30] as const;
export type MyScansRange = typeof MY_SCANS_RANGES[number];

/**
 * One entry per vehicle per day. A multi-part capture logs one scan row per
 * part and hangs the same photo on each (api/scans/photos), so the rows are
 * folded together and the photo shows once.
 */
export function groupMyScans(scans: MyScanRow[], photos: MyScanPhotoRow[], dayKey: (iso: string) => string): MyScanGroup[] {
  const photosByScan = new Map<string, MyScanPhotoRow[]>();
  for (const p of [...photos].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const list = photosByScan.get(p.scan_log_id) || [];
    list.push(p);
    photosByScan.set(p.scan_log_id, list);
  }

  const groups = new Map<string, MyScanGroup>();
  const sorted = [...scans].sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
  for (const s of sorted) {
    const key = `${s.vin}|${dayKey(s.scanned_at)}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        id: s.id,
        vin: s.vin,
        vehicle: [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ') || null,
        parts: [],
        unitNumber: s.unit_number,
        stockNumber: s.stock_number ?? null,
        customer: s.billable_customer,
        location: s.location_name,
        scannedAt: s.scanned_at,
        photoPaths: [],
      };
      groups.set(key, g);
    }
    if (s.part_number && !g.parts.includes(s.part_number)) g.parts.push(s.part_number);
    if (s.scanned_at < g.scannedAt) g.scannedAt = s.scanned_at;
    g.unitNumber = g.unitNumber || s.unit_number;
    g.stockNumber = g.stockNumber || s.stock_number || null;
    g.customer = g.customer || s.billable_customer;
    for (const p of photosByScan.get(s.id) || []) {
      if (!g.photoPaths.includes(p.storage_path)) g.photoPaths.push(p.storage_path);
    }
  }
  return [...groups.values()];
}
