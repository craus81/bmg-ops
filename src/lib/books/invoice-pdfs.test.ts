import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OwnInvoiceData } from './own-invoice-check';

// FleetSuite's own invoice PDFs (Books part 68, migration 498): one copy's PDF
// sent to NetSuite's invoice or held back, the two-hourly run, and what the
// daily check reads. NetSuite, the PDF script's ping, the letterhead, the
// customer records and the check against NetSuite's invoice are stand-ins, as
// is the database. Made-up data.

const h = vi.hoisted(() => ({
  attach: vi.fn(),
  ping: vi.fn(),
  letterhead: vi.fn(),
  records: vi.fn(),
  heartbeat: vi.fn(),
  status: 'matches',
  customer: 'NetSuite Name' as string | null,
}));

vi.mock('@/lib/netsuite', () => ({ attachPdfToInvoice: h.attach }));
vi.mock('@/lib/restlet-probe', () => ({ pingRestlet: h.ping }));
vi.mock('@/lib/statement-pdf-server', () => ({ readLetterhead: h.letterhead }));
vi.mock('@/lib/fleetsuite-records', () => ({ readCustomerRecords: h.records }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: h.heartbeat }));
vi.mock('./own-invoice-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./own-invoice-check')>()),
  checkOwnInvoices: (data: { invoices: Array<{ own: OwnInvoiceData }> }) => ({
    invoices: data.invoices.map((p) => ({ netsuiteId: p.own.netsuite_id, number: p.own.number, customer: h.customer, status: h.status })),
  }),
}));
vi.mock('./own-invoice-pdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('./own-invoice-pdf')>();
  return { ...real, buildOwnInvoicePdf: vi.fn(real.buildOwnInvoicePdf) };
});

import {
  HOLD_FOR, MAX_PDF_BYTES, letterheadProblem, loadOwnInvoicePdf, lookAtInvoicePdfs, markInvoicePdfsTold, readInvoicePdfView,
  readInvoicePdfsSwitch, runInvoicePdfs, scriptBlocked, sendInvoicePdf, tooBig,
} from './invoice-pdfs';
import { buildOwnInvoicePdf } from './own-invoice-pdf';

const COMPANY = {
  name: 'BMG Fleet Installations', address: '100 Made Up Rd', city: "O'Fallon", state: 'MO', zip: '63366',
  phone: '(636) 555-0100', email: 'billing@example.com',
};
const LETTERHEAD = { company: COMPANY, logoDataUrl: null };
const CRAIG = 'b2c3d4e5-0000-4000-8000-000000000001';
const URL = 'https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=102&deploy=1';

const own = (id: string, over: Partial<OwnInvoiceData> = {}): OwnInvoiceData => ({
  netsuite_id: id,
  number: `INV${id}`,
  made_from: 'vehicle',
  made_from_id: null,
  sales_order_id: '777',
  customer_netsuite_id: '42',
  customer_id: null,
  date: '2026-11-18',
  location_id: '1',
  location_from: 'sent',
  po_number: '4500123',
  memo: null,
  vin: null,
  terms_id: '2',
  terms_name: 'Net 30',
  terms_days: 30,
  due_date: '2026-12-18',
  tax_rule: 'tax@2',
  tax_basis: 'rate',
  tax_rate: '0.082380',
  subtotal: '100.00',
  tax: '8.24',
  total: '108.24',
  lines_from: 'sent',
  unknowns: [],
  made_at: '2026-11-18T15:00:00Z',
  lines: [
    { line_no: 1, item_id: '9', item_number: 'RAN-1234', description: 'Ranger shelving', quantity: '1.0000', rate: '100.0000', amount: '100.00', priced: true, taxable: true, tax: '8.24', sales_order_line_id: null },
  ],
  ...over,
} as OwnInvoiceData);

interface Fake {
  on?: boolean | null;
  changedAt?: string | null;
  /** The copy's version, by NetSuite's id; none is no copy. */
  versions?: Record<string, number>;
  /** Ids gl_own_invoice_pairs has no invoice for. */
  unpaired?: string[];
  claim?: unknown;
  due?: Array<{ netsuite_id: string; version: number }>;
  toTell?: unknown[];
  lastResult?: unknown;
  /** What own_invoice_pdf_state answers; none is no copy. */
  pdfState?: unknown;
  /** A table read or function that fails, with its message. */
  fails?: Record<string, string>;
}

