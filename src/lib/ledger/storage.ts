import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { r2GetBytes, r2Head, r2Upload } from '@/lib/r2';
import { ledgerPdfsEnabled } from './pdf-gate';

/**
 * Where ledger documents live in R2, the only function that puts one there,
 * and the rules for how those bytes are allowed back out.
 *
 * There is ONE physical R2 bucket; the "bucket" every helper takes is a key
 * prefix inside it (src/lib/r2.ts). `ledger` is in DENIED_STORAGE_PREFIXES
 * (src/lib/storage-guard.ts), so the generic /api/storage routes refuse it
 * for every caller and every operation — ledger bytes are served ONLY by the
 * record-scoped GET /api/ledger/documents/[id].
 *
 * Keys, RELATIVE to the prefix (that relative string is what
 * `ledger_documents.storage_path` stores — never a URL, never the full key):
 *   quickbooks/<Entity>/<Id>/<safeFileName>
 *   netsuite/<NsType>/<internalId>/<tranid>.pdf
 *   fleetsuite/<doc_type>/<id>/<number>.pdf        (later)
 *
 * No realm id and no NetSuite account id ever appears in a key: the object
 * store is not the place to publish which tenant the history came from, and
 * `ledgerStoragePath` gives a caller nowhere to put one.
 */

export const LEDGER_R2_PREFIX = 'ledger';

/**
 * The ONE key a gate-free write may use, relative to the prefix.
 *
 * The R2 privacy gate has exactly one documented exception (spec §0): the
 * fixed, non-sensitive `ledger/probe.txt` the importer's `probe_r2` mode
 * writes so the owner can prove the bucket is private BEFORE any financial
 * byte is stored. Pinning the exception to this constant — rather than to the
 * `probe: true` flag alone — is what keeps it an exception for one harmless
 * object instead of a standing opt-out any caller could spread into a real
 * document write. Every producer of the probe key imports this.
 */
export const LEDGER_PROBE_PATH = 'probe.txt';

/** Longest key we will build, relative to the prefix. */
const MAX_PATH_CHARS = 200;
/** Longest sanitized file name, before the whole-path budget trims it. */
const MAX_FILE_NAME_CHARS = 120;

/**
 * Shorten a file name to `max` characters while KEEPING its extension — a
 * ".pdf" trimmed off the end leaves an object the browser won't open.
 *
 * When the budget cannot hold the extension AND at least one character of
 * stem, the extension is DROPPED rather than clipped: a half extension
 * ('a.p') is the one outcome this helper exists to prevent, and it would
 * also mislabel the object for anyone reading the key.
 */
function capKeepingExtension(file: string, max: number): string {
  if (max <= 0) return '';
  if (file.length <= max) return file;
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 && file.length - dot <= 12 ? file.slice(dot) : '';
  const stem = ext ? file.slice(0, dot) : file;
  const room = max - ext.length;
  if (room < 1) return stem.slice(0, max);
  return (stem.slice(0, room) + ext).slice(0, max);
}

/**
 * Make a source-supplied file name safe to use as the last key segment:
 * everything outside word characters, dot, dash and space becomes '_', so a
 * name can never introduce a path separator, and an empty result becomes
 * 'file' rather than a key that ends in a slash.
 */
export function safeLedgerFileName(name: string): string {
  const cleaned = capKeepingExtension(
    String(name ?? '').replace(/[^\w.\- ]+/g, '_').trim(),
    MAX_FILE_NAME_CHARS,
  ).trim();
  // '...' survives the character class but names nothing — and a segment of
  // pure dots is the one sanitized shape that still reads as traversal.
  if (!cleaned || /^\.+$/.test(cleaned)) return 'file';
  return cleaned;
}

/** Reject anything that could break out of, or malform, a key segment. */
function assertSegment(label: string, value: string): string {
  const v = String(value ?? '').trim();
  if (!v) throw new Error(`Ledger storage path: ${label} is required`);
  // eslint-disable-next-line no-control-regex
  // '.' and '..' both name a directory rather than a thing; reject them here
  // rather than letting isSafeLedgerStoragePath fail the write later with an
  // error that blames the path instead of the caller.
  if (/^\.+$/.test(v) || v.includes('..') || v.includes('/') || v.includes('\\') || /[\x00-\x1f\x7f]/.test(v)) {
    throw new Error(`Ledger storage path: unsafe ${label} ${JSON.stringify(value)}`);
  }
  return v;
}

