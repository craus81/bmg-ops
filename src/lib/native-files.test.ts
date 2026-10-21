import { describe, it, expect, vi } from 'vitest';

vi.mock('./supabase-browser', () => ({ createClient: () => ({ auth: { getSession: async () => ({}) } }) }));

import { withFileExtension, nameBlobUrl, blobUrlName } from './native-files';

const PDF_HEAD = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

describe('withFileExtension', () => {
  it('keeps a name that already has an ending', () => {
    expect(withFileExtension('Invoice_INV1532.pdf', 'application/pdf')).toBe('Invoice_INV1532.pdf');
    expect(withFileExtension('EST-2610-024.pdf', '')).toBe('EST-2610-024.pdf');
  });

  it('adds .pdf to a PDF named without one (the "File" Save to Files bug)', () => {
    expect(withFileExtension('File', 'application/pdf')).toBe('File.pdf');
    expect(withFileExtension('Pro Forma Invoice', 'application/pdf; charset=binary')).toBe('Pro Forma Invoice.pdf');
  });

  it('tells a PDF by its first bytes when the type is missing', () => {
    expect(withFileExtension('File', '', PDF_HEAD)).toBe('File.pdf');
    expect(withFileExtension('File', 'application/octet-stream', PDF_HEAD)).toBe('File.pdf');
  });

  it('uses the type for images', () => {
    expect(withFileExtension('Photo', 'image/jpeg')).toBe('Photo.jpg');
  });

  it('falls back to File and strips characters Files refuses', () => {
    expect(withFileExtension('', 'application/pdf')).toBe('File.pdf');
    expect(withFileExtension(null, 'application/pdf')).toBe('File.pdf');
    expect(withFileExtension('INV/1532', 'application/pdf')).toBe('INV-1532.pdf');
  });

  it('leaves an unknown type alone', () => {
    expect(withFileExtension('Notes', 'application/x-unknown')).toBe('Notes');
  });
});

describe('blob URL names', () => {
  it('remembers the name a screen gave a blob: URL', () => {
    const url = nameBlobUrl('blob:https://go.bmgfleet.com/abc', 'Invoice_INV1532.pdf');
    expect(url).toBe('blob:https://go.bmgfleet.com/abc');
    expect(blobUrlName(url)).toBe('Invoice_INV1532.pdf');
    expect(blobUrlName('blob:https://go.bmgfleet.com/other')).toBeNull();
  });
});
