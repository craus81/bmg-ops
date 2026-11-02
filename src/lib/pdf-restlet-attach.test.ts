// The PDF script in NetSuite (scripts/netsuite-pdf-restlet.js) attaches FleetSuite's own PDF of an invoice to
// NetSuite's invoice (Books part 68, docs/books.md "Invoice PDFs"). NetSuite can't run here, so this loads the script
// with made-up stand-ins for N/render, N/record, N/file and N/search that keep what it asked for, and holds what it
// does and answers.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Filter = [string, string, string] | 'AND';

interface Fake {
  folders: Array<{ id: string; name: string; parent: string | null }>;
  files: Array<{ id: string; name: string; folder: number; contents: string; fileType: string; isOnline: boolean }>;
  attached: Array<{ fileId: number; invoiceId: number }>;
  detached: Array<{ fileId: number; invoiceId: number }>;
  invoices: Set<string>;
  failDetach?: boolean;
  failOnInvoiceSearch?: boolean;
  failAttach?: string;
}

const fresh = (more: Partial<Fake> = {}): Fake => ({
  folders: [], files: [], attached: [], detached: [], invoices: new Set(['123456', '123457']), ...more,
});

function loadScript(fake: Fake): { get: (p: unknown) => any; post: (b: unknown) => any } {
  let nextId = 9000;
  const id = () => String(++nextId);
  const conds = (filters: Filter[]) => filters.filter((f): f is [string, string, string] => f !== 'AND');
  const value = (filters: Filter[], field: string) => conds(filters).find((f) => f[0] === field)?.[2];

  const search = {
    Type: { FOLDER: 'folder', INVOICE: 'invoice' },
    createColumn: (c: unknown) => c,
    lookupFields: ({ type, id: lookupId }: { type: string; id: string }) => {
      if (type !== 'invoice' || !fake.invoices.has(lookupId)) throw { name: 'SSS_INVALID_TYPE_ARG', message: `No invoice ${lookupId}` };
      return { tranid: `INV${lookupId}` };
    },
    create: ({ type, filters }: { type: string; filters: Filter[] }) => {
      let rows: Array<{ id: string; getValue: (c: { name: string; join?: string }) => string }> = [];
      if (type === 'folder' && value(filters, 'name') !== undefined) {
        rows = fake.folders
          .filter((f) => f.name === value(filters, 'name') && (value(filters, 'parent') === '@NONE@' ? f.parent === null : true))
          .map((f) => ({ id: f.id, getValue: () => f.id }));
      } else if (type === 'folder' && value(filters, 'file.name') !== undefined) {
        rows = fake.files
          .filter((f) => String(f.folder) === value(filters, 'internalid') && f.name === value(filters, 'file.name'))
          .map((f) => ({ id: String(f.folder), getValue: (c) => (c.name === 'internalid' && c.join === 'file' ? f.id : '') }));
      } else if (type === 'invoice') {
        if (fake.failOnInvoiceSearch) throw { name: 'SSS_INVALID_SRCH_FILTER_JOIN', message: 'An nlobjSearchFilter contains an invalid join ID' };
        rows = fake.attached
          .filter((a) => String(a.invoiceId) === value(filters, 'internalid') && String(a.fileId) === value(filters, 'file.internalid'))
          .map((a) => ({ id: String(a.invoiceId), getValue: () => '' }));
      } else {
        throw new Error(`a search the stand-in doesn't know: ${type} ${JSON.stringify(filters)}`);
      }
      return { run: () => ({ each: (cb: (r: unknown) => boolean) => { for (const r of rows) if (!cb(r)) break; } }) };
    },
  };
  const record = {
    Type: { INVOICE: 'invoice', FOLDER: 'folder', CREDIT_MEMO: 'creditmemo', ESTIMATE: 'estimate', SALES_ORDER: 'salesorder' },
    create: ({ type }: { type: string }) => {
      const fields: Record<string, string> = {};
      return {
        setValue: ({ fieldId, value: v }: { fieldId: string; value: string }) => { fields[fieldId] = v; },
        save: () => {
          if (type !== 'folder') throw new Error('only folders are made here');
          const folderId = id();
          fake.folders.push({ id: folderId, name: fields.name, parent: null });
          return Number(folderId);
        },
      };
    },
    attach: ({ record: r, to }: { record: { type: string; id: number }; to: { type: string; id: number } }) => {
      if (r.type !== 'file' || to.type !== 'invoice') throw new Error('attached the wrong thing');
      if (fake.failAttach) throw { name: 'INSUFFICIENT_PERMISSION', message: fake.failAttach };
      fake.attached.push({ fileId: r.id, invoiceId: to.id });
    },
    detach: ({ record: r, from }: { record: { type: string; id: number }; from: { type: string; id: number } }) => {
      if (fake.failDetach) throw { name: 'RCRD_DSNT_EXIST', message: 'That record does not exist.' };
      fake.detached.push({ fileId: r.id, invoiceId: from.id });
    },
  };
  const file = {
    Type: { PDF: 'PDF' },
    create: (o: { name: string; fileType: string; contents: string; folder: number; isOnline: boolean }) => ({
      save: () => {
        const fileId = id();
        fake.files.push({ id: fileId, ...o });
        return Number(fileId);
      },
    }),
  };
  const render = { PrintMode: { PDF: 'PDF' }, transaction: () => ({ getContents: () => 'JVBERi0x' }) };

  const source = readFileSync(path.resolve(__dirname, '../../scripts/netsuite-pdf-restlet.js'), 'utf8');
  let api: any = null;
  const define = (deps: string[], factory: (...mods: unknown[]) => unknown) => {
    expect(deps).toEqual(['N/render', 'N/record', 'N/file', 'N/search']);
    api = factory(render, record, file, search);
  };
  new Function('define', source)(define);
  return api;
}

