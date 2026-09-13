/**
 * Usage-telemetry client core (R7-4) — no React. Installed once per page
 * load by <UsageTelemetry /> (src/components/UsageTelemetry.tsx) and the
 * useFormTelemetry hook; the install guard on window.__fsUsageTelemetry
 * makes every later call a no-op re-use, StrictMode double-mounts included.
 *
 * What it records — WHERE friction happens, never WHAT was typed:
 *   - uncaught errors / unhandled rejections (deduped, budgeted)
 *   - hard-navigation load time (sampled 1-in-4, always when slow)
 *   - soft-navigation settle time (app-router pathname changes)
 *   - slow (> 4 s) or failed (5xx / network) same-origin API + Supabase REST calls
 *   - form attempts: started / submitted / abandoned, with a COUNT of
 *     distinct touched fields held in a WeakSet of element references —
 *     element names, ids and values are never read.
 *
 * Every event passes sanitizeEvent() (src/lib/usage-telemetry-sanitize.ts)
 * BEFORE it is queued — the same scrubbers the server re-runs — so a page
 * path with a magic-link token or a message with an e-mail address never
 * leaves the browser as typed.
 *
 * Transport: in-memory queue (max 200), flushed every 20 s, on pagehide,
 * and 1 s after an error / abandon lands; batches of ≤ 25 events / ≤ 16 KB
 * via navigator.sendBeacon (keepalive fetch fallback). No retry, nothing
 * in storage — a lost beacon is accepted and the report says so.
 *
 * Kill switch: NEXT_PUBLIC_TELEMETRY=off (build-time) → nothing installs.
 */

import {
  sanitizeEvent, templateRoute, describeRejection, cleanText, cleanStack, utf8Bytes,
  type ClientEventKind, type FormExit,
} from '@/lib/usage-telemetry-sanitize';

export const TELEMETRY_ENDPOINT = '/api/client-events';
const FLUSH_INTERVAL_MS = 20_000;
const URGENT_FLUSH_MS = 1_000;
const MAX_QUEUE = 200;
const MAX_BATCH = 25;
const MAX_BATCH_BYTES = 15_000;
const SLOW_PAGE_MS = 3_000;
const SLOW_API_MS = 4_000;
const SOFT_NAV_CAP_MS = 15_000;
const SETTLE_QUIET_MS = 300;
const TIMING_SAMPLE = 0.25;
const ERROR_BUDGET = 20;
const ERROR_RESEND_MS = 5 * 60_000;
const API_PER_ROUTE_PER_WINDOW = 3;
const API_WINDOW_MS = 5 * 60_000;

interface QueuedEvent {
  kind: ClientEventKind;
  page: string;
  form_id?: string;
  ts: string;
  detail: Record<string, unknown>;
}

interface Attempt {
  id: string;
  started: boolean;
  startedAt: number;
  touched: WeakSet<object>;
  fields: number;
  step: number | null;
  /** Templated page the attempt started on — an abandon fired from a
   *  navigation must be attributed to the form's page, not the new one. */
  page: string;
}

export interface UsageTelemetryApi {
  enabled: boolean;
  sessionId: string;
  enqueue: (kind: ClientEventKind, detail?: Record<string, unknown>, formId?: string) => void;
  flush: () => void;
  notePathChange: (pathname: string) => void;
  registerForm: (formId: string) => void;
  unregisterForm: (formId: string, exit: FormExit) => void;
  touchField: (formId: string, el: EventTarget | null) => void;
  markStarted: (formId: string, step?: number) => void;
  markStep: (formId: string, step: number) => void;
  markSubmitted: (formId: string) => void;
  markAbandoned: (formId: string, exit: FormExit) => void;
  abandonAll: (exit: FormExit) => void;
}

const NOOP: UsageTelemetryApi = {
  enabled: false, sessionId: '',
  enqueue: () => {}, flush: () => {}, notePathChange: () => {},
  registerForm: () => {}, unregisterForm: () => {}, touchField: () => {},
  markStarted: () => {}, markStep: () => {}, markSubmitted: () => {}, markAbandoned: () => {}, abandonAll: () => {},
};

export function isTelemetryEnabled(): boolean {
  return process.env.NEXT_PUBLIC_TELEMETRY !== 'off';
}

