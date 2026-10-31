import { describe, it, expect } from 'vitest';
import { recipientsOf, attachmentNames, docRefsForText } from './sent-mail-scan';

describe('sent mail scan helpers', () => {
  it('reads every To and Cc address', () => {
    expect(recipientsOf('"AP" <AP@Hosemate.com>, buyer@hosemate.com', 'Jessie <jessie@bmgfleet.com>'))
      .toEqual(['ap@hosemate.com', 'buyer@hosemate.com', 'jessie@bmgfleet.com']);
    expect(recipientsOf('', '')).toEqual([]);
  });

  it('collects nested attachment names', () => {
    const msg = { payload: { parts: [{ filename: '', parts: [{ filename: 'INV1512.pdf' }] }, { filename: 'SO1177.pdf' }] } };
    expect(attachmentNames(msg)).toEqual(['INV1512.pdf', 'SO1177.pdf']);
  });

  it('turns numbers into refs, keeping only known estimates and our own vendor POs', () => {
    const lookups = { estimates: new Map([['EST-2610-076', 'est-1']]), vendorPos: new Set(['PO2231']) };
    const refs = docRefsForText('EST-2610-076 Invoice-PF-2610-076.pdf EST-2610-999 INV1512 SO1177 PO2231 PO9999', lookups);
    expect(refs).toEqual(['estimate:est-1', 'pro_forma:est-1', 'invoice:INV1512', 'sales_order:SO1177', 'vendor_po:PO2231']);
  });
});
