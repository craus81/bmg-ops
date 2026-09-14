import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// r2.ts constructs an S3 client from env at call time; mock the module so
// these tests assert what we DID and DIDN'T send to R2, never the network.
const r2Head = vi.fn<(prefix: string, path: string) => Promise<boolean>>();
const r2Upload = vi.fn<
  (prefix: string, path: string, body: Buffer, contentType?: string)
    => Promise<{ success: boolean; key: string; publicUrl: string; error?: string }>
>();
vi.mock('@/lib/r2', () => ({
  r2Head: (...args: any[]) => (r2Head as any)(...args),
  r2Upload: (...args: any[]) => (r2Upload as any)(...args),
}));

import {
  LEDGER_R2_PREFIX, LEDGER_PROBE_PATH, safeLedgerFileName, ledgerStoragePath, sha256Hex, putLedgerObject,
  isSafeLedgerStoragePath, ledgerDocumentHeaders,
} from './storage';

/** app_settings stand-in: no `ledger` row, so the gate is whatever env says. */
const service = {
  from: () => {
    const q: any = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: null, error: null }) };
    return q;
  },
} as any;

/** app_settings stand-in whose read FAILS — the gate must stay shut. */
const brokenService = {
  from: () => {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: { message: 'connection reset' } }),
    };
    return q;
  },
} as any;

beforeEach(() => {
  r2Head.mockReset().mockResolvedValue(false);
  r2Upload.mockReset().mockResolvedValue({ success: true, key: 'ledger/x', publicUrl: 'https://public/ledger/x' });
});
afterEach(() => { delete process.env.LEDGER_PDFS_ENABLED; });

