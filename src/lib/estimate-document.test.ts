import { describe, it, expect } from 'vitest';
import { renderEstimateDocument, vehicleDescription } from './estimate-document';

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
});