function fake(opts: Fake = {}) {
  const calls: Array<{ fn: string; args: Record<string, any> }> = [];
  const reads: string[] = [];
  const versions = opts.versions ?? { '123456': 1 };
  const service = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const q: any = {
        select: () => q,
        eq: (col: string, value: unknown) => { filters[col] = value; return q; },
        maybeSingle: async () => {
          reads.push(table);
          if (opts.fails?.[table]) return { data: null, error: { message: opts.fails[table] } };
          if (table === 'books_switches') {
            expect(filters.piece).toBe('invoice_pdfs');
            return { data: opts.on === null ? null : { is_on: opts.on ?? true, changed_at: opts.changedAt === undefined ? '2026-11-01T00:00:00Z' : opts.changedAt }, error: null };
          }
          if (table === 'gl_own_invoices') {
            const v = versions[String(filters.netsuite_id)];
            return { data: v ? { version: v, made_at: '2026-11-18T15:00:00Z' } : null, error: null };
          }
          if (table === 'sync_state') {
            expect(filters.sync_type).toBe('books_invoice_pdfs');
            return { data: opts.lastResult === undefined ? null : { last_result: opts.lastResult }, error: null };
          }
          throw new Error(`unexpected table ${table}`);
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, any>) => {
      calls.push({ fn, args });
      if (opts.fails?.[fn]) return { data: null, error: { message: opts.fails[fn] } };
      switch (fn) {
        case 'gl_own_invoice_pairs': {
          const id = String(args.p_netsuite_id);
          expect(args).toEqual({ p_from: null, p_to: null, p_netsuite_id: id });
          return { data: { invoices: opts.unpaired?.includes(id) ? [] : [{ own: own(id) }] }, error: null };
        }
        case 'own_invoice_pdf_hold': return { data: true, error: null };
        case 'own_invoice_pdf_claim': return { data: opts.claim ?? { claimed: true, replace_file_id: null, tries: 1 }, error: null };
        case 'own_invoice_pdf_settle': return { data: true, error: null };
        case 'own_invoice_pdfs_due': return { data: opts.due ?? [], error: null };
        case 'own_invoice_pdfs_to_tell': return { data: opts.toTell ?? [], error: null };
        case 'own_invoice_pdfs_mark_told': return { data: null, error: null };
        case 'own_invoice_pdf_state': return { data: opts.pdfState ?? null, error: null };
        default: throw new Error(`unexpected function ${fn}`);
      }
    },
  };
  return { service: service as unknown as SupabaseClient, calls, reads, called: (fn: string) => calls.filter((c) => c.fn === fn).map((c) => c.args) };
}

beforeEach(() => {
  h.status = 'matches';
  h.customer = 'NetSuite Name';
  h.attach.mockReset().mockResolvedValue({ outcome: 'attached', fileId: '88001', replaced: null });
  h.ping.mockReset().mockResolvedValue({ reachable: true, version: '2026-11-01.1', error: null });
  h.letterhead.mockReset().mockResolvedValue(LETTERHEAD);
  h.records.mockReset().mockResolvedValue(new Map([['42', {
    name: '  Gateway Plumbing Supply ',
    address: { addr1: '1200 Industrial Dr', addr2: '', city: 'Springfield', state: 'MO', zip: '65802' },
  }]]));
  h.heartbeat.mockReset().mockResolvedValue({ recorded: true });
  vi.mocked(buildOwnInvoicePdf).mockClear();
  vi.stubEnv('NETSUITE_PDF_RESTLET_URL', URL);
});
afterEach(() => { vi.unstubAllEnvs(); });

const drawn = () => vi.mocked(buildOwnInvoicePdf).mock.calls.map((c) => c[0]);