/**
 * Build the storage_path for one document. `entity` is the source's own type
 * name (QuickBooks `Invoice`, NetSuite `CustInvc`, …) and `externalRef` its
 * bare id — the same pair `external_id` is built from, so a key and a row
 * can always be matched back up by eye.
 */
export function ledgerStoragePath(
  source: 'quickbooks' | 'netsuite' | 'fleetsuite',
  entity: string,
  externalRef: string,
  fileName: string,
): string {
  // `source` is a union at compile time only — a value read back out of a row
  // (`row.source`) or handed in by untyped JS gets the same check as the other
  // two segments rather than being interpolated on trust.
  const dir =
    `${assertSegment('source', source)}/` +
    `${assertSegment('entity', entity)}/` +
    `${assertSegment('externalRef', externalRef)}/`;
  const budget = MAX_PATH_CHARS - dir.length;
  if (budget < 1) throw new Error(`Ledger storage path: ${dir} leaves no room for a file name`);

  // Trimming to the remaining budget can leave a stem of nothing but dots
  // ('...pdf' at a 1-char budget becomes '.'), which names no file — apply
  // the same fallback safeLedgerFileName uses, itself trimmed to the budget.
  const capped = capKeepingExtension(safeLedgerFileName(fileName), budget);
  return dir + (/^\.+$/.test(capped) ? 'file'.slice(0, budget) : capped);
}

/**
 * Is this a stored `storage_path` still shaped like something we will hand to
 * R2? `ledgerStoragePath` is the only builder, and it cannot produce a bad
 * value — but the column is data, and the reader (`GET
 * /api/ledger/documents/[id]`) is the single door for the whole prefix, so it
 * re-checks the shape rather than trusting whoever wrote the row. A path with
 * '..' in it would be concatenated into `ledger/<path>` and could name an
 * object outside the prefix; this is the same defense `checkStoragePath`
 * (src/lib/storage-guard.ts) applies on the generic storage routes.
 *
 * Traversal is a SEGMENT equal to '..' (or '.'), never the two characters
 * wherever they fall. `safeLedgerFileName` maps every separator to '_' but
 * keeps dots, so the builder's own output routinely contains an in-segment
 * '..' — '../../etc/passwd' sanitizes to '.._.._etc_passwd', and 'Invoice..pdf'
 * is simply what someone named the file. A substring test would reject those,
 * which buys no safety (the separators are already gone, so such a segment
 * names one ordinary object) and would strand real documents at status
 * 'failed' with an error blaming the path. An empty segment covers a leading
 * '/', a trailing '/' and any '//'.
 */
export function isSafeLedgerStoragePath(path: string): boolean {
  const p = String(path ?? '');
  if (!p || p.length > MAX_PATH_CHARS) return false;
  // eslint-disable-next-line no-control-regex
  if (p.includes('\\') || /[\x00-\x1f\x7f]/.test(p)) return false;
  // A whitespace-only segment is unreachable from ledgerStoragePath (every
  // segment is trimmed) but would key `ledger/ /…` if a row were hand-built.
  return !p.split('/').some(seg => seg.trim() === '' || seg === '.' || seg === '..');
}

/**
 * The only content types served INLINE from the app's own origin.
 *
 * `ledger_documents.content_type` is whatever the SOURCE said it was: a
 * QuickBooks `Attachable` carries a caller-chosen ContentType, so a
 * 'text/html' or 'image/svg+xml' attachment is an ordinary thing to find in
 * the ledger. Served inline from ops.bmgfleet.com that is stored XSS running
 * in the reader's own finance/executive session, and
 * `X-Content-Type-Options: nosniff` does not help — nosniff stops the browser
 * GUESSING a type, not honouring a declared one, and the app ships no
 * Content-Security-Policy. So: PDFs and flat images render (the case the
 * PDF viewer needs), everything else downloads as octet-stream. SVG is
 * deliberately absent — it is a script container.
 */
const INLINE_SAFE_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
]);

/**
 * Build the response headers for one streamed ledger document: what type we
 * admit to, whether it may render in the tab, and the caching rules every
 * financial document gets.
 */
