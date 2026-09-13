/**
 * Usage-telemetry scrubbers (R7-4) — ISOMORPHIC: the browser runs these
 * before an event is queued, and POST /api/client-events runs the SAME
 * functions again before insert. Neither side trusts the other to have
 * stripped anything.
 *
 * The contract, in one place:
 *   - URLs become templated pathnames: query string and hash always
 *     dropped; e-sign / magic-link tokens → ':token'; VINs → ':vin';
 *     uuids and integer ids → ':id'.
 *   - Free text is masked: e-mails, uuids and long hex tokens, phone
 *     numbers, VIN-shaped tokens, digit runs, quoted (any quote style,
 *     backticks included) and parenthesised fragments, Postgres
 *     `Key (…)=(…)` constraint details.
 *   - Per-kind detail allowlists drop every key not named here, so a
 *     value-like field can't ride along even by accident.
 *
 * Pure functions, no DOM, no Node APIs — unit-tested in
 * usage-telemetry-sanitize.test.ts.
 */

export const CLIENT_EVENT_KINDS = [
  'error', 'slow_page', 'page_timing', 'api_slow',
  'form_start', 'form_submit', 'form_abandon', 'queue_overflow',
] as const;
export type ClientEventKind = typeof CLIENT_EVENT_KINDS[number];

export const FORM_EXITS = ['navigate', 'close', 'pagehide', 'unmount'] as const;
export type FormExit = typeof FORM_EXITS[number];

export const MAX_PAGE_CHARS = 200;
export const MAX_FORM_ID_CHARS = 60;
export const MAX_MESSAGE_CHARS = 300;
export const MAX_ROUTE_CHARS = 120;
export const MAX_STACK_CHARS = 1500;
export const MAX_STACK_FRAMES = 5;
export const MAX_DETAIL_BYTES = 4096;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_RE = /^\d+$/;

/** Segments whose NEXT segment is an e-sign / magic-link credential. The
 *  /book/[token] segment IS the estimate-approval token, so it can never
 *  reach the table as typed. Matched with or without a leading /api. */
const TOKEN_AFTER_ONE: string[] = ['book', 'portal'];
const TOKEN_AFTER_TWO: string[] = ['approve', 'signed'];
const TOKEN_AFTER_PAIR: [string, string][] = [['cni', 'schedule']];

function stripApi(segs: string[]): { api: boolean; rest: string[] } {
  if (segs[0] && segs[0].toLowerCase() === 'api') return { api: true, rest: segs.slice(1) };
  return { api: false, rest: segs };
}

/**
 * Templated pathname for a URL or path: query and hash removed, credential
 * segments → ':token', vehicle segments → ':vin' (by position), uuid or
 * all-digit segments → ':id'. Never throws; unusable input → '/'.
 */
export function templateRoute(input: unknown): string {
  if (typeof input !== 'string' || !input) return '/';
  let path = input;
  // Absolute URLs: keep the pathname only. Manual parse so this works without
  // the URL constructor's origin requirement and identically on both sides.
  const schemeIdx = path.indexOf('://');
  if (schemeIdx > 0 && schemeIdx < 10) {
    const afterHost = path.indexOf('/', schemeIdx + 3);
    path = afterHost === -1 ? '/' : path.slice(afterHost);
  }
  const q = path.indexOf('?');
  if (q !== -1) path = path.slice(0, q);
  const h = path.indexOf('#');
  if (h !== -1) path = path.slice(0, h);
  if (!path.startsWith('/')) path = '/' + path;

  const segs = path.split('/').filter(Boolean);
  const { api, rest } = stripApi(segs);
  const out = rest.slice();

  // Credential positions — decided on the raw segments before any other
  // rule so a uuid-shaped token becomes ':token', not ':id'. Segment names
  // compare case-insensitively: a hand-typed /Vehicles/<vin> 404s in Next,
  // but the pathname still reaches the beacon as typed.
  const lower = out.map((s) => s.toLowerCase());
  if (out.length >= 2 && TOKEN_AFTER_ONE.includes(lower[0])) out[1] = ':token';
  if (out.length >= 3 && TOKEN_AFTER_TWO.includes(lower[0])) out[2] = ':token';
  for (const [a, b] of TOKEN_AFTER_PAIR) {
    if (out.length >= 3 && lower[0] === a && lower[1] === b) out[2] = ':token';
  }
  // /vehicles/<anything> — the segment is a VIN by position, whatever it looks like.
  if (out.length >= 2 && lower[0] === 'vehicles') out[1] = ':vin';

  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s === ':token' || s === ':vin') continue;
    if (UUID_RE.test(s) || DIGITS_RE.test(s)) out[i] = ':id';
  }

  const joined = '/' + (api ? ['api', ...out] : out).join('/');
  return joined.length > MAX_PAGE_CHARS ? joined.slice(0, MAX_PAGE_CHARS) : joined;
}

