// Locking vendor bank numbers (Books part 59): the key read from
// VENDOR_BANK_KEY, numbers locked so they open only with that key and only
// for the vendor and row they were entered as, shaped as migration 490 keeps
// them, and the seal on a confirmation, which holds only for its vendor and
// row under its key. Made-up keys and numbers.
import { describe, it, expect, afterEach } from 'vitest';
import { KEY_BAD, KEY_MISSING, bankKey, confirmSeal, confirmSealHolds, lockNumbers, openNumbers, openedProblem, type BankKey } from './vendor-bank-lock';
import type { BankNumbers } from './vendor-bank';

const RAW = Buffer.alloc(32, 7).toString('base64');
const OTHER_RAW = Buffer.alloc(32, 8).toString('base64');
const keyOf = (raw: string): BankKey => {
  const read = bankKey(raw);
  if (!('key' in read)) throw new Error(read.problem);
  return read.key;
};
const KEY = keyOf(RAW);
const OTHER = keyOf(OTHER_RAW);
const ROW = 'e0000000-0000-4000-8000-000000000001';
const NUMBERS: BankNumbers = { routing: '123456780', account: '123456789012', type: 'checking' };

/** As migration 490 keeps them. */
const LOCKED_SHAPE = /^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{40,255}$/;
const SEAL_SHAPE = /^[0-9a-f]{8}\.[A-Za-z0-9_-]{43}$/;

const ENV = process.env.VENDOR_BANK_KEY;
afterEach(() => {
  if (ENV === undefined) delete process.env.VENDOR_BANK_KEY;
  else process.env.VENDOR_BANK_KEY = ENV;
});

describe('bankKey', () => {
  it('reads 32 random bytes as base64 from VENDOR_BANK_KEY', () => {
    expect(RAW).toHaveLength(44);
    process.env.VENDOR_BANK_KEY = ` ${RAW}\n`;
    const read = bankKey();
    expect(read).toEqual({ key: KEY });
    expect(KEY.id).toMatch(/^[0-9a-f]{8}$/);
    expect(KEY.lock).toHaveLength(32);
    expect(KEY.confirm).toHaveLength(32);
    // Each use draws its own key, none of them the one set.
    const secret = Buffer.from(RAW, 'base64');
    expect(KEY.lock.equals(KEY.confirm)).toBe(false);
    expect(KEY.lock.equals(secret)).toBe(false);
    expect(KEY.confirm.equals(secret)).toBe(false);
    // Without its padding too, and the same key gives the same id; another key another.
    expect(keyOf(RAW.replace(/=$/, ''))).toEqual(KEY);
    expect(OTHER.id).not.toBe(KEY.id);
    expect(OTHER.lock.equals(KEY.lock)).toBe(false);
  });

  it('says when there is none to use', () => {
    delete process.env.VENDOR_BANK_KEY;
    expect(bankKey()).toEqual({ problem: KEY_MISSING });
    expect(bankKey('  ')).toEqual({ problem: KEY_MISSING });
    expect(KEY_MISSING).toBe("Vendor bank numbers can't be kept until VENDOR_BANK_KEY is set in Vercel.");
    for (const bad of [RAW.slice(0, 40), `${RAW}A`, Buffer.alloc(16, 7).toString('base64'), Buffer.alloc(32, 7).toString('hex'), `${RAW.slice(0, 42)}!=`]) {
      expect(bankKey(bad)).toEqual({ problem: KEY_BAD });
    }
    expect(KEY_BAD).toBe("VENDOR_BANK_KEY isn't a key FleetSuite can use: it's 32 random bytes as base64, 44 characters.");
  });
});

