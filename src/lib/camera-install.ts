/**
 * Camera installs (migration 343): a Surfsight camera + Geotab GO9B put in a
 * vehicle for a T-Mobile program. Its own process, separate from check-in,
 * sales orders and the upfit flow — see /camera-installs.
 *
 * Shared by the scan page (client) and /api/camera-installs (server), so a
 * barcode the scanner accepts is exactly what the server will save.
 */

export interface CameraInstall {
  id: string;
  customer_id: string | null;
  customer_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  vin: string;
  vehicle_year: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  odometer: number | null;
  license_plate: string | null;
  camera_imei: string;
  go9b_imei: string;
  checkin_id: string | null;
  notes: string | null;
  installed_by: string | null;
  installed_by_name?: string | null;
  installed_at: string;
  updated_at: string;
}

/**
 * Luhn check — the last digit of every real IMEI is a Luhn check digit, so
 * this rejects a misread digit and most of the other numbers printed on a
 * device label (part numbers, dates, the serial).
 */
export function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * A scanned or typed IMEI → the 15 digits, or null to reject it. Labels
 * sometimes encode "IMEI:" or spaces with the number, so non-digits are
 * stripped first; anything that isn't 15 digits passing the Luhn check is
 * the wrong barcode.
 */
export function cleanImei(raw: string): string | null {
  const d = (raw || '').replace(/\D/g, '');
  return d.length === 15 && luhnOk(d) ? d : null;
}

/** Group an IMEI for reading off a screen or page: 35 123456 789012 3. */
export function formatImei(imei: string | null | undefined): string {
  const d = (imei || '').replace(/\D/g, '');
  if (d.length !== 15) return imei || '';
  return `${d.slice(0, 2)} ${d.slice(2, 8)} ${d.slice(8, 14)} ${d.slice(14)}`;
}

export function vehicleLabel(r: Pick<CameraInstall, 'vehicle_year' | 'vehicle_make' | 'vehicle_model'>): string {
  return [r.vehicle_year, r.vehicle_make, r.vehicle_model].filter(Boolean).join(' ');
}

export const CAMERA_INSTALL_CSV_HEADERS = [
  'Installed', 'Customer', 'Contact', 'Phone', 'Email',
  'Year', 'Make', 'Model', 'VIN', 'Odometer', 'License Plate',
  'Camera IMEI', 'GO9B IMEI', 'Installed By', 'Notes',
];

export function cameraInstallCsvRow(r: CameraInstall): (string | number | null)[] {
  return [
    new Date(r.installed_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago' }),
    r.customer_name, r.contact_name, r.contact_phone, r.contact_email,
    r.vehicle_year, r.vehicle_make, r.vehicle_model, r.vin, r.odometer, r.license_plate,
    r.camera_imei, r.go9b_imei, r.installed_by_name || '', r.notes,
  ];
}
