// FleetSuite's own PDF of an invoice on its page in Books → Own invoices (src/app/api/admin/books/own-invoices/pdf,
// Books part 68): opening it for whoever opens the books, a super admin sending it to NetSuite's invoice now, and the
// invoice's read saying where its PDF is. The sending itself is src/lib/books/invoice-pdfs.ts's, held here. Made-up data.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { InvoicePdfView } from './invoice-pdf-status';

const PAT = 'a0000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  roles: ['admin', 'super_admin'] as string[],
  audits: [] as Array<Record<string, any>>,
  load: vi.fn(),
  view: vi.fn(),
  switchOn: vi.fn(),
  blocked: vi.fn(),
  send: vi.fn(),
  invoice: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever h.roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => h.roles.includes(r));
      return booksAllows(access, need) ? { user: { id: PAT }, access } : { error: new Response('Forbidden', { status: 403 }) };
    }),
    requireSuperAdmin: vi.fn(async () => (h.roles.includes('super_admin') ? { user: { id: PAT } } : { error: new Response('Forbidden', { status: 403 }) })),
  };
});
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async (_s: unknown, entry: Record<string, any>) => { h.audits.push(entry); }) }));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({ rpc: async () => ({ data: {}, error: null }) }),
}));
vi.mock('./invoice-pdfs', () => ({
  loadOwnInvoicePdf: h.load,
  readInvoicePdfView: h.view,
  readInvoicePdfsSwitch: h.switchOn,
  scriptBlocked: h.blocked,
  sendInvoicePdf: h.send,
}));
// The invoice's read, for the one invoice: its check and books are the Own invoices page's, held here.
vi.mock('./own-invoice-check', () => ({ checkOwnInvoices: () => ({ invoices: h.invoice ? [h.invoice] : [] }) }));
vi.mock('./own-invoice-posting', () => ({ ownBooks: () => new Map() }));

import { GET, POST, maxDuration } from '../../app/api/admin/books/own-invoices/pdf/route';
import { GET as GET_INVOICE } from '../../app/api/admin/books/own-invoices/route';

