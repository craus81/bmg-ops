import { storage } from '@/lib/storage';
import { toJpegIfHeic } from '@/lib/heic';
import { apiFetch } from '@/lib/api-client';

// One photo onto one or more scan_logs rows: store it under
// photos/scans/<first scan id>/ and record it via /api/scans/photos (one
// scan_photos row per scan). Shared by the Scan screen's photo step and the
// Scans list "+ Photo" (2026-10-28: photos texted/emailed in after the scan).

/** A scan_photos row as /api/scans/photos returns it. */
export interface ScanPhotoRow {
  id: string;
  scan_log_id: string;
  storage_path: string;
  created_at: string | null;
  taken_by: string | null;
}

export async function uploadScanPhoto(
  picked: File,
  scanIds: string[],
): Promise<{ ok: true; rows: ScanPhotoRow[] } | { ok: false; error: string }> {
  if (scanIds.length === 0) return { ok: false, error: 'No scan to attach the photo to' };
  const file = await toJpegIfHeic(picked);
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const path = `scans/${scanIds[0]}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: upErr } = await storage.from('photos').upload(path, file, { contentType: file.type });
  if (upErr) return { ok: false, error: 'Photo upload failed: ' + upErr.message };
  const res = await apiFetch('/api/scans/photos', {
    method: 'POST',
    body: JSON.stringify({ scanIds, storagePath: path, contentType: file.type || undefined }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: 'Photo save failed: ' + (json.error || `HTTP ${res.status}`) };
  return { ok: true, rows: Array.isArray(json.photos) ? json.photos : [] };
}
