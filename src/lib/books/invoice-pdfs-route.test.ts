// The two-hourly run's cron route (src/app/api/cron/books-invoice-pdfs/route.ts):
// the cron secret or a super admin, and a response that says only how the run
// went. The run itself is held.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { InvoicePdfsRun } from './invoice-pdfs';

const h = vi.hoisted(() => ({
  run: vi.fn(),
  superAdmin: vi.fn(),
}));

vi.mock('@/lib/api-auth', () => ({ requireSuperAdmin: h.superAdmin }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => ({ service: true }) }));
vi.mock('./invoice-pdfs', () => ({ runInvoicePdfs: h.run }));

import { GET, maxDuration } from '../../app/api/cron/books-invoice-pdfs/route';

const URL = 'https://go.bmgfleet.com/api/cron/books-invoice-pdfs';
const cron = () => new NextRequest(URL, { headers: { authorization: 'Bearer cron-secret' } });
const ran = (over: Partial<InvoicePdfsRun> = {}): InvoicePdfsRun => ({ looked: 0, attached: 0, refused: 0, unsure: 0, held: 0, left: 0, ...over });

beforeEach(() => {
  process.env.CRON_SECRET = 'cron-secret';
  h.run.mockReset().mockResolvedValue(ran());
  h.superAdmin.mockReset().mockResolvedValue({ error: new Response('Forbidden', { status: 403 }) });
});

describe('the invoice PDFs cron', () => {
  it('runs with four minutes to send in, and says only how it went', async () => {
    const before = Date.now();
    h.run.mockResolvedValue(ran({ looked: 3, attached: 2, held: 1 }));
    const res = await GET(cron());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ booksInvoicePdfs: 'ok' });
    const [service, opts] = h.run.mock.calls[0];
    expect(service).toEqual({ service: true });
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 240_000);
    expect(opts.deadline).toBeLessThanOrEqual(Date.now() + 240_000);
    expect(maxDuration).toBe(300);
    expect(h.superAdmin).not.toHaveBeenCalled();
  });

  it.each([
    [ran({ skipped: 'off' }), 'off'],
    [ran({ blocked: "The PDF script's address isn't set (NETSUITE_PDF_RESTLET_URL).", error: 'also' }), 'blocked'],
    [ran({ looked: 2, error: "1: Couldn't put the PDF on its way: down" }), 'failed'],
    [ran({ looked: 4, left: 2 }), 'partial'],
    [ran({ looked: 25, attached: 25, more: true }), 'partial'],
  ])('says the run was %j as %s', async (result, said) => {
    h.run.mockResolvedValue(result);
    expect(await (await GET(cron())).json()).toEqual({ booksInvoicePdfs: said });
  });

  it('says it failed when the run throws, and never what it was', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.run.mockRejectedValue(new Error('INV10001 for Gateway Plumbing'));
    const res = await GET(cron());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ booksInvoicePdfs: 'failed' });
    expect(log).toHaveBeenCalledWith('[books] invoice PDFs threw:', 'INV10001 for Gateway Plumbing');
    log.mockRestore();
  });

  it('turns away anyone without the cron secret who is not a super admin, and runs for one who is', async () => {
    expect((await GET(new NextRequest(URL))).status).toBe(403);
    expect((await GET(new NextRequest(URL, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(403);
    delete process.env.CRON_SECRET;
    expect((await GET(new NextRequest(URL, { headers: { authorization: 'Bearer undefined' } }))).status).toBe(403);
    expect(h.run).not.toHaveBeenCalled();
    h.superAdmin.mockResolvedValue({ user: { id: 'craig' } });
    expect(await (await GET(new NextRequest(URL))).json()).toEqual({ booksInvoicePdfs: 'ok' });
    expect(h.run).toHaveBeenCalledTimes(1);
  });
});
