// Two-step sign-in's rules (Books part 87, src/lib/two-step.ts): who is asked
// for a code, how a token's level is read, and the small helpers the screens
// use. Made-up tokens and keys.
import { describe, it, expect } from 'vitest';
import {
  TWO_STEP_REFUSAL, TWO_STEP_ROLES, cleanCode, hasAuthenticator, holdsMoneyRole, isTwoStepNeed, keyInGroups, qrImageSrc,
  tokenLevel, twoStepNeed, verifiedAuthenticators,
} from './two-step';

/** A made-up access token: only its claims matter here, never its signature. */
const token = (claims: Record<string, unknown>) =>
  `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2lnbmF0dXJl`;

describe('the money roles', () => {
  it('are the super admins, executives, finance, the bookkeeper and the CPA', () => {
    expect(TWO_STEP_ROLES).toEqual(['super_admin', 'executive', 'finance', 'bookkeeper', 'cpa']);
    for (const role of TWO_STEP_ROLES) expect(holdsMoneyRole([role]), role).toBe(true);
    expect(holdsMoneyRole(['sales', 'cpa'])).toBe(true);
  });

  it("aren't the rest of the shop, the customers or the installers", () => {
    for (const role of ['admin', 'sales', 'shop_tech', 'field_tech', 'graphics_production', 'installer', 'customer']) {
      expect(holdsMoneyRole([role]), role).toBe(false);
    }
    expect(holdsMoneyRole([])).toBe(false);
    expect(holdsMoneyRole(null)).toBe(false);
    expect(holdsMoneyRole(undefined)).toBe(false);
  });
});

describe('tokenLevel', () => {
  it("reads the level a sign-in's token was issued at", () => {
    expect(tokenLevel(token({ sub: 'u-1', aal: 'aal1' }))).toBe('aal1');
    expect(tokenLevel(token({ sub: 'u-1', aal: 'aal2', amr: [{ method: 'totp' }] }))).toBe('aal2');
  });

  it('reads a token whose claims hold letters outside plain ASCII', () => {
    expect(tokenLevel(token({ name: 'Zoë Ñandú — 東京', aal: 'aal2' }))).toBe('aal2');
  });

  it('names no level for a token without one, with another, or that is no token at all', () => {
    expect(tokenLevel(token({ sub: 'u-1' }))).toBeNull();
    expect(tokenLevel(token({ aal: 'aal3' }))).toBeNull();
    expect(tokenLevel(token({ aal: 2 }))).toBeNull();
    expect(tokenLevel('made-up-token')).toBeNull();
    expect(tokenLevel('a.%%%.c')).toBeNull();
    expect(tokenLevel('a.bm90IGpzb24.c')).toBeNull();
    expect(tokenLevel('')).toBeNull();
    expect(tokenLevel(null)).toBeNull();
    expect(tokenLevel(undefined)).toBeNull();
  });
});

describe('authenticator apps', () => {
  const app = (id: string, status: string, factor_type = 'totp') => ({ id, status, factor_type });

  it('counts only an authenticator app whose first code was taken', () => {
    expect(verifiedAuthenticators([app('a', 'verified'), app('b', 'unverified'), app('c', 'verified', 'phone')]))
      .toEqual([app('a', 'verified')]);
    expect(hasAuthenticator({ factors: [app('a', 'verified')] })).toBe(true);
    expect(hasAuthenticator({ factors: [app('b', 'unverified')] })).toBe(false);
    expect(hasAuthenticator({ factors: [app('c', 'verified', 'phone')] })).toBe(false);
    expect(hasAuthenticator({ factors: [] })).toBe(false);
    expect(hasAuthenticator({ factors: null })).toBe(false);
    expect(hasAuthenticator({})).toBe(false);
    expect(hasAuthenticator(null)).toBe(false);
    expect(verifiedAuthenticators(undefined)).toEqual([]);
  });
});

describe('twoStepNeed', () => {
  const at = (over: Partial<Parameters<typeof twoStepNeed>[0]> = {}) =>
    twoStepNeed({ level: 'aal1', hasAuthenticator: false, moneyRole: false, switchOn: false, ...over });

  it('lets in a sign-in that gave its code, whatever else holds', () => {
    expect(at({ level: 'aal2', hasAuthenticator: true, moneyRole: true, switchOn: true })).toBeNull();
    expect(at({ level: 'aal2', moneyRole: true, switchOn: true })).toBeNull();
  });

  it('asks anyone with an authenticator app for its code, switch on or off', () => {
    expect(at({ hasAuthenticator: true })).toBe('code');
    expect(at({ hasAuthenticator: true, moneyRole: true, switchOn: true })).toBe('code');
    expect(at({ level: null, hasAuthenticator: true })).toBe('code');
  });

  it('has a money role set an app up first only while the switch is on', () => {
    expect(at({ moneyRole: true, switchOn: true })).toBe('setup');
    expect(at({ level: null, moneyRole: true, switchOn: true })).toBe('setup');
    expect(at({ moneyRole: true, switchOn: false })).toBeNull();
    expect(at({ moneyRole: false, switchOn: true })).toBeNull();
    expect(at()).toBeNull();
  });

  it('knows its own needs and nothing else', () => {
    expect(isTwoStepNeed('code')).toBe(true);
    expect(isTwoStepNeed('setup')).toBe(true);
    for (const v of ['unknown', '', null, undefined, 1, {}]) expect(isTwoStepNeed(v)).toBe(false);
    expect(TWO_STEP_REFUSAL).toEqual({
      code: 'Enter the code from your authenticator app to carry on.',
      setup: 'Set up two-step sign-in to carry on: your role needs a code from an authenticator app when you sign in.',
      unknown: "FleetSuite couldn't check two-step sign-in just now. Try again in a moment.",
    });
  });
});

describe('the screens’ helpers', () => {
  it('takes six digits, with spaces or a dash, and nothing else', () => {
    expect(cleanCode('123456')).toBe('123456');
    expect(cleanCode(' 123 456 ')).toBe('123456');
    expect(cleanCode('123-456')).toBe('123456');
    expect(cleanCode('12345')).toBeNull();
    expect(cleanCode('1234567')).toBeNull();
    expect(cleanCode('12a456')).toBeNull();
    expect(cleanCode('')).toBeNull();
  });

  it('shows a set-up key in groups of four', () => {
    expect(keyInGroups('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(keyInGroups('ABCDEF')).toBe('ABCD EF');
    expect(keyInGroups('AB CD')).toBe('ABCD');
    expect(keyInGroups('')).toBe('');
  });

  it("makes Supabase's QR code an image whose SVG survives a # in it", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>';
    const src = qrImageSrc(`data:image/svg+xml;utf-8,${svg}`);
    expect(src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    expect(src).not.toContain('#');
    expect(decodeURIComponent(src.slice('data:image/svg+xml;charset=utf-8,'.length))).toBe(svg);
    expect(qrImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });
});
