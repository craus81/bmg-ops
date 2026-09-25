// Opening stored files inside the iPhone app.
//
// A target="_blank" link in the Capacitor app is handed to Safari, which has
// no FleetSuite session, so /api/storage/download answers "Unauthorized" and a
// download (the Download all zip) just does nothing in the app's web view.
// In the app we fetch the file ourselves instead and either show it in
// ProofViewer or hand it to the iOS share sheet (Save to Files, AirDrop,
// Print). Computers keep the plain links.

import { storageDownloadUrl } from './storage';

export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return !!(window as any).Capacitor?.isNativePlatform?.();
  } catch {
    return false;
  }
}

const VIEWABLE_EXT = new Set(['pdf', 'ai', 'jpg', 'jpeg', 'png', 'gif', 'webp']);

/** Files ProofViewer can draw: PDFs (and PDF-compatible .ai) and common images. */
export function isViewableInApp(fileName: string, fileType?: string | null): boolean {
  const type = (fileType || '').toLowerCase();
  if (type === 'application/pdf') return true;
  if (type.startsWith('image/') && !/heic|heif|photoshop|postscript|tiff/.test(type)) return true;
  const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  return VIEWABLE_EXT.has(ext);
}

/**
 * Download a stored file into memory. Asks the download route for a
 * short-lived R2 link (the request carries the app's session cookie), then
 * fetches that link without credentials so R2's CORS rule applies. Large
 * design files skip the serverless function this way.
 */
export async function fetchStoredFile(
  bucket: string,
  path: string,
  fileName: string,
  fileType?: string | null,
): Promise<File> {
  const res = await fetch(`${storageDownloadUrl(bucket, path, fileName)}&format=json`, { credentials: 'include' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.url) throw new Error(body?.error || `HTTP ${res.status}`);
  const file = await fetch(body.url, { credentials: 'omit' });
  if (!file.ok) throw new Error(`HTTP ${file.status}`);
  const blob = await file.blob();
  return new File([blob], fileName, { type: fileType || blob.type || 'application/octet-stream' });
}

export function canShareFiles(files: File[]): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}
