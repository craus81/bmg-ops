import { describe, expect, it } from 'vitest';
import { buildEstimatePdf, estimatePdfFilename, proFormaInvoiceNumber, proFormaIssuedDate, type EstimatePdfData } from './estimate-pdf';

// 1×1 PNG — enough for jsPDF to parse and embed.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const baseEstimate = {
  estimate_number: 'EST-1042',
  title: 'Contractor package — Transit 148',
  customer_name: 'Acme Fleet Services',
  vehicle_year: '2026',
  vehicle_platform_label: 'Ford Transit',
  vehicle_wheelbase: '148',
  vehicle_roof: 'medium',
  vin: '1FTBW2CM5PKA00001',
  unit_number: 'U-77',
  po_number: 'PO-991',
  expiration_date: '2026-09-30',
  subtotal: 1500,
  labor_hours: 6,
  labor_hours_override: null,
  labor_rate: 120,
  labor_total: 720,
  tax_rate: 0.0795,
  tax_amount: 119.25,
  tax_exempt: false,
  grand_total: 2339.25,
  install_instructions: 'Install shelving on driver side.\nBulkhead behind seats.',
  on_site_contact_name: 'Dana',
  on_site_contact_phone: '555-0100',
  delivery_preferences: 'Deliver to the Elkhart yard.',
  notes: 'Customer wants the work before October.',
};

const data: EstimatePdfData = {
  estimate: baseEstimate,
  lines: [
    {
      item_number: 'SH-4820',
      description: 'Steel shelving unit 48x20',
      notes: 'Driver side',
      quantity: 2,
      unit_price: 450,
      line_total: 900,
      part_product_url: 'https://vendor.example.com/sh-4820',
      image: { dataUrl: PNG_1PX, format: 'PNG' },
    },
    { item_number: 'BH-100', description: 'Bulkhead', quantity: 1, unit_price: 600, line_total: 600 },
    { description: 'Contractor package — assembly labor', quantity: 1, unit_price: 0, labor_hours: 2 } as any,
  ],
  company: {
    name: 'BMG Fleet', address: '100 Main St', city: 'Elkhart', state: 'IN', zip: '46514',
    phone: '555-0199', email: 'sales@bmgfleet.com',
  },
  logo: { dataUrl: PNG_1PX, format: 'PNG' },
};

