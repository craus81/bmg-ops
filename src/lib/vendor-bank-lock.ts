/**
 * Locks and opens vendor bank numbers (Books part 59, src/lib/vendor-bank.ts)
 * with VENDOR_BANK_KEY, a key only the server has: 32 random bytes as base64,
 * set in Vercel. Only /api/pay-vendors/bank uses it, and no page loads it
 * (src/lib/client-graph.test.ts checks), so neither the key nor a number it
 * opens reaches a browser.
 *
 * The numbers are locked with AES-256-GCM, and the lock names the vendor and
 * the row they were entered as, so locked numbers moved to another vendor or
 * row don't open. A confirmation on a call-back is sealed the same way: an
 * HMAC of the vendor and the row, so a row set to confirmed in the database
 * by anything but this server doesn't hold. Both keys are drawn from
 * VENDOR_BANK_KEY with HKDF, with a short id for it that says which key
 * locked what. Lose the key and the numbers can't be opened: they're entered
 * and confirmed again.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { ACCOUNT_MAX, ACCOUNT_MIN, isAccountType, type BankNumbers } from '@/lib/vendor-bank';

export interface BankKey {
  /** 8 hex digits that say which key locked a vendor's numbers; nothing can be worked out from it. */
  id: string;
  lock: Buffer;
  confirm: Buffer;
}

export const KEY_MISSING = "Vendor bank numbers can't be kept until VENDOR_BANK_KEY is set in Vercel.";
export const KEY_BAD = "VENDOR_BANK_KEY isn't a key FleetSuite can use: it's 32 random bytes as base64, 44 characters.";

/** The key from VENDOR_BANK_KEY, or why there's none to use. */
export function bankKey(raw: string | undefined = process.env.VENDOR_BANK_KEY): { key: BankKey } | { problem: string } {
  const text = (raw ?? '').trim();
  if (!text) return { problem: KEY_MISSING };
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(text)) return { problem: KEY_BAD };
  const secret = Buffer.from(text, 'base64');
  const draw = (use: string, bytes: number) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), `FleetSuite vendor bank numbers: ${use}`, bytes));
  return { key: { id: draw('key id', 4).toString('hex'), lock: draw('lock', 32), confirm: draw('confirm', 32) } };
}

const VERSION = 'v1';

/** What the lock names, so the numbers open only on the vendor and row they were entered as. */
const named = (key: BankKey, vendorId: string, rowId: string) => Buffer.from(`${VERSION}:${key.id}:vendor ${vendorId}:row ${rowId}`);

/** The numbers, locked: 'v1.<key id>.<iv>.<tag>.<locked>', base64url. */
export function lockNumbers(key: BankKey, numbers: BankNumbers, vendorId: string, rowId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.lock, iv);
  cipher.setAAD(named(key, vendorId, rowId));
  const locked = Buffer.concat([cipher.update(JSON.stringify(numbers), 'utf8'), cipher.final()]);
  return [VERSION, key.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), locked.toString('base64url')].join('.');
}

export type Opened = { numbers: BankNumbers } | { problem: 'other_key' | 'broken' };

/** The numbers locked for this vendor and row; 'other_key' when another key locked them, 'broken' when they don't open. */
export function openNumbers(key: BankKey, locked: string, vendorId: string, rowId: string): Opened {
  const parts = locked.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return { problem: 'broken' };
  if (parts[1] !== key.id) return { problem: 'other_key' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.lock, Buffer.from(parts[2], 'base64url'));
    decipher.setAAD(named(key, vendorId, rowId));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
    const opened = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8'));
    const account = new RegExp(`^\\d{${ACCOUNT_MIN},${ACCOUNT_MAX}}$`);
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    if (!/^\d{9}$/.test(text(opened?.routing)) || !account.test(text(opened?.account)) || !isAccountType(opened?.type)) return { problem: 'broken' };
    return { numbers: { routing: opened.routing, account: opened.account, type: opened.type } };
  } catch {
    return { problem: 'broken' };
  }
}

/** What the page says about numbers that didn't open. */
export const openedProblem = (problem: 'other_key' | 'broken') => (problem === 'other_key'
  ? 'These were locked with another key than VENDOR_BANK_KEY holds now: put that key back, or enter them again.'
  : "These don't open as they were locked, so they were changed outside FleetSuite: enter them again.");

const mac = (key: BankKey, vendorId: string, rowId: string) =>
  createHmac('sha256', key.confirm).update(`${VERSION}:confirmed:vendor ${vendorId}:row ${rowId}`).digest('base64url');

/** The seal on numbers confirmed on a call-back: '<key id>.<HMAC>'. */
export const confirmSeal = (key: BankKey, vendorId: string, rowId: string) => `${key.id}.${mac(key, vendorId, rowId)}`;

/** Whether this server, with this key, confirmed this vendor's row. */
export function confirmSealHolds(key: BankKey, seal: string | null | undefined, vendorId: string, rowId: string): boolean {
  const expected = Buffer.from(confirmSeal(key, vendorId, rowId));
  const given = Buffer.from(seal ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
