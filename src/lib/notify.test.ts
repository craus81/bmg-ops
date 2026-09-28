import { describe, it, expect, vi } from 'vitest';

// notify.ts builds Supabase/Twilio/Resend/APNs/web-push clients at module
// scope (no env in vitest), so those collaborators are stubbed. Under test
// is the pure channel-resolution policy, not delivery.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/twilio', () => ({ sendSMS: vi.fn() }));
vi.mock('@/lib/resend', () => ({ sendEmail: vi.fn(), buildNotificationEmail: vi.fn() }));
vi.mock('@/lib/apns', () => ({ apnsConfigured: () => false, sendApnsNotification: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

import { intersectChannels, ALWAYS_ALL_CHANNELS, shouldDigestEmail, type NotifyChannel } from './notify';

// R3-4: explicit `channels` on a notify payload are the event's CEILING —
// the user's preferences narrow them, never widen them — and only
// forceChannels (used by the handful of un-silenceable alarms) skips the
// preference check. The original condition reduced to `!channels`, which
// made every explicit channel list a silent preference bypass.
describe('intersectChannels', () => {
  it('keeps only channels both the event and the user want, in event order', () => {
    const requested: NotifyChannel[] = ['in_app', 'push', 'email'];
    expect(intersectChannels(requested, ['email', 'in_app'])).toEqual(['in_app', 'email']);
  });

  it('a user with everything off gets nothing', () => {
    expect(intersectChannels(['in_app', 'push', 'email'], [])).toEqual([]);
  });

  it('preferences cannot add channels the event does not support', () => {
    expect(intersectChannels(['in_app'], ['in_app', 'email', 'push'])).toEqual(['in_app']);
  });
});

describe('ALWAYS_ALL_CHANNELS', () => {
  it('carries the un-silenceable operational events', () => {
    expect(ALWAYS_ALL_CHANNELS.has('assignment')).toBe(true);
    expect(ALWAYS_ALL_CHANNELS.has('graphics_ready_for_install')).toBe(true);
    // The rejection alert email is the reply path back to the customer's
    // change request — it must reliably exist.
    expect(ALWAYS_ALL_CHANNELS.has('estimate_rejected')).toBe(true);
  });
});

// Daily staff digest (2026-09-28): non-urgent alert emails queue for one
// afternoon summary; urgent types, forced alarms and reply-path emails
// still send immediately.
describe('shouldDigestEmail', () => {
  it('batches a routine alert', () => {
    expect(shouldDigestEmail({ type: 'vehicle_complete' })).toBe(true);
    expect(shouldDigestEmail({ type: 'mention' })).toBe(true);
  });

  it('sends emailNow types immediately', () => {
    expect(shouldDigestEmail({ type: 'estimate_review_requested' })).toBe(false);
    expect(shouldDigestEmail({ type: 'invoice_email_bounced' })).toBe(false);
  });

  it('sends forced alarms and reply-path emails immediately', () => {
    expect(shouldDigestEmail({ type: 'vehicle_complete', forceChannels: true })).toBe(false);
    expect(shouldDigestEmail({ type: 'vehicle_complete', emailReplyTo: ['c@example.com'] })).toBe(false);
  });

  it('sends unregistered types immediately (fail open)', () => {
    expect(shouldDigestEmail({ type: 'not_a_registered_type' })).toBe(false);
  });
});
