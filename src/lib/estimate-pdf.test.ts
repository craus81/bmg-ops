import { describe, expect, it } from 'vitest';
import { buildEstimatePdf, estimatePdfFilename, type EstimatePdfData } from './estimate-pdf';

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
});