describe('locking and opening', () => {
  it('opens what it locked, with the key, vendor and row it was locked for', () => {
    const locked = lockNumbers(KEY, NUMBERS, '31', ROW);
    expect(locked).toMatch(LOCKED_SHAPE);
    expect(locked.split('.')[1]).toBe(KEY.id);
    expect(locked).not.toContain(NUMBERS.account);
    expect(locked).not.toContain(NUMBERS.routing);
    expect(openNumbers(KEY, locked, '31', ROW)).toEqual({ numbers: NUMBERS });
    // Locked twice, the same numbers look different.
    expect(lockNumbers(KEY, NUMBERS, '31', ROW)).not.toBe(locked);
  });

  it('fits migration 490 for the shortest and longest numbers', () => {
    for (const numbers of [{ routing: '021000005', account: '1234', type: 'checking' }, { routing: '123456780', account: '12345678901234567', type: 'savings' }] as BankNumbers[]) {
      const locked = lockNumbers(KEY, numbers, '99999999999', 'ffffffff-ffff-4fff-bfff-ffffffffffff');
      expect(locked).toMatch(LOCKED_SHAPE);
      expect(openNumbers(KEY, locked, '99999999999', 'ffffffff-ffff-4fff-bfff-ffffffffffff')).toEqual({ numbers });
    }
  });

  it("doesn't open for another vendor or row, another key, or anything changed", () => {
    const locked = lockNumbers(KEY, NUMBERS, '31', ROW);
    expect(openNumbers(KEY, locked, '32', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, locked, '31', 'e0000000-0000-4000-8000-000000000002')).toEqual({ problem: 'broken' });
    expect(openNumbers(OTHER, locked, '31', ROW)).toEqual({ problem: 'other_key' });
    // Another key with this key's id still doesn't open it.
    expect(openNumbers({ ...OTHER, id: KEY.id }, locked, '31', ROW)).toEqual({ problem: 'broken' });

    const parts = locked.split('.');
    const swap = (i: number, to: string) => parts.map((p, j) => (j === i ? to : p)).join('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(openNumbers(KEY, swap(0, 'v2'), '31', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, swap(2, flip(parts[2])), '31', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, swap(3, flip(parts[3])), '31', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, swap(4, flip(parts[4])), '31', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, swap(4, ''), '31', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, parts.slice(0, 4).join('.'), '31', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, `${locked}.x`, '31', ROW)).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, '', '31', ROW)).toEqual({ problem: 'broken' });
  });

  it('opens only numbers shaped as entered', () => {
    const odd = (numbers: unknown) => openNumbers(KEY, lockNumbers(KEY, numbers as BankNumbers, '31', ROW), '31', ROW);
    expect(odd({ ...NUMBERS, routing: '12345678' })).toEqual({ problem: 'broken' });
    expect(odd({ ...NUMBERS, routing: 123456780 })).toEqual({ problem: 'broken' });
    expect(odd({ ...NUMBERS, account: '123' })).toEqual({ problem: 'broken' });
    expect(odd({ ...NUMBERS, account: '123456789012345678' })).toEqual({ problem: 'broken' });
    expect(odd({ ...NUMBERS, account: '12345678901x' })).toEqual({ problem: 'broken' });
    expect(odd({ ...NUMBERS, type: 'loan' })).toEqual({ problem: 'broken' });
    expect(odd(null)).toEqual({ problem: 'broken' });
    // Only the numbers come back.
    expect(odd({ ...NUMBERS, extra: 'x' })).toEqual({ numbers: NUMBERS });
  });

  it('says what to do about numbers that don\'t open', () => {
    expect(openedProblem('other_key')).toBe('These were locked with another key than VENDOR_BANK_KEY holds now: put that key back, or enter them again.');
    expect(openedProblem('broken')).toBe("These don't open as they were locked, so they were changed outside FleetSuite: enter them again.");
  });
});

describe('the seal on a confirmation', () => {
  it('holds for its vendor and row under its key only', () => {
    const seal = confirmSeal(KEY, '31', ROW);
    expect(seal).toMatch(SEAL_SHAPE);
    expect(seal.startsWith(`${KEY.id}.`)).toBe(true);
    expect(confirmSeal(KEY, '31', ROW)).toBe(seal);
    expect(confirmSealHolds(KEY, seal, '31', ROW)).toBe(true);
    expect(confirmSealHolds(KEY, seal, '32', ROW)).toBe(false);
    expect(confirmSealHolds(KEY, seal, '31', 'e0000000-0000-4000-8000-000000000002')).toBe(false);
    expect(confirmSealHolds(OTHER, seal, '31', ROW)).toBe(false);
    expect(confirmSealHolds(KEY, seal.slice(0, -1), '31', ROW)).toBe(false);
    expect(confirmSealHolds(KEY, `${seal}A`, '31', ROW)).toBe(false);
    expect(confirmSealHolds(KEY, null, '31', ROW)).toBe(false);
    expect(confirmSealHolds(KEY, undefined, '31', ROW)).toBe(false);
    expect(confirmSealHolds(KEY, '', '31', ROW)).toBe(false);
    // It isn't the lock's key that makes it.
    expect(confirmSeal({ ...KEY, confirm: KEY.lock }, '31', ROW)).not.toBe(seal);
  });
});
