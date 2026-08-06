import { describe, it, expect, afterEach } from 'vitest';
import { deepLinks, allowedPdfSrc } from './deep-links';

// The PDF viewer wraps an attachment in app chrome so a "open in new tab"
// click isn't a dead end. Two things must hold: the link carries a real way
// back, and the viewer only ever frames our own files.

describe('deepLinks.pdfViewer', () => {
  it('carries the source, name and return path', () => {
    const url = deepLinks.pdfViewer('/api/gmail/attachment?messageId=abc', {
      name: 'PO 12345.pdf',
      back: deepLinks.poPendingReview('abc'),
      backLabel: 'PO import',
    });
    const params = new URLSearchParams(url.split('?')[1]);
    expect(url.startsWith('/pdf?')).toBe(true);
    expect(params.get('src')).toBe('/api/gmail/attachment?messageId=abc');
    expect(params.get('name')).toBe('PO 12345.pdf');
    expect(params.get('back')).toBe('/admin/pos?review=abc');
    expect(params.get('backLabel')).toBe('PO import');
  });

  it('omits the optional params rather than emitting empty ones', () => {
    expect(deepLinks.pdfViewer('/api/gmail/attachment?messageId=abc'))
      .toBe('/pdf?src=%2Fapi%2Fgmail%2Fattachment%3FmessageId%3Dabc');
  });
});

describe('allowedPdfSrc', () => {
  const ORIGIN = 'https://ops.bmgfleet.com';
  const FILE_HOST = 'https://files.example.com';
  afterEach(() => { delete process.env.NEXT_PUBLIC_R2_PUBLIC_URL; });

  it('allows same-origin paths and URLs', () => {
    expect(allowedPdfSrc('/api/gmail/attachment?messageId=abc', ORIGIN))
      .toBe('/api/gmail/attachment?messageId=abc');
    expect(allowedPdfSrc(`${ORIGIN}/api/gmail/attachment`, ORIGIN))
      .toBe(`${ORIGIN}/api/gmail/attachment`);
  });

  it('allows our public file host', () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_URL = FILE_HOST;
    expect(allowedPdfSrc(`${FILE_HOST}/po/123.pdf`, ORIGIN)).toBe(`${FILE_HOST}/po/123.pdf`);
  });

  it('refuses anything that would frame someone else in our chrome', () => {
    expect(allowedPdfSrc('//evil.example.com/x.pdf', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('https://evil.example.com/x.pdf', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('javascript:alert(1)', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('data:text/html,<h1>hi', ORIGIN)).toBe(null);
    expect(allowedPdfSrc('http://ops.bmgfleet.com/x.pdf', ORIGIN)).toBe(null);
    expect(allowedPdfSrc(null, ORIGIN)).toBe(null);
    expect(allowedPdfSrc('', ORIGIN)).toBe(null);
  });
});
