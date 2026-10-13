/**
 * Completion Photos: finished-work photos from every job in one place.
 *
 * The rows come from the completion_photos view (migration 369), which
 * unions shop completion photos (vehicle_photos), outside-installer photos
 * (cni_job_photos) and scan photos (scan_photos) into one shape. Every
 * file lives under the 'photos' storage prefix.
 *
 * Pure and client-safe: the page, the staff API and the public share link
 * all name files and build links the same way through here.
 */

import { deepLinks } from './deep-links';

export type CompletionPhotoSource = 'shop' | 'installer' | 'scan';

export const COMPLETION_PHOTO_SOURCES: CompletionPhotoSource[] = ['shop', 'installer', 'scan'];

export const SOURCE_LABELS: Record<CompletionPhotoSource, string> = {
  shop: 'Shop',
  installer: 'Installer',
  scan: 'Scan',
};

/** One completion_photos view row. */
export interface CompletionPhotoRow {
  id: string;
  source: CompletionPhotoSource;
  storage_path: string;
  taken_at: string | null;
  taken_by: string | null;
  customer_name: string | null;
  vin: string | null;
  vehicle: string | null;
  job_label: string | null;
  record_id: string | null;
}

/** View ids are '<source>:<uuid>'. Anything else is not a photo id. */
const PHOTO_ID_RE = /^(shop|installer|scan):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCompletionPhotoId(id: unknown): id is string {
  return typeof id === 'string' && PHOTO_ID_RE.test(id);
}

/** Keep a file-name part safe on every OS, and short. */
function namePart(s: string | null | undefined): string {
  return (s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * The name a photo saves under: "Orkin – SO-24817 – A41927 – 1.jpg".
 * Customer, job and the VIN's last 6 are what a person sorting a folder of
 * these needs; `n` keeps several photos of one vehicle apart.
 */
export function completionPhotoFileName(
  row: Pick<CompletionPhotoRow, 'customer_name' | 'job_label' | 'vin' | 'storage_path'>,
  n: number,
): string {
  const ext = (row.storage_path.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
  const vin = (row.vin || '').trim();
  const parts = [
    namePart(row.customer_name),
    namePart(row.job_label),
    vin ? namePart(vin.slice(-6).toUpperCase()) : '',
  ].filter(Boolean);
  if (parts.length === 0) parts.push('Photo');
  return `${parts.join(' – ')} – ${n}.${ext}`;
}

/** Give repeated names a running number so a zip never overwrites a file. */
export function numberedFileNames(rows: Pick<CompletionPhotoRow, 'customer_name' | 'job_label' | 'vin' | 'storage_path'>[]): string[] {
  const seen = new Map<string, number>();
  return rows.map(r => {
    const key = completionPhotoFileName(r, 0);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return completionPhotoFileName(r, n);
  });
}

/** Where a photo came from inside the app: the job or vehicle it belongs to. */
export function completionPhotoRecordLink(row: Pick<CompletionPhotoRow, 'source' | 'record_id' | 'vin'>): string | null {
  if (row.source === 'shop' && row.record_id) return deepLinks.vehicle(row.record_id);
  if (row.source === 'installer' && row.record_id) return deepLinks.cniJobPhotos(row.record_id);
  if (row.vin) return deepLinks.vehicleRecord(row.vin);
  return null;
}