describe('buildEstimatePdf', () => {
  it('renders a valid PDF with the estimate content', () => {
    const doc = buildEstimatePdf(data);
    const out = Buffer.from(doc.output('arraybuffer'));
    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(out.byteLength).toBeGreaterThan(2000);
    // jsPDF stores page text compressed only when asked — default keeps it
    // findable, so spot-check the load-bearing strings landed.
    const raw = out.toString('latin1');
    expect(raw).toContain('Estimate #EST-1042');
    expect(raw).toContain('SH-4820');
    expect(raw).toContain('Acme Fleet Services');
    // Product link rides as a real link annotation.
    expect(raw).toContain('https://vendor.example.com/sh-4820');
  });

  it('renders a hitch kit with photos on its parts', () => {
    const group = { kit_group_id: '11111111-1111-4111-8111-111111111111', kit_item_number: 'Hitch kit', kit_name: 'Trailer hitch kit, 2024 Ford Transit, Class 3, 4-way', kit_quantity: 1 };
    const doc = buildEstimatePdf({
      ...data,
      lines: [
        { item_number: '13193', description: 'Class 3 hitch', quantity: 1, unit_price: 285.95, line_total: 285.95, image: { dataUrl: PNG_1PX, format: 'PNG' }, ...group } as any,
        { item_number: '56327', description: '4-way harness', quantity: 1, unit_price: 100.95, line_total: 100.95, image: { dataUrl: PNG_1PX, format: 'PNG' }, ...group } as any,
      ],
    });
    const raw = Buffer.from(doc.output('arraybuffer')).toString('latin1');
    expect(raw).toContain('Trailer hitch kit, 2024 Ford Transit');
    expect(raw).toContain('386.90');
    expect(raw).toContain('56327');
    expect((raw.match(/\/Subtype \/Image/g) || []).length).toBeGreaterThan(0);
  });

  it('renders the vinyl/graphics section from linked wrap quotes', () => {
    const doc = buildEstimatePdf({
      ...data,
      graphics: [{
        quoteNumber: 'WQ-2093',
        vehicle: '2026 Transit 148',
        totalSqft: 214,
        films: [
          { name: '3M IJ180cv3', areas: ['Hood', 'Roof'] },
          { name: 'Avery SW900', areas: ['Driver side'] },
        ],
      }],
    });
    const raw = Buffer.from(doc.output('arraybuffer')).toString('latin1');
    expect(raw).toContain('WQ-2093');
    expect(raw).toContain('3M IJ180cv3');
    expect(raw).toContain('Avery SW900');
  });

  it('renders without images, logo, company, or optional sections', () => {
    const doc = buildEstimatePdf({
      estimate: {
        estimate_number: 'EST-1', customer_name: null, subtotal: 100,
        labor_total: 0, tax_exempt: true, grand_total: 100, labor_rate: 120, labor_hours: 0,
      },
      lines: [{ description: 'Thing', quantity: 1, unit_price: 100 }],
    });
    const out = Buffer.from(doc.output('arraybuffer'));
    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(out.toString('latin1')).toContain('Exempt');
  });

  it('renders the lender version as a plain invoice numbered PF-…', () => {
    const raw = Buffer.from(buildEstimatePdf({ ...data, proForma: { issuedDate: 'October 20, 2026' } })
      .output('arraybuffer')).toString('latin1');
    expect(raw).toContain('(Invoice)');
    expect(raw).toContain('Invoice #PF-1042');
    expect(raw).toContain('Issued October 20, 2026');
    expect(raw).toContain('Bill to Acme Fleet Services');
    // Ford won't fund anything labeled pro forma.
    expect(raw.toLowerCase()).not.toContain('pro forma');
    expect(raw).not.toContain('NOT A BILL');
    expect(raw).not.toContain('Estimate #');
    // The lender may take weeks; a pro forma doesn't expire.
    expect(raw).not.toContain('Expires 2026-09-30');
  });

  it('survives a corrupt image without throwing', () => {
    const doc = buildEstimatePdf({
      estimate: { estimate_number: 'EST-2', subtotal: 0, grand_total: 0, tax_exempt: false, labor_total: 0 },
      lines: [{ description: 'Bad image line', quantity: 1, unit_price: 0, image: { dataUrl: 'data:image/png;base64,garbage', format: 'PNG' } }],
    });
    expect(Buffer.from(doc.output('arraybuffer')).byteLength).toBeGreaterThan(500);
  });
});

describe('estimatePdfFilename', () => {
  it('sanitizes the estimate number', () => {
    expect(estimatePdfFilename({ estimate_number: 'EST 10/42' })).toBe('Estimate-EST_10_42.pdf');
    expect(estimatePdfFilename({})).toBe('Estimate-estimate.pdf');
  });

  it('names the pro forma version', () => {
    expect(estimatePdfFilename({ estimate_number: 'EST-2610-022' }, { proForma: true })).toBe('Invoice-PF-2610-022.pdf');
    expect(estimatePdfFilename({ estimate_number: '1042' }, { proForma: true })).toBe('Invoice-PF-1042.pdf');
  });
});

describe('proFormaInvoiceNumber', () => {
  it('swaps EST for PF', () => {
    expect(proFormaInvoiceNumber('EST-2610-022')).toBe('PF-2610-022');
    expect(proFormaInvoiceNumber('est-7')).toBe('PF-7');
  });

  it('prefixes PF when there is no EST', () => {
    expect(proFormaInvoiceNumber('1042')).toBe('PF-1042');
    expect(proFormaInvoiceNumber('ESTATE-1')).toBe('PF-ESTATE-1');
    expect(proFormaInvoiceNumber(null)).toBe('PF');
  });
});

describe('proFormaIssuedDate', () => {
  it('uses BMG\'s time zone', () => {
    // 03:00Z on the 21st is still the evening of the 20th in O'Fallon.
    expect(proFormaIssuedDate(new Date('2026-10-21T03:00:00Z'))).toBe('October 20, 2026');
  });
});
