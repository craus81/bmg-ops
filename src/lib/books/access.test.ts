// Who can open FleetSuite's own books and what each can do there
// (src/lib/books/access.ts, Books part 52).
import { describe, it, expect } from 'vitest';
import { booksAccess, booksAllows, booksOnly, type BooksAccess } from './access';

const holding = (...roles: string[]) => (role: string) => roles.includes(role);
const LEVELS: BooksAccess[] = ['read', 'keep', 'owner'];

describe('booksAccess', () => {
  it('gives super admins the owner level, the bookkeeper keep and the CPA read', () => {
    expect(booksAccess(holding('admin', 'super_admin'))).toBe('owner');
    expect(booksAccess(holding('bookkeeper'))).toBe('keep');
    expect(booksAccess(holding('cpa'))).toBe('read');
  });

  it('goes by the highest level someone holds', () => {
    expect(booksAccess(holding('cpa', 'bookkeeper'))).toBe('keep');
    expect(booksAccess(holding('bookkeeper', 'admin', 'super_admin'))).toBe('owner');
  });

  it('keeps everyone else out, admins, executives and finance included', () => {
    for (const role of ['admin', 'executive', 'finance', 'sales', 'graphics_production', 'shop_tech', 'field_tech', 'installer', 'customer']) {
      expect(booksAccess(holding(role)), role).toBeNull();
    }
    expect(booksAccess(holding())).toBeNull();
  });
});

describe('booksAllows', () => {
  it('lets each level do everything the ones below it can', () => {
    expect(LEVELS.map((need) => booksAllows('owner', need))).toEqual([true, true, true]);
    expect(LEVELS.map((need) => booksAllows('keep', need))).toEqual([true, true, false]);
    expect(LEVELS.map((need) => booksAllows('read', need))).toEqual([true, false, false]);
  });

  it("allows nothing to someone who can't open the books", () => {
    for (const need of LEVELS) {
      expect(booksAllows(null, need)).toBe(false);
      expect(booksAllows(undefined, need)).toBe(false);
    }
  });
});

describe('booksOnly', () => {
  it('is a bookkeeper or CPA login with no other role', () => {
    expect(booksOnly(holding('bookkeeper'))).toBe(true);
    expect(booksOnly(holding('cpa'))).toBe(true);
    expect(booksOnly(holding('bookkeeper', 'cpa'))).toBe(true);
  });

  it("isn't anyone with another role too, or with neither", () => {
    expect(booksOnly(holding('bookkeeper', 'finance'))).toBe(false);
    expect(booksOnly(holding('cpa', 'executive'))).toBe(false);
    expect(booksOnly(holding('cpa', 'customer'))).toBe(false);
    expect(booksOnly(holding('admin', 'super_admin'))).toBe(false);
    expect(booksOnly(holding('finance'))).toBe(false);
    expect(booksOnly(holding())).toBe(false);
  });
});
