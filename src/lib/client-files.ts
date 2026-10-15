/**
 * Client Files: every file in Dropbox /OFFICE/Clients, searchable in
 * FleetSuite (owner ask 2026-10-15, migration 379).
 *
 * Craig's picks: index every file, copy the light ones (PDFs and photos) to
 * R2 so they open instantly, leave the big .ai/.eps print files in Dropbox
 * and fetch them from there on download; Clients only; all staff. He also
 * asked that each client folder match to its customer record so the files
 * show on the customer's page.
 *
 * This file is the pure part, shared by the sync (src/lib/client-files-sync.ts),
 * the routes and the pages: what kind a file is, whether it gets copied,
 * where it sits under Clients, and how a folder name is matched to a
 * customer. Client-safe: no Supabase, no Dropbox.
 */

/** Dropbox folder the copy covers. DROPBOX_CLIENT_FILES_PATH overrides it (server only). */
export const DEFAULT_CLIENT_FILES_ROOT = '/OFFICE/Clients';

/** R2 prefix for copies and thumbnails (staff-readable, see storage-guard.ts). */
export const CLIENT_FILES_R2_PREFIX = 'client-files';

/** Light files bigger than this stay in Dropbox like the print files. */
export const MAX_COPY_BYTES = 50 * 1024 * 1024;

export type ClientFileKind = 'pdf' | 'photo' | 'print' | 'other';

export const CLIENT_FILE_KINDS: readonly ClientFileKind[] = ['pdf', 'photo', 'print', 'other'];

/** Chip labels on the Client Files page. */
export const KIND_LABELS: Record<ClientFileKind, string> = {
  pdf: 'Proofs & PDFs',
  photo: 'Photos',
  print: 'Print files',
  other: 'Other',
};

const PHOTO_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp']);
const PRINT_EXTS = new Set(['ai', 'eps', 'psd', 'svg', 'cdr', 'indd', 'dxf', 'plt', 'fs']);