describe('ledgerStoragePath', () => {
  it('builds <source>/<entity>/<ref>/<file>, relative to the prefix', () => {
    expect(ledgerStoragePath('quickbooks', 'Invoice', '123', 'Invoice_1042.pdf'))
      .toBe('quickbooks/Invoice/123/Invoice_1042.pdf');
    expect(ledgerStoragePath('netsuite', 'CustInvc', '99001', 'INV1042.pdf'))
      .toBe('netsuite/CustInvc/99001/INV1042.pdf');
  });

  it('refuses traversal, separators and control characters in source, entity or ref', () => {
    for (const bad of ['..', 'a/b', 'a\\b', 'a\u0000b', 'a\nb', '']) {
      expect(() => ledgerStoragePath('quickbooks', bad, '123', 'a.pdf'), `entity ${JSON.stringify(bad)}`).toThrow();
      expect(() => ledgerStoragePath('quickbooks', 'Invoice', bad, 'a.pdf'), `ref ${JSON.stringify(bad)}`).toThrow();
      // `source` is a union at COMPILE time only — a value read back off a
      // row is a string like any other, so it gets the same check.
      expect(() => ledgerStoragePath(bad as any, 'Invoice', '123', 'a.pdf'), `source ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('sanitizes an unsafe file name instead of throwing — the source picked it, not us', () => {
    expect(ledgerStoragePath('quickbooks', 'Attachable', '7', '../../etc/passwd'))
      .toBe('quickbooks/Attachable/7/.._.._etc_passwd');
    expect(ledgerStoragePath('quickbooks', 'Attachable', '7', 'W-9 (signed).pdf'))
      .toBe('quickbooks/Attachable/7/W-9 _signed_.pdf');
    expect(ledgerStoragePath('quickbooks', 'Attachable', '7', '///')).toBe('quickbooks/Attachable/7/_');
    // A name that sanitizes to nothing still has to produce a usable key.
    expect(ledgerStoragePath('quickbooks', 'Attachable', '7', '   ')).toBe('quickbooks/Attachable/7/file');
    expect(safeLedgerFileName('..')).toBe('file');
    expect(safeLedgerFileName('')).toBe('file');
  });

  it('never exceeds 200 characters, and keeps the extension when it trims', () => {
    const path = ledgerStoragePath('quickbooks', 'Invoice', '123', `${'x'.repeat(400)}.pdf`);
    expect(path.length).toBeLessThanOrEqual(200);
    expect(path.endsWith('.pdf')).toBe(true);
    expect(safeLedgerFileName(`${'y'.repeat(400)}.pdf`).length).toBeLessThanOrEqual(120);
    expect(safeLedgerFileName(`${'y'.repeat(400)}.pdf`).endsWith('.pdf')).toBe(true);
    // A very long entity/ref pair leaves no room at all — better to throw
    // than to store a truncated key nothing can find again.
    expect(() => ledgerStoragePath('quickbooks', 'E'.repeat(120), 'R'.repeat(120), 'a.pdf')).toThrow();
    // …and a budget of one or two characters must still name a file rather
    // than trimming '...pdf' down to a bare '.' segment.
    for (const refLen of [84, 85, 86]) {
      const last = ledgerStoragePath('quickbooks', 'E'.repeat(100), 'R'.repeat(refLen), '...pdf').split('/').pop()!;
      expect(last, `ref length ${refLen}`).not.toMatch(/^\.+$/);
      expect(last.length, `ref length ${refLen}`).toBeGreaterThan(0);
    }
  });

  it('drops the extension rather than clipping it when the budget is tiny', () => {
    // A budget shorter than '.pdf' is the one case where "keep the
    // extension" cannot be honoured: a clipped '.p' mislabels the object,
    // which is exactly what the helper exists to prevent. Better a stem.
    for (const refLen of [80, 81, 82, 83, 84, 85, 86]) {
      const path = ledgerStoragePath('quickbooks', 'E'.repeat(100), 'R'.repeat(refLen), 'statement.pdf');
      const last = path.split('/').pop()!;
      expect(path.length, `ref length ${refLen}`).toBeLessThanOrEqual(200);
      expect(last, `ref length ${refLen}`).not.toMatch(/^\.+$/);
      // Either the whole extension survived, or none of it did — never '.p'.
      expect(last.endsWith('.pdf') || !/\.[a-z]{1,3}$/.test(last), `ref length ${refLen}: ${last}`).toBe(true);
    }
  });

  it('has nowhere to put a realm or account id — the key names the record only', () => {
    const realm = '9130354674162571';
    const path = ledgerStoragePath('quickbooks', 'Invoice', '123', 'Invoice_1042.pdf');
    expect(path).not.toContain(realm);
    expect(`${LEDGER_R2_PREFIX}/${path}`).toBe('ledger/quickbooks/Invoice/123/Invoice_1042.pdf');
  });
});

describe('isSafeLedgerStoragePath', () => {
  it('accepts what the builder builds, and the one fixed probe key', () => {
    expect(isSafeLedgerStoragePath(ledgerStoragePath('quickbooks', 'Invoice', '123', 'Invoice_1042.pdf'))).toBe(true);
    expect(isSafeLedgerStoragePath('netsuite/CustInvc/99001/INV1042.pdf')).toBe(true);
    expect(isSafeLedgerStoragePath('probe.txt')).toBe(true);
  });

  it('refuses anything that could name an object outside the prefix', () => {
    for (const bad of [
      '', '..', '../secrets/x.pdf', 'quickbooks/../../signed-documents/x.pdf',
      '/quickbooks/Invoice/1/a.pdf', 'quickbooks\\Invoice\\1\\a.pdf',
      'quickbooks//Invoice/1/a.pdf', 'quickbooks/Invoice/1/',
      'quickbooks/Invoice/1/a\u0000.pdf', 'quickbooks/Invoice/1/a\n.pdf',
      `quickbooks/Invoice/1/${'x'.repeat(300)}.pdf`,
    ]) {
      expect(isSafeLedgerStoragePath(bad), JSON.stringify(bad)).toBe(false);
    }
    // A space is ordinary in a source file name and stays allowed.
    expect(isSafeLedgerStoragePath('quickbooks/Attachable/7/W-9 _signed_.pdf')).toBe(true);
  });

  it('reads traversal as a SEGMENT, so dots inside a file name are fine', () => {
    // The builder and the guard have to agree, or the guard rejects the only
    // thing that ever reaches it. safeLedgerFileName strips separators but
    // keeps dots, so '..' lands INSIDE a segment all the time — in a
    // sanitized hostile name and in perfectly ordinary ones. Two dots with
    // no separator around them name one object; they cannot walk anywhere.
    for (const name of [
      'Invoice..pdf', 'Q1..2024 statement.pdf', '../../etc/passwd',
      'a/../b.pdf', 'W-9 (signed).pdf', '.hidden.pdf',
    ]) {
      const built = ledgerStoragePath('quickbooks', 'Attachable', '7', name);
      expect(isSafeLedgerStoragePath(built), `${JSON.stringify(name)} -> ${built}`).toBe(true);
    }
    // A lone '.' segment is still refused — it names the directory, not a file.
    expect(isSafeLedgerStoragePath('quickbooks/./Invoice/1/a.pdf')).toBe(false);
    expect(isSafeLedgerStoragePath('.')).toBe(false);
  });
});

describe('ledgerDocumentHeaders', () => {
  it('renders a PDF inline — the case the viewer needs', () => {
    const h = ledgerDocumentHeaders('Invoice_1042.pdf', 'application/pdf');
    expect(h['Content-Type']).toBe('application/pdf');
    expect(h['Content-Disposition']).toBe(`inline; filename="Invoice_1042.pdf"; filename*=UTF-8''Invoice_1042.pdf`);
    expect(h['Cache-Control']).toBe('private, no-store');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('never serves a source-supplied HTML or SVG attachment inline', () => {
    // content_type comes from QuickBooks — an Attachable carries whatever
    // ContentType the uploader chose. Inline from our own origin that would
    // run as the signed-in finance user; nosniff does NOT stop a DECLARED
    // text/html. Everything outside the allowlist downloads instead.
    for (const ct of [
      'text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml',
      'application/xml', 'text/xml', 'application/javascript', 'TEXT/HTML', '', null, undefined,
    ]) {
      const h = ledgerDocumentHeaders('note.html', ct as any);
      expect(h['Content-Type'], String(ct)).toBe('application/octet-stream');
      expect(h['Content-Disposition'].startsWith('attachment;'), String(ct)).toBe(true);
      expect(h['Content-Disposition'].startsWith('inline'), String(ct)).toBe(false);
    }
  });

  it('keeps a parameterised PDF type inline, and flat images too', () => {
    expect(ledgerDocumentHeaders('a.pdf', 'application/pdf; charset=binary')['Content-Type']).toBe('application/pdf');
    for (const ct of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']) {
      expect(ledgerDocumentHeaders('a', ct)['Content-Disposition'].startsWith('inline'), ct).toBe(true);
    }
  });

  it('escapes the file name into both Content-Disposition params', () => {
    const h = ledgerDocumentHeaders('Facture "café".pdf', 'application/pdf');
    // The ASCII param carries no quote or backslash that could end it early,
    // and the real name rides in filename*.
    expect(h['Content-Disposition']).toBe(
      `inline; filename="Facture _caf__.pdf"; filename*=UTF-8''Facture%20%22caf%C3%A9%22.pdf`,
    );
    const blank = ledgerDocumentHeaders('   ', 'application/pdf');
    expect(blank['Content-Disposition']).toContain('filename="document"');
  });
});

describe('sha256Hex', () => {
  it('hashes the bytes, not their string form', () => {
    // Known vector: sha256('abc').
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('putLedgerObject — the gate is enforced here, not by convention', () => {
  it('refuses a normal write while the gate is shut, and never touches R2', async () => {
    const res = await putLedgerObject(service, 'quickbooks/Invoice/123/a.pdf', Buffer.from('%PDF'), 'application/pdf');
    expect(res).toEqual({ ok: false, error: 'LEDGER_PDFS_ENABLED off — docs/r2-private-flip.md' });
    expect(r2Upload).not.toHaveBeenCalled();
    expect(r2Head).not.toHaveBeenCalled();
  });

  it('writes the fixed probe object with the gate still shut', async () => {
    // The ONE documented exception: ledger/probe.txt carries no ledger data
    // and exists so the owner can prove the R2 flip took before any
    // financial byte is stored (docs/r2-private-flip.md).
    expect(LEDGER_PROBE_PATH).toBe('probe.txt');
    const res = await putLedgerObject(service, LEDGER_PROBE_PATH, Buffer.from('probe'), 'text/plain', { probe: true });
    expect(res).toEqual({
      ok: true, key: 'ledger/probe.txt', sha256: sha256Hex(Buffer.from('probe')), size: 5, existed: false,
    });
    expect(r2Upload).toHaveBeenCalledWith('ledger', 'probe.txt', expect.any(Buffer), 'text/plain');
  });

  it('will not carry real content through the probe exception', async () => {
    // The exception is the KEY, not the flag. A `probe: true` that got spread
    // or copy-pasted onto a document write would otherwise put a customer
    // invoice into a bucket whose privacy is still unproven, silently.
    for (const path of [
      'quickbooks/Invoice/123/Invoice_1042.pdf',
      ledgerStoragePath('quickbooks', 'Attachable', '7', 'W-9 (signed).pdf'),
      'probe.txt.pdf',
      'quickbooks/probe.txt',
    ]) {
      const res = await putLedgerObject(service, path, Buffer.from('%PDF'), 'application/pdf', { probe: true });
      expect(res.ok, path).toBe(false);
      expect((res as { error: string }).error, path)
        .toBe('The gate-free probe write is only for probe.txt — docs/r2-private-flip.md');
    }
    expect(r2Upload).not.toHaveBeenCalled();
    expect(r2Head).not.toHaveBeenCalled();
  });

  it('accepts every key its own builder produces, once the gate is open', async () => {
    // The round trip the two halves of this module have to agree on: whatever
    // ledgerStoragePath emits, putLedgerObject must be willing to store. A
    // guard that reads '..' as a substring passes each half's own test and
    // still refuses ordinary names like 'Invoice..pdf'.
    process.env.LEDGER_PDFS_ENABLED = 'true';
    for (const name of ['Invoice..pdf', '../../etc/passwd', 'W-9 (signed).pdf', 'Q1..2024 statement.pdf']) {
      const path = ledgerStoragePath('quickbooks', 'Attachable', '7', name);
      const res = await putLedgerObject(service, path, Buffer.from('%PDF'), 'application/pdf');
      expect(res, `${JSON.stringify(name)} -> ${path}`).toMatchObject({ ok: true, key: `ledger/${path}` });
    }
    expect(r2Upload).toHaveBeenCalledTimes(4);
  });

  it('uploads once the gate is open, and never returns a public URL', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    const bytes = Buffer.from('%PDF-1.4');
    const res = await putLedgerObject(service, 'quickbooks/Invoice/123/a.pdf', bytes, 'application/pdf');
    expect(res).toEqual({
      ok: true, key: 'ledger/quickbooks/Invoice/123/a.pdf', sha256: sha256Hex(bytes), size: bytes.byteLength, existed: false,
    });
    expect(JSON.stringify(res)).not.toContain('public');
  });

  it('reports an object that is already there as existed, without re-uploading', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    r2Head.mockResolvedValue(true);
    const res = await putLedgerObject(service, 'quickbooks/Invoice/123/a.pdf', Buffer.from('%PDF'), 'application/pdf');
    expect(res).toMatchObject({ ok: true, existed: true });
    expect(r2Upload).not.toHaveBeenCalled();
  });

  it('stays shut when the settings row cannot be READ, and never touches R2', async () => {
    // Fails CLOSED: an unreadable app_settings row is not permission to
    // write financial bytes into a bucket whose privacy is unproven.
    const res = await putLedgerObject(brokenService, 'quickbooks/Invoice/123/a.pdf', Buffer.from('%PDF'), 'application/pdf');
    expect(res).toEqual({ ok: false, error: 'LEDGER_PDFS_ENABLED off — docs/r2-private-flip.md' });
    expect(r2Upload).not.toHaveBeenCalled();
    expect(r2Head).not.toHaveBeenCalled();
  });

  it('refuses a hand-built path that could leave the prefix, gate open or not', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    for (const bad of ['../signed-documents/x.pdf', '/quickbooks/a.pdf', 'quickbooks\\a.pdf', '']) {
      const res = await putLedgerObject(service, bad, Buffer.from('%PDF'), 'application/pdf');
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      expect((res as { error: string }).error, JSON.stringify(bad)).toContain('Unsafe ledger storage path');
    }
    expect(r2Upload).not.toHaveBeenCalled();
    expect(r2Head).not.toHaveBeenCalled();
  });

  it('turns an R2 failure into ok:false rather than throwing', async () => {
    process.env.LEDGER_PDFS_ENABLED = 'true';
    r2Upload.mockResolvedValue({ success: false, key: '', publicUrl: '', error: 'AccessDenied' });
    expect(await putLedgerObject(service, 'quickbooks/Invoice/123/a.pdf', Buffer.from('%PDF'), 'application/pdf'))
      .toEqual({ ok: false, error: 'AccessDenied' });
  });
});
