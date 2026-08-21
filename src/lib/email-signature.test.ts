import { describe, it, expect } from 'vitest';
import { renderSignatureHtml } from './email-signature';
import { renderEstimateDocument } from './estimate-document';
import { buildNotificationEmail, buildInvoiceEmail } from './resend';

describe('renderSignatureHtml', () => {
  it('renders escaped text with newlines preserved via pre-line', () => {
    const html = renderSignatureHtml('Pat Doe\nBMG Fleet <Sales>\n(555) 555-0100');
    expect(html).toContain('white-space:pre-line');
    expect(html).toContain('Pat Doe\nBMG Fleet &lt;Sales&gt;\n(555) 555-0100');
  });

  it('returns empty for blank/undefined so templates render unchanged', () => {
    expect(renderSignatureHtml(null)).toBe('');
    expect(renderSignatureHtml('   ')).toBe('');
    expect(renderSignatureHtml(undefined)).toBe('');
  });

  it('themes the divider and text for dark cards', () => {
    expect(renderSignatureHtml('x', 'dark')).toContain('#1e2d3d');
    expect(renderSignatureHtml('x', 'light')).toContain('#e5e7eb');
  });
});

describe('signature placement in the email builders', () => {
  it('estimate document renders the composed sender signature', () => {
    const html = renderEstimateDocument(
      { estimate_number: 'EST-1', customer_name: 'Acme', subtotal: 1, grand_total: 1 },
      [],
      { signature: 'Pat Doe\nBMG Fleet' },
    );
    expect(html).toContain('Pat Doe\nBMG Fleet');
  });

  it('notification and invoice emails render it in the dark theme', () => {
    expect(buildNotificationEmail('T', 'B', undefined, undefined, { signature: 'Pat Doe' }))
      .toContain('Pat Doe');
    expect(buildInvoiceEmail('Acme', ['1'], [], undefined, 'Pat Doe')).toContain('Pat Doe');
  });

  it('emails without a signature are unchanged (no stray divider)', () => {
    const html = buildNotificationEmail('T', 'B');
    expect(html).not.toContain('white-space:pre-line');
  });
});
