import { describe, it, expect } from 'vitest';
import { cooldownPassed, reviewBlockHtml, COOLDOWN_MONTHS } from './review-request';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const monthsAgo = (n: number) => new Date(NOW - n * 30.44 * 86_400_000).toISOString();

describe('cooldownPassed', () => {
  it('allows an ask when we have never asked', () => {
    expect(cooldownPassed(null, NOW)).toBe(true);
    expect(cooldownPassed(undefined, NOW)).toBe(true);
  });
  it('blocks an ask inside the window', () => {
    expect(cooldownPassed(monthsAgo(COOLDOWN_MONTHS - 1), NOW)).toBe(false);
  });
  it('allows one once the window has passed', () => {
    expect(cooldownPassed(monthsAgo(COOLDOWN_MONTHS + 1), NOW)).toBe(true);
  });
  it('allows at exactly the boundary', () => {
    expect(cooldownPassed(monthsAgo(COOLDOWN_MONTHS), NOW)).toBe(true);
  });
  it('treats an unreadable stamp as never asked rather than blocking forever', () => {
    // Failing the other way would silently retire a customer from ever
    // being asked, with no way to notice.
    expect(cooldownPassed('not-a-date', NOW)).toBe(true);
  });
});

describe('reviewBlockHtml', () => {
  it('links to the configured URL', () => {
    expect(reviewBlockHtml('https://g.page/r/abc')).toContain('https://g.page/r/abc');
  });
  it('invites a complaint to come to us FIRST', () => {
    // The line that keeps this from being a review-farming block.
    expect(reviewBlockHtml('https://x.test')).toContain('reply to this email first');
  });
  it('escapes a URL rather than letting it break out of the attribute', () => {
    const html = reviewBlockHtml('https://x.test/"><script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;');
  });
});
