import { describe, it, expect } from 'vitest';
import { renderEstimateDocument, renderEstimateBatchDocument, vehicleDescription, estimateContextMemo } from './estimate-document';

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

  it('prints the stock number beside the unit number', () => {
    const html = renderEstimateDocument(
      { ...baseEst, vin: '1FTBW3XM5PKA12345', unit_number: '4417', stock_number: 'F24-0912' },
      []
    );
    expect(html).toContain('Unit 4417 &middot; Stock F24-0912');
  });

  it('prints VIN alone without a dangling separator', () => {
    const html = renderEstimateDocument({ ...baseEst, vin: 'PKA12345' }, []);
    expect(html).toContain('VIN PKA12345');
    expect(html).not.toContain('&middot;');
  });

  it('renders the Vinyl/Graphics section with films and diagram (the #621 surfaces)', () => {
    const html = renderEstimateDocument(baseEst, [], {
      graphics: [{
        quoteNumber: 'WQ-77',
        vehicle: 'Transit 148',
        totalSqft: 214,
        films: [{ name: '3M IJ180cv3', areas: ['Hood', 'Roof'] }],
        diagramUrl: 'https://pub.example.com/vehicle-templates/quote-diagrams/WQ-77.png',
      }],
    });
    expect(html).toContain('Vinyl / Graphics');
    expect(html).toContain('Quote WQ-77');
    expect(html).toContain('3M IJ180cv3');
    expect(html).toContain('Hood, Roof');
    expect(html).toContain('quote-diagrams/WQ-77.png');
  });

  it('omits the Vinyl/Graphics section when no graphics are passed', () => {
    const html = renderEstimateDocument(baseEst, []);
    expect(html).not.toContain('Vinyl / Graphics');
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
// Graphic proofs from linked graphics jobs (graphics_jobs.estimate_attach)
// render into the same legal document — the combined design + price send.
describe('renderEstimateDocument graphic proofs', () => {
  const baseEst = {
    estimate_number: 'EST-2608-TEST',
    customer_name: 'Acme Fleet',
    subtotal: 100,
    grand_total: 100,
  };

  it('renders the Graphic Proofs section with an inline image and a PDF link', () => {
    const html = renderEstimateDocument(baseEst, [], {
      proofs: [{
        jobNumber: '319',
        jobTitle: 'JW Mechanical door logos',
        files: [
          { name: 'door-proof.png', url: 'https://pub.example.com/graphics-proofs/319/door-proof.png', isPdf: false },
          { name: 'layout.pdf', url: 'https://pub.example.com/graphics-proofs/319/layout.pdf', isPdf: true },
        ],
      }],
    });
    expect(html).toContain('Graphic Proofs — For Your Approval');
    expect(html).toContain('Job #319 — JW Mechanical door logos');
    expect(html).toContain('graphics-proofs/319/door-proof.png');
    expect(html).toContain('Open layout.pdf (PDF)');
  });

  it('lists a PDF proof by name when its url is withheld (frozen snapshot)', () => {
    const html = renderEstimateDocument(baseEst, [], {
      proofs: [{
        jobNumber: '319',
        jobTitle: null,
        files: [{ name: 'layout.pdf', url: null, isPdf: true }],
      }],
    });
    expect(html).toContain('Graphic Proof — For Your Approval');
    expect(html).toContain('layout.pdf (PDF proof)');
    expect(html).not.toContain('Open layout.pdf');
  });

  it('omits the section when no proofs are passed', () => {
    const html = renderEstimateDocument(baseEst, []);
    expect(html).not.toContain('Graphic Proof');
  });

  it('escapes proof names and urls', () => {
    const html = renderEstimateDocument(baseEst, [], {
      proofs: [{
        jobNumber: null,
        jobTitle: '<script>x</script>',
        files: [{ name: '<img>.png', url: 'https://pub.example.com/a"b.png', isPdf: false }],
      }],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a&quot;b.png');
  });
});

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

  it('shows photos on a hitch kit\'s parts but not on a rack\'s components', () => {
    const kitLine = (id: string, item: string, kitNumber: string, group: string) => ({
      id, item_number: item, description: `${item} part`, quantity: 1, unit_price: 50, line_total: 50,
      kit_group_id: group, kit_item_number: kitNumber, kit_name: `${kitNumber} kit`, kit_quantity: 1,
      part_image_url: `https://www.curtmfg.com/media/${item}.jpg`,
    });
    const html = renderEstimateDocument(baseEst, [
      kitLine('h1', '13193', 'Hitch kit', '11111111-1111-4111-8111-111111111111'),
      kitLine('r1', 'FEA-0024', 'AR1205-S', '22222222-2222-4222-8222-222222222222'),
    ]);
    expect(html).toContain('src="https://www.curtmfg.com/media/13193.jpg"');
    expect(html).not.toContain('FEA-0024.jpg');
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

  it('carries the stock number into the memo after the unit', () => {
    expect(estimateContextMemo({ estimate_number: 'EST-1', unit_number: '4417', stock_number: ' F24-0912 ' }))
      .toBe('Unit: 4417 · Stock: F24-0912\nFleetSuite Estimate #EST-1');
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

// ── Fleet multi-unit (R6-9, migration 304) ────────────────────────────────
describe('renderEstimateDocument fleet quoting', () => {
  const est = (over = {}) => ({
    estimate_number: 'EST-FLEET', customer_name: 'Acme Fleet',
    subtotal: 48000, grand_total: 64056, labor_total: 0, tax_amount: 0,
    ...over,
  });
  const lines = [{ item_number: 'RACK-1', description: 'Roof rack', quantity: 2, unit_price: 100 }];

  it('renders a single-vehicle estimate exactly as before', () => {
    const html = renderEstimateDocument(est({ subtotal: 200, grand_total: 200 }), lines);
    expect(html).not.toContain('Per vehicle');
    // Bare quantity, no multiplier.
    expect(html).not.toMatch(/2 &times; /);
  });

  it('shows the quantity as per-vehicle × vehicles', () => {
    const html = renderEstimateDocument(est({ vehicle_count: 12 }), lines);
    expect(html).toContain('2 &times; 12');
  });

  it('bills the line at the FLEET amount, so the column adds up to the subtotal', () => {
    // 2 × $100 × 12 = $2,400 — not $200 under a $48,000 subtotal, which is a
    // column a customer can see does not add up.
    const html = renderEstimateDocument(est({ vehicle_count: 12 }), lines);
    expect(html).toContain('$2400.00');
  });

  it('states the per-vehicle figure beside the total', () => {
    const html = renderEstimateDocument(est({ vehicle_count: 12 }), lines);
    expect(html).toContain('Per vehicle (&times; 12)');
    expect(html).toContain('$5338.00');
  });

  it('marks the per-vehicle figure approximate when it does not divide evenly', () => {
    // $100.01 over 3 vehicles is $33.336… — printing a flat $33.34 invites a
    // customer to multiply it back and find a penny missing.
    const html = renderEstimateDocument(est({ vehicle_count: 3, grand_total: 100.01 }), lines);
    expect(html).toContain('&asymp;');
  });

  it('does not mark it approximate when it divides exactly', () => {
    const html = renderEstimateDocument(est({ vehicle_count: 12 }), lines);
    expect(html).not.toContain('&asymp;');
  });
});

describe('Attached section', () => {
  const baseEst = { estimate_number: 'EST-1', customer_name: 'Acme', subtotal: 0, grand_total: 0 };
  it('lists bare names unlinked (the compose preview)', () => {
    const html = renderEstimateDocument(baseEst, [], { attachmentNames: ['Estimate EST-1.pdf', 'Spec sheet.pdf'] });
    expect(html).toContain('Estimate EST-1.pdf &middot; Spec sheet.pdf');
    expect(html).not.toContain('Click a name to download');
  });

  it('links each attachment to its download URL on the real send', () => {
    const html = renderEstimateDocument(baseEst, [], {
      attachmentNames: [
        { name: 'Estimate EST-1.pdf', url: 'https://go.bmgfleet.com/api/approve/estimate/t/download/pdf' },
        { name: 'Rack & bin.pdf', url: 'https://go.bmgfleet.com/api/approve/estimate/t/download/file/f1' },
      ],
    });
    expect(html).toContain('<a href="https://go.bmgfleet.com/api/approve/estimate/t/download/pdf"');
    expect(html).toContain('>Estimate EST-1.pdf</a>');
    expect(html).toContain('>Rack &amp; bin.pdf</a>');
    expect(html).toContain('Click a name to download a full-size copy');
  });
});

// A fleet order in one email (migration 412): titled for the order, every
// vehicle listed with its own estimate and Review link, items shown once.
describe('renderEstimateDocument fleet order', () => {
  const est = { estimate_number: 'EST-1450', customer_name: 'Gateway Plumbing', subtotal: 100, grand_total: 100, unit_number: '101', vin: 'VIN101' };
  const vehicles = [
    { estimateNumber: 'EST-1450', unitNumber: '101', vin: 'VIN101', grandTotal: 100, reviewUrl: 'https://x/approve/estimate/t1', pdfUrl: 'https://x/p1' },
    { estimateNumber: 'EST-1451', unitNumber: '102', vin: null, grandTotal: 100, reviewUrl: 'https://x/approve/estimate/t2', pdfUrl: 'https://x/p2' },
  ];

  it('titles the order, lists each vehicle with its link and the order total', () => {
    const html = renderEstimateDocument(est, [], { fleet: { vehicles } });
    expect(html).toContain('Estimates for 2 vehicles');
    expect(html).toContain('#EST-1450, #EST-1451');
    expect(html).toContain('https://x/approve/estimate/t2');
    expect(html).toContain('Order total (2 vehicles)');
    expect(html).toContain('$200.00');
    expect(html).toContain('Total for each vehicle');
    expect(html).toContain('The items below are for each vehicle');
    // The unit/VIN header line moves into the vehicle table.
    expect(html).not.toContain('Unit 101');
  });

  it('says whose items they are when a vehicle is priced differently', () => {
    const html = renderEstimateDocument(est, [], { fleet: { vehicles: [vehicles[0], { ...vehicles[1], grandTotal: 140 }] } });
    expect(html).toContain("the items below are unit 101's");
  });

  it('a one-vehicle "order" renders as an ordinary estimate', () => {
    const html = renderEstimateDocument(est, [], { fleet: { vehicles: [vehicles[0]] } });
    expect(html).toContain('Estimate #EST-1450');
    expect(html).toContain('Unit 101');
  });
});

// Several of one customer's estimates in one approval email (Craig,
// 2026-10-28): different jobs, so each is a row with its own links and no
// one estimate's items stand in for the rest.
describe('renderEstimateBatchDocument', () => {
  const estimates = [
    { estimateNumber: 'EST-2610-041', title: 'Upfit + decals', vehicle: '2026 Transit 250 · Unit 4417', grandTotal: 6842.1, reviewUrl: 'https://x/approve/estimate/t1', pdfUrl: 'https://x/p1' },
    { estimateNumber: 'EST-2610-045', title: 'Ladder rack', vehicle: null, grandTotal: 4315.55, reviewUrl: 'https://x/approve/estimate/t2', pdfUrl: 'https://x/p2' },
  ];

  it('lists each estimate with its links and the total of all of them', () => {
    const html = renderEstimateBatchDocument(estimates, 'Metro Plumbing', { ctaUrl: 'https://x/approve/fleet/t1', ctaLabel: 'Review & approve all 2' });
    expect(html).toContain('2 estimates for your approval');
    expect(html).toContain('#EST-2610-041, #EST-2610-045');
    expect(html).toContain('Prepared for Metro Plumbing');
    expect(html).toContain('https://x/approve/estimate/t2');
    expect(html).toContain('https://x/p1');
    expect(html).toContain('Total (2 estimates)');
    expect(html).toContain('$11157.65');
    expect(html).toContain('Review &amp; approve all 2');
    expect(html).not.toContain('vehicles');
  });

  it('escapes what staff typed', () => {
    const html = renderEstimateBatchDocument([{ ...estimates[0], title: '<b>x</b>' }], null);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