const BASE = 'https://go.bmgfleet.com/api/admin/books/own-invoices';
const open = (id: string) => GET(new NextRequest(`${BASE}/pdf?${new URLSearchParams({ id })}`));
const send = (body: unknown) => POST(new NextRequest(`${BASE}/pdf`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

const VIEW: InvoicePdfView = {
  on: true,
  since: '2027-04-01T05:00:00Z',
  state: { version: 1, made_at: '2027-04-02T15:00:00Z', pdfs: [] },
};

beforeEach(() => {
  h.roles = ['admin', 'super_admin'];
  h.audits.length = 0;
  h.load.mockReset().mockResolvedValue({
    ok: true, bytes: Buffer.from('%PDF-1.3 made up'), filename: 'Invoice_INV10001.pdf', number: 'INV10001', status: 'matches',
  });
  h.view.mockReset().mockResolvedValue(VIEW);
  h.switchOn.mockReset().mockResolvedValue({ on: true, changedAt: '2027-04-01T05:00:00Z' });
  h.blocked.mockReset().mockResolvedValue(null);
  h.send.mockReset().mockResolvedValue({ done: 'sent', outcome: 'attached', fileId: '88001', replaced: null });
  h.invoice = { netsuiteId: '123456', number: 'INV10001', status: 'matches', customer: 'Gateway Plumbing' };
});

describe('opening FleetSuite\'s PDF of an invoice', () => {
  it('opens it in the browser under its name, never kept, for whoever opens the books', async () => {
    for (const roles of [['admin', 'super_admin'], ['bookkeeper'], ['cpa']]) {
      h.roles = roles;
      const res = await open('123456');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
      expect(res.headers.get('Content-Disposition')).toBe('inline; filename="Invoice_INV10001.pdf"');
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.3 made up');
    }
    expect(h.load).toHaveBeenCalledWith(expect.anything(), '123456');
  });

  it('turns away anyone who can\'t open the books, and an id that isn\'t one', async () => {
    h.roles = ['admin'];
    expect((await open('123456')).status).toBe(403);
    h.roles = ['admin', 'super_admin'];
    for (const id of ['', 'INV10001', '12 34', '1'.repeat(21)]) {
      expect(await answer(await open(id))).toEqual({ status: 400, body: { error: "That isn't a NetSuite invoice id" } });
    }
    expect(h.load).not.toHaveBeenCalled();
  });

  it('says so when FleetSuite has no copy, or the PDF couldn\'t be made', async () => {
    h.load.mockResolvedValue({ ok: false, status: 404, error: 'FleetSuite has no copy of that invoice' });
    expect(await answer(await open('123456'))).toEqual({ status: 404, body: { error: 'FleetSuite has no copy of that invoice' } });
    h.load.mockRejectedValue(new Error("Couldn't read FleetSuite's copy of the invoice: down"));
    expect(await answer(await open('123456'))).toEqual({ status: 500, body: { error: "Couldn't read FleetSuite's copy of the invoice: down" } });
  });
});

describe('a super admin sending it to NetSuite', () => {
  it('sends it as them, even after three tries, says what NetSuite said, and audits it without amounts', async () => {
    expect(maxDuration).toBe(90);
    expect(await answer(await send({ id: '123456' }))).toEqual({ status: 200, body: { outcome: 'attached' } });
    expect(h.send).toHaveBeenCalledWith(expect.anything(), { netsuiteId: '123456', by: PAT, again: true });
    expect(h.audits).toEqual([{
      actorId: PAT, table: 'own_invoice_pdfs', recordId: '123456', action: 'send_invoice_pdf',
      detail: { outcome: 'attached', fileId: '88001', replaced: null },
    }]);

    h.audits.length = 0;
    h.send.mockResolvedValue({ done: 'sent', outcome: 'refused', error: 'You do not have permission to attach files' });
    expect(await answer(await send({ id: '123456' }))).toEqual({ status: 200, body: { outcome: 'refused' } });
    h.send.mockResolvedValue({ done: 'sent', outcome: 'unsure', error: "NetSuite didn't answer in time." });
    expect(await answer(await send({ id: '123456' }))).toEqual({ status: 200, body: { outcome: 'unsure' } });
    h.send.mockResolvedValue({ done: 'held', heldFor: 'differs' });
    expect(await answer(await send({ id: '123456' }))).toEqual({ status: 200, body: { outcome: 'held', heldFor: 'differs' } });
    expect(h.audits.map((a) => a.detail)).toEqual([{ outcome: 'refused' }, { outcome: 'unsure' }, { outcome: 'held', heldFor: 'differs' }]);
  });

  it('is for super admins only: the bookkeeper and the CPA open it but never send it', async () => {
    for (const roles of [['bookkeeper'], ['cpa'], ['admin']]) {
      h.roles = roles;
      expect((await send({ id: '123456' })).status).toBe(403);
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it("sends nothing while Invoice PDFs is off, or the PDF script can't take it, saying why", async () => {
    h.switchOn.mockResolvedValue({ on: false, changedAt: null });
    expect(await answer(await send({ id: '123456' }))).toEqual({
      status: 409, body: { error: 'Invoice PDFs is switched off, so FleetSuite sends no PDF to NetSuite.' },
    });
    expect(h.blocked).not.toHaveBeenCalled();
    h.switchOn.mockResolvedValue({ on: true, changedAt: '2027-04-01T05:00:00Z' });
    h.blocked.mockResolvedValue("The PDF script in NetSuite is the copy from 2026-09-15.1, which can't attach PDFs.");
    expect(await answer(await send({ id: '123456' }))).toEqual({
      status: 409, body: { error: "The PDF script in NetSuite is the copy from 2026-09-15.1, which can't attach PDFs." },
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
  });

  it.each([
    ['missing', 404, 'FleetSuite has no copy of that invoice'],
    ['changed', 409, 'The invoice was fixed while FleetSuite was making its PDF. Look at it again, then send it.'],
    ['attached', 409, "NetSuite has FleetSuite's PDF of this invoice already."],
    ['sending', 409, "FleetSuite's PDF of this invoice is on its way to NetSuite already."],
    ['off', 409, 'Invoice PDFs is switched off, so FleetSuite sends no PDF to NetSuite.'],
  ])('says when nothing went because it was %s', async (why, status, error) => {
    h.send.mockResolvedValue({ done: 'skipped', why });
    expect(await answer(await send({ id: '123456' }))).toEqual({ status, body: { error } });
    expect(h.audits).toEqual([]);
  });

  it("turns away an id that isn't one, and says what went wrong when the send throws", async () => {
    for (const id of ['', 'INV10001', '1'.repeat(21)]) {
      expect(await answer(await send({ id }))).toEqual({ status: 400, body: { error: "That isn't a NetSuite invoice id" } });
    }
    expect((await send({ invoice: '123456' })).status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
    h.send.mockRejectedValue(new Error("FleetSuite couldn't read the company's name for the PDF's letterhead (Settings → Company), so it sent nothing."));
    expect(await answer(await send({ id: '123456' }))).toEqual({
      status: 500, body: { error: "FleetSuite couldn't read the company's name for the PDF's letterhead (Settings → Company), so it sent nothing." },
    });
  });
});

describe("the invoice's read", () => {
  const read = () => GET_INVOICE(new NextRequest(`${BASE}?id=123456`));

  it('says where its PDF is', async () => {
    const { status, body } = await answer(await read());
    expect(status).toBe(200);
    expect(body.invoice).toEqual({ ...h.invoice, books: null, pdf: VIEW });
    expect(h.view).toHaveBeenCalledWith(expect.anything(), '123456');
  });

  it("still shows the invoice when its PDF can't be read, saying why", async () => {
    h.view.mockRejectedValue(new Error("Couldn't read the invoice's PDF: down"));
    const { status, body } = await answer(await read());
    expect(status).toBe(200);
    expect(body.invoice).toEqual({ ...h.invoice, books: null, pdfError: "Couldn't read the invoice's PDF: down" });
  });
});