/** Lowercase extension without the dot ('' when none). */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  const ext = name.slice(i + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export function kindOf(name: string): ClientFileKind {
  const ext = extOf(name);
  if (ext === 'pdf') return 'pdf';
  if (PHOTO_EXTS.has(ext)) return 'photo';
  if (PRINT_EXTS.has(ext)) return 'print';
  return 'other';
}

/** PDFs and photos up to MAX_COPY_BYTES get a copy in R2; everything else is fetched from Dropbox. */
export function isCopyable(kind: ClientFileKind, sizeBytes: number): boolean {
  return (kind === 'pdf' || kind === 'photo') && sizeBytes > 0 && sizeBytes <= MAX_COPY_BYTES;
}

/** Content type for a copy, so a browser shows it inline. */
export function contentTypeFor(ext: string): string {
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'heic': return 'image/heic';
    case 'heif': return 'image/heif';
    case 'tif': case 'tiff': return 'image/tiff';
    case 'bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}

/** Dropbox kinds its thumbnailer handles (photos up to 20 MB, and PDFs). */
export function wantsThumbnail(ext: string): boolean {
  return ['pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'heic'].includes(ext);
}

/** R2 key (under CLIENT_FILES_R2_PREFIX) for a file's copy: stable per Dropbox id, so a new revision overwrites it. */
export function copyKeyFor(dropboxId: string, ext: string): string {
  return `${dropboxId.replace(/^id:/, '')}/file${ext ? `.${ext}` : ''}`;
}

export function thumbKeyFor(dropboxId: string): string {
  return `${dropboxId.replace(/^id:/, '')}/thumb.png`;
}

/**
 * Where a Dropbox path sits under the root: the path below it, and the
 * client folder (its first segment) when the item is inside one. Files
 * loose in the root have no client folder. Null when the path is not under
 * the root at all (or is the root itself).
 */
export function locateUnderRoot(pathDisplay: string, root: string): { relPath: string; clientFolder: string | null } | null {
  const rootLower = root.replace(/\/+$/, '').toLowerCase();
  if (!pathDisplay.toLowerCase().startsWith(rootLower + '/')) return null;
  const relPath = pathDisplay.slice(rootLower.length + 1);
  if (!relPath) return null;
  const slash = relPath.indexOf('/');
  return { relPath, clientFolder: slash > 0 ? relPath.slice(0, slash) : null };
}

/** The client folder's own path (lowercase) for an item under it. */
export function clientFolderPathLower(root: string, clientFolder: string): string {
  return `${root.replace(/\/+$/, '')}/${clientFolder}`.toLowerCase();
}

export function formatBytes(n: number | null | undefined): string {
  const b = Number(n) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${b} B`;
}

// ── Folder → customer matching ──

/** Business-suffix words that don't tell two companies apart. */
const NOISE_WORDS = new Set(['the', 'inc', 'incorporated', 'llc', 'co', 'company', 'corp', 'corporation', 'ltd', 'lp', 'llp', 'pc', 'plc']);

/** Same short forms as src/lib/loose-search.ts, folded to one spelling. */
const FOLD: Record<string, string> = { st: 'saint', mt: 'mount', ft: 'fort', bros: 'brothers', '&': 'and' };

/**
 * A company or folder name as comparable words: lowercase, accents and
 * punctuation dropped, "St" read as "Saint", business suffixes (Inc, LLC,
 * Co, The) left out. "The Home Depot, Inc." → ["home", "depot"].
 */
export function matchWords(name: string | null | undefined): string[] {
  const s = (name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bl l c\b/g, 'llc')
    .trim();
  if (!s) return [];
  return s.split(' ')
    .map(w => FOLD[w] ?? w)
    .filter(w => !NOISE_WORDS.has(w));
}

/**
 * Folder names often carry a note after a dash ("State Farm - Evan",
 * "The Flood Team - Dan"); the part before it is the company.
 */
export function folderNameVariants(folderName: string): string[] {
  const out = [folderName];
  const dash = folderName.split(/\s+[-–—]\s+/);
  if (dash.length > 1 && dash[0].trim()) out.push(dash[0].trim());
  return out;
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity of two strings' letter pairs, 0..1. */
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

export interface MatchableCustomer {
  id: string;
  name: string;
  active?: boolean | null;
}

interface PreparedCustomer extends MatchableCustomer {
  words: string[];
  compact: string;
}

export function prepareCustomers(customers: MatchableCustomer[]): PreparedCustomer[] {
  const out: PreparedCustomer[] = [];
  for (const c of customers) {
    const words = matchWords(c.name);
    if (words.length === 0) continue;
    out.push({ ...c, words, compact: words.join('') });
  }
  return out;
}

/**
 * How alike a folder name and a customer name are, 0..1.
 *   1     same words once punctuation, "The", Inc/LLC and spacing are set
 *         aside ("HomeTeam" = "Home Team", "Fischer MEchanical" =
 *         "Fischer Mechanical, Inc.")
 *   ~0.8+ one name's words all inside the other's ("Spencer Towing" in
 *         "Spencer Towing & Recovery")
 *   else  letter-pair similarity, for typos and run-together names
 */
export function nameSimilarity(folderWords: string[], c: { words: string[]; compact: string }): number {
  if (folderWords.length === 0 || c.words.length === 0) return 0;
  const fCompact = folderWords.join('');
  if (fCompact === c.compact) return 1;
  const fSet = new Set(folderWords);
  const cSet = new Set(c.words);
  const [small, large] = fSet.size <= cSet.size ? [fSet, cSet] : [cSet, fSet];
  const contained = [...small].every(w => large.has(w));
  // A single short word ("CTS", "BMG") inside a long name is too weak to call.
  const meaningful = [...small].some(w => w.length >= 4) || small.size >= 2;
  if (contained && meaningful) return Math.min(0.95, 0.75 + 0.2 * (small.size / large.size));
  return dice(fCompact, c.compact) * 0.9;
}

/** Scores at or above this are worth showing a person. */
export const SUGGEST_THRESHOLD = 0.6;
export const MAX_CANDIDATES = 3;

export interface MatchCandidate {
  customer_id: string;
  name: string;
  score: number;
}

export interface FolderMatch {
  /** auto = one customer with the same name; suggested = close calls for a person; unmatched = nothing close. */
  status: 'auto' | 'suggested' | 'unmatched';
  customerId: string | null;
  score: number | null;
  candidates: MatchCandidate[];
}

/**
 * Match one client folder to a customer. Only an exact name match (as
 * matchWords sees it) with exactly one customer links on its own, which is
 * what Craig was promised; anything less goes to the review list with its
 * best few candidates. Active customers win ties.
 */
export function matchFolder(folderName: string, customers: PreparedCustomer[]): FolderMatch {
  const best = new Map<string, MatchCandidate & { active: boolean }>();
  for (const variant of folderNameVariants(folderName)) {
    const words = matchWords(variant);
    if (words.length === 0) continue;
    for (const c of customers) {
      const score = Math.round(nameSimilarity(words, c) * 1000) / 1000;
      if (score < SUGGEST_THRESHOLD) continue;
      const prev = best.get(c.id);
      if (!prev || score > prev.score) best.set(c.id, { customer_id: c.id, name: c.name, score, active: c.active !== false });
    }
  }
  const ranked = [...best.values()].sort((a, b) =>
    b.score - a.score || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const candidates = ranked.slice(0, MAX_CANDIDATES).map(({ customer_id, name, score }) => ({ customer_id, name, score }));
  if (ranked.length === 0) return { status: 'unmatched', customerId: null, score: null, candidates: [] };

  const exact = ranked.filter(r => r.score === 1);
  // Two customers with the same name: an active one beats inactive copies.
  const exactActive = exact.filter(r => r.active);
  const sole = exact.length === 1 ? exact[0] : exactActive.length === 1 ? exactActive[0] : null;
  if (sole) return { status: 'auto', customerId: sole.customer_id, score: 1, candidates };
  return { status: 'suggested', customerId: null, score: ranked[0].score, candidates };
}