function uuid(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Install (or re-use) the page's telemetry. Safe to call from any client
 * code path; returns the no-op API on the server, when the kill switch is
 * set, or when the browser lacks what it needs.
 */
export function installUsageTelemetry(): UsageTelemetryApi {
  if (typeof window === 'undefined' || typeof document === 'undefined') return NOOP;
  if (!isTelemetryEnabled()) return NOOP;
  const w = window as unknown as { __fsUsageTelemetry?: UsageTelemetryApi & { fetch?: typeof fetch } };
  if (w.__fsUsageTelemetry) return w.__fsUsageTelemetry;

  const originalFetch: typeof fetch | undefined = typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined;
  const sessionId = uuid();
  const queue: QueuedEvent[] = [];
  let dropped = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let urgentTimer: ReturnType<typeof setTimeout> | null = null;

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const currentPage = () => templateRoute(window.location.pathname);

  // ── Queue + transport ───────────────────────────────────────────────
  /** Sanitize + queue; returns the queued copy (or null when dropped). */
  function enqueueRaw(ev: QueuedEvent): QueuedEvent | null {
    const clean = sanitizeEvent(ev);
    if (!clean) return null;
    const item: QueuedEvent = { kind: clean.kind, page: clean.page, ts: ev.ts, detail: clean.detail };
    if (clean.form_id) item.form_id = clean.form_id;
    if (queue.length >= MAX_QUEUE) {
      // Full: page timings are samples and go first; otherwise the new
      // event is the casualty. Either way it is counted, never silent.
      const idx = queue.findIndex(q => q.kind === 'page_timing');
      dropped++;
      if (idx === -1) return null;
      queue.splice(idx, 1);
    }
    queue.push(item);
    scheduleFlush(item.kind === 'error' || item.kind === 'form_abandon');
    return item;
  }

  function enqueue(kind: ClientEventKind, detail: Record<string, unknown> = {}, formId?: string, page?: string) {
    const ev: QueuedEvent = { kind, page: page || currentPage(), ts: new Date().toISOString(), detail };
    if (formId) ev.form_id = formId;
    enqueueRaw(ev);
  }

  function scheduleFlush(urgent: boolean) {
    if (urgent && !urgentTimer) urgentTimer = setTimeout(() => { urgentTimer = null; flush(); }, URGENT_FLUSH_MS);
    if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_INTERVAL_MS);
  }

  function send(body: string): boolean {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const ok = navigator.sendBeacon(TELEMETRY_ENDPOINT, new Blob([body], { type: 'application/json' }));
        if (ok) return true;
      }
    } catch { /* fall through */ }
    if (!originalFetch) return false;
    try {
      originalFetch(TELEMETRY_ENDPOINT, {
        method: 'POST', body, keepalive: true, credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (urgentTimer) { clearTimeout(urgentTimer); urgentTimer = null; }
    let guard = 0;
    while (queue.length > 0 && guard++ < 20) {
      let take = Math.min(MAX_BATCH, queue.length);
      let body = '';
      for (;;) {
        const payload: Record<string, unknown> = { session_id: sessionId, events: queue.slice(0, take) };
        if (dropped > 0) payload.dropped = dropped;
        body = JSON.stringify(payload);
        // Bytes, not UTF-16 length: the server gate is content-length, and
        // masked text is full of 3-byte '…' characters.
        if (utf8Bytes(body) <= MAX_BATCH_BYTES || take === 1) break;
        take = Math.max(1, Math.floor(take / 2));
      }
      if (utf8Bytes(body) > MAX_BATCH_BYTES) { queue.shift(); dropped++; continue; } // one oversize event
      // Hand-off is the removal point: never sent twice, never retried.
      queue.splice(0, take);
      const carried = dropped; // the count this body reports
      if (!send(body)) { dropped += take; continue; }
      dropped -= carried;
    }
  }

  // ── Errors ──────────────────────────────────────────────────────────
  const errorSeen = new Map<string, { count: number; lastSentAt: number; queued: QueuedEvent | null }>();
  let budgetExhaustedSent = false;

  function recordError(message: string, extra: { source?: string; line?: number; col?: number; stack?: string; rejection?: boolean }) {
    const page = currentPage();
    const key = `${message}|${extra.source || ''}|${page}`;
    const prior = errorSeen.get(key);
    if (prior) {
      prior.count++;
      if (prior.queued && queue.includes(prior.queued)) { prior.queued.detail.count = prior.count; return; }
      if (now() - prior.lastSentAt < ERROR_RESEND_MS) return;
    } else if (errorSeen.size >= ERROR_BUDGET) {
      if (!budgetExhaustedSent) { budgetExhaustedSent = true; enqueue('error', { message: 'error budget exhausted', count: 1 }); }
      return;
    }
    const entry = prior || { count: 1, lastSentAt: 0, queued: null };
    const ev: QueuedEvent = {
      kind: 'error', page, ts: new Date().toISOString(),
      detail: { message, source: extra.source, line: extra.line, col: extra.col, stack: extra.stack, count: entry.count, rejection: extra.rejection },
    };
    entry.lastSentAt = now();
    errorSeen.set(key, entry);
    // enqueueRaw sanitizes into a fresh object; repeats bump the count on
    // THAT copy while it is still queued instead of adding rows.
    entry.queued = enqueueRaw(ev);
  }

  function onError(event: Event) {
    try {
      if (event instanceof ErrorEvent) {
        const raw = String(event.message || '');
        if (/ResizeObserver loop/i.test(raw)) return;
        const crossOrigin = /^Script error\.?$/i.test(raw.trim()) && !event.filename;
        const message = crossOrigin ? 'Script error (cross-origin)' : cleanText(raw || 'unknown error');
        recordError(message, {
          source: event.filename ? templateRoute(event.filename) : undefined,
          line: event.lineno || undefined, col: event.colno || undefined,
          stack: cleanStack(event.error && (event.error as Error).stack),
        });
        return;
      }
      const t = event.target as Element | null;
      if (t && (t instanceof HTMLScriptElement || t instanceof HTMLLinkElement)) {
        const src = t instanceof HTMLScriptElement ? t.src : t.href;
        recordError('resource load failed', { source: src ? templateRoute(src) : undefined });
      }
    } catch { /* telemetry must never throw into the page */ }
  }

  function onRejection(event: PromiseRejectionEvent) {
    try {
      const { message, stack } = describeRejection(event.reason);
      recordError(message, { stack, rejection: true });
    } catch { /* never throw */ }
  }

  // ── Timing: hard navigation ─────────────────────────────────────────
  let lcpMs: number | null = null;
  try {
    if (typeof PerformanceObserver !== 'undefined') {
      const po = new PerformanceObserver(list => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) lcpMs = Math.round(last.startTime);
      });
      po.observe({ type: 'largest-contentful-paint', buffered: true } as PerformanceObserverInit);
    }
  } catch { /* unsupported */ }

  function reportTiming(ms: number, detail: Record<string, unknown>) {
    if (ms > SLOW_PAGE_MS) enqueue('slow_page', { ms: Math.round(ms), weight: 1, ...detail });
    else if (Math.random() < TIMING_SAMPLE) enqueue('page_timing', { ms: Math.round(ms), weight: 4, ...detail });
  }

  function reportHardNav() {
    try {
      const nav = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
      const ms = nav && nav.duration > 0 ? nav.duration : now();
      reportTiming(ms, { nav: 'hard', lcp_ms: lcpMs });
    } catch { /* ignore */ }
  }
  const whenLoaded = (fn: () => void) => {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
  };
  whenLoaded(() => setTimeout(reportHardNav, 1_500));

  // ── Timing: soft navigation (app router) ────────────────────────────
  let currentPath = window.location.pathname;
  let inFlight = 0;
  let soft: { t0: number; requests: number; settleTimer: ReturnType<typeof setTimeout> | null; capTimer: ReturnType<typeof setTimeout> | null } | null = null;

  function endSoft(capped: boolean) {
    if (!soft) return;
    const s = soft;
    soft = null;
    if (s.settleTimer) clearTimeout(s.settleTimer);
    if (s.capTimer) clearTimeout(s.capTimer);
    const ms = capped ? SOFT_NAV_CAP_MS : now() - s.t0;
    reportTiming(ms, { nav: 'soft', requests: s.requests, ...(capped ? { capped: true } : {}) });
  }
  function maybeSettle() {
    if (!soft) return;
    if (soft.settleTimer) clearTimeout(soft.settleTimer);
    soft.settleTimer = setTimeout(() => { if (soft && inFlight === 0) endSoft(false); }, SETTLE_QUIET_MS);
  }
  function notePathChange(pathname: string) {
    if (!pathname || pathname === currentPath) return;
    currentPath = pathname;
    abandonAll('navigate');
    if (soft) { // a new navigation before settle cancels the measurement
      if (soft.settleTimer) clearTimeout(soft.settleTimer);
      if (soft.capTimer) clearTimeout(soft.capTimer);
      soft = null;
    }
    const s = { t0: now(), requests: 0, settleTimer: null as ReturnType<typeof setTimeout> | null, capTimer: null as ReturnType<typeof setTimeout> | null };
    soft = s;
    s.capTimer = setTimeout(() => { if (soft === s) endSoft(true); }, SOFT_NAV_CAP_MS);
    requestAnimationFrame(() => { if (soft === s && inFlight === 0) maybeSettle(); });
  }

  // ── Slow / failed API calls (fetch wrapper) ─────────────────────────
  const apiSeen = new Map<string, number[]>();
  let supabaseHost = '';
  try { supabaseHost = process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host : ''; } catch { /* unset */ }

  function classify(url: string): string | null {
    try {
      const u = new URL(url, window.location.origin);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (u.origin === window.location.origin) {
        if (!u.pathname.startsWith('/api/') || u.pathname === TELEMETRY_ENDPOINT) return null;
        return templateRoute(u.pathname);
      }
      if (supabaseHost && u.host === supabaseHost && u.pathname.startsWith('/rest/v1/')) {
        const table = u.pathname.slice('/rest/v1/'.length).split('/')[0] || 'unknown';
        return `supabase:${table.replace(/[^a-z0-9_]/gi, '')}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  function recordApi(route: string, method: string, ms: number, status: number | null, failed: boolean) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (failed && offline) return; // the SW / no-network case is not route friction
    if (!(ms > SLOW_API_MS || (status !== null && status >= 500) || failed)) return;
    const key = `${method} ${route}`;
    const t = now();
    const hits = (apiSeen.get(key) || []).filter(x => t - x < API_WINDOW_MS);
    if (hits.length >= API_PER_ROUTE_PER_WINDOW) { apiSeen.set(key, hits); return; }
    hits.push(t);
    apiSeen.set(key, hits);
    enqueue('api_slow', { route, method, ms: Math.round(ms), status, failed, ...(offline ? { offline: true } : {}) });
  }

  if (originalFetch) {
    const wrapped: typeof fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      let route: string | null = null;
      let method = 'GET';
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        route = classify(url);
        method = String(init?.method || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();
      } catch { route = null; }
      if (!route) return originalFetch(input, init);
      const r = route;
      const t0 = now();
      inFlight++;
      if (soft) soft.requests++;
      const done = (status: number | null, failed: boolean) => {
        inFlight--;
        try { recordApi(r, method, now() - t0, status, failed); } catch { /* never throw */ }
        if (inFlight === 0) maybeSettle();
      };
      let p: Promise<Response>;
      try {
        p = originalFetch(input, init);
      } catch (e) {
        done(null, true);
        throw e;
      }
      return p.then(
        res => { done(res.status, false); return res; },
        err => { done(null, true); throw err; },
      );
    };
    window.fetch = wrapped;
  }

  // ── Forms ───────────────────────────────────────────────────────────
  const attempts = new Map<string, Attempt>();
  const freshAttempt = (): Attempt => ({ id: uuid(), started: false, startedAt: 0, touched: new WeakSet<object>(), fields: 0, step: null, page: '/' });

  function formDetail(a: Attempt, exit: FormExit | null) {
    return {
      attempt_id: a.id,
      seconds_open: a.started ? Math.round((now() - a.startedAt) / 1000) : 0,
      fields_touched: a.fields,
      step: a.step,
      exit,
    };
  }
  function registerForm(formId: string) {
    if (!attempts.has(formId)) attempts.set(formId, freshAttempt());
  }
  function markStarted(formId: string, step?: number) {
    const a = attempts.get(formId);
    if (!a || a.started) { if (a && step !== undefined) a.step = step; return; }
    a.started = true;
    a.startedAt = now();
    a.page = currentPage();
    if (step !== undefined) a.step = step;
    enqueue('form_start', formDetail(a, null), formId, a.page);
  }
  function touchField(formId: string, el: EventTarget | null) {
    const a = attempts.get(formId);
    if (!a || !el || typeof el !== 'object') return;
    if (!a.started) markStarted(formId);
    if (!a.touched.has(el)) { a.touched.add(el); a.fields++; }
  }
  function markStep(formId: string, step: number) {
    const a = attempts.get(formId);
    if (a) a.step = step;
  }
  function markSubmitted(formId: string) {
    const a = attempts.get(formId);
    if (!a) return;
    if (a.started) enqueue('form_submit', formDetail(a, null), formId, a.page);
    attempts.set(formId, freshAttempt());
  }
  function markAbandoned(formId: string, exit: FormExit) {
    const a = attempts.get(formId);
    if (!a) return;
    if (a.started) enqueue('form_abandon', formDetail(a, exit), formId, a.page);
    attempts.set(formId, freshAttempt());
  }
  function unregisterForm(formId: string, exit: FormExit) {
    markAbandoned(formId, exit);
    attempts.delete(formId);
  }
  function abandonAll(exit: FormExit) {
    for (const id of Array.from(attempts.keys())) markAbandoned(id, exit);
  }

  // ── Listeners ───────────────────────────────────────────────────────
  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', () => { abandonAll('pagehide'); flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  const api: UsageTelemetryApi & { fetch?: typeof fetch } = {
    enabled: true, sessionId,
    enqueue, flush, notePathChange,
    registerForm, unregisterForm, touchField, markStarted, markStep, markSubmitted, markAbandoned, abandonAll,
    fetch: originalFetch,
  };
  w.__fsUsageTelemetry = api;
  return api;
}
