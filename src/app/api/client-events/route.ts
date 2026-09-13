import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { z, validateBody } from '@/lib/validate';
import { createServiceClient } from '@/lib/supabase-service';
import { getAccessToken } from '@/lib/api-auth';
import { checkRateLimit, getRequestIp } from '@/lib/magic-link-approval';
import { sanitizeEvent, uaFamily, CLIENT_EVENT_KINDS } from '@/lib/usage-telemetry-sanitize';

export const dynamic = 'force-dynamic';

/**
 * POST /api/client-events — the usage-telemetry beacon (R7-4).
 *
 * Deliberately PUBLIC: the booking and credit-application pages have no
 * session, so identity is optional and resolved server-side from the
 * cookie/bearer the browser already carries. A beacon never gets a 401 or
 * a 500 back — every outcome other than a malformed body is 204, including
 * "rate limited" and "insert failed", because a client that retried would
 * only add load and a client that surfaced the error would be worse than
 * the missing row.
 *
 * What is NOT stored, by construction (see migration 313):
 *   - user_id: identity is resolved in flight ONLY to rate-limit and to
 *     read a role. The app runs on shared shop tablets; a per-employee
 *     activity log is not what was asked for.
 *   - IP: never written to client_events. The per-IP flood gate records
 *     it in approval_rate_limits (purged after 2 days) like every other
 *     rate-limited route.
 *   - raw User-Agent (only a coarse ua_family from the header — the
 *     body's own user_agent, if any, is ignored).
 *   - anything the client sent that the allowlist in sanitizeEvent() does
 *     not name; every string is re-masked here regardless of what the
 *     browser already did.
 *
 * Flood control: a coarse per-IP gate (60/min) runs BEFORE identity is
 * looked up, so a flood of junk tokens cannot buy an auth API call per
 * request; then 6 batches/min per verified user (hashed) or IP, AND
 * 200 batches/hour per session id. Over any → 204, nothing written.
 *
 * Restricted callers: a batch with no token ('anonymous') OR a token that
 * did not verify (role NULL) may only report the two public forms — an
 * unverifiable bearer must not buy more than no bearer at all.
 */

const MAX_BODY_BYTES = 16_384;
const MAX_EVENTS = 25;
const IP_BATCHES_PER_MIN = 60;
const USER_BATCHES_PER_MIN = 6;
const SESSION_BATCHES_PER_HOUR = 200;
/** A client clock more than this far from ours is not worth recording. */
const CLIENT_TS_TOLERANCE_MS = 24 * 60 * 60_000;

/** Pages a restricted (anonymous or unverifiable) caller may report — the two public forms. */
const ANON_PAGES = new Set(['/book/:token', '/credit-application']);
const ANON_API_ROUTES = new Set(['/api/book/:token', '/api/credit-application/submit']);
const ANON_FORMS = new Set(['booking', 'credit_application']);

