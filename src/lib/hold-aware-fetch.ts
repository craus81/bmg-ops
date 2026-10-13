'use client';

import { HOLD_OVERRIDE_HEADER, type HoldBlockedBody } from '@/lib/customer-hold';

interface DialogLike {
  alert: (msg: string, opts?: any) => Promise<any>;
  prompt: (msg: string, initial?: string, opts?: any) => Promise<string | null>;
}

/**
 * Fetch a route gated on the customer hold (migration 366). When the server
 * answers 409 customerOnHold, an admin / A/R contact is asked for a reason
 * and the same request is retried with it; anyone else is told who can
 * override. Returns the final Response, or null when the person cancelled
 * or couldn't override (they've already been told why), so callers just
 * stop. Pass the same `ctx` to a flow's follow-up retries (e.g. "convert
 * anyway") so the reason given once rides along instead of asking again.
 */
export async function holdAwareFetch(
  dialog: DialogLike,
  url: string,
  init: RequestInit,
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
  ctx: { reason?: string } = {},
): Promise<Response | null> {
  const withReason = (r: string): RequestInit => {
    const headers = new Headers(init.headers || {});
    // Encoded: header values must be Latin-1, a typed reason may not be.
    headers.set(HOLD_OVERRIDE_HEADER, encodeURIComponent(r));
    return { ...init, headers };
  };
  const res = await fetchFn(url, ctx.reason ? withReason(ctx.reason) : init);
  if (res.status !== 409) return res;
  let body: HoldBlockedBody | null = null;
  try { body = await res.clone().json(); } catch { return res; }
  if (!body?.customerOnHold) return res;

  if (!body.canOverride) {
    await dialog.alert(`${body.customer} is on hold for past-due invoices.\n\n${body.reason}.\n\nAn admin or A/R has to override it before this can go out. Let the customer know their account is on hold for nonpayment.`, { title: 'Customer on hold' });
    return null;
  }
  const reason = await dialog.prompt(
    `${body.customer} is on hold for past-due invoices.\n\n${body.reason}.\n\nType the reason to go ahead anyway. It's logged, and A/R is told.`,
    '',
    { title: 'Customer on hold', confirmLabel: 'Go ahead anyway', placeholder: 'Reason (required)' },
  );
  if (reason === null || !reason.trim()) return null;
  ctx.reason = reason.trim().slice(0, 500);
  return fetchFn(url, withReason(ctx.reason));
}
