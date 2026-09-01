import { describe, expect, it } from 'vitest';
import { buildQuoteDocPdf, htmlToText } from './quote-doc-pdf';
import { wrapQuoteDocModel } from './wrap-quote-document';
import type { QuoteDocModel } from './quote-document';

describe('htmlToText', () => {
  it('drops tags and decodes entities', () => {
    expect(htmlToText('<b>Material &mdash; 3M IJ180</b>')).toBe('Material - 3M IJ180');
    expect(htmlToText('Roll &quot;60&quot; wide&quot;')).toBe('Roll "60" wide"');
    expect(htmlToText('A &amp; B &middot; C')).toBe('A & B · C');
  });

  it('breaks the grey detail span onto its own line', () => {
    expect(htmlToText('Hood <span style="color:#6b7280;">12.50 ft² · Gloss</span>'))
      .toBe('Hood\n12.50 ft² · Gloss');
  });

  it('folds characters helvetica cannot encode', () => {
    // The adapters emit a real minus sign on discount rows.
    expect(htmlToText('−$120.00')).toBe('-$120.00');
    expect(htmlToText('‘quoted’')).toBe("'quoted'");
  });

  it('is empty for empty input', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });
});

const model: QuoteDocModel = {
  docTitle: 'Wrap Quote',
  subtitleHtml: 'WQ-2093 · March 4, 2026',
  customerBlockHtml: 'Acme Fleet Services<br>100 Main St<br>Elkhart, IN 46514',
  identityLinesHtml: ['<b>Vehicle:</b> 2026 Transit 148'],
  columns: { qty: 'Qty', rate: 'Price' },
  rows: [
    { itemHtml: 'Hood <span style="color:#6b7280;">12.50 ft²</span>', qtyHtml: '1', rateHtml: '$120.00', totalHtml: '$120.00' },
    { itemHtml: '<b>Material — 3M IJ180</b>', qtyHtml: '1', rateHtml: '$340.00', totalHtml: '<b>$340.00</b>' },
  ],
  totals: [
    { labelHtml: 'Quantity discount (10%)', valueHtml: '−$46.00', color: '#7c3aed' },
    { labelHtml: 'Subtotal', valueHtml: '$414.00' },
    { labelHtml: 'Total', valueHtml: '$444.03', bold: true, color: '#059669' },
  ],
  sections: [{ title: 'Project Notes', bodyHtml: 'Customer wants matte laminate.' }],
  footnotesHtml: ['<b>Film usage:</b> 3M IJ180 — 42.00 ft²'],
};

describe('buildQuoteDocPdf', () => {
  it('renders a valid PDF carrying the model content', () => {
    const out = Buffer.from(buildQuoteDocPdf(model, {
      company: { name: 'BMG Fleet', address: '100 Main St', city: 'Elkhart', state: 'IN', zip: '46514' },
    }).output('arraybuffer'));
    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const raw = out.toString('latin1');
    expect(raw).toContain('Wrap Quote');
    expect(raw).toContain('WQ-2093');
    expect(raw).toContain('Acme Fleet Services');
    expect(raw).toContain('Material - 3M IJ180');
    expect(raw).toContain('Project Notes'.toUpperCase());
    expect(raw).toContain('$444.03');
  });

  it('renders a quote whose line items are hidden (totals only)', () => {
    const out = Buffer.from(
      buildQuoteDocPdf({ ...model, columns: null, rows: [] }).output('arraybuffer'),
    );
    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(out.toString('latin1')).toContain('$444.03');
  });

  it('renders a real wrap quote through the shared adapter', () => {
    const quote = {
      quote_number: 'WQ-3001',
      created_at: '2026-03-04T12:00:00Z',
      customer: { name: 'Acme Fleet Services', city: 'Elkhart', state: 'IN' },
      vehicle_description: '2026 Transit 148',
      project_type: 'Full wrap',
      measurements: [
        { name: 'Hood', qty: 1, billed_area_sqft: 12.5, unit_price: 120, line_total: 120, substrate: { name: '3M IJ180' } },
      ],
      labor: { films: [], design: { total: 150 } },
      subtotal: 270,
      tax_rate: 7,
      tax_amount: 18.9,
      total: 288.9,
    };
    const out = Buffer.from(
      buildQuoteDocPdf(wrapQuoteDocModel(quote, { pricing: true, lineItems: true })).output('arraybuffer'),
    );
    const raw = out.toString('latin1');
    expect(raw).toContain('WQ-3001');
    expect(raw).toContain('Hood');
    expect(raw).toContain('$288.90');
  });
});
