import { describe, it, expect, vi } from 'vitest';

// notify.ts builds Supabase/Twilio/Resend/APNs/web-push clients at module
// scope (no env in vitest), so those collaborators are stubbed. Under test
// is the pure channel-resolution policy, not delivery.
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({}) }));
vi.mock('@/lib/twilio', () => ({ sendSMS: vi.fn() }));
vi.mock('@/lib/resend', () => ({ sendEmail: vi.fn(), buildNotificationEmail: vi.fn() }));
vi.mock('@/lib/apns', () => ({ apnsConfigured: () => false, sendApnsNotification: vi.fn() }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

import { intersectChannels, ALWAYS_ALL_CHANNELS, type NotifyChannel } from './notify';

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
