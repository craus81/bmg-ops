/**
 * Locks and opens vendor bank numbers (Books part 59, src/lib/vendor-bank.ts)
 * with VENDOR_BANK_KEY, a key only the server has: 32 random bytes as base64,
 * set in Vercel. Only /api/pay-vendors/bank and /api/pay-vendors/ach use it,
 * and no page loads it (src/lib/client-graph.test.ts checks), so neither the
 * key nor a number it opens reaches a browser, but for the ACH file a super
 * admin downloads for First Bank (part 60). That file, and BMG's account
 * number for its offsetting debit, are locked the same way.
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

/**
 * What a lock names, so what's locked opens only for what it was locked for: a vendor's numbers on the row they were
 * entered as, an ACH file by its id, BMG's account for a bank account's offsetting debit.
 */
const vendorUse = (vendorId: string, rowId: string) => `vendor ${vendorId}:row ${rowId}`;
const fileUse = (fileId: string) => `ach file ${fileId}`;
const offsetUse = (accountId: string) => `offset account ${accountId}`;

/** Text locked for one use: 'v1.<key id>.<iv>.<tag>.<locked>', base64url. */
function lock(key: BankKey, text: string, use: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.lock, iv);
  cipher.setAAD(Buffer.from(`${VERSION}:${key.id}:${use}`));
  const locked = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [VERSION, key.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), locked.toString('base64url')].join('.');
}

type Problem = 'other_key' | 'broken';

/** Text locked for this use; 'other_key' when another key locked it, 'broken' when it doesn't open. */
function open(key: BankKey, locked: string, use: string): { text: string } | { problem: Problem } {
  const parts = locked.split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return { problem: 'broken' };
  if (parts[1] !== key.id) return { problem: 'other_key' };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.lock, Buffer.from(parts[2], 'base64url'));
    decipher.setAAD(Buffer.from(`${VERSION}:${key.id}:${use}`));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
    return { text: Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8') };
  } catch {
    return { problem: 'broken' };
  }
}

export type Opened = { numbers: BankNumbers } | { problem: Problem };

/** Numbers as they were locked, or 'broken' when what opened isn't numbers. */
function numbersIn(opened: { text: string } | { problem: Problem }): Opened {
  if ('problem' in opened) return opened;
  try {
    const n = JSON.parse(opened.text);
    const account = new RegExp(`^\\d{${ACCOUNT_MIN},${ACCOUNT_MAX}}$`);
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    if (!/^\d{9}$/.test(text(n?.routing)) || !account.test(text(n?.account)) || !isAccountType(n?.type)) return { problem: 'broken' };
    return { numbers: { routing: n.routing, account: n.account, type: n.type } };
  } catch {
    return { problem: 'broken' };
  }
}

/** The numbers, locked to the vendor and row they're entered as. */
export const lockNumbers = (key: BankKey, numbers: BankNumbers, vendorId: string, rowId: string) =>
  lock(key, JSON.stringify(numbers), vendorUse(vendorId, rowId));

/** The numbers locked for this vendor and row; 'other_key' when another key locked them, 'broken' when they don't open. */
export const openNumbers = (key: BankKey, locked: string, vendorId: string, rowId: string): Opened =>
  numbersIn(open(key, locked, vendorUse(vendorId, rowId)));

/** BMG's account for a bank account's offsetting debit in the ACH file, locked to that bank account. */
export const lockOffset = (key: BankKey, numbers: BankNumbers, accountId: string) => lock(key, JSON.stringify(numbers), offsetUse(accountId));

export const openOffset = (key: BankKey, locked: string, accountId: string): Opened => numbersIn(open(key, locked, offsetUse(accountId)));

/** An ACH file, locked to its id while it waits to be uploaded to First Bank. */
export const lockFile = (key: BankKey, text: string, fileId: string) => lock(key, text, fileUse(fileId));

export const openFile = (key: BankKey, locked: string, fileId: string) => open(key, locked, fileUse(fileId));

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

/** A set of a vendor's numbers, as vendor_bank_accounts keeps it (migration 490): as much as says whether it holds. */
export interface KeptSet {
  id: string;
  vendor_netsuite_id: string;
  routing_number: string;
  account_last4: string;
  account_type: string;
  status: string;
  account_locked: string | null;
  confirm_seal: string | null;
}

/**
 * Why a set waiting or confirmed can't be trusted as it stands, or null when it can: its numbers don't open with this
 * key, what it shows isn't what's locked, or it's confirmed without this server's seal. With no key, nothing's said.
 */
export function keptSetProblem(r: KeptSet, key: BankKey | null): string | null {
  if (!key || !r.account_locked) return null;
  const opened = openNumbers(key, r.account_locked, r.vendor_netsuite_id, r.id);
  if ('problem' in opened) return openedProblem(opened.problem);
  const n = opened.numbers;
  if (n.routing !== r.routing_number || !n.account.endsWith(r.account_last4) || n.type !== r.account_type) {
    return "What these show isn't what's locked, so they were changed outside FleetSuite: enter them again.";
  }
  if (r.status === 'confirmed' && !confirmSealHolds(key, r.confirm_seal, r.vendor_netsuite_id, r.id)) {
    return "FleetSuite didn't confirm these, so they were changed outside it: enter them again and confirm them on a call-back.";
  }
  return null;
}
