/**
 * Access guard for the R2 storage API (/api/storage, /presign, /download).
 *
 * There is ONE physical R2 bucket (R2_BUCKET_NAME, default 'fleetsuite', see
 * src/lib/r2.ts). The "bucket" callers pass is a key PREFIX inside it — the
 * stored key is `${bucket}/${path}`. The routes previously took an arbitrary
 * bucket+path on a service-role client behind bare auth, so any approved
 * account could read, overwrite, or delete ANY object — including the signed,
 * hashed E-SIGN approval snapshots under the `signed-documents/` prefix.
 *
 * This guard:
 *   - blocks the `signed-documents` prefix for every operation (it is written
 *     only server-side by the approval flow and must never be reachable here);
 *   - rejects path traversal / absolute / control-char paths;
 *   - limits WRITES and DELETES to the app's known prefixes (an allowlist),
 *     so a caller can't create or destroy objects under an arbitrary prefix.
 *
 * Reads are not allowlisted (the bucket is public-read, so an auth-gated read
 * of a well-formed, non-denied prefix is not a regression) — but the
 * signed-documents deny and the traversal checks still apply.
 */

// Prefixes the app legitimately writes to / deletes from through the client
// storage API. Compiled from every `storage.from(...)` / storageDownloadUrl
// call site plus the server-side r2* helpers. `signed-documents` is
// deliberately absent.
export const ALLOWED_STORAGE_PREFIXES = new Set<string>([
  'photos',
  'graphics-proofs',
  'graphics-files',
  'vehicle-templates',
  'cni-docs',
  'cni-photos',
  'upfit-files',
  'invoices',
  'knowledge-files',
  'prospect-files',
  'parts-invoices',
  'proofs',
  'po-pdfs',
  'part-files',
  'quote-diagrams',
  'install-guides',
]);

// Never reachable through the storage API, for any operation.
const DENIED_STORAGE_PREFIXES = new Set<string>(['signed-documents']);

// Top-level prefixes are lowercase kebab tokens (photos, graphics-proofs, …).
const PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * Returns an error message if the (bucket, path) pair is not allowed for the
 * requested operation, or null if it is fine to proceed.
 */
export function checkStoragePath(
  bucket: string,
  path: string,
  opts: { write: boolean },
): string | null {
  if (!PREFIX_RE.test(bucket)) return 'Invalid bucket';
  if (DENIED_STORAGE_PREFIXES.has(bucket)) return 'Forbidden bucket';

  // Path-traversal / absolute-path / control-char defense.
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('..') ||
    path.includes('\\') ||
    path.includes('\0')
  ) {
    return 'Invalid path';
  }

  if (opts.write && !ALLOWED_STORAGE_PREFIXES.has(bucket)) {
    return 'Forbidden bucket';
  }

  return null;
}
