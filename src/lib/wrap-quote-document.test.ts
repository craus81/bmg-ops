import { describe, it, expect } from 'vitest';
import { wrapDocTitle, wrapQuoteDocModel } from './wrap-quote-document';
import { renderQuoteDocument } from './quote-document';

// The wrap adapter feeds BOTH customer-facing wrap surfaces (the emailed
// quote and the frozen signed snapshot). These tests pin the wrap-specific
// conventions that a "helpful" refactor would silently corrupt: raw-percent
// tax (never ×100), locale thousands separators, and '—' for the null
// prices on roll-nested shape rows (null is meaningful — the per-film
// Material rows carry the money).

const baseQuote = {
  quote_number: 'WQ-42',
  created_at: '2026-08-20T15:00:00.000Z',
  customer: { name: 'Acme Fleet', city: 'Kalamazoo', state: 'MI', zip: '49001', email: 'fleet@acme.example' },
  project_type: 'Partial Wrap',
  vehicle_description: '2026 Ford Transit 148',
  measurements: [
    { name: 'Driver Side', qty: 1, billed_area_sqft: 62.5, substrate: { name: '3M IJ180cv3' }, unit_price: 12, line_total: 750 },
  ],
  labor: {
    films: [{ label: '3M IJ180cv3', sqft: 62.5, rate: 4, total: 250 }],
    design: { total: 150 },
  },
  subtotal: 1150,
  tax_rate: 7.25,
  tax_amount: 83.38,
  total: 1233.38,
};

describe('wrapDocTitle', () => {
  it('says Wrap Quote whenever money rides along (body pricing or the NetSuite PDF)', () => {
    expect(wrapDocTitle(true, false)).toBe('Wrap Quote');
    expect(wrapDocTitle(false, true)).toBe('Wrap Quote');
    expect(wrapDocTitle(false, false)).toBe('Wrap Coverage');
  });
});