const EventSchema = z.object({
  kind: z.enum(CLIENT_EVENT_KINDS),
  page: z.string().max(2000),
  form_id: z.string().max(60).optional(),
  ts: z.string().datetime({ offset: true }).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const BodySchema = z.object({
  session_id: z.string().uuid(),
  events: z.array(EventSchema).min(1).max(MAX_EVENTS),
  dropped: z.number().int().min(0).max(1e6).optional(),
}).passthrough();

const service = createServiceClient();

const NO_CONTENT = () => new NextResponse(null, { status: 204 });

/**
 * Who is calling, for rate limiting and the role column only.
 *   role 'anonymous' → no token presented at all
 *   role null        → a token was presented but could not be verified, or
 *                      the profile read failed (unknown — never a guess)
 */
async function resolveCaller(req: NextRequest): Promise<{ role: string | null; limitKey: string | null; anonymous: boolean }> {
  const token = getAccessToken(req);
  if (!token) return { role: 'anonymous', limitKey: null, anonymous: true };
  try {
    const { data: { user }, error } = await service.auth.getUser(token);
    if (error || !user) return { role: null, limitKey: null, anonymous: false };
    const { data: profile, error: pErr } = await service
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    // The rate-limit bucket is keyed on a truncated hash of the user id so
    // approval_rate_limits (purged after 2 days) never holds the id itself.
    const limitKey = 'u:' + createHash('sha256').update(user.id).digest('hex').slice(0, 24);
    if (pErr || !profile) return { role: null, limitKey, anonymous: false };
    const role = typeof profile.role === 'string' && profile.role ? profile.role.slice(0, 40) : null;
    return { role, limitKey, anonymous: false };
  } catch {
    return { role: null, limitKey: null, anonymous: false };
  }
}

function plausibleClientTs(ts: string | undefined, nowMs: number): string | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  if (!Number.isFinite(t) || Math.abs(t - nowMs) > CLIENT_TS_TOLERANCE_MS) return null;
  return new Date(t).toISOString();
}

export async function POST(req: NextRequest) {
  // Size gate on the header BEFORE the body is touched: an oversize beacon
  // is dropped unread, never parsed.
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return NO_CONTENT();

  // The body is read exactly once, here. validateBody calls req.json();
  // anything that reads the stream before it would 400 every batch.
  const parsed = await validateBody(req, BodySchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const ip = getRequestIp(req);

  // Flood control — three buckets, all must pass. Each check writes a row
  // to approval_rate_limits; the purge cron clears 'client_events%' rows.
  // The IP gate runs FIRST, before any auth lookup, so an over-budget
  // address costs nothing more than this one counter read.
  let caller: Awaited<ReturnType<typeof resolveCaller>>;
  try {
    const perIp = await checkRateLimit(ip, 'client_events_ip', IP_BATCHES_PER_MIN, 60_000);
    if (!perIp) return NO_CONTENT();
    caller = await resolveCaller(req);
    const perCaller = await checkRateLimit(caller.limitKey ?? ip, 'client_events', USER_BATCHES_PER_MIN, 60_000);
    if (!perCaller) return NO_CONTENT();
    const perSession = await checkRateLimit('sess', `client_events_sess:${body.session_id}`, SESSION_BATCHES_PER_HOUR, 3_600_000);
    if (!perSession) return NO_CONTENT();
  } catch (e: any) {
    // A limiter that throws writes nothing. (A count that merely errors
    // allows the batch — see checkRateLimit: the insert below shares the
    // database that failed to count, so it cannot become unlimited.)
    console.error('[client-events] rate limiter unavailable:', e?.message || 'unknown');
    return NO_CONTENT();
  }

  // 'anonymous' = no token at all; role NULL = a token that did not verify
  // (or the profile read failed). Both are restricted to the public forms;
  // the row keeps role NULL vs 'anonymous' so the report can tell them apart.
  const restricted = caller.anonymous || caller.role === null;

  const nowMs = Date.now();
  const uaFam = uaFamily(req.headers.get('user-agent'));
  const rows: Record<string, unknown>[] = [];

  for (const raw of body.events) {
    const ev = sanitizeEvent(raw);
    if (!ev) continue;
    if (restricted) {
      // No verifiable session: only the two public forms may report, and
      // only their own form ids. Everything else is dropped silently.
      const route = ev.kind === 'api_slow' ? String(ev.detail.route || '') : '';
      const pageOk = ANON_PAGES.has(ev.page) && (ev.kind !== 'api_slow' || ANON_API_ROUTES.has(route));
      const formOk = !ev.form_id || ANON_FORMS.has(ev.form_id);
      if (!pageOk || !formOk) continue;
    }
    rows.push({
      kind: ev.kind,
      page: ev.page,
      form_id: ev.form_id,
      detail: ev.detail,
      role: caller.role,
      session_id: body.session_id,
      ua_family: uaFam,
      client_ts: plausibleClientTs(raw.ts, nowMs),
    });
  }

  // The client counts what its queue had to drop; one row per batch keeps
  // that loss visible in the report instead of vanishing.
  if (body.dropped && body.dropped > 0 && !restricted) {
    rows.push({
      kind: 'queue_overflow', page: '/', form_id: null, detail: { dropped: body.dropped },
      role: caller.role, session_id: body.session_id, ua_family: uaFam, client_ts: null,
    });
  }

  if (rows.length === 0) return NO_CONTENT();

  const { error } = await service.from('client_events').insert(rows);
  if (error) {
    // Never the rows: a failed insert must not echo the payload into logs.
    console.error('[client-events] insert failed:', error.message, error.code);
  }
  return NO_CONTENT();
}
