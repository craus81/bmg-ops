/**
 * Verizon RFID install helpers — shared by the main scan flow, the CNI
 * installer capture flow, and the server route that logs to scan_logs.
 *
 * A Verizon RFID install (part 06CS901033) captures three device identifiers
 * off the unit's label in addition to the vehicle VIN: a serial number (SN),
 * a 15-digit cellular IMEI, and the SIM card's ICCID (the "CCID" on the
 * label, ~19-20 digits).
 */

export const VERIZON_RFID_PART = '06CS901033';

// Part numbers visually conflate O/0 — normalize before comparing.
export const normalizePartNumber = (s: string | null | undefined): string =>
  (s || '').toUpperCase().replace(/O/g, '0').replace(/\s+/g, '');

export const isVerizonRfidPart = (partNumber: string | null | undefined): boolean =>
  normalizePartNumber(partNumber) === VERIZON_RFID_PART;

// Per-field acceptance. Each returns the cleaned value, or null to reject.
export const validateSerial = (raw: string): string | null => {
  const c = (raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length >= 4 ? c : null;
};
export const validateImei = (raw: string): string | null => {
  const d = (raw || '').replace(/\D/g, '');
  return d.length === 15 ? d : null;
};
export const validateIccid = (raw: string): string | null => {
  const d = (raw || '').replace(/\D/g, '');
  return d.length >= 18 && d.length <= 22 ? d : null;
};
