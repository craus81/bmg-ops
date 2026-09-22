/**
 * Quote expiry rules (R6-9) — shared by the daily sweep, the quotes list and
 * the builders, so the chip a rep reads and the email a customer gets can
 * never disagree about when a quote dies.
 *
 * The expiry is `approval_token_expires_at`: the moment the approval link
 * stops resolving, already enforced by the approval routes. That IS the
 * quote's expiry as far as the customer is concerned — it is the date in
 * their email and the button that stops working.
 *
 * Two things this refuses to say:
 *
 *  - A quote with NO expiry date is `no_link`, never `expired`. Rows that
 *    predate the token era, and drafts never sent for approval, have no link
 *    at all; calling that "expired" would send a rep chasing a re-send of
 *    something that was never sent this way.
 *  - The pre-expiry warning never fires after expiry. If a sweep is missed,
 *    warning someone that a quote "expires in -2 days" is worse than saying
 *    nothing — the expired notice covers it instead.
 */

/** Days before expiry the customer warning and rep heads-up go out. */
export const WARN_DAYS = 3;

/**
 * How far back an expiry can be and still be worth telling someone about.
 *
 * Without this, the first sweep after deploy would notify a rep about every
 * quote they ever sent and never closed — links that died months ago, which
 * is not news and is exactly how a new alert gets muted in week one. The
 * quiet-day nudges have been chasing those all along, and the list still
 * shows every one of them as expired; this only bounds the interruption.
 */
export const EXPIRED_NOTICE_DAYS = 14;

const DAY_MS = 86_400_000;

export type ExpiryState = 'no_link' | 'active' | 'expiring' | 'expired';

export interface ExpiryRow {
  approval_token_expires_at?: string | null;
  expiry_warned_for?: string | null;
  expiry_notified_for?: string | null;
}

/** Whole days from `now` until the link dies; null when there is no link. */
export function daysUntilExpiry(expiresAt?: string | null, now: number = Date.now()): number | null {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / DAY_MS);
}

export function expiryState(expiresAt?: string | null, now: number = Date.now()): ExpiryState {
  const days = daysUntilExpiry(expiresAt, now);
  if (days == null) return 'no_link';
  if (days < 0) return 'expired';
  return days <= WARN_DAYS ? 'expiring' : 'active';
}

/**
 * What a human reads. Null when there is no link — the caller shows nothing
 * rather than a sentence about a date that does not exist.
 */
export function expiryLabel(expiresAt?: string | null, now: number = Date.now()): string | null {
  const days = daysUntilExpiry(expiresAt, now);
  if (days == null) return null;
  if (days < 0) return 'Link expired';
  if (days === 0) return 'Expires today';
  if (days === 1) return 'Expires tomorrow';
  return `Expires in ${days} days`;
}

/**
 * Same value the stamps carry, normalized: comparing raw strings would call a
 * link re-armed just because Postgres rendered the same instant differently
 * (`+00` vs `Z`, microseconds vs milliseconds).
 */
function stampKey(value?: string | null): number | null {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? null : t;
}

const firedFor = (stamp: string | null | undefined, expiresAt: string | null | undefined): boolean => {
  const a = stampKey(stamp);
  const b = stampKey(expiresAt);
  return a != null && b != null && a === b;
};

/** Is the pre-expiry warning due for this row right now? */
export function dueWarning(row: ExpiryRow, now: number = Date.now()): boolean {
  if (expiryState(row.approval_token_expires_at, now) !== 'expiring') return false;
  return !firedFor(row.expiry_warned_for, row.approval_token_expires_at);
}

/** Is the "this quote's link has expired" notice due for this row right now? */
export function dueExpiredNotice(row: ExpiryRow, now: number = Date.now()): boolean {
  if (expiryState(row.approval_token_expires_at, now) !== 'expired') return false;
  const days = daysUntilExpiry(row.approval_token_expires_at, now);
  if (days == null || days < -EXPIRED_NOTICE_DAYS) return false;
  return !firedFor(row.expiry_notified_for, row.approval_token_expires_at);
}

/** Short date for email copy — "Friday, September 12". */
export function expiryDateText(expiresAt?: string | null): string | null {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