/** True when a templated page still names a record family (:id/:vin/:token)
 *  — the report renders these as text, never as a link. */
export function isTemplatedPage(page: string): boolean {
  return /:(id|vin|token)(\/|$)/.test(page);
}

// ── Free-text masking ───────────────────────────────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PG_KEY_RE = /Key \([^)]*\)=\([^)]*\)/g;
/** A uuid anywhere in free text — e-sign / magic-link tokens are
 *  crypto.randomUUID(), and templateRoute only sees them in paths; a token
 *  quoted in a message or a stack frame must not survive as hex. */
const UUID_TEXT_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Long unhyphenated hex — customer_portal_token is 64 hex characters
 *  (generate_portal_token, migration 045), and VIN_RE cannot catch it: that
 *  rule needs a word boundary within 17 characters. */
const HEX_RE = /\b[0-9a-f]{20,}\b/gi;
const PHONE_RE = /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
/** 11–17 alphanumerics containing at least one digit, case-insensitive —
 *  VINs are 17, but partials and unit/serial numbers land in messages too. */
export const VIN_RE = /\b(?=[A-Z0-9]*\d)[A-Z0-9]{11,17}\b/gi;
const DIGITS4_RE = /\d{4,}/g;
const DQUOTE_RE = /"[^"\n]{1,120}"/g;
const SQUOTE_RE = /'[^'\n]{1,120}'/g;
const BTICK_RE = /`[^`\n]{1,120}`/g;
const CURLY_RE = /“[^”\n]{1,120}”/g;
const PARENS_RE = /\([^()\n]{1,120}\)/g;

/**
 * Mask personal / record data inside free text. Applied to error messages,
 * stacks, API routes and every string inside detail. Order matters: emails
 * and the Postgres Key shape go first (digit and paren rules would otherwise
 * eat them into something less recognisable), phones before digit runs.
 */
export function maskPii(input: unknown): string {
  if (typeof input !== 'string') return '';
  let s = input;
  s = s.replace(EMAIL_RE, '[email]');
  s = s.replace(PG_KEY_RE, 'Key (…)=(…)');
  s = s.replace(UUID_TEXT_RE, '[uuid]');
  s = s.replace(HEX_RE, '[hex]');
  s = s.replace(PHONE_RE, '[phone]');
  s = s.replace(VIN_RE, '[vin]');
  s = s.replace(DIGITS4_RE, '[n]');
  s = s.replace(DQUOTE_RE, '"[…]"');
  s = s.replace(SQUOTE_RE, '"[…]"');
  s = s.replace(BTICK_RE, '"[…]"');
  s = s.replace(CURLY_RE, '"[…]"');
  s = s.replace(PARENS_RE, '(…)');
  return s;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/** Mask + truncate a free-text field. */
export function cleanText(input: unknown, max = MAX_MESSAGE_CHARS): string {
  return truncate(maskPii(input), max);
}

/**
 * Reduce a stack trace to at most 5 `path:line:col` frames with origins,
 * query strings and hashes removed, then mask what's left.
 */
export function cleanStack(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  const frames: string[] = [];
  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Keep only the location: "at fn (https://host/_next/x.js?v=1:12:34)" → "/_next/x.js:12:34".
    // The path goes through templateRoute: an inline-script or eval frame
    // carries the DOCUMENT url, i.e. /book/<token> on the e-sign pages.
    const m = line.match(/((?:https?:\/\/[^/\s)]+)?(\/[^\s):?#]*))(?:[?#][^\s):]*)?:(\d+):(\d+)/);
    if (m) frames.push(`${templateRoute(m[2])}:${m[3]}:${m[4]}`);
    else if (!/^at\s/.test(line) && frames.length === 0) continue; // the message line
    else frames.push(maskPii(line.replace(/^at\s+/, '')).slice(0, 120));
    if (frames.length >= MAX_STACK_FRAMES) break;
  }
  if (frames.length === 0) return undefined;
  return truncate(maskPii(frames.join('\n')), MAX_STACK_CHARS);
}

// ── unhandledrejection reason → recorded message ───────────────────────

export interface RejectionSummary { message: string; stack?: string }

/**
 * What an unhandled promise rejection is allowed to say. Non-Error reasons
 * (supabase-js PostgrestError objects, Response instances, plain strings)
 * echo row values and response bodies, so only their TYPE is recorded.
 * Error reasons whose message is structured text (JSON, arrays, markup) are
 * recorded as 'structured message dropped' rather than the text.
 */
export function describeRejection(reason: unknown): RejectionSummary {
  if (!(reason instanceof Error)) {
    let extra = '';
    if (typeof Response !== 'undefined' && reason instanceof Response) extra = ' Response ' + reason.status;
    return { message: `non-Error rejection (${typeof reason}${extra})` };
  }
  const msg = String(reason.message ?? '').trim();
  const structured = msg.startsWith('{') || msg.startsWith('[') || msg.startsWith('<');
  return {
    message: structured ? 'structured message dropped' : cleanText(msg),
    stack: cleanStack(reason.stack),
  };
}

// ── Per-kind detail allowlists ─────────────────────────────────────────

type Detail = Record<string, unknown>;

const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined;
const int = (v: unknown, lo: number, hi: number): number | undefined => num(v, lo, hi);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const NAVS = ['hard', 'soft'] as const;

function put(out: Detail, key: string, v: unknown) {
  if (v !== undefined) out[key] = v;
}

/**
 * Keep only the keys this kind is allowed to carry, each coerced to its
 * shape and masked. Anything else — including keys named value/values/
 * fields/body/payload — is dropped without comment.
 */
export function sanitizeDetail(kind: ClientEventKind, raw: unknown): Detail {
  const d: Detail = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Detail) : {};
  const out: Detail = {};
  switch (kind) {
    case 'error':
      put(out, 'message', typeof d.message === 'string' ? cleanText(d.message) : 'unknown');
      put(out, 'source', typeof d.source === 'string' && d.source ? truncate(maskPii(templateRoute(d.source)), MAX_PAGE_CHARS) : undefined);
      put(out, 'line', int(d.line, 0, 1e7));
      put(out, 'col', int(d.col, 0, 1e7));
      put(out, 'stack', cleanStack(d.stack));
      put(out, 'count', int(d.count, 1, 1e6));
      put(out, 'rejection', bool(d.rejection));
      break;
    case 'slow_page':
    case 'page_timing':
      put(out, 'ms', num(d.ms, 0, 600_000));
      put(out, 'lcp_ms', d.lcp_ms === null ? null : num(d.lcp_ms, 0, 600_000));
      put(out, 'nav', oneOf(d.nav, NAVS));
      put(out, 'weight', oneOf(String(d.weight), ['1', '4']) ? Number(d.weight) : undefined);
      put(out, 'requests', int(d.requests, 0, 10_000));
      put(out, 'capped', bool(d.capped));
      break;
    case 'api_slow':
      put(out, 'route', typeof d.route === 'string' ? truncate(maskPii(templateRoute(d.route)), MAX_ROUTE_CHARS) : '/');
      put(out, 'method', oneOf(typeof d.method === 'string' ? d.method.toUpperCase() : d.method, METHODS) ?? 'GET');
      put(out, 'ms', num(d.ms, 0, 600_000));
      put(out, 'status', d.status === null ? null : int(d.status, 100, 599));
      put(out, 'failed', bool(d.failed) ?? false);
      put(out, 'offline', bool(d.offline));
      break;
    case 'form_start':
    case 'form_submit':
    case 'form_abandon':
      put(out, 'attempt_id', typeof d.attempt_id === 'string' && UUID_RE.test(d.attempt_id) ? d.attempt_id.toLowerCase() : undefined);
      put(out, 'seconds_open', num(d.seconds_open, 0, 86_400 * 7));
      put(out, 'fields_touched', int(d.fields_touched, 0, 10_000));
      put(out, 'step', d.step === null ? null : int(d.step, 0, 1000));
      put(out, 'exit', d.exit === null ? null : oneOf(d.exit, FORM_EXITS));
      break;
    case 'queue_overflow':
      put(out, 'dropped', int(d.dropped, 0, 1e6));
      break;
  }
  return out;
}

/** UTF-8 byte length of a string, without Buffer (isomorphic). */
export function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? 4 : 3;
    if (c >= 0xd800 && c <= 0xdbff) i++;
  }
  return bytes;
}

/** Byte length of the JSON form, without Buffer (isomorphic). */
export function jsonBytes(v: unknown): number {
  return utf8Bytes(JSON.stringify(v) ?? '');
}

export interface SanitizedEvent {
  kind: ClientEventKind;
  page: string;
  form_id: string | null;
  detail: Detail;
}

/**
 * Full per-event pass: kind must be known, page is templated, form_id is
 * shape-checked, detail is allowlisted and capped at 4 KB (over → a marker
 * object, never a partial). Returns null for anything unusable.
 */
export function sanitizeEvent(raw: unknown): SanitizedEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const kind = oneOf(e.kind, CLIENT_EVENT_KINDS);
  if (!kind) return null;
  // Templated, then masked (a path outside the known families can still
  // carry an e-mail or VIN), then re-bounded: masking can lengthen a string
  // and the column CHECK is MAX_PAGE_CHARS.
  const page = truncate(maskPii(templateRoute(e.page)), MAX_PAGE_CHARS);
  let form_id: string | null = null;
  if (typeof e.form_id === 'string' && /^[a-z][a-z0-9_]{0,59}$/.test(e.form_id)) form_id = e.form_id;
  if (kind.startsWith('form_') && !form_id) return null;
  let detail = sanitizeDetail(kind, e.detail);
  if (jsonBytes(detail) > MAX_DETAIL_BYTES) detail = { truncated: true };
  return { kind, page, form_id, detail };
}

// ── User-agent family (server-side only; the raw string is never stored) ─

export type UaFamily = 'ios-webview' | 'ios-safari' | 'android-webview' | 'android-chrome' | 'desktop' | 'other';

export function uaFamily(ua: string | null | undefined): UaFamily {
  const s = (ua || '').toLowerCase();
  if (!s) return 'other';
  const ios = /iphone|ipad|ipod/.test(s) || (/macintosh/.test(s) && /mobile/.test(s));
  if (ios) {
    // Capacitor / WKWebView UAs carry "Mobile/…" without "Safari/…"; Safari carries both.
    return /safari\//.test(s) && !/crios|fxios/.test(s) ? 'ios-safari' : 'ios-webview';
  }
  if (/android/.test(s)) {
    return /; wv\)|version\/\d/.test(s) ? 'android-webview' : 'android-chrome';
  }
  if (/windows|macintosh|linux|cros/.test(s)) return 'desktop';
  return 'other';
}
