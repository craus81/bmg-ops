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
 *     so a caller can't create or destroy objects under an arbitrary prefix;
 *   - scopes BOTH operations by caller tier (R3-22): staff read anything
 *     non-denied, external installers only their floor prefixes, and
 *     customer-only accounts nothing — see StorageAccess below. Before the
 *     R2 flip the bucket was public-read, so reads were deliberately not
 *     scoped; once these routes are the read path, they are the wall.
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
 * Caller tiers for the generic storage routes (R3-22, owner decision C2
 * 2026-09-07). Once the public R2 domain is edge-limited, these routes ARE
 * the read path, so who may read what finally matters:
 *   'staff'     — internal BMG staff: every non-denied prefix.
 *   'installer' — external CNI installers: only the prefixes their surfaces
 *                 actually render (pick-list proofs/photos/guides, the scan
 *                 page's part proofs, their own invoice + profile-doc
 *                 uploads). Deliberately NOT cni-photos: those reads go
 *                 through the record-scoped CNI routes (#765), and the
 *                 generic route must not become a cross-company bypass.
 *   'none'      — customer-only accounts: denied. Every customer surface
 *                 (portal PDFs, approval pages, signed docs) presigns
 *                 server-side with its own record checks.
 * Compute the tier with storageAccessOf() from api-auth.
 */
export type StorageAccess = 'staff' | 'installer' | 'none';

export const INSTALLER_READ_PREFIXES = new Set<string>([
  'photos',
  'graphics-proofs',
  'graphics-files',
  'proofs',
  'install-guides',
  'part-files',
  'vehicle-templates',
  'invoices',
  'cni-docs',
]);

export const INSTALLER_WRITE_PREFIXES = new Set<string>([
  'photos', // pick-list / PhotoSession uploads
  'invoices', // their own vendor invoices
  'cni-docs', // W-9s, insurance certs on their profile
]);

/**
 * Returns an error message if the (bucket, path) pair is not allowed for the
 * requested operation at the caller's access tier, or null to proceed.
 */
export function checkStoragePath(
  bucket: string,
  path: string,
  opts: { write: boolean; access: StorageAccess },
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

  if (opts.access === 'none') return 'Forbidden';

  if (opts.write) {
    if (!ALLOWED_STORAGE_PREFIXES.has(bucket)) return 'Forbidden bucket';
    if (opts.access === 'installer' && !INSTALLER_WRITE_PREFIXES.has(bucket)) {
      return 'Forbidden bucket';
    }
    return null;
  }

  if (opts.access === 'installer' && !INSTALLER_READ_PREFIXES.has(bucket)) {
    return 'Forbidden bucket';
  }
  return null;
}
