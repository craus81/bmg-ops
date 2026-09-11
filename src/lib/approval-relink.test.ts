import { describe, it, expect } from 'vitest';
import {
  maskEmail,
  maskedDestination,
  inCooldown,
  buildRelinkEmail,
  RELINK_COOLDOWN_MINUTES,
  RELINK_EXPIRY_DAYS,
} from './approval-relink';

describe('maskEmail', () => {
  it('keeps enough to recognise your own mailbox and no more', () => {
    expect(maskEmail('jordan@acmefleet.com')).toBe('jo•••@acmefleet.com');
  });
  it('masks a very short local part without exposing it whole', () => {
    expect(maskEmail('jo@acmefleet.com')).toBe('j•••@acmefleet.com');
    expect(maskEmail('j@acmefleet.com')).toBe('j•••@acmefleet.com');
  });
  it('never echoes a string that is not an address', () => {
    // Whatever landed in the column, the page must not print it back.
    expect(maskEmail('not-an-address')).toBe('•••');
    expect(maskEmail('')).toBe('•••');
    expect(maskEmail('@nolocal.com')).toBe('•••');
  });
  it('masks the local part of every address, not just the first', () => {
    expect(maskEmail('  Purchasing@Acme.com  ')).toBe('Pu•••@Acme.com');
  });
});

describe('maskedDestination', () => {
  it('names one address', () => {
    expect(maskedDestination(['jordan@acmefleet.com'])).toBe('jo•••@acmefleet.com');
  });
  it('counts the rest rather than listing them', () => {
    expect(maskedDestination(['a@x.com', 'b@x.com'])).toBe('a•••@x.com and 1 other');
    expect(maskedDestination(['a@x.com', 'b@x.com', 'c@x.com'])).toBe('a•••@x.com and 2 others');
  });
  it('says nothing when there is nowhere to send', () => {
    expect(maskedDestination([])).toBe('');
    expect(maskedDestination(['', '  '])).toBe('');
  });
});

describe('inCooldown', () => {
  const NOW = Date.parse('2026-09-11T12:00:00Z');
  const minsAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

  it('blocks a second request inside the window', () => {
    expect(inCooldown(minsAgo(RELINK_COOLDOWN_MINUTES - 1), NOW)).toBe(true);
  });
  it('allows one after the window', () => {
    expect(inCooldown(minsAgo(RELINK_COOLDOWN_MINUTES + 1), NOW)).toBe(false);
  });
  it('never blocks a record that has never been relinked', () => {
    expect(inCooldown(null, NOW)).toBe(false);
    expect(inCooldown(undefined, NOW)).toBe(false);
  });
  it('does not block on an unreadable timestamp', () => {
    // Failing open here only costs one extra email; failing closed would
    // permanently wedge a customer out of their own link.
    expect(inCooldown('not-a-date', NOW)).toBe(false);
  });
});

describe('buildRelinkEmail', () => {
  const base = {
    label: 'Estimate #EST-2609-014',
    customerName: 'Acme Fleet',
    token: 'tok-abc',
    emails: ['jordan@acmefleet.com'],
    expiryDays: RELINK_EXPIRY_DAYS,
  };

  it('links to the approval page for the kind it was asked about', () => {
    expect(buildRelinkEmail({ ...base, kind: 'estimate' }).html).toContain('/approve/estimate/tok-abc');
    expect(buildRelinkEmail({ ...base, kind: 'quote' }).html).toContain('/approve/quote/tok-abc');
    expect(buildRelinkEmail({ ...base, kind: 'proof' }).html).toContain('/approve/proof/tok-abc');
  });

  it('states the real life of the link it is sending', () => {
    const { text } = buildRelinkEmail({ ...base, kind: 'estimate' });
    expect(text).toContain(`works for ${RELINK_EXPIRY_DAYS} days`);
  });

  it('tells a recipient who did not ask that the old link stays dead', () => {
    // The one line that matters if this email reaches someone unexpected.
    const { text } = buildRelinkEmail({ ...base, kind: 'estimate' });
    expect(text).toContain('the old link stays expired');
  });

  it('asks a proof recipient to review artwork, not to approve a price', () => {
    const { text } = buildRelinkEmail({ ...base, kind: 'proof', label: 'Job 4471' });
    expect(text).toContain('review your artwork');
    expect(text).not.toContain('approve here');
  });

  it('escapes a customer name rather than rendering it as markup', () => {
    const { html } = buildRelinkEmail({ ...base, kind: 'estimate', customerName: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('addresses the reader plainly when no name is on file', () => {
    const { text } = buildRelinkEmail({ ...base, kind: 'estimate', customerName: null });
    expect(text.startsWith('Hi,')).toBe(true);
  });
});
