import { describe, it, expect } from 'vitest';
import { renderEstimateDocument, vehicleDescription, estimateContextMemo } from './estimate-document';

// The estimate document is the legal record the customer approves — the
// send-for-approval email and the frozen signed snapshot both come from this
// renderer. These tests pin the K5 vehicle-identity block: the meeting's ask
// was literally "does the VIN appear on the PDF?".
describe('renderEstimateDocument vehicle identity (K5)', () => {
  const baseEst = {
    estimate_number: 'EST-2608-TEST',
    customer_name: 'Acme Fleet',
    subtotal: 100,
    grand_total: 100,
  };

  it('prints VIN and unit number in the header when present', () => {
    const html = renderEstimateDocument(
      { ...baseEst, vin: '1FTBW3XM5PKA12345', unit_number: 'T-204' },
      []
    );
    expect(html).toContain('VIN 1FTBW3XM5PKA12345');
    expect(html).toContain('Unit T-204');
  });

  it('prints VIN alone without a dangling separator', () => {
    const html = renderEstimateDocument({ ...baseEst, vin: 'PKA12345' }, []);
    expect(html).toContain('VIN PKA12345');
    expect(html).not.toContain('&middot;');
  });

  it('omits the vehicle block entirely when neither field is set', () => {
    const html = renderEstimateDocument({ ...baseEst }, []);
    expect(html).not.toContain('VIN ');
    expect(html).not.toContain('Unit ');
  });

  it('escapes HTML in the vehicle fields', () => {
    const html = renderEstimateDocument(
      { ...baseEst, vin: '<script>x</script>', unit_number: 'A&B' },
      []
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A&amp;B');
  });

  it('prints the stored vehicle description ahead of VIN/unit (N4-B2)', () => {
    const html = renderEstimateDocument(
      {
        ...baseEst,
        vin: '1FTBR1C82TKA17431', unit_number: '402',
        vehicle_year: '2026', vehicle_platform_label: 'Ford Transit',
        vehicle_roof: 'medium', vehicle_wheelbase: '148',
      },
      []
    );
    expect(html).toContain('2026 Ford Transit · medium roof · 148&quot; WB &middot; VIN 1FTBR1C82TKA17431 &middot; Unit 402');
  });
});

// Enhanced-estimate line assets: photo thumbnail + vendor product link,
// attached by enrichLinesWithPartAssets and rendered here for the email,
// the approval page's sibling markup, and the signed snapshot alike.
describe('renderEstimateDocument line assets', () => {
  const baseEst = { estimate_number: 'EST-1', customer_name: 'Acme', subtotal: 10, grand_total: 10 };
  const baseLine = { id: 'l1', item_number: 'RR-KIT-148', description: 'Shelving kit', quantity: 1, unit_price: 10, line_total: 10 };

  it('renders the photo thumbnail and product link when enriched', () => {
    const html = renderEstimateDocument(baseEst, [{
      ...baseLine,
      part_image_url: 'https://pub.example.com/photos/parts/p1/vendor-1.jpg',
      part_product_url: 'https://vendor.example.com/rr-kit-148',
    }]);
    expect(html).toContain('src="https://pub.example.com/photos/parts/p1/vendor-1.jpg"');
    expect(html).toContain('href="https://vendor.example.com/rr-kit-148"');
    expect(html).toContain('View product');
  });

  it('renders plain rows when no assets are attached', () => {
    const html = renderEstimateDocument(baseEst, [baseLine]);
    expect(html).toContain('RR-KIT-148');
    expect(html).not.toContain('View product');
    expect(html).not.toContain('<img src=');
  });

  it('escapes asset URLs', () => {
    const html = renderEstimateDocument(baseEst, [{
      ...baseLine,
      part_product_url: 'https://vendor.example.com/a?b=1&c="x"',
    }]);
    expect(html).toContain('href="https://vendor.example.com/a?b=1&amp;c=&quot;x&quot;"');
  });
});

describe('vehicleDescription', () => {
  it('composes year + platform + qualifiers, skipping blanks', () => {
    expect(vehicleDescription({
      vehicle_year: '2026', vehicle_platform_label: 'Ford Transit',
      vehicle_roof: 'medium', vehicle_wheelbase: '148',
    })).toBe('2026 Ford Transit · medium roof · 148" WB');
    expect(vehicleDescription({
      vehicle_platform_label: 'Ford Transit Connect', vehicle_wheelbase: 'SWB',
    })).toBe('Ford Transit Connect · SWB');
    expect(vehicleDescription({
      vehicle_year: '2025', vehicle_platform_label: 'Ford F-150',
      vehicle_cab: 'SuperCrew', vehicle_bed: '5.5',
    })).toBe("2025 Ford F-150 · SuperCrew cab · 5.5' bed");
    expect(vehicleDescription({ vin: '1FTBR1C82TKA17431' })).toBe('');
  });

  it('falls back to the free-text vehicle when no platform label is set', () => {
    expect(vehicleDescription({ vehicle_year: '2024', vehicle_other: 'Honda Civic' }))
      .toBe('2024 Honda Civic');
    expect(vehicleDescription({ vehicle_other: 'Isuzu NPR box truck' }))
      .toBe('Isuzu NPR box truck');
    // Platform label wins when both exist (vehicle_other is nulled on save
    // when a platform is selected, but be safe about stale rows).
    expect(vehicleDescription({
      vehicle_year: '2026', vehicle_platform_label: 'Ford Transit', vehicle_other: 'stale',
    })).toBe('2026 Ford Transit');
  });
});

// One memo builder for both NetSuite push paths (estimate push and
// convert-to-SO) — these pin the shape so the two copies can't drift.
describe('estimateContextMemo', () => {
  it('stacks title, notes, the context line, and the estimate number', () => {
    expect(estimateContextMemo({
      estimate_number: 'EST-2608-ABCD',
      title: 'Fleet Upfit — 10 Transits',
      notes: 'Install before end of month',
      vehicle_year: '2026', vehicle_platform_label: 'Ford Transit', vehicle_roof: 'medium',
      delivery_preferences: 'Deliver to site',
      unit_number: 'T-204',
    })).toBe([
      'Fleet Upfit — 10 Transits',
      'Install before end of month',
      'Vehicle: 2026 Ford Transit · medium roof · Delivery: Deliver to site · Unit: T-204',
      'FleetSuite Estimate #EST-2608-ABCD',
    ].join('\n'));
  });

  it('collapses to just the estimate number when nothing else is set', () => {
    expect(estimateContextMemo({ estimate_number: 'EST-2608-ABCD' }))
      .toBe('FleetSuite Estimate #EST-2608-ABCD');
  });

  it('keeps install and on-site context in the context line', () => {
    expect(estimateContextMemo({
      estimate_number: 'EST-1',
      install_instructions: 'Roof rack first',
      on_site_contact_name: 'Pat', on_site_contact_phone: '555-0100',
    })).toBe('Install: Roof rack first · On-site: Pat 555-0100\nFleetSuite Estimate #EST-1');
  });
});