export function ledgerDocumentHeaders(
  fileName: string,
  contentType?: string | null,
): Record<string, string> {
  // A parameterised type ('application/pdf; charset=binary') is still a PDF;
  // compare the media type alone, lowercased.
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  const inline = INLINE_SAFE_CONTENT_TYPES.has(declared);

  const name = String(fileName || '').trim() || 'document';
  // Plain filename param stays ASCII and quote-free; the full UTF-8 name
  // rides in RFC 5987 filename*, which every current browser prefers.
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  return {
    'Content-Type': inline ? declared : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    // Financial documents: never cached by a shared proxy, never left on
    // disk by the browser after the tab closes.
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Store one ledger document's bytes. THE one return shape for every caller.
 *
 * No ledger byte reaches R2 until the privacy flip is verified — this
 * function checks ledgerPdfsEnabled() itself so a caller cannot forget. The
 * ONE exception is the fixed non-sensitive `LEDGER_PROBE_PATH`
 * (ledger/probe.txt), used only by the importer's probe_r2 mode, which writes
 * it while the gate is still off so the R2 privacy flip can be verified
 * before any financial byte is stored — docs/r2-private-flip.md.
 *
 * The exception is that KEY, not the `probe` flag: `opts.probe` on any other
 * path is refused outright. A boolean opt-out would let a copy-paste or a
 * spread `opts` in the importer put a real invoice into a bucket whose
 * privacy is still unproven, and the tell would be silent — the object would
 * simply be there.
 *
 * The `path` is re-checked with `isSafeLedgerStoragePath` before anything
 * reaches R2, so a hand-built key can never walk out of the prefix.
 *
 * An object that is already there is reported as `existed: true` without a
 * re-upload: a resumed import re-walks pages it has already stored, and
 * re-PUTting a 4 MB PDF per retry is the difference between a chunk that
 * finishes inside its budget and one that never does. The returned `key` is
 * the full R2 key for logs; `publicUrl` is deliberately never returned or
 * persisted — r2Upload hands one back for every prefix, private or not.
 *
 * TWO RULES KEEP `sha256`/`size` HONEST, because callers stamp them onto
 * `ledger_documents` as the description of what is in the bucket:
 *
 *  - `opts.replace` skips the existence short-circuit entirely and PUTs.
 *    An edited QuickBooks document keeps its key (the file name is
 *    `<Entity>_<DocNumber|Id>.pdf`, unchanged when only amounts moved), so
 *    without this a re-fetch would leave the PRE-edit bytes in R2 while the
 *    row swore they were the post-edit ones. Every re-fetch passes it.
 *  - On the `existed: true` path the digest and size returned are the STORED
 *    object's, read back — never the caller's fetched bytes. We did not
 *    write those bytes, so we cannot vouch for them. If the read-back fails
 *    we upload instead of guessing, and answer `existed: false`.
 */
export async function putLedgerObject(
  service: SupabaseClient,
  path: string,
  bytes: Buffer,
  contentType: string,
  opts?: { probe?: true; replace?: boolean },
): Promise<
  | { ok: true; key: string; sha256: string; size: number; existed: boolean }
  | { ok: false; error: string }
> {
  // The builder cannot produce one of these, so a bad path is a caller bug —
  // but it is also the one input that could name an object outside the
  // prefix, and the probe write goes through here too.
  if (!isSafeLedgerStoragePath(path)) {
    return { ok: false, error: `Unsafe ledger storage path ${JSON.stringify(String(path ?? '').slice(0, 80))}` };
  }

  if (opts?.probe) {
    // The gate-free exception is one fixed, contentless object — not "any
    // write whose caller passed a flag". Anything else takes the gate.
    if (path !== LEDGER_PROBE_PATH) {
      return {
        ok: false,
        error: `The gate-free probe write is only for ${LEDGER_PROBE_PATH} — docs/r2-private-flip.md`,
      };
    }
  } else {
    const gate = await ledgerPdfsEnabled(service);
    if (!gate.enabled) {
      return { ok: false, error: 'LEDGER_PDFS_ENABLED off — docs/r2-private-flip.md' };
    }
  }

  const key = `${LEDGER_R2_PREFIX}/${path}`;
  const digest = sha256Hex(bytes);
  const size = bytes.byteLength;

  if (!opts?.replace && (await r2Head(LEDGER_R2_PREFIX, path))) {
    // Report what is ACTUALLY there, not what we happen to be holding: the
    // caller writes this digest into a column that claims to describe the
    // object. A read-back that fails leaves us unable to describe it, so we
    // fall through and store our own bytes rather than assert someone
    // else's.
    const stored = await r2GetBytes(LEDGER_R2_PREFIX, path);
    if (stored) {
      return {
        ok: true,
        key,
        sha256: sha256Hex(stored.bytes),
        size: stored.bytes.byteLength,
        existed: true,
      };
    }
  }

  const uploaded = await r2Upload(LEDGER_R2_PREFIX, path, bytes, contentType);
  if (!uploaded.success) {
    return { ok: false, error: uploaded.error || 'R2 upload failed' };
  }
  return { ok: true, key, sha256: digest, size, existed: false };
}
