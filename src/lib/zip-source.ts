import JSZip from 'jszip';
import { r2Get } from './r2';

// Bulk-upload ZIPs are staged in R2 first (browser -> presigned PUT via
// lib/storage), then referenced by key, because serverless request bodies
// are capped around 4.5MB and template ZIPs run far larger. The legacy
// multipart path is kept for small files / older clients.
//
// Staged keys live under the vehicle-templates prefix at zips/<timestamp>-
// <name>.zip; the client deletes them after a successful import.

export const ZIP_STAGING_PREFIX = 'vehicle-templates';

export function isStagedZipPath(p: unknown): p is string {
  return typeof p === 'string' && /^zips\/[A-Za-z0-9._-]{1,200}\.zip$/.test(p);
}

export async function loadStagedZip(zipPath: string): Promise<JSZip | null> {
  const r = await r2Get(ZIP_STAGING_PREFIX, zipPath);
  if (!r.success || !r.body) return null;
  const buf = await new Response(r.body).arrayBuffer();
  return JSZip.loadAsync(buf);
}
