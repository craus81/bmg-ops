/**
 * Two-step sign-in (Books part 87, migration 509, docs/books.md "Two-step
 * sign-in"; the NetSuite Exit Checklist's "Controls").
 *
 * Supabase Auth keeps each person's authenticator app as a TOTP factor, and
 * a sign-in that has given its code is at `aal2` (its access token's `aal`
 * claim; Supabase keeps it at `aal2` when the token refreshes). FleetSuite
 * asks for that code:
 *   - from everyone who has set an authenticator app up, whether or not the
 *     switch is on;
 *   - and, with Books → Switches "Two-step sign-in for money roles" on, from
 *     everyone who holds a money role (TWO_STEP_ROLES), who sets one up first
 *     when they haven't.
 * requireAuth (src/lib/api-auth.ts) refuses an API call from a sign-in that
 * still needs it, with `twoStep` in the answer, and the app shows the code or
 * set-up screen (src/components/TwoStep.tsx) before anything else.
 *
 * Client-safe: the app and the server both use it.
 */

/** The roles that work with BMG's money: the books, payments and the owner's numbers. */
export const TWO_STEP_ROLES: readonly string[] = ['super_admin', 'executive', 'finance', 'bookkeeper', 'cpa'];

/** What a sign-in still has to do: give its code, or set an authenticator app up first. */
export type TwoStepNeed = 'code' | 'setup';

export type AssuranceLevel = 'aal1' | 'aal2';

export const isTwoStepNeed = (v: unknown): v is TwoStepNeed => v === 'code' || v === 'setup';

/** Does someone with these roles hold a money role? */
export function holdsMoneyRole(roles: readonly string[] | null | undefined): boolean {
  return !!roles && roles.some((r) => TWO_STEP_ROLES.includes(r));
}

/**
 * A token's base64url part as text, a byte to a letter: the claim read here
 * is plain ASCII, and JSON.parse takes any other letters as they come.
 */
function base64UrlText(part: string): string {
  return atob(part.replace(/-/g, '+').replace(/_/g, '/'));
}

/**
 * The assurance level a Supabase access token was issued at, or null when it
 * names none. Reads the token without checking its signature, so only for a
 * token Supabase has already taken (requireAuth's getUser).
 */
export function tokenLevel(token: string | null | undefined): AssuranceLevel | null {
  const part = token?.split('.')[1];
  if (!part) return null;
  try {
    const aal = JSON.parse(base64UrlText(part))?.aal;
    return aal === 'aal1' || aal === 'aal2' ? aal : null;
  } catch {
    return null;
  }
}

interface FactorLike {
  id?: string;
  factor_type?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

/** The authenticator apps someone has finished setting up, from Supabase's user or its factor list. */
export function verifiedAuthenticators<F extends FactorLike>(factors: readonly F[] | null | undefined): F[] {
  return (factors ?? []).filter((f) => f.factor_type === 'totp' && f.status === 'verified');
}

/** Has this person finished setting up an authenticator app? Takes Supabase's user, with its factors. */
export function hasAuthenticator(user: { factors?: readonly FactorLike[] | null } | null | undefined): boolean {
  return verifiedAuthenticators(user?.factors).length > 0;
}

/**
 * What a sign-in still has to do before FleetSuite lets it in, or null when
 * nothing: one that gave its code is through; anyone with an authenticator
 * app gives its code; with the switch on, a money role without one sets it up.
 */
export function twoStepNeed(at: {
  level: AssuranceLevel | null;
  hasAuthenticator: boolean;
  moneyRole: boolean;
  switchOn: boolean;
}): TwoStepNeed | null {
  if (at.level === 'aal2') return null;
  if (at.hasAuthenticator) return 'code';
  return at.moneyRole && at.switchOn ? 'setup' : null;
}

/** What FleetSuite answers a call it refuses for two-step sign-in. */
export const TWO_STEP_REFUSAL: Readonly<Record<TwoStepNeed | 'unknown', string>> = {
  code: 'Enter the code from your authenticator app to carry on.',
  setup: 'Set up two-step sign-in to carry on: your role needs a code from an authenticator app when you sign in.',
  unknown: "FleetSuite couldn't check two-step sign-in just now. Try again in a moment.",
};

/** A typed code without its spaces and dashes, or null when that isn't six digits. */
export function cleanCode(typed: string): string | null {
  const digits = typed.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** A set-up key in groups of four, easier to copy into an authenticator app by hand. */
export function keyInGroups(secret: string): string {
  return (secret.replace(/\s/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * The QR code Supabase makes for a new authenticator app, as an image source
 * that survives the characters an SVG holds: Supabase's own data: URL leaves
 * them as they are, and a "#" in it would end the image early.
 */
export function qrImageSrc(qr: string): string {
  const prefix = 'data:image/svg+xml;utf-8,';
  return qr.startsWith(prefix) ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.slice(prefix.length))}` : qr;
}

/**
 * The window event apiFetch (src/lib/api-client.ts) raises when FleetSuite
 * refuses a call for two-step sign-in, with the need as its detail, so a
 * sign-in the switch caught partway through shows the screen at once.
 */
export const TWO_STEP_EVENT = 'fleetsuite:two-step';

/** How long after a code is first taken that FleetSuite tells the super admins someone set it up. */
export const SET_UP_TOLD_WITHIN_MS = 60 * 60 * 1000;