const PDF = Buffer.from('%PDF-1.3 made-up invoice').toString('base64');
const send = (more: Record<string, unknown> = {}) => ({
  action: 'attach_pdf', invoiceId: '123456', fileName: 'Invoice_INV10001_123456.pdf', pdfBase64: PDF, ...more,
});

describe('the PDF script: attach_pdf', () => {
  it('keeps the PDF in its own folder at the top of the File Cabinet, made the first time, and attaches it', () => {
    const fake = fresh({ folders: [{ id: '50', name: 'FleetSuite Invoice PDFs', parent: '7' }] });
    const script = loadScript(fake);
    expect(script.post(send())).toEqual({ success: true, fileId: '9002', reused: false, replaced: null });
    // A folder of that name inside another one isn't it.
    expect(fake.folders).toEqual([
      { id: '50', name: 'FleetSuite Invoice PDFs', parent: '7' },
      { id: '9001', name: 'FleetSuite Invoice PDFs', parent: null },
    ]);
    expect(fake.files).toEqual([
      { id: '9002', name: 'Invoice_INV10001_123456.pdf', fileType: 'PDF', contents: PDF, folder: 9001, isOnline: false },
    ]);
    expect(fake.attached).toEqual([{ fileId: 9002, invoiceId: 123456 }]);

    // The next invoice's goes in the same folder.
    expect(script.post(send({ invoiceId: '123457', fileName: 'Invoice_INV10002_123457.pdf' })))
      .toEqual({ success: true, fileId: '9003', reused: false, replaced: null });
    expect(fake.folders).toHaveLength(2);
    expect(fake.files.map((f) => [f.name, f.folder])).toEqual([['Invoice_INV10001_123456.pdf', 9001], ['Invoice_INV10002_123457.pdf', 9001]]);
  });

  it('sent again with the same name, finds the file it kept and never attaches it twice', () => {
    const fake = fresh();
    const script = loadScript(fake);
    const first = script.post(send());
    expect(script.post(send())).toEqual({ success: true, fileId: first.fileId, reused: true, replaced: null });
    expect(fake.files).toHaveLength(1);
    expect(fake.attached).toHaveLength(1);

    // Kept but never attached (the attach failed): attached now.
    fake.attached.length = 0;
    expect(script.post(send())).toMatchObject({ success: true, reused: true });
    expect(fake.attached).toEqual([{ fileId: Number(first.fileId), invoiceId: 123456 }]);
  });

  it("attaches it when the search can't say whether it's on the invoice", () => {
    const fake = fresh({ failOnInvoiceSearch: true });
    const script = loadScript(fake);
    expect(script.post(send())).toMatchObject({ success: true, reused: false });
    expect(fake.attached).toHaveLength(1);
  });

  it("takes the earlier version's file off the invoice, and says whether it came off", () => {
    const fake = fresh();
    const script = loadScript(fake);
    expect(script.post(send({ fileName: 'Invoice_INV10001_123456_v2.pdf', replaceFileId: '8800' })))
      .toEqual({ success: true, fileId: '9002', reused: false, replaced: true });
    expect(fake.detached).toEqual([{ fileId: 8800, invoiceId: 123456 }]);
    // The earlier file is only taken off the invoice, never out of the File Cabinet.
    expect(fake.files).toHaveLength(1);

    fake.failDetach = true;
    expect(script.post(send({ fileName: 'Invoice_INV10001_123456_v3.pdf', replaceFileId: '9002' })))
      .toEqual({ success: true, fileId: '9003', reused: false, replaced: false });

    // Never the file it just attached.
    fake.failDetach = false;
    expect(script.post(send({ fileName: 'Invoice_INV10001_123456_v3.pdf', replaceFileId: '9003' })))
      .toEqual({ success: true, fileId: '9003', reused: true, replaced: null });
    expect(fake.detached).toHaveLength(1);
    // An empty one is none.
    expect(script.post(send({ fileName: 'Invoice_INV10001_123456_v3.pdf', replaceFileId: '' }))).toMatchObject({ replaced: null });
  });

  it('refuses what it can\'t attach, before keeping a file', () => {
    const fake = fresh();
    const script = loadScript(fake);
    expect(script.post(send({ invoiceId: 'INV10001' }))).toEqual({ success: false, error: "attach_pdf needs the invoice's internal id" });
    expect(script.post(send({ invoiceId: undefined }))).toEqual({ success: false, error: "attach_pdf needs the invoice's internal id" });
    expect(script.post(send({ fileName: 'Invoice 10001.pdf' }))).toEqual({ success: false, error: 'attach_pdf needs a file name ending in .pdf, letters, digits, _ . - only' });
    expect(script.post(send({ fileName: 'Invoice_10001.exe' }))).toMatchObject({ success: false });
    expect(script.post(send({ fileName: `${'x'.repeat(121)}.pdf` }))).toMatchObject({ success: false });
    expect(script.post(send({ pdfBase64: '' }))).toEqual({ success: false, error: 'attach_pdf needs the PDF' });
    expect(script.post(send({ pdfBase64: 12 }))).toEqual({ success: false, error: 'attach_pdf needs the PDF' });
    expect(script.post(send({ replaceFileId: 'abc' }))).toEqual({ success: false, error: 'attach_pdf: replaceFileId must be an internal id' });
    // An invoice NetSuite doesn't have.
    expect(script.post(send({ invoiceId: '999' }))).toEqual({ success: false, error: 'Failed to attach the PDF: No invoice 999' });
    expect(fake.folders).toEqual([]);
    expect(fake.files).toEqual([]);
    expect(fake.attached).toEqual([]);
  });

  it("answers with NetSuite's reason when the attach fails", () => {
    const fake = fresh({ failAttach: 'You do not have permissions to set a value for element file.' });
    const script = loadScript(fake);
    expect(script.post(send())).toEqual({
      success: false, error: 'Failed to attach the PDF: You do not have permissions to set a value for element file.',
    });
    // The file it kept is found and attached on the next send.
    fake.failAttach = undefined;
    expect(script.post(send())).toMatchObject({ success: true, reused: true });
  });

  it('answers a ping on either entry point, and nothing else', () => {
    const script = loadScript(fresh());
    const version = readFileSync(path.resolve(__dirname, '../../scripts/netsuite-pdf-restlet.js'), 'utf8').match(/var SCRIPT_VERSION = '([^']+)'/)![1];
    expect(script.post({ action: 'ping' })).toEqual({ success: true, mode: 'ping', version });
    expect(script.get({ action: 'ping' })).toEqual({ success: true, mode: 'ping', version });
    expect(script.post({ action: 'attach' })).toEqual({ success: false, error: 'Unknown action: send action attach_pdf' });
    expect(script.post(null)).toEqual({ success: false, error: 'Unknown action: send action attach_pdf' });
    // The GET still renders a PDF as before.
    expect(script.get({ invoiceId: '123456' })).toMatchObject({ success: true, pdfBase64: 'JVBERi0x' });
  });
});
