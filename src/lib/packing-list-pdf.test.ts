import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/company-profile', () => ({ fetchCompanyLetterhead: vi.fn(async () => null) }));

import { buildPackingListPdf } from './packing-list-pdf';

describe('buildPackingListPdf', () => {
  it('draws the packing list in the shared form layout with no prices', () => {
    const doc = buildPackingListPdf({
      jobNumber: 'G-2611-014', customer: 'Acme', shipTo: '1 Depot Way\nSt. Charles MO', poNumber: '45120',
      carrier: 'UPS', trackingNumber: '1Z999', lines: [{ partNumber: 'DECAL-DR', description: 'Door decals', quantity: 12 }],
    }, { letterhead: null, now: new Date('2026-11-06T12:00:00Z') });
    const raw = doc.output();
    expect(raw).toContain('Packing List');
    expect(raw).toContain('G-2611-014');
    expect(raw).toContain('DECAL-DR');
    expect(raw).toContain('1Z999');
    expect(raw).toContain('Packed by / Date');
    expect(raw).not.toContain('$');
  });
});
