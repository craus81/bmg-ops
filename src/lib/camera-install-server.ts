/**
 * Server-side pieces of /api/camera-installs (create + edit share them).
 * See src/lib/camera-install.ts and migration 343.
 */

import { isValidVIN } from '@/lib/vin-decoder';
import { cleanImei, formatImei } from '@/lib/camera-install';

export const CAMERA_INSTALL_SELECT =
  '*, installer:profiles!camera_installs_installed_by_fkey(full_name)';

/** Flatten the embedded installer profile into installed_by_name. */
export function withInstallerName(row: any) {
  const { installer, ...rest } = row || {};
  return { ...rest, installed_by_name: installer?.full_name || null };
}

export interface CameraInstallInput {
  customer_id?: string | null;
  customer_name: string;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  vin: string;
  vehicle_year?: string | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  odometer?: number | null;
  license_plate?: string | null;
  camera_imei: string;
  go9b_imei: string;
  notes?: string | null;
}

const blank = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);

/** Validate + normalize what the page sent into the row to save. */
export function cameraInstallFields(b: CameraInstallInput):
  { values: Required<CameraInstallInput> } | { error: string } {
  const vin = b.vin.trim().toUpperCase();
  if (!isValidVIN(vin)) return { error: 'That VIN isn’t valid. Rescan it.' };
  const camera = cleanImei(b.camera_imei);
  if (!camera) return { error: 'The camera IMEI isn’t a valid 15-digit IMEI. Rescan it.' };
  const go9b = cleanImei(b.go9b_imei);
  if (!go9b) return { error: 'The GO9B IMEI isn’t a valid 15-digit IMEI. Rescan it.' };
  if (camera === go9b) return { error: 'The camera and GO9B IMEIs are the same number. One of them is the wrong barcode.' };
  return {
    values: {
      customer_id: b.customer_id || null,
      customer_name: b.customer_name.trim(),
      contact_name: blank(b.contact_name),
      contact_phone: blank(b.contact_phone),
      contact_email: blank(b.contact_email),
      vin,
      vehicle_year: blank(b.vehicle_year),
      vehicle_make: blank(b.vehicle_make),
      vehicle_model: blank(b.vehicle_model),
      odometer: b.odometer ?? null,
      license_plate: blank(b.license_plate)?.toUpperCase() ?? null,
      camera_imei: camera,
      go9b_imei: go9b,
      notes: blank(b.notes),
    },
  };
}

/**
 * Is either IMEI already recorded on a DIFFERENT vehicle? Returns a message
 * naming it, or null. The same VIN is fine (a redo of the same van). A device
 * can legitimately move vans, so the page lets the tech save anyway.
 */
export async function imeiConflicts(
  service: any,
  v: { vin: string; camera_imei: string; go9b_imei: string },
  excludeId: string | null,
): Promise<string | null> {
  let query = service
    .from('camera_installs')
    .select('id, vin, camera_imei, go9b_imei, customer_name')
    .or(`camera_imei.in.(${v.camera_imei},${v.go9b_imei}),go9b_imei.in.(${v.camera_imei},${v.go9b_imei})`)
    .neq('vin', v.vin)
    .limit(5);
  if (excludeId) query = query.neq('id', excludeId);
  const { data } = await query;
  const hit = (data || [])[0];
  if (!hit) return null;
  const imei = [v.camera_imei, v.go9b_imei].find(i => i === hit.camera_imei || i === hit.go9b_imei) || v.camera_imei;
  return `IMEI ${formatImei(imei)} is already recorded on VIN ${hit.vin}${hit.customer_name ? ` (${hit.customer_name})` : ''}.`;
}

/** The vehicle's FleetSuite check-in for this VIN, newest first, if any. */
export async function findCheckinId(service: any, vin: string): Promise<string | null> {
  const { data } = await service
    .from('fleet_checkins')
    .select('id')
    .eq('vin', vin)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id || null;
}