describe('sendInvoicePdf', () => {
  it("sends nothing while Invoice PDFs is off, or without a row for its switch", async () => {
    for (const on of [false, null]) {
      const db = fake({ on });
      expect(await sendInvoicePdf(db.service, { netsuiteId: '123456', by: null, again: false })).toEqual({ done: 'skipped', why: 'off' });
      expect(db.calls).toEqual([]);
      expect(db.reads).toEqual(['books_switches']);
    }
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("sends nothing for an invoice FleetSuite has no copy of", async () => {
    const none = fake({ versions: {} });
    expect(await sendInvoicePdf(none.service, { netsuiteId: '123456', by: null, again: false })).toEqual({ done: 'skipped', why: 'missing' });
    expect(none.calls).toEqual([]);
    const unpaired = fake({ unpaired: ['123456'] });
    expect(await sendInvoicePdf(unpaired.service, { netsuiteId: '123456', by: null, again: false })).toEqual({ done: 'skipped', why: 'missing' });
    expect(unpaired.called('own_invoice_pdf_claim')).toEqual([]);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("holds back a copy that doesn't match NetSuite's invoice, saying why, and sends nothing", async () => {
    expect(HOLD_FOR).toEqual({ differs: 'differs', incomplete: 'incomplete', voided: 'voided', waiting: 'waiting' });
    for (const status of ['differs', 'incomplete', 'voided', 'waiting'] as const) {
      h.status = status;
      const db = fake({ versions: { '123456': 2 } });
      expect(await sendInvoicePdf(db.service, { netsuiteId: '123456', by: CRAIG, again: true })).toEqual({ done: 'held', heldFor: status });
      expect(db.called('own_invoice_pdf_hold')).toEqual([{ p_invoice: '123456', p_version: 2, p_for: status }]);
      expect(db.called('own_invoice_pdf_claim')).toEqual([]);
    }
    expect(h.attach).not.toHaveBeenCalled();
    expect(drawn()).toEqual([]);
  });

  it("says so when it can't hold one back, or read the copy", async () => {
    h.status = 'differs';
    await expect(sendInvoicePdf(fake({ fails: { own_invoice_pdf_hold: 'down' } }).service, { netsuiteId: '123456', by: null, again: false }))
      .rejects.toThrow("Couldn't hold back the PDF: down");
    await expect(sendInvoicePdf(fake({ fails: { gl_own_invoices: 'down' } }).service, { netsuiteId: '123456', by: null, again: false }))
      .rejects.toThrow("Couldn't read FleetSuite's copy of the invoice: down");
    await expect(sendInvoicePdf(fake({ fails: { gl_own_invoice_pairs: 'down' } }).service, { netsuiteId: '123456', by: null, again: false }))
      .rejects.toThrow("Couldn't read FleetSuite's copy of the invoice: down");
    await expect(sendInvoicePdf(fake({ fails: { books_switches: 'down' } }).service, { netsuiteId: '123456', by: null, again: false }))
      .rejects.toThrow("Couldn't read the switch: down");
  });

  it("attaches a matching copy's PDF to NetSuite's invoice and keeps NetSuite's id for the file", async () => {
    const db = fake();
    const sent = await sendInvoicePdf(db.service, { netsuiteId: '123456', by: CRAIG, again: true });
    expect(sent).toEqual({ done: 'sent', outcome: 'attached', fileId: '88001', replaced: null });
    expect(db.called('own_invoice_pdf_claim')).toEqual([{
      p_invoice: '123456', p_version: 1, p_file_name: 'Invoice_INV123456_123456.pdf', p_by: CRAIG, p_again: true,
    }]);
    const [args] = h.attach.mock.calls[0];
    expect(args).toMatchObject({ invoiceId: '123456', fileName: 'Invoice_INV123456_123456.pdf', replaceFileId: null });
    expect(Buffer.from(args.pdfBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect(db.called('own_invoice_pdf_settle')).toEqual([{
      p_invoice: '123456', p_version: 1, p_state: 'attached', p_file_id: '88001', p_replaced: null, p_error: null,
    }]);
    // The order matters: the copy's version is read before the copy, and claimed before anything goes.
    expect(db.calls.map((c) => c.fn)).toEqual(['gl_own_invoice_pairs', 'own_invoice_pdf_claim', 'own_invoice_pdf_settle']);
    expect(db.reads).toEqual(['books_switches', 'gl_own_invoices']);
  });

  it("bills it to the customer as FleetSuite has them, NetSuite's name where FleetSuite has none", async () => {
    await sendInvoicePdf(fake().service, { netsuiteId: '123456', by: null, again: false });
    expect(h.records).toHaveBeenCalledWith(expect.anything(), ['42']);
    expect(drawn()[0]).toMatchObject({
      number: 'INV123456', customer: 'Gateway Plumbing Supply', billTo: ['1200 Industrial Dr', 'Springfield, MO 65802'], voided: false,
      letterhead: LETTERHEAD,
    });
    h.records.mockResolvedValue(new Map([['42', { name: '  ', address: 'not an address' }]]));
    await sendInvoicePdf(fake().service, { netsuiteId: '123456', by: null, again: false });
    expect(drawn()[1]).toMatchObject({ customer: 'NetSuite Name', billTo: [] });
    h.records.mockResolvedValue(new Map());
    await sendInvoicePdf(fake().service, { netsuiteId: '123456', by: null, again: false });
    expect(drawn()[2]).toMatchObject({ customer: 'NetSuite Name', billTo: [] });
  });

  it('reads the letterhead once, unless the run hands it one', async () => {
    await sendInvoicePdf(fake().service, { netsuiteId: '123456', by: null, again: false });
    expect(h.letterhead).toHaveBeenCalledTimes(1);
    const other = { company: { ...COMPANY, name: '1084 Holdings' }, logoDataUrl: null };
    await sendInvoicePdf(fake().service, { netsuiteId: '123456', by: null, again: false, letterhead: other });
    expect(h.letterhead).toHaveBeenCalledTimes(1);
    expect(drawn()[1].letterhead).toBe(other);
  });

  it("sends nothing on a letterhead without the company's name", async () => {
    for (const letterhead of [null, { company: { ...COMPANY, name: '  ' }, logoDataUrl: null }]) {
      const db = fake();
      await expect(sendInvoicePdf(db.service, { netsuiteId: '123456', by: null, again: false, letterhead: letterhead as any }))
        .rejects.toThrow("FleetSuite couldn't read the company's name for the PDF's letterhead (Settings → Company), so it sent nothing.");
      expect(db.called('own_invoice_pdf_claim')).toEqual([]);
    }
    expect(h.attach).not.toHaveBeenCalled();
  });

  it("names the next version's file and has NetSuite take the one before off the invoice", async () => {
    h.attach.mockResolvedValue({ outcome: 'attached', fileId: '88002', replaced: true });
    const db = fake({ versions: { '123456': 2 }, claim: { claimed: true, replace_file_id: '88001', tries: 1 } });
    expect(await sendInvoicePdf(db.service, { netsuiteId: '123456', by: null, again: false }))
      .toEqual({ done: 'sent', outcome: 'attached', fileId: '88002', replaced: true });
    expect(db.called('own_invoice_pdf_claim')[0]).toMatchObject({ p_version: 2, p_file_name: 'Invoice_INV123456_123456_v2.pdf', p_by: null, p_again: false });
    expect(h.attach.mock.calls[0][0]).toMatchObject({ fileName: 'Invoice_INV123456_123456_v2.pdf', replaceFileId: '88001' });
    expect(db.called('own_invoice_pdf_settle')[0]).toMatchObject({ p_version: 2, p_file_id: '88002', p_replaced: true });
  });

  it("sends nothing it isn't given to send: on its way already, attached, changed, or tried three times", async () => {
    for (const why of ['sending', 'attached', 'changed', 'tries', 'missing'] as const) {
      const db = fake({ claim: { claimed: false, why } });
      expect(await sendInvoicePdf(db.service, { netsuiteId: '123456', by: null, again: false })).toEqual({ done: 'skipped', why });
      expect(db.called('own_invoice_pdf_settle')).toEqual([]);
    }
    expect(await sendInvoicePdf(fake({ claim: { claimed: false } }).service, { netsuiteId: '123456', by: null, again: false }))
      .toEqual({ done: 'skipped', why: 'sending' });
    expect(await sendInvoicePdf(fake({ claim: null as any }).service, { netsuiteId: '123456', by: null, again: false }))
      .toMatchObject({ done: 'sent' }); // the default claim
    expect(h.attach).toHaveBeenCalledTimes(1);
    await expect(sendInvoicePdf(fake({ fails: { own_invoice_pdf_claim: 'down' } }).service, { netsuiteId: '123456', by: null, again: false }))
      .rejects.toThrow("Couldn't put the PDF on its way: down");
    expect(h.attach).toHaveBeenCalledTimes(1);
  });

  it("keeps what NetSuite said when it refused it or FleetSuite can't tell", async () => {
    for (const answer of [
      { outcome: 'refused', error: 'You do not have permission to attach files.' },
      { outcome: 'unsure', error: "NetSuite didn't answer in time." },
    ]) {
      h.attach.mockResolvedValueOnce(answer);
      const db = fake();
      expect(await sendInvoicePdf(db.service, { netsuiteId: '123456', by: null, again: false })).toEqual({ done: 'sent', ...answer });
      expect(db.called('own_invoice_pdf_settle')).toEqual([{
        p_invoice: '123456', p_version: 1, p_state: answer.outcome, p_file_id: null, p_replaced: null, p_error: answer.error,
      }]);
    }
  });

  it("says so when NetSuite answered and FleetSuite couldn't keep it", async () => {
    await expect(sendInvoicePdf(fake({ fails: { own_invoice_pdf_settle: 'down' } }).service, { netsuiteId: '123456', by: null, again: false }))
      .rejects.toThrow("NetSuite answered, but FleetSuite couldn't keep its answer: down");
    expect(h.attach).toHaveBeenCalledTimes(1);
  });

  it('refuses a PDF too big to send without sending it, as a try', async () => {
    const big = new ArrayBuffer(MAX_PDF_BYTES + 1);
    vi.mocked(buildOwnInvoicePdf).mockReturnValueOnce({ output: () => big } as any);
    const db = fake();
    expect(await sendInvoicePdf(db.service, { netsuiteId: '123456', by: null, again: false }))
      .toEqual({ done: 'sent', outcome: 'refused', error: tooBig(MAX_PDF_BYTES + 1) });
    expect(h.attach).not.toHaveBeenCalled();
    expect(db.called('own_invoice_pdf_claim')).toHaveLength(1);
    expect(db.called('own_invoice_pdf_settle')[0]).toMatchObject({ p_state: 'refused', p_error: tooBig(MAX_PDF_BYTES + 1) });
    expect(tooBig(MAX_PDF_BYTES + 1)).toBe(
      "FleetSuite's PDF of this invoice is 701 KB, more than the 700 KB it sends. A smaller logo in Settings → Company makes it smaller.",
    );
    expect(tooBig(1_500_000)).toContain('is 1,465 KB,');
    // Right at the most it sends, it goes.
    vi.mocked(buildOwnInvoicePdf).mockReturnValueOnce({ output: () => new ArrayBuffer(MAX_PDF_BYTES) } as any);
    await sendInvoicePdf(fake().service, { netsuiteId: '123456', by: null, again: false });
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(MAX_PDF_BYTES).toBe(716_800);
  });
});

describe('letterheadProblem', () => {
  it("is the reason when the company's name can't be read", () => {
    expect(letterheadProblem(LETTERHEAD)).toBeNull();
    expect(letterheadProblem(null)).toMatch(/^FleetSuite couldn't read the company's name/);
    expect(letterheadProblem({ company: null as any, logoDataUrl: null })).not.toBeNull();
    expect(letterheadProblem({ company: { ...COMPANY, name: ' ' }, logoDataUrl: null })).not.toBeNull();
  });
});

describe('loadOwnInvoicePdf', () => {
  it("draws FleetSuite's own PDF of one of its invoices, whatever the check says", async () => {
    h.status = 'differs';
    const pdf = await loadOwnInvoicePdf(fake().service, '123456');
    expect(pdf).toMatchObject({ ok: true, filename: 'Invoice_INV123456.pdf', number: 'INV123456', status: 'differs' });
    if (!pdf.ok) throw new Error('no PDF');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(h.letterhead).toHaveBeenCalledTimes(1);
    h.status = 'voided';
    await loadOwnInvoicePdf(fake().service, '123456', LETTERHEAD);
    expect(h.letterhead).toHaveBeenCalledTimes(1);
    expect(drawn()[1].voided).toBe(true);
    expect(drawn()[0].voided).toBe(false);
  });

  it("has nothing for an invoice FleetSuite has no copy of", async () => {
    expect(await loadOwnInvoicePdf(fake({ unpaired: ['9'] }).service, '9'))
      .toEqual({ ok: false, status: 404, error: 'FleetSuite has no copy of that invoice' });
    expect(drawn()).toEqual([]);
  });
});

describe('readInvoicePdfsSwitch', () => {
  it('reads the switch and since when', async () => {
    expect(await readInvoicePdfsSwitch(fake({ on: true, changedAt: '2027-04-01T12:00:00Z' }).service))
      .toEqual({ on: true, changedAt: '2027-04-01T12:00:00Z' });
    expect(await readInvoicePdfsSwitch(fake({ on: false, changedAt: null }).service)).toEqual({ on: false, changedAt: null });
    expect(await readInvoicePdfsSwitch(fake({ on: null }).service)).toEqual({ on: false, changedAt: null });
  });
});

describe('readInvoicePdfView', () => {
  const pdf = {
    version: '2', state: 'refused', held_for: null, file_name: 'Invoice_INV123456_123456_v2.pdf', file_id: null, replaced_file_id: '88001',
    replaced: null, tries: '1', error: 'No.', asked_by_name: 'Craig George', checked_at: '2026-11-18T21:00:00Z',
    started_at: '2026-11-18T21:00:00Z', answered_at: '2026-11-18T21:01:00Z',
  };

  it("reads the switch, since when it's been on, and the copy's PDFs, with numbers as numbers", async () => {
    const db = fake({ pdfState: { version: '2', made_at: '2026-11-18T15:00:00Z', pdfs: [pdf] } });
    expect(await readInvoicePdfView(db.service, '123456')).toEqual({
      on: true,
      since: '2026-11-01T00:00:00Z',
      state: { version: 2, made_at: '2026-11-18T15:00:00Z', pdfs: [{ ...pdf, version: 2, tries: 1 }] },
    });
    expect(db.called('own_invoice_pdf_state')).toEqual([{ p_invoice: '123456' }]);
  });

  it("has nothing since while it's off, and no state for an invoice FleetSuite has no copy of", async () => {
    expect(await readInvoicePdfView(fake({ on: false, pdfState: { version: 1, made_at: '2026-11-18T15:00:00Z', pdfs: [] } }).service, '123456'))
      .toEqual({ on: false, since: null, state: { version: 1, made_at: '2026-11-18T15:00:00Z', pdfs: [] } });
    expect(await readInvoicePdfView(fake({ changedAt: null }).service, '123456')).toEqual({ on: true, since: null, state: null });
    expect((await readInvoicePdfView(fake({ pdfState: { version: 1, made_at: '2026-11-18T15:00:00Z', pdfs: null } }).service, '123456')).state?.pdfs)
      .toEqual([]);
  });

  it('throws when either read fails', async () => {
    await expect(readInvoicePdfView(fake({ fails: { own_invoice_pdf_state: 'down' } }).service, '123456'))
      .rejects.toThrow("Couldn't read the invoice's PDF: down");
    await expect(readInvoicePdfView(fake({ fails: { books_switches: 'down' } }).service, '123456'))
      .rejects.toThrow("Couldn't read the switch: down");
  });
});

describe('scriptBlocked', () => {
  it("says why the PDF script can't attach PDFs, or nothing when it can", async () => {
    expect(await scriptBlocked()).toBeNull();
    expect(h.ping).toHaveBeenCalledWith('pdf', URL);
    h.ping.mockResolvedValue({ reachable: true, version: '2026-11-02.1', error: null });
    expect(await scriptBlocked()).toBeNull();

    h.ping.mockResolvedValue({ reachable: true, version: '2026-09-15.1', error: null });
    expect(await scriptBlocked()).toBe(
      "The PDF script in NetSuite is the copy from 2026-09-15.1, which can't attach PDFs. "
      + 'Upload the newest scripts/netsuite-pdf-restlet.js over it and save its script record.',
    );
    h.ping.mockResolvedValue({ reachable: true, version: null, error: null });
    expect(await scriptBlocked()).toMatch(/^The PDF script in NetSuite is a copy from before 2026-09-10, which can't attach PDFs\./);

    h.ping.mockResolvedValue({ reachable: false, version: null, error: 'NetSuite RESTlet error (403): Invalid login attempt.' });
    expect(await scriptBlocked()).toBe("The PDF script in NetSuite didn't answer: NetSuite RESTlet error (403): Invalid login attempt.");
    h.ping.mockResolvedValue({ reachable: false, version: null, error: null });
    expect(await scriptBlocked()).toBe("The PDF script in NetSuite didn't answer: no answer.");
    h.ping.mockResolvedValue({ reachable: false, version: null, error: `Busy ${'x'.repeat(300)}` });
    const long = await scriptBlocked();
    expect(long!.length).toBeLessThan(220);
    expect(long).toMatch(/x…$/);

    vi.stubEnv('NETSUITE_PDF_RESTLET_URL', '  ');
    h.ping.mockClear();
    expect(await scriptBlocked()).toBe("The PDF script's address isn't set (NETSUITE_PDF_RESTLET_URL).");
    expect(h.ping).not.toHaveBeenCalled();
  });
});

describe('runInvoicePdfs', () => {
  const later = () => Date.now() + 60_000;

  it('looks at nothing while Invoice PDFs is off, and records that it ran', async () => {
    const db = fake({ on: false });
    const run = await runInvoicePdfs(db.service, { deadline: later() });
    expect(run).toMatchObject({ skipped: 'off', looked: 0, attached: 0 });
    expect(db.calls).toEqual([]);
    expect(h.ping).not.toHaveBeenCalled();
    expect(h.heartbeat).toHaveBeenCalledWith(db.service, 'books_invoice_pdfs', expect.objectContaining({ skipped: 'off' }), expect.objectContaining({
      records: 0, touchLastSyncedAt: true, startedAt: expect.any(Number),
    }));
  });

  it("sends nothing while the PDF script can't take them, and says why", async () => {
    h.ping.mockResolvedValue({ reachable: true, version: '2026-09-15.1', error: null });
    const db = fake({ due: [{ netsuite_id: '123456', version: 1 }] });
    const run = await runInvoicePdfs(db.service, { deadline: later() });
    expect(run.blocked).toMatch(/^The PDF script in NetSuite is the copy from 2026-09-15\.1/);
    expect(db.calls).toEqual([]);
    expect(h.heartbeat.mock.calls[0][3]).toMatchObject({ touchLastSyncedAt: false });
    expect(h.heartbeat.mock.calls[0][2]).toMatchObject({ blocked: run.blocked });
  });

  it('sends each copy made since it went on, the run counting what became of each', async () => {
    h.attach
      .mockResolvedValueOnce({ outcome: 'attached', fileId: '88001', replaced: null })
      .mockResolvedValueOnce({ outcome: 'refused', error: 'No.' })
      .mockResolvedValueOnce({ outcome: 'unsure', error: 'Timed out.' });
    const db = fake({
      changedAt: '2027-04-01T12:00:00Z',
      versions: { '1': 1, '2': 1, '3': 1, '4': 1, '5': 1 },
      claim: { claimed: true, replace_file_id: null, tries: 1 },
      due: ['1', '2', '3', '4', '5'].map((id) => ({ netsuite_id: id, version: 1 })),
    });
    // The fourth is held back, the fifth on its way already.
    let pairs = 0;
    const rpc = db.service.rpc.bind(db.service);
    (db.service as any).rpc = async (fn: string, args: any) => {
      if (fn === 'gl_own_invoice_pairs') h.status = ++pairs === 4 ? 'waiting' : 'matches';
      if (fn === 'own_invoice_pdf_claim' && args.p_invoice === '5') return { data: { claimed: false, why: 'sending' }, error: null };
      return rpc(fn, args);
    };
    const run = await runInvoicePdfs(db.service, { deadline: later() });
    expect(run).toEqual(expect.objectContaining({ looked: 5, attached: 1, refused: 1, unsure: 1, held: 1, left: 0 }));
    expect(run.more).toBeUndefined();
    expect(run.error).toBeUndefined();
    expect(db.called('own_invoice_pdfs_due')).toEqual([{ p_since: '2027-04-01T12:00:00Z', p_limit: 25 }]);
    expect(h.letterhead).toHaveBeenCalledTimes(1);
    expect(h.attach).toHaveBeenCalledTimes(3);
    expect(db.called('own_invoice_pdf_claim').every((c) => c.p_by === null && c.p_again === false)).toBe(true);
    expect(h.heartbeat.mock.calls[0][3]).toMatchObject({ records: 5, touchLastSyncedAt: true });
  });

  it('says there may be more when it had as many as a run looks at', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => String(1000 + i));
    const db = fake({ versions: Object.fromEntries(ids.map((id) => [id, 1])), due: ids.map((id) => ({ netsuite_id: id, version: 1 })) });
    const run = await runInvoicePdfs(db.service, { deadline: later() });
    expect(run).toMatchObject({ looked: 25, attached: 25, more: true });
    const fewer = fake({ versions: { '1': 1 }, due: [{ netsuite_id: '1', version: 1 }] });
    expect((await runInvoicePdfs(fewer.service, { deadline: later() })).more).toBeUndefined();
  });

  it('leaves the rest for the next run once its time is up', async () => {
    const db = fake({ versions: { '1': 1, '2': 1 }, due: [{ netsuite_id: '1', version: 1 }, { netsuite_id: '2', version: 1 }] });
    const run = await runInvoicePdfs(db.service, { deadline: Date.now() - 1 });
    expect(run).toMatchObject({ looked: 0, left: 2 });
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('goes on past one that fails, and says which', async () => {
    const db = fake({ versions: { '1': 1, '2': 1 }, due: [{ netsuite_id: '1', version: 1 }, { netsuite_id: '2', version: 1 }] });
    const rpc = db.service.rpc.bind(db.service);
    (db.service as any).rpc = async (fn: string, args: any) => (fn === 'gl_own_invoice_pairs' && args.p_netsuite_id === '1'
      ? { data: null, error: { message: 'pairs down' } }
      : rpc(fn, args));
    const run = await runInvoicePdfs(db.service, { deadline: later() });
    expect(run).toMatchObject({ looked: 2, attached: 1, error: "1: Couldn't read FleetSuite's copy of the invoice: pairs down" });
    expect(h.heartbeat.mock.calls[0][3]).toMatchObject({ touchLastSyncedAt: false });
  });

  it("sends nothing when the company's name can't be read for the letterhead", async () => {
    h.letterhead.mockResolvedValue({ company: { ...COMPANY, name: '' }, logoDataUrl: null });
    const db = fake({ due: [{ netsuite_id: '123456', version: 1 }] });
    const run = await runInvoicePdfs(db.service, { deadline: later() });
    expect(run).toMatchObject({ looked: 0, blocked: expect.stringMatching(/^FleetSuite couldn't read the company's name/) });
    expect(db.called('gl_own_invoice_pairs')).toEqual([]);
    // With nothing to send it doesn't read the letterhead at all.
    h.letterhead.mockClear();
    const none = await runInvoicePdfs(fake({ due: [] }).service, { deadline: later() });
    expect(none).toMatchObject({ looked: 0 });
    expect(none.blocked).toBeUndefined();
    expect(h.letterhead).not.toHaveBeenCalled();
  });

  it('looks only at copies made from now when the switch has no time it went on', async () => {
    const db = fake({ changedAt: null });
    const before = Date.now();
    await runInvoicePdfs(db.service, { deadline: later() });
    const since = Date.parse(db.called('own_invoice_pdfs_due')[0].p_since);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
    const bad = fake({ changedAt: 'not a time' });
    await runInvoicePdfs(bad.service, { deadline: later() });
    expect(Date.parse(bad.called('own_invoice_pdfs_due')[0].p_since)).toBeGreaterThanOrEqual(before);
  });

  it("records it when it can't read which to send, or the switch", async () => {
    const run = await runInvoicePdfs(fake({ fails: { own_invoice_pdfs_due: 'due down' } }).service, { deadline: later() });
    expect(run.error).toBe("Couldn't read which PDFs to send: due down");
    const off = await runInvoicePdfs(fake({ fails: { books_switches: 'switch down' } }).service, { deadline: later() });
    expect(off.error).toBe("Couldn't read the switch: switch down");
    expect(h.heartbeat.mock.calls.every((c) => c[3].touchLastSyncedAt === false)).toBe(true);
  });

  it('keeps at most five reasons, cut short', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => String(i + 1));
    const db = fake({ versions: Object.fromEntries(ids.map((id) => [id, 1])), due: ids.map((id) => ({ netsuite_id: id, version: 1 })), fails: { own_invoice_pdf_claim: 'x'.repeat(200) } });
    const run = await runInvoicePdfs(db.service, { deadline: later() });
    expect(run.looked).toBe(7);
    expect(run.error!.length).toBe(600);
    expect(run.error!.startsWith("1: Couldn't put the PDF on its way: ")).toBe(true);
    expect(run.error).not.toContain('6: ');
  });
});

describe('lookAtInvoicePdfs', () => {
  const row = { invoice_id: '123456', version: '2', number: 'INV10001', state: 'refused', error: 'No.', tries: '1' };

  it("tells nothing while Invoice PDFs is off", async () => {
    const db = fake({ on: false, toTell: [row], lastResult: { blocked: 'Nope.' } });
    expect(await lookAtInvoicePdfs(db.service, true)).toEqual({ items: [], blocked: null });
    expect(db.calls).toEqual([]);
  });

  it('reads the PDFs to tell about, and at the first look why the last run sent none', async () => {
    const db = fake({ toTell: [row, { ...row, invoice_id: '9', number: null, state: 'unsure', error: null, tries: 3 }], lastResult: { blocked: 'Nope.' } });
    const first = await lookAtInvoicePdfs(db.service, true);
    expect(first).toEqual({
      items: [
        { invoiceId: '123456', version: 2, number: 'INV10001', state: 'refused', error: 'No.', tries: 1 },
        { invoiceId: '9', version: 2, number: null, state: 'unsure', error: '', tries: 3 },
      ],
      blocked: 'Nope.',
    });
    expect(db.called('own_invoice_pdfs_to_tell')).toEqual([{ p_limit: 50 }]);
    const second = fake({ toTell: [], lastResult: { blocked: 'Nope.' } });
    expect(await lookAtInvoicePdfs(second.service, false)).toEqual({ items: [], blocked: null });
    expect(second.reads).not.toContain('sync_state');
    for (const lastResult of [{ blocked: '' }, { blocked: 5 }, { looked: 3 }, null]) {
      expect((await lookAtInvoicePdfs(fake({ lastResult }).service, true)).blocked).toBeNull();
    }
    expect((await lookAtInvoicePdfs(fake().service, true)).blocked).toBeNull();
  });

  it("says so when it can't read them", async () => {
    await expect(lookAtInvoicePdfs(fake({ fails: { own_invoice_pdfs_to_tell: 'down' } }).service, false))
      .rejects.toThrow("couldn't read the PDFs to tell about (down)");
    await expect(lookAtInvoicePdfs(fake({ fails: { sync_state: 'down' } }).service, true))
      .rejects.toThrow("couldn't read the last run (down)");
  });
});

describe('markInvoicePdfsTold', () => {
  it('marks each version told about', async () => {
    const db = fake();
    await markInvoicePdfsTold(db.service, [
      { invoiceId: '123456', version: 2, number: 'INV10001', state: 'refused', error: 'No.', tries: 1 },
      { invoiceId: '9', version: 1, number: null, state: 'unsure', error: '', tries: 3 },
    ]);
    expect(db.called('own_invoice_pdfs_mark_told')).toEqual([{ p_keys: [{ invoice_id: '123456', version: 2 }, { invoice_id: '9', version: 1 }] }]);
    await expect(markInvoicePdfsTold(fake({ fails: { own_invoice_pdfs_mark_told: 'down' } }).service, []))
      .rejects.toThrow("couldn't mark the PDFs told about (down)");
  });
});
