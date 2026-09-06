/**
 * Shared utility for tokenized customer approval flows (T1.7 estimate,
 * T1.8 proof). Handles token generation, expiry validation, audit metadata
 * capture, rate-limiting, and content hashing for the signed-document
 * snapshot.
 */

import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { r2Upload } from '@/lib/r2';

const DEFAULT_EXPIRY_DAYS = 30;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_ATTEMPTS = 20;

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export interface ApprovalMetadata {
  ip: string;
  userAgent: string;
  deliveryChannel: 'email_link' | 'sms_link' | null;
  deliveryTarget: string | null;
  timeOnPageSeconds: number | null;
}

export interface TokenPayload {
  token: string;
  expiresAt: string; // ISO
}

/**
 * Generate a new approval token + expiry. Default 30 days.
 */
export function generateToken(expiryDays: number = DEFAULT_EXPIRY_DAYS): TokenPayload {
  const expires = new Date();
  expires.setDate(expires.getDate() + expiryDays);
  return {
    token: crypto.randomUUID(),
    expiresAt: expires.toISOString(),
  };
}

/**
 * Extract the best-effort client IP from an incoming request.
 * Respects x-forwarded-for (first hop) and falls back to x-real-ip.
 */
export function getRequestIp(req: NextRequest | Request): string {
  const h = (req as any).headers as Headers;
  const fwd = h.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  const realIp = h.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

export function getRequestUserAgent(req: NextRequest | Request): string {
  const h = (req as any).headers as Headers;
  return h.get('user-agent') || 'unknown';
}

/**
 * Rate-limit a given IP + action. Returns true when allowed, false when
 * the caller should respond 429. Records the attempt on each call so the
 * window rolls naturally.
 */
export async function checkRateLimit(ip: string, action: string, maxAttempts: number = RATE_LIMIT_MAX_ATTEMPTS): Promise<boolean> {
  // No forwarding header used to mean NO limit at all — a fail-open a
  // direct-to-origin client could sit in forever (Round 3, §7.2.5). Real
  // traffic on Vercel always carries x-forwarded-for; whatever doesn't
  // shares one bucket and gets rate-limited together.
  if (!ip || ip === 'unknown') ip = 'no-ip';
  const supabase = getServiceClient();
  const cutoff = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

  const { count } = await supabase
    .from('approval_rate_limits')
    .select('id', { count: 'exact', head: true })
    .eq('ip_address', ip)
    .eq('action', action)
    .gt('attempted_at', cutoff);

  const attempts = count || 0;
  if (attempts >= maxAttempts) return false;

  await supabase.from('approval_rate_limits').insert({
    ip_address: ip,
    action,
  });
  return true;
}

/**
 * sha256 hex digest of a string — used for signed-document integrity
 * verification. Caller can compare later renderings against the stored
 * hash to detect drift.
 */
export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Upload a rendered document snapshot to the signed-documents bucket and
 * return the storage path + hash. Contents are text (HTML/PDF base64/etc.)
 * so caller controls encoding.
 */
export async function uploadSignedDocument(
  subpath: string,
  contents: string,
  contentType: string = 'text/html'
): Promise<{ path: string; hash: string }> {
  const hash = sha256Hex(contents);
  const path = `${subpath}-${Date.now()}.${contentType.includes('html') ? 'html' : 'pdf'}`;
  const buffer = Buffer.from(contents, 'utf8');
  const result = await r2Upload('signed-documents', path, buffer, contentType);
  if (!result.success) throw new Error(`Failed to upload signed document: ${result.error}`);
  return { path: result.key, hash };
}

/**
 * Deterministic fingerprint of WHAT was sent for approval: the money-and-
 * items contract — item numbers, quantities, unit prices (line order by
 * sort_order) plus the header totals. send-for-approval stamps it
 * (estimates.approval_sent_hash, migration 242); the accept route
 * recomputes and refuses on mismatch, closing the edit-during-approval
 * window (Round 3 finding: a save landing while the link was live froze a
 * "signed" record showing prices the customer never saw).
 *
 * Descriptions are deliberately excluded: the approval renderer enriches
 * lines (catalog photos, vendor links), and a cosmetic description touch
 * must not strand a legitimate acceptance.
 */
export function approvalContentHash(
  estimate: { subtotal?: unknown; labor_total?: unknown; tax_amount?: unknown; grand_total?: unknown; tax_rate?: unknown },
  lines: Array<{ item_number?: unknown; quantity?: unknown; unit_price?: unknown; sort_order?: unknown }>,
): string {
  const money = (v: unknown) => +(parseFloat(String(v ?? 0)) || 0).toFixed(2);
  const body = {
    lines: [...lines]
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
      .map(l => [String(l.item_number ?? ''), money(l.quantity), money(l.unit_price)]),
    totals: [estimate.subtotal, estimate.labor_total, estimate.tax_amount, estimate.grand_total, estimate.tax_rate].map(money),
  };
  return sha256Hex(JSON.stringify(body));
}

/**
 * Validate a token has not expired. Returns a reason string on failure.
 */
export function validateExpiry(expiresAt: string | null): { ok: boolean; reason?: string } {
  if (!expiresAt) return { ok: false, reason: 'no_expiry' };
  if (new Date(expiresAt).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/**
 * Normalize raw request body into ApprovalMetadata. Trusts server-supplied
 * IP/UA over client-supplied values; accepts client-supplied timeOnPage.
 */
export function captureMetadata(
  req: NextRequest | Request,
  body: { timeOnPageSeconds?: number | null; deliveryChannel?: string | null; deliveryTarget?: string | null }
): ApprovalMetadata {
  const channel = body.deliveryChannel === 'sms_link' || body.deliveryChannel === 'email_link'
    ? (body.deliveryChannel as 'sms_link' | 'email_link')
    : null;
  return {
    ip: getRequestIp(req),
    userAgent: getRequestUserAgent(req),
    deliveryChannel: channel,
    deliveryTarget: body.deliveryTarget || null,
    timeOnPageSeconds: typeof body.timeOnPageSeconds === 'number' ? Math.floor(body.timeOnPageSeconds) : null,
  };
}

// Canonical E-SIGN agreement copy — client-safe module so the approval
// pages can import the same string this server lib stamps into snapshots.
export { AGREEMENT_TEXT } from '@/lib/approval-agreement';
