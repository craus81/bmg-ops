import { describe, it, expect, vi, beforeEach } from 'vitest';

// notify.ts builds Supabase/Twilio/Resend/APNs/web-push clients at module
// scope, so the dispatcher's collaborators are stubbed here. Under test is
// the targeting (super admins), the digest collapse, and the payloads — not
// the delivery channels themselves.
const superAdminIds = vi.fn(async () => [] as string[]);
const notifyManyMock = vi.fn(async (_ids: string[], _payload: any) => {});

vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: () => superAdminIds(),
  notifyMany: (ids: string[], payload: any) => notifyManyMock(ids, payload),
}));

import {
  buildPoBillingAttentionNotification,
  buildPoBillingAttentionDigest,
  notifyPoBillingAttention,
  type FlaggedPoAlert,
} from './po-billing-notify';

const flagged = (poNumber: string, problems: string[] = ['RM1: invoiced 50 of 40 ordered — over-billed']): FlaggedPoAlert => ({
  poId: `id-${poNumber}`,
  poNumber,
  problems,
});

beforeEach(() => {
  superAdminIds.mockReset();
  superAdminIds.mockResolvedValue([]);
  notifyManyMock.mockReset();
});

describe('buildPoBillingAttentionNotification', () => {
  it('names the PO and leads with the problems', () => {
    const { title, body } = buildPoBillingAttentionNotification(
      flagged('35045953', ['RM1: invoiced 50 of 40 ordered — over-billed', 'RM2: invoiced 3 but not a line on this PO']),
    );
    expect(title).toBe('Billing needs attention on PO #35045953');
    expect(body).toBe('RM1: invoiced 50 of 40 ordered — over-billed · RM2: invoiced 3 but not a line on this PO');
  });

  it('truncates past three problems with a count', () => {
    const { body } = buildPoBillingAttentionNotification(flagged('7', ['a', 'b', 'c', 'd', 'e']));
    expect(body).toBe('a · b · c · +2 more');
  });
});

describe('buildPoBillingAttentionDigest', () => {
  it('lists the PO numbers', () => {
    const { title, body } = buildPoBillingAttentionDigest([flagged('1'), flagged('2'), flagged('3')]);
    expect(title).toBe('Billing needs attention on 3 POs');
    expect(body).toContain('#1, #2, #3');
  });

  it('caps the list at eight with a remainder', () => {
    const pos = Array.from({ length: 11 }, (_, i) => flagged(String(i + 1)));
    const { body } = buildPoBillingAttentionDigest(pos);
    expect(body).toContain('#8');
    expect(body).not.toContain('#9,');
    expect(body).toContain('and 3 more');
  });
});

describe('notifyPoBillingAttention', () => {
  it('sends one alert per PO to every super admin, on in-app + email + push', async () => {
    superAdminIds.mockResolvedValue(['admin-a', 'admin-b']);

    const count = await notifyPoBillingAttention([flagged('100'), flagged('200')]);

    expect(count).toBe(2);
    expect(notifyManyMock).toHaveBeenCalledTimes(2);
    const [ids, payload] = notifyManyMock.mock.calls[0];
    expect(ids).toEqual(['admin-a', 'admin-b']);
    expect(payload.type).toBe('po_billing_attention');
    expect(payload.title).toBe('Billing needs attention on PO #100');
    expect(payload.url).toBe('/admin/pos/id-100');
    expect(payload.channels).toEqual(['in_app', 'email', 'push']);
    expect(payload.forceChannels).toBe(true);
  });

  it('collapses a large batch into a single digest pointing at the PO list', async () => {
    superAdminIds.mockResolvedValue(['admin-a']);
    const pos = Array.from({ length: 9 }, (_, i) => flagged(String(i + 1)));

    const count = await notifyPoBillingAttention(pos);

    expect(count).toBe(1);
    expect(notifyManyMock).toHaveBeenCalledTimes(1);
    const [, payload] = notifyManyMock.mock.calls[0];
    expect(payload.title).toBe('Billing needs attention on 9 POs');
    expect(payload.url).toBe('/admin/pos');
  });

  it('sends nothing with no flagged POs', async () => {
    superAdminIds.mockResolvedValue(['admin-a']);
    expect(await notifyPoBillingAttention([])).toBe(0);
    expect(superAdminIds).not.toHaveBeenCalled();
    expect(notifyManyMock).not.toHaveBeenCalled();
  });

  it('sends nothing when there are no super admins to tell', async () => {
    expect(await notifyPoBillingAttention([flagged('1')])).toBe(0);
    expect(notifyManyMock).not.toHaveBeenCalled();
  });

  it('swallows failures so a broken send never fails the sweep', async () => {
    superAdminIds.mockRejectedValue(new Error('supabase down'));
    await expect(notifyPoBillingAttention([flagged('1')])).resolves.toBe(0);
  });
});