describe('wrapQuoteDocModel formatting conventions', () => {
  it('renders the tax rate RAW (wrap rates are percents, never ×100)', () => {
    const m = wrapQuoteDocModel(baseQuote, { pricing: true, lineItems: true });
    expect(m.totals!.map(t => t.labelHtml)).toContain('Tax (7.25%)');
  });

  it('formats money with locale thousands separators', () => {
    const m = wrapQuoteDocModel({ ...baseQuote, subtotal: 12345.5 }, { pricing: true, lineItems: true });
    expect(m.totals!.find(t => t.labelHtml === 'Subtotal')!.valueHtml).toBe('$12,345.50');
  });

  it("renders '—' (never $0.00) for null prices on roll-nested shape rows", () => {
    const m = wrapQuoteDocModel({
      ...baseQuote,
      measurements: [{ name: 'Hood', qty: 1, billed_area_sqft: 20, unit_price: null, line_total: null }],
    }, { pricing: true, lineItems: true });
    expect(m.rows[0].rateHtml).toBe('—');
    expect(m.rows[0].totalHtml).toBe('—');
  });

  it('rolls nesting up into per-film Material rows and the roll-layout footnote', () => {
    const m = wrapQuoteDocModel({
      ...baseQuote,
      nesting: {
        enabled: true,
        roll_width_in: 60,
        sets: 2,
        films: [{ label: '3M IJ180cv3', material_total: 420, roll_sqft: 105, extra_area_sqft: 0, rolls: [{ used_length_in: 252 }] }],
      },
    }, { pricing: true, lineItems: true });
    const material = m.rows.find(r => r.itemHtml.includes('Material — 3M IJ180cv3'))!;
    expect(material.totalHtml).toBe('<b>$420.00</b>');
    expect(material.itemHtml).toContain('21.0 ft of 60.00&quot; roll');
    expect(material.itemHtml).toContain('2 sets');
    expect(m.footnotesHtml!.join('')).toContain('Materials priced from nested roll layout:');
  });

  it('shows the kit rollup row and the adjustment totals on kit-quantity jobs', () => {
    const m = wrapQuoteDocModel({
      ...baseQuote,
      package_qty: 3,
      adjustments: {
        pre_subtotal: 3450, pre_materials: 2250, kit_materials: 750, kit_area_sqft: 62.5,
        discount_amount: 172.5, discount_pct: 5, min_bump: 0,
      },
    }, { pricing: true, lineItems: true });
    const rollup = m.rows.find(r => r.itemHtml.includes('Materials — 3 kits'))!;
    expect(rollup.qtyHtml).toBe('<b>3</b>');
    expect(rollup.itemHtml).toContain('62.50 ft² per kit');
    expect(m.rows[0].itemHtml).toContain('per kit');
    const labels = m.totals!.map(t => t.labelHtml);
    expect(labels).toContain('Subtotal before adjustments');
    expect(labels).toContain('Quantity discount (5.00%)');
    expect(labels).not.toContain('Shop minimum');
    expect(m.totals!.find(t => t.labelHtml === 'Quantity discount (5.00%)')!.valueHtml).toBe('−$172.50');
  });

  it('prices with totals but no line table when itemization is hidden', () => {
    const m = wrapQuoteDocModel(baseQuote, { pricing: true, lineItems: false });
    expect(m.columns).toBeNull();
    expect(m.rows).toEqual([]);
    expect(m.totals).not.toBeNull();
    expect(m.footnotesHtml).toEqual([]);
  });

  it('carries no money at all on coverage-only sends', () => {
    const m = wrapQuoteDocModel({ ...baseQuote, diagram_path: 'x.png' },
      { pricing: false, lineItems: false, diagramUrl: 'https://pub.example.com/vehicle-templates/x.png' });
    expect(m.totals).toBeNull();
    expect(m.columns).toBeNull();
    expect(m.diagram!.url).toContain('x.png');
    expect(m.docTitle).toBe('Wrap Coverage');
  });

  it('escapes customer and quote fields', () => {
    const m = wrapQuoteDocModel({
      ...baseQuote,
      customer: { name: 'A&B <Fleet>' },
      project_notes: '<b>raw</b>',
    }, { pricing: true, lineItems: true });
    expect(m.customerBlockHtml).toBe('A&amp;B &lt;Fleet&gt;');
    expect(m.sections![0].bodyHtml).toBe('&lt;b&gt;raw&lt;/b&gt;');
  });
});

describe('wrap model through the shared renderer', () => {
  it('renders the full emailed quote: customer block, install rows, totals, CTA panel', () => {
    const html = renderQuoteDocument(
      wrapQuoteDocModel(baseQuote, { pricing: true, lineItems: true }),
      {
        company: { name: 'BMG Fleet' },
        ctaUrl: 'https://app.example.com/approve/quote/tok123',
        ctaLabel: 'Review & Accept This Quote',
        ctaNote: 'The link expires in 30 days.',
        ctaPanel: true,
      },
    );
    expect(html).toContain('Wrap Quote');
    expect(html).toContain('WQ-42');
    expect(html).toContain('Acme Fleet');
    expect(html).toContain('<b>Project Type:</b> Partial Wrap');
    expect(html).toContain('Install — 3M IJ180cv3');
    expect(html).toContain('62.50 ft² @ $4.00/ft²');
    expect(html).toContain('Tax (7.25%)');
    expect(html).toContain('$1,233.38');
    expect(html).toContain('href="https://app.example.com/approve/quote/tok123"');
    expect(html).toContain('Review &amp; Accept This Quote');
    expect(html).toContain('The link expires in 30 days.');
    expect(html).toContain('Sent by BMG Fleet');
  });

  it('renders the signed snapshot shape: totals without the hidden line table, audit block appended', () => {
    const html = renderQuoteDocument(
      wrapQuoteDocModel({ ...baseQuote, hide_line_items: true }, { pricing: true, lineItems: false }),
      { signedBlockHtml: '<div id="audit">ACCEPTED</div>' },
    );
    expect(html).not.toContain('Install — 3M IJ180cv3');
    expect(html).toContain('$1,233.38');
    expect(html).toContain('<div id="audit">ACCEPTED</div>');
  });
});
