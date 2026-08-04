import { describe, it, expect } from 'vitest';
import { normalizeWebsiteUrl } from './netsuite';

// NetSuite rejects the whole customer create with a 400 ("Error while
// accessing a resource. Invalid URL") when the Web Address field isn't a
// fully-formed URL — which business-card scans almost never produce.
describe('normalizeWebsiteUrl', () => {
  it('prepends https:// to scheme-less card websites', () => {
    expect(normalizeWebsiteUrl('www.bmgfleet.com')).toBe('https://www.bmgfleet.com');
    expect(normalizeWebsiteUrl('bmgfleet.com')).toBe('https://bmgfleet.com');
    expect(normalizeWebsiteUrl('bmgfleet.com/contact')).toBe('https://bmgfleet.com/contact');
  });

  it('keeps an existing scheme', () => {
    expect(normalizeWebsiteUrl('https://bmgfleet.com')).toBe('https://bmgfleet.com');
    expect(normalizeWebsiteUrl('http://bmgfleet.com')).toBe('http://bmgfleet.com');
  });

  it('strips whitespace OCR artifacts', () => {
    expect(normalizeWebsiteUrl('  www.bmgfleet.com  ')).toBe('https://www.bmgfleet.com');
    expect(normalizeWebsiteUrl('www. bmgfleet .com')).toBe('https://www.bmgfleet.com');
  });

  it('drops values that cannot become a valid URL', () => {
    expect(normalizeWebsiteUrl('N/A')).toBeUndefined();
    expect(normalizeWebsiteUrl('none')).toBeUndefined();
    expect(normalizeWebsiteUrl('not a real website')).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(normalizeWebsiteUrl('')).toBeUndefined();
    expect(normalizeWebsiteUrl('   ')).toBeUndefined();
    expect(normalizeWebsiteUrl(null)).toBeUndefined();
    expect(normalizeWebsiteUrl(undefined)).toBeUndefined();
  });
});
