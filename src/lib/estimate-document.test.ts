import { describe, it, expect } from 'vitest';
import { renderEstimateDocument } from './estimate-document';

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
});
