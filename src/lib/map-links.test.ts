import { describe, it, expect } from 'vitest';
import { mapQuery, mapUrl, isApplePlatform } from './map-links';

describe('mapQuery', () => {
  it('cleans the stored one-line and dotted forms', () => {
    expect(mapQuery("1200 Main St, O'Fallon, MO, 63368")).toBe("1200 Main St, O'Fallon, MO, 63368");
    expect(mapQuery("1200 Main St · Suite 4 · O'Fallon, MO · 63368")).toBe("1200 Main St, Suite 4, O'Fallon, MO, 63368");
  });

  it('joins multi-line ship-to blocks', () => {
    expect(mapQuery('Acme Fleet\n  1200 Main St\n\nSt. Louis, MO 63101\n')).toBe('1200 Main St, St. Louis, MO 63101');
    expect(mapQuery('Attn: Joe\nAcme Fleet\n1200 Main St, Suite 4\nSt. Louis, MO 63101')).toBe('1200 Main St, Suite 4, St. Louis, MO 63101');
    // No street line: the name may be all that places it.
    expect(mapQuery('Ford Kansas City Assembly\nClaycomo, MO 64119')).toBe('Ford Kansas City Assembly, Claycomo, MO 64119');
  });

  it('builds a line from address parts', () => {
    expect(mapQuery({ street: '5 Oak Rd', city: 'Wentzville', state: 'MO', zip: '63385' })).toBe('5 Oak Rd, Wentzville, MO 63385');
    expect(mapQuery({ address: '5 Oak Rd', address2: 'Unit B', city: 'Wentzville', state: 'MO' })).toBe('5 Oak Rd Unit B, Wentzville, MO');
    expect(mapQuery({ city: 'Wentzville', state: 'MO' })).toBe('Wentzville, MO');
  });

  it('returns empty for nothing mappable', () => {
    expect(mapQuery(null)).toBe('');
    expect(mapQuery('')).toBe('');
    expect(mapQuery('—')).toBe('');
    expect(mapQuery({ state: 'MO' })).toBe('');
    expect(mapQuery({})).toBe('');
  });
});

describe('mapUrl', () => {
  const addr = '1200 Main St, St. Louis, MO 63101';
  it('links Google Maps by default', () => {
    expect(mapUrl(addr)).toBe('https://www.google.com/maps/search/?api=1&query=1200%20Main%20St%2C%20St.%20Louis%2C%20MO%2063101');
    expect(mapUrl(addr, { directions: true })).toBe('https://www.google.com/maps/dir/?api=1&destination=1200%20Main%20St%2C%20St.%20Louis%2C%20MO%2063101');
  });
  it('links Apple Maps on Apple devices', () => {
    expect(mapUrl(addr, { apple: true })).toBe('https://maps.apple.com/?q=1200%20Main%20St%2C%20St.%20Louis%2C%20MO%2063101');
    expect(mapUrl(addr, { apple: true, directions: true })).toBe('https://maps.apple.com/?daddr=1200%20Main%20St%2C%20St.%20Louis%2C%20MO%2063101');
  });
  it('returns null when there is nothing to map', () => {
    expect(mapUrl('  ')).toBeNull();
  });
});

describe('isApplePlatform', () => {
  it('spots iPhone, iPad and Mac', () => {
    expect(isApplePlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
    expect(isApplePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
    expect(isApplePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isApplePlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(false);
    expect(isApplePlatform(undefined)).toBe(false);
  });
});
