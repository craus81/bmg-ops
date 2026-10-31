// How the daily check's cron route tells the super admins
// (src/app/api/cron/books-daily-check/route.ts): each alert as its own kind of
// notification, in the app and by push, and an Inventory Adjust's, a send to
// NetSuite FleetSuite isn't sure about and a change made in NetSuite to a
// customer or vendor by email too for whoever has "Copy me on new alerts"
// ticked, which the registry decides (Craig, 2026-10-28: every new alert
// copies him). The check itself is held.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { CheckAlert } from './daily-check';

const sent: Array<{ ids: string[]; payload: Record<string, unknown> }> = [];
let alerts: CheckAlert[] = [];

vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => ({ error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => ({}) }));
vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: vi.fn(async () => ['craig', 'harold']),
  notifyMany: vi.fn(async (ids: string[], payload: Record<string, unknown>) => { sent.push({ ids, payload }); }),
}));
vi.mock('./daily-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./daily-check')>()),
  runDailyCheck: vi.fn(async (_service: unknown, opts: { tell: (a: CheckAlert[]) => Promise<void> }) => {
    await opts.tell(alerts);
    return { look: 'second', told: alerts.length };
  }),
}));

import { GET } from '../../app/api/cron/books-daily-check/route';

const cron = () => new NextRequest('https://go.bmgfleet.com/api/cron/books-daily-check', { headers: { authorization: 'Bearer cron-secret' } });
const alert = (about: CheckAlert['about']): CheckAlert => ({ title: `About ${about ?? 'a month'}`, body: 'Why.', url: '/admin/books', about });

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  sent.length = 0;
  alerts = [];
});

describe('the books daily check cron', () => {
  it('tells every super admin of each alert as its kind, emailing only an Inventory Adjust, an unsure send and a change in NetSuite (to whoever is copied)', async () => {
    alerts = [
      alert(undefined), alert('stock'), alert('balance'), alert('own'), alert('fulfillment'), alert('bill'), alert('receipt'),
      alert('adjustment'), alert('mistake'), alert('send'), alert('change'),
    ];
    const res = await GET(cron());
    expect(await res.json()).toEqual({ booksDailyCheck: 'ok', look: 'second', told: 11 });
    expect(sent.map((s) => [s.payload.type, s.payload.channels])).toEqual([
      ['books_month_differs', ['in_app', 'push']],
      ['books_stock_differs', ['in_app', 'push']],
      ['books_balance_differs', ['in_app', 'push']],
      ['books_own_invoice_differs', ['in_app', 'push']],
      ['books_own_fulfillment_differs', ['in_app', 'push']],
      ['books_own_bill_differs', ['in_app', 'push']],
      ['books_own_receipt_differs', ['in_app', 'push']],
      ['books_own_adjustment_differs', ['in_app', 'push', 'email']],
      ['books_mistake_found', ['in_app', 'push']],
      ['books_netsuite_send_unsure', ['in_app', 'push', 'email']],
      ['books_record_changed_in_netsuite', ['in_app', 'push', 'email']],
    ]);
    expect(sent.every((s) => s.ids.join() === 'craig,harold')).toBe(true);
    expect(sent[7].payload).toMatchObject({ title: 'About adjustment', body: 'Why.', url: '/admin/books' });
  });

  it('turns away anyone without the cron secret who is not a super admin', async () => {
    const res = await GET(new NextRequest('https://go.bmgfleet.com/api/cron/books-daily-check'));
    expect(res.status).toBe(403);
    expect(sent).toEqual([]);
  });
});
