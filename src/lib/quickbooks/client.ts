import type { SupabaseClient } from '@supabase/supabase-js';
import { qboApiBase } from './config';
import { fetchCompanyInfo } from './oauth';
import { getAccessToken, updateCapabilities } from './tokens';

/**
 * The QuickBooks Online REST client — the ONE place a QuickBooks HTTP call
 * is made (outside the OAuth token endpoints in oauth.ts).
 *
 * READ ONLY BY CONSTRUCTION. Intuit has no read-only accounting scope, so
 * the guarantee has to live in the code: `fetch` hard-codes GET and this
 * interface exposes no method that could create, update or delete anything.
 *
 * PROBES, NOT ASSUMPTIONS. developer.intuit.com was unreachable while this
 * was written, so every fact in docs/qbo-api-notes.md marked [M] or [L] is
 * TRIED ONCE here, its verdict recorded in `quickbooks_tokens.capabilities`,
 * and degraded to a named status — never hard-coded as certain and never a
 * silent failure. The probed facts are: `orderById`, `orderByTxnDate`,
 * `companyInfo`, `queryTotalCount`, `cdc`, `pdf[<Entity>]` and
 * `attachableDownload`.
 *
 * A NON-THROTTLE FAILURE IS A FAILED RUN, NOT AN EMPTY PAGE. The one thing
 * this client must never do is hand a caller `[]` when QuickBooks actually
 * said no: the importer would stamp that page as done and the history would
 * be silently short. Every shape it cannot recognise raises `QboApiError`.
 */

export interface QboCapabilities {
  /** Per-entity PDF support: `pdf['Invoice'] = true` once one rendered. */
  pdf?: Record<string, boolean>;
  cdc?: boolean;
  attachableDownload?: 'download_endpoint' | 'temp_uri' | false;
  queryTotalCount?: boolean;
  orderById?: boolean;
  orderByTxnDate?: boolean;
  companyInfo?: boolean;
  throttle?: { lastRetryAfterS?: number; hits: number };
  probedAt?: string;
  // No reportMonthColumns key by design: REPORT_PLAN always sends
  // summarize_column_by 'Total', so there is no column-title question to
  // settle (§2.7).
}

export class QboApiError extends Error {
  status: number;
  code?: string;
  detail?: string;
  fault?: unknown;
  throttled: boolean;

  constructor(
    message: string,
    opts: { status?: number; code?: string; detail?: string; fault?: unknown; throttled?: boolean } = {},
  ) {
    super(message);
    this.name = 'QboApiError';
    this.status = opts.status ?? 0;
    this.code = opts.code;
    this.detail = opts.detail;
    this.fault = opts.fault;
    this.throttled = !!opts.throttled;
  }
}

export interface QboPage<T> {
  items: T[];
  orderBy: 'Id' | 'MetaData.LastUpdatedTime';
}

export interface QboQueryResult<T> {
  items: T[];
  startPosition: number;
  maxResults: number;
  totalCount: number | null;
  entity: string;
}

