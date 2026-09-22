import { describe, it, expect } from 'vitest';
import {
  WARN_DAYS, EXPIRED_NOTICE_DAYS, daysUntilExpiry, expiryState, expiryLabel, dueWarning, dueExpiredNotice, expiryDateText,
} from './quote-expiry';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

describe('daysUntilExpiry', () => {
  it('counts whole days left', () => {
    expect(daysUntilExpiry(inDays(5), NOW)).toBe(5);
    expect(daysUntilExpiry(inDays(0.5), NOW)).toBe(0);
  });

  it('goes negative once past', () => {
    expect(daysUntilExpiry(inDays(-2), NOW)).toBe(-2);
  });

  it('is null — not 0 — with no date on record', () => {
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry(undefined, NOW)).toBeNull();
    expect(daysUntilExpiry('not a date', NOW)).toBeNull();
  });
});

describe('expiryState', () => {
  it('is active while there is room', () => {
    expect(expiryState(inDays(20), NOW)).toBe('active');
    expect(expiryState(inDays(WARN_DAYS + 1), NOW)).toBe('active');
  });

  it('turns expiring at the warn threshold, inclusive', () => {
    expect(expiryState(inDays(WARN_DAYS), NOW)).toBe('expiring');
    expect(expiryState(inDays(0.1), NOW)).toBe('expiring');
  });

  it('is expired the moment it passes', () => {
    expect(expiryState(inDays(-0.1), NOW)).toBe('expired');
  });

  it('NO link is no_link, never expired — a quote never sent this way was not "sent and lapsed"', () => {
    expect(expiryState(null, NOW)).toBe('no_link');
    expect(expiryState(undefined, NOW)).toBe('no_link');
  });
});

describe('expiryLabel', () => {
  it('reads the way a person would say it', () => {
    expect(expiryLabel(inDays(5), NOW)).toBe('Expires in 5 days');
    expect(expiryLabel(inDays(1.2), NOW)).toBe('Expires tomorrow');
    expect(expiryLabel(inDays(0.2), NOW)).toBe('Expires today');
    expect(expiryLabel(inDays(-3), NOW)).toBe('Link expired');
  });

  it('says nothing at all without a date, rather than inventing a state', () => {
    expect(expiryLabel(null, NOW)).toBeNull();
  });
});

describe('dueWarning', () => {
  const row = (over = {}) => ({ approval_token_expires_at: inDays(2), ...over });

  it('fires inside the window when nothing has been sent yet', () => {
    expect(dueWarning(row(), NOW)).toBe(true);
  });

  it('does not fire twice for the same link', () => {
    expect(dueWarning(row({ expiry_warned_for: inDays(2) }), NOW)).toBe(false);
  });

  it('re-arms on its own when a re-send mints a new expiry', () => {
    // Warned for the old link; the quote was re-sent and now expires later.
    expect(dueWarning({ approval_token_expires_at: inDays(2), expiry_warned_for: inDays(-28) }, NOW)).toBe(true);
  });

  it('matches stamps by instant, not by string — Postgres renders the same moment several ways', () => {
    expect(dueWarning({
      approval_token_expires_at: '2026-09-13T12:00:00+00:00',
      expiry_warned_for: '2026-09-13T12:00:00.000Z',
    }, NOW)).toBe(false);
  });

  it('stays quiet outside the window', () => {
    expect(dueWarning(row({ approval_token_expires_at: inDays(10) }), NOW)).toBe(false);
  });

  it('NEVER warns after expiry — "expires in -2 days" is worse than silence', () => {
    expect(dueWarning(row({ approval_token_expires_at: inDays(-2) }), NOW)).toBe(false);
  });

  it('has nothing to warn about with no link', () => {
    expect(dueWarning({ approval_token_expires_at: null }, NOW)).toBe(false);
  });
});

describe('dueExpiredNotice', () => {
  it('fires once the link is dead', () => {
    expect(dueExpiredNotice({ approval_token_expires_at: inDays(-1) }, NOW)).toBe(true);
  });

  it('covers a warning the sweep missed — an outage does not lose the telling', () => {
    // Never warned (expiry_warned_for null) and already past: the expired
    // notice is what the rep gets.
    expect(dueExpiredNotice({ approval_token_expires_at: inDays(-4), expiry_warned_for: null }, NOW)).toBe(true);
  });

  it('does not repeat for the same link', () => {
    expect(dueExpiredNotice({
      approval_token_expires_at: inDays(-1), expiry_notified_for: inDays(-1),
    }, NOW)).toBe(false);
  });

  it('re-arms after a re-send that later expires again', () => {
    expect(dueExpiredNotice({
      approval_token_expires_at: inDays(-1), expiry_notified_for: inDays(-40),
    }, NOW)).toBe(true);
  });

  it('goes quiet on links that died long ago — otherwise the first sweep after deploy notifies a rep about every quote they never closed', () => {
    expect(dueExpiredNotice({ approval_token_expires_at: inDays(-(EXPIRED_NOTICE_DAYS - 1)) }, NOW)).toBe(true);
    expect(dueExpiredNotice({ approval_token_expires_at: inDays(-(EXPIRED_NOTICE_DAYS + 1)) }, NOW)).toBe(false);
  });

  it('says nothing while the link still works, or when there is none', () => {
    expect(dueExpiredNotice({ approval_token_expires_at: inDays(1) }, NOW)).toBe(false);
    expect(dueExpiredNotice({ approval_token_expires_at: null }, NOW)).toBe(false);
  });
});

describe('expiryDateText', () => {
  it('spells the date out for email copy', () => {
    expect(expiryDateText('2026-09-12T17:00:00Z')).toMatch(/September 12/);
  });
  it('is null with nothing to spell', () => {
    expect(expiryDateText(null)).toBeNull();
  });
});