export interface QboClient {
  fetch(
    path: string,
    opts?: {
      method?: 'GET';
      accept?: 'application/json' | 'application/pdf';
      query?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<Response>;
  query<T = any>(statement: string): Promise<QboQueryResult<T>>;
  page<T = any>(entity: string, where: string | null, startPosition: number, maxResults: number, opts?: { order?: 'Id' | 'MetaData.LastUpdatedTime' }): Promise<QboPage<T>>;
  count(entity: string, where?: string): Promise<number | null>;
  latestTxnDate(entity: string): Promise<{ date: string | null; supported: boolean }>;
  cdc(
    entities: string[],
    changedSinceIso: string,
  ): Promise<
    | { ok: true; changes: Record<string, { items: any[]; deleted: string[] }> }
    | { ok: false; unsupported: true; reason: string }
  >;
  pdf(
    entityPath: string,
    id: string,
  ): Promise<
    | { ok: true; bytes: Buffer }
    | { ok: false; unsupported: true; reason: string }
    | { ok: false; error: string; status?: number }
  >;
  attachables(startPosition: number, maxResults: number): Promise<any[]>;
  download(
    attachableId: string,
    tempDownloadUri: string | null,
  ): Promise<
    | { ok: true; bytes: Buffer; via: 'download_endpoint' | 'temp_uri' }
    // `scope` says how far the verdict reaches: `capability` settled
    // `attachableDownload = false` for the realm (the caller may write off
    // every pending attachment), `document` is this row alone.
    | { ok: false; unsupported: true; reason: string; scope: 'capability' | 'document' }
    | { ok: false; error: string }
  >;
  report(
    name: string,
    params: Record<string, string>,
  ): Promise<{ rawText: string; json: any; generatedAt: string | null }>;
  companyInfo(): Promise<{ companyName: string | null; probe: 'ok' | 'failed'; reason?: string }>;
  stats(): { calls: number; throttled: number; slowestMs: number };
}

/**
 * The lower-case REST segment the PDF endpoint takes.
 *
 * QuickBooks' query grammar is PascalCase (`SELECT * FROM CreditMemo`) but
 * its REST paths are lower-case and unhyphenated (`/creditmemo/123/pdf`).
 * Nothing else in the repo knows this mapping, so it lives here and throws
 * for a type QuickBooks renders no PDF for — asking for one would be a 404
 * misread as a transient failure and retried three times.
 */
const PDF_ENTITY_PATHS: Record<string, string> = {
  Invoice: 'invoice',
  CreditMemo: 'creditmemo',
  SalesReceipt: 'salesreceipt',
  RefundReceipt: 'refundreceipt',
  Estimate: 'estimate',
  Bill: 'bill',
};

export function entityPath(entity: string): string {
  const p = PDF_ENTITY_PATHS[entity];
  if (!p) throw new Error('unsupported_pdf_entity');
  return p;
}

// ═══════════ RATE LIMITER ═══════════
//
// Intuit's documented ceiling is ~500 requests/minute per realm with ~10
// concurrent ([M]). We sit under both: 6 in flight and 400 per sliding 60 s,
// because a throttle costs a 30-second backoff and a chunk only has 45
// seconds of budget — staying under is cheaper than recovering.

const MAX_IN_FLIGHT = 6;
const MAX_PER_WINDOW = 400;
const WINDOW_MS = 60_000;

class Limiter {
  private inFlight = 0;
  private recent: number[] = [];
  private waiters: (() => void)[] = [];

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.recent = this.recent.filter(t => now - t < WINDOW_MS);
      if (this.inFlight < MAX_IN_FLIGHT && this.recent.length < MAX_PER_WINDOW) {
        this.inFlight++;
        this.recent.push(now);
        return;
      }
      if (this.recent.length >= MAX_PER_WINDOW) {
        await sleep(Math.max(50, WINDOW_MS - (now - this.recent[0])));
        continue;
      }
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function faultOf(body: string): { code?: string; message?: string; detail?: string; fault?: unknown } {
  try {
    const json = JSON.parse(body);
    const err = json?.Fault?.Error?.[0] || json?.fault?.error?.[0];
    if (err) {
      return {
        code: err.code != null ? String(err.code) : undefined,
        message: err.Message || err.message,
        detail: err.Detail || err.detail,
        fault: json.Fault || json.fault,
      };
    }
  } catch {
    /* not JSON — fall through */
  }
  return {};
}

const isThrottleBody = (body: string) => /ThrottleExceeded|throttle/i.test(body);

export function createQboClient(
  service: SupabaseClient,
  opts?: { runId?: string; onCall?: (path: string, status: number, ms: number) => void },
): QboClient {
  const limiter = new Limiter();
  let calls = 0;
  let throttled = 0;
  let slowestMs = 0;

  // Probe verdicts are cached in memory for the life of the chunk AND
  // persisted, so a resumed chunk does not re-probe and a running one does
  // not re-read the row on every page.
  let caps: QboCapabilities | null = null;

  async function capabilities(): Promise<QboCapabilities> {
    if (caps) return caps;
    const { conn } = await getAccessToken(service);
    caps = conn.capabilities || {};
    return caps;
  }

  async function recordCapability(patch: Partial<QboCapabilities>): Promise<void> {
    caps = { ...(caps || {}), ...patch, ...(patch.pdf ? { pdf: { ...((caps || {}).pdf || {}), ...patch.pdf } } : {}) };
    await updateCapabilities(service, patch);
  }

  /**
   * One authenticated GET with the full retry ladder.
   *
   *   401                → refresh once, retry once. A second 401 is real.
   *   429 / 403+throttle → honour Retry-After (capped at 60 s), else
   *                        1.5 s · 2ⁿ. Up to 5 attempts.
   *   5xx / network      → 3 attempts.
   *   any other 4xx      → NEVER retried; it is an answer, not an outage.
   */
  async function rawFetch(
    path: string,
    o: { accept?: 'application/json' | 'application/pdf'; query?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Response> {
    const accept = o.accept || 'application/json';
    let refreshed = false;
    let throttleAttempts = 0;
    let serverAttempts = 0;

    for (;;) {
      const { token, conn } = await getAccessToken(service, refreshed ? { forceRefresh: false } : undefined);
      const base = qboApiBase(conn.environment, conn.realmId);
      const params = new URLSearchParams(o.query || {});
      // Every call, without exception: an unpinned minor version means Intuit
      // decides our response shape.
      params.set('minorversion', conn.minorVersion || '73');
      const url = `${base}${path.startsWith('/') ? path : `/${path}`}?${params.toString()}`;

      await limiter.acquire();
      const startedAt = Date.now();
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: accept },
          signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
          cache: 'no-store',
        });
      } catch (e: any) {
        limiter.release();
        serverAttempts++;
        if (serverAttempts >= 3) {
          throw new QboApiError(`QuickBooks request failed: ${String(e?.message || e).slice(0, 200)}`, { status: 0 });
        }
        await sleep(1_500 * 2 ** (serverAttempts - 1));
        continue;
      } finally {
        const ms = Date.now() - startedAt;
        calls++;
        slowestMs = Math.max(slowestMs, ms);
      }
      limiter.release();
      const ms = Date.now() - startedAt;
      opts?.onCall?.(path, res.status, ms);

      if (res.ok) return res;

      // The body is read once here; callers only ever see an ok response or
      // a QboApiError, so there is no half-consumed stream to hand on.
      const body = await res.text();

      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await getAccessToken(service, { forceRefresh: true });
        continue;
      }
      if (res.status === 429 || (res.status === 403 && isThrottleBody(body))) {
        throttled++;
        throttleAttempts++;
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitS = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) : 0;
        await recordCapability({
          throttle: { hits: ((caps || {}).throttle?.hits || 0) + 1, lastRetryAfterS: waitS || undefined },
        });
        if (throttleAttempts >= 5) {
          throw new QboApiError('QuickBooks throttled the request', { status: res.status, throttled: true });
        }
        await sleep(waitS ? waitS * 1000 : 1_500 * 2 ** (throttleAttempts - 1));
        continue;
      }
      // 501 Not Implemented is excluded on purpose: it is a permanent answer
      // ("this endpoint does not exist for that entity"), not an outage, and
      // retrying it three times per document would burn a whole chunk's
      // budget discovering the same no. `pdf()` classifies it as unsupported.
      if (res.status >= 500 && res.status !== 501) {
        serverAttempts++;
        if (serverAttempts >= 3) {
          const f = faultOf(body);
          throw new QboApiError(f.message || `QuickBooks returned HTTP ${res.status}`, {
            status: res.status, code: f.code, detail: f.detail, fault: f.fault,
          });
        }
        await sleep(1_500 * 2 ** (serverAttempts - 1));
        continue;
      }

      const f = faultOf(body);
      throw new QboApiError(f.message || `QuickBooks returned HTTP ${res.status}`, {
        status: res.status,
        code: f.code,
        detail: f.detail,
        fault: f.fault,
        throttled: false,
      });
    }
  }

  async function query<T = any>(statement: string): Promise<QboQueryResult<T>> {
    const res = await rawFetch('/query', { query: { query: statement } });
    const body: any = await res.json();
    // [probe] envelope. A 200 whose body has no QueryResponse is a shape we
    // do not understand — reporting it as an empty page would mark the walk
    // finished with the history half-imported.
    if (!body || typeof body !== 'object' || !body.QueryResponse) {
      throw new QboApiError('bad_envelope', { status: 200, detail: 'response carried no QueryResponse' });
    }
    const qr = body.QueryResponse;
    // The entity array is whichever PascalCase key holds an array; the
    // statement's FROM clause names it, but a count-only response has none.
    const entity =
      Object.keys(qr).find(k => Array.isArray(qr[k]) && /^[A-Z]/.test(k)) ||
      (/\bFROM\s+([A-Za-z]+)/i.exec(statement)?.[1] ?? '');
    return {
      items: (entity && Array.isArray(qr[entity]) ? qr[entity] : []) as T[],
      startPosition: Number(qr.startPosition) || 0,
      maxResults: Number(qr.maxResults) || 0,
      totalCount: typeof qr.totalCount === 'number' ? qr.totalCount : null,
      entity,
    };
  }

  /**
   * One page of an entity. **[probe: orderById]**
   *
   * `ORDERBY Id` is the stable key we want, but whether QuickBooks accepts it
   * for every entity is [M]. While the verdict is unsettled a non-throttle
   * rejection is retried ONCE with `ORDERBY MetaData.LastUpdatedTime` ([H]);
   * whichever form works is recorded and used from then on. Callers persist
   * the returned `orderBy` in their cursor so a resumed run pages the same
   * way it started.
   *
   * `opts.order` FORCES a clause and skips the probe entirely — the windowed
   * walk in sync.ts asks for `MetaData.LastUpdatedTime` because that is the
   * column it is also filtering on ([H]), so paging stays stable while rows
   * keep changing underneath. A forced clause never records a capability:
   * nothing was tried once, and the caller chose it.
   */
  async function page<T = any>(
    entity: string,
    where: string | null,
    startPosition: number,
    maxResults: number,
    opts?: { order?: 'Id' | 'MetaData.LastUpdatedTime' },
  ): Promise<QboPage<T>> {
    const size = Math.min(Math.max(1, maxResults), 1000);
    const caps0 = await capabilities();
    const build = (order: 'Id' | 'MetaData.LastUpdatedTime') =>
      `SELECT * FROM ${entity}${where ? ` WHERE ${where}` : ''} ORDERBY ${order} STARTPOSITION ${startPosition} MAXRESULTS ${size}`;

    if (opts?.order) {
      const r = await query<T>(build(opts.order));
      return { items: r.items, orderBy: opts.order };
    }
    if (caps0.orderById === false) {
      const r = await query<T>(build('MetaData.LastUpdatedTime'));
      return { items: r.items, orderBy: 'MetaData.LastUpdatedTime' };
    }
    try {
      const r = await query<T>(build('Id'));
      if (caps0.orderById === undefined) await recordCapability({ orderById: true });
      return { items: r.items, orderBy: 'Id' };
    } catch (e) {
      const settled = caps0.orderById !== undefined;
      if (settled || !(e instanceof QboApiError) || e.throttled) throw e;
      // The one retry the probe is allowed.
      const r = await query<T>(build('MetaData.LastUpdatedTime'));
      await recordCapability({ orderById: false });
      return { items: r.items, orderBy: 'MetaData.LastUpdatedTime' };
    }
  }

  /** `SELECT COUNT(*)` — null when QuickBooks reports no totalCount [probe]. */
  async function count(entity: string, where?: string): Promise<number | null> {
    const r = await query(`SELECT COUNT(*) FROM ${entity}${where ? ` WHERE ${where}` : ''}`);
    const supported = r.totalCount != null;
    const caps0 = await capabilities();
    if (caps0.queryTotalCount !== supported) await recordCapability({ queryTotalCount: supported });
    return r.totalCount;
  }

  /**
   * The newest TxnDate on an entity — the QuickBooks half of the cutover
   * window. **[probe: orderByTxnDate]** and deliberately NEVER THROWS on a
   * rejection: the cutover proposal only needs the NetSuite side, so a
   * refusal downgrades to `supported: false` plus a dry-run warning rather
   * than failing the run the owner is trying to read a report from.
   */
  async function latestTxnDate(entity: string): Promise<{ date: string | null; supported: boolean }> {
    const caps0 = await capabilities();
    if (caps0.orderByTxnDate === false) return { date: null, supported: false };
    try {
      const r = await query<any>(`SELECT * FROM ${entity} ORDERBY TxnDate DESC MAXRESULTS 1`);
      if (caps0.orderByTxnDate === undefined) await recordCapability({ orderByTxnDate: true });
      const d = r.items[0]?.TxnDate;
      return { date: d ? String(d) : null, supported: true };
    } catch (e) {
      if (e instanceof QboApiError && !e.throttled) {
        await recordCapability({ orderByTxnDate: false });
        return { date: null, supported: false };
      }
      throw e;
    }
  }

  /** Change Data Capture, the cheap daily path. [probe: cdc] */
  async function cdc(
    entities: string[],
    changedSinceIso: string,
  ): Promise<
    | { ok: true; changes: Record<string, { items: any[]; deleted: string[] }> }
    | { ok: false; unsupported: true; reason: string }
  > {
    const caps0 = await capabilities();
    if (caps0.cdc === false) return { ok: false, unsupported: true, reason: 'CDC was rejected by this company before' };
    let body: any;
    try {
      const res = await rawFetch('/cdc', { query: { entities: entities.join(','), changedSince: changedSinceIso } });
      body = await res.json();
    } catch (e) {
      if (e instanceof QboApiError && !e.throttled) {
        await recordCapability({ cdc: false });
        return { ok: false, unsupported: true, reason: e.message };
      }
      throw e;
    }
    const groups = body?.CDCResponse?.[0]?.QueryResponse;
    if (!Array.isArray(groups)) {
      await recordCapability({ cdc: false });
      return { ok: false, unsupported: true, reason: 'CDC response carried no CDCResponse[0].QueryResponse' };
    }
    const changes: Record<string, { items: any[]; deleted: string[] }> = {};
    for (const group of groups) {
      for (const [key, value] of Object.entries(group)) {
        if (!Array.isArray(value) || !/^[A-Z]/.test(key)) continue;
        const bucket = (changes[key] ||= { items: [], deleted: [] });
        for (const row of value as any[]) {
          // A deleted entity comes back as a stub with status 'Deleted' — the
          // only way a delete is ever visible, since query never returns one.
          if (row?.status === 'Deleted') bucket.deleted.push(String(row.Id));
          else bucket.items.push(row);
        }
      }
    }
    if (caps0.cdc !== true) await recordCapability({ cdc: true });
    return { ok: true, changes };
  }

  /**
   * A rendered PDF. [probe: pdf[<Entity>]]
   *
   * 400/404/415/501 classify as UNSUPPORTED for that type rather than as a
   * transient failure — QuickBooks renders no PDF for some entities ([L] for
   * Bill especially), and retrying that three times per document would burn
   * the whole chunk budget on a shape that will never work.
   */
  async function pdf(
    entityPath_: string,
    id: string,
  ): Promise<
    | { ok: true; bytes: Buffer }
    | { ok: false; unsupported: true; reason: string }
    | { ok: false; error: string; status?: number }
  > {
    const entity = Object.keys(PDF_ENTITY_PATHS).find(k => PDF_ENTITY_PATHS[k] === entityPath_) || entityPath_;
    const caps0 = await capabilities();
    if (caps0.pdf?.[entity] === false) {
      return { ok: false, unsupported: true, reason: `QuickBooks renders no PDF for ${entity}` };
    }
    try {
      const res = await rawFetch(`/${entityPath_}/${encodeURIComponent(id)}/pdf`, {
        accept: 'application/pdf',
        timeoutMs: 45_000,
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (caps0.pdf?.[entity] !== true) await recordCapability({ pdf: { [entity]: true } });
      return { ok: true, bytes };
    } catch (e) {
      if (e instanceof QboApiError && !e.throttled && [400, 404, 415, 501].includes(e.status)) {
        await recordCapability({ pdf: { [entity]: false } });
        return { ok: false, unsupported: true, reason: `${entity} PDF rejected with HTTP ${e.status}: ${e.message}` };
      }
      if (e instanceof QboApiError) return { ok: false, error: e.message, status: e.status };
      throw e;
    }
  }

  async function attachables(startPosition: number, maxResults: number): Promise<any[]> {
    const r = await page<any>('Attachable', null, startPosition, maxResults);
    return r.items;
  }

  /**
   * Attachment bytes. [probe: attachableDownload]
   *
   * Two [M] paths: `GET /download/<id>` answers with a short-lived URL as
   * plain text, and the entity itself carries a `TempDownloadUri`. Both
   * expire in minutes, so both are followed inside the same chunk that
   * fetched the Attachable — never stored, and `TempDownloadUri` is stripped
   * from `raw` by the sanitizer.
   *
   * Classification MIRRORS `pdf()`, because the caller treats `unsupported`
   * as permanent and sweeps rows out of the queue for good: only a definitive
   * rejection (400/404/415/501, or a 200 that is not a URL) says the path
   * does not exist. A network error, a 401, or a 5xx that exhausted
   * `rawFetch`'s three attempts is an `error` the caller retries — one blip
   * must never write off a whole class of attachments.
   *
   * `scope` says how far an `unsupported` verdict reaches: `capability`
   * settles `attachableDownload = false` for the realm (every pending
   * attachment is written off), `document` is about this row alone.
   */
  async function download(
    attachableId: string,
    tempDownloadUri: string | null,
  ): Promise<
    | { ok: true; bytes: Buffer; via: 'download_endpoint' | 'temp_uri' }
    | { ok: false; unsupported: true; reason: string; scope: 'capability' | 'document' }
    | { ok: false; error: string }
  > {
    const caps0 = await capabilities();
    let endpointReason: string | null = null;
    let endpointDefinitive = false;

    if (caps0.attachableDownload !== 'temp_uri') {
      try {
        const res = await rawFetch(`/download/${encodeURIComponent(attachableId)}`, { accept: 'application/json', timeoutMs: 30_000 });
        const text = (await res.text()).trim();
        if (/^https?:\/\//i.test(text)) {
          const file = await fetch(text, { signal: AbortSignal.timeout(45_000), cache: 'no-store' });
          if (file.ok) {
            const bytes = Buffer.from(await file.arrayBuffer());
            if (caps0.attachableDownload !== 'download_endpoint') {
              await recordCapability({ attachableDownload: 'download_endpoint' });
            }
            return { ok: true, bytes, via: 'download_endpoint' };
          }
          // The URL is short-lived; a non-2xx from it is far more likely
          // expiry than "this realm has no download path". Transient.
          endpointReason = `the download URL answered HTTP ${file.status}`;
        } else {
          // A 200 that is not a URL is the [M] shape being wrong, not a blip.
          endpointDefinitive = true;
          endpointReason = 'the download endpoint did not return a URL';
        }
      } catch (e: any) {
        if (e instanceof QboApiError && e.throttled) throw e;
        if (e instanceof QboApiError && [400, 404, 415, 501].includes(e.status)) endpointDefinitive = true;
        endpointReason = String(e?.message || e).slice(0, 200);
      }
    }

    if (tempDownloadUri) {
      try {
        const file = await fetch(tempDownloadUri, { signal: AbortSignal.timeout(45_000), cache: 'no-store' });
        if (file.ok) {
          const bytes = Buffer.from(await file.arrayBuffer());
          if (caps0.attachableDownload !== 'temp_uri') await recordCapability({ attachableDownload: 'temp_uri' });
          return { ok: true, bytes, via: 'temp_uri' };
        }
        return { ok: false, error: `TempDownloadUri answered HTTP ${file.status}` };
      } catch (e: any) {
        return { ok: false, error: String(e?.message || e).slice(0, 200) };
      }
    }

    if (endpointDefinitive) {
      // One exception to the class write-off: if the endpoint has ALREADY
      // handed bytes back for this realm, a definitive rejection is about
      // this attachable id (deleted at source, say) and must not un-prove a
      // capability we have watched work. Scope it to the row instead.
      if (caps0.attachableDownload === 'download_endpoint') {
        return { ok: false, unsupported: true, reason: endpointReason ?? 'download rejected', scope: 'document' };
      }
      await recordCapability({ attachableDownload: false });
      return { ok: false, unsupported: true, reason: endpointReason ?? 'download rejected', scope: 'capability' };
    }
    if (endpointReason) {
      // Transient: the caller counts an attempt and gives up after three,
      // leaving every other attachment alone.
      return { ok: false, error: endpointReason };
    }
    // The download endpoint is known to be unusable here and this row never
    // carried a TempDownloadUri (its index page ran in an earlier chunk).
    // No amount of retrying produces one — but it says nothing about rows
    // whose URI IS in hand, so the capability is left where it is.
    return { ok: false, unsupported: true, reason: 'no download path available for this attachment', scope: 'document' };
  }

  /**
   * One report. `rawText` is the response body BYTE-EXACT — the owner asked
   * for reports "as QuickBooks reported them", and re-serializing parsed JSON
   * would silently reorder keys and drop formatting the source chose.
   */
  async function report(
    name: string,
    params: Record<string, string>,
  ): Promise<{ rawText: string; json: any; generatedAt: string | null }> {
    const res = await rawFetch(`/reports/${encodeURIComponent(name)}`, { query: params, timeoutMs: 60_000 });
    const rawText = await res.text();
    let json: any;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new QboApiError('bad_envelope', { status: 200, detail: `report ${name} returned non-JSON` });
    }
    if (!json?.Header && !json?.Rows) {
      throw new QboApiError('bad_envelope', { status: 200, detail: `report ${name} carried neither Header nor Rows` });
    }
    return { rawText, json, generatedAt: json?.Header?.Time ? String(json.Header.Time) : null };
  }

  async function companyInfo(): Promise<{ companyName: string | null; probe: 'ok' | 'failed'; reason?: string }> {
    const { token, conn } = await getAccessToken(service);
    const result = await fetchCompanyInfo(
      token,
      conn.environment,
      conn.realmId,
      conn.minorVersion || '73',
      AbortSignal.timeout(8_000),
    );
    await recordCapability({ companyInfo: result.ok });
    return result.ok
      ? { companyName: result.companyName, probe: 'ok' }
      : { companyName: null, probe: 'failed', reason: result.reason };
  }

  return {
    fetch: (path, o) => rawFetch(path, o),
    query,
    page,
    count,
    latestTxnDate,
    cdc,
    pdf,
    attachables,
    download,
    report,
    companyInfo,
    stats: () => ({ calls, throttled, slowestMs }),
  };
}
