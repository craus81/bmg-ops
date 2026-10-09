import { describe, expect, it } from 'vitest';
import { jobOrderLinesFromRows, stripStatusPrefix, type JobOrderData } from './job-order';
import { buildJobOrderPdf, jobOrderFilename } from './job-order-pdf';

describe('jobOrderLinesFromRows', () => {
  it('flips sales quantities positive and keeps description-only lines', () => {
    const lines = jobOrderLinesFromRows([
      { part_number: '06U357', description: 'Masterack shelf', quantity: '-2', item_type: 'InvtPart' },
      { part_number: 'NOTE', description: 'Install per drawing', quantity: null, item_type: 'Description' },
      { part_number: 'LABOR', display_name: 'Upfit labor', quantity: '-3.5', item_type: 'Service' },
    ]);
    expect(lines).toEqual([
      { partNumber: '06U357', description: 'Masterack shelf', quantity: 2 },
      { partNumber: 'NOTE', description: 'Install per drawing', quantity: null },
      { partNumber: 'LABOR', description: 'Upfit labor', quantity: 3.5 },
    ]);
  });

  it('drops money-only and empty lines', () => {
    const lines = jobOrderLinesFromRows([
      { part_number: 'Subtotal', quantity: null, item_type: 'Subtotal' },
      { part_number: 'DISC10', description: '10% off', quantity: null, item_type: 'Discount' },
      { part_number: '', description: '', quantity: '-1', item_type: 'InvtPart' },
      { part_number: 'ZERO', description: 'zero qty', quantity: '0', item_type: 'InvtPart' },
    ]);
    expect(lines).toEqual([]);
  });
});

describe('stripStatusPrefix', () => {
  it('removes the record-type prefix', () => {
    expect(stripStatusPrefix('Sales Order : Pending Fulfillment')).toBe('Pending Fulfillment');
    expect(stripStatusPrefix(null)).toBeNull();
  });
});

describe('buildJobOrderPdf', () => {
  const data: JobOrderData = {
    id: '123', soNumber: 'SO1060', orderDate: '10/9/2026', customer: 'Acme Fleet',
    poNumber: 'PO-77', vin: '1FTBR1C82PKA12345', memo: 'Rush', status: 'Pending Fulfillment',
    salesRep: 'Jane Rep', shipDate: null, shipMethod: null, shipTo: '1 Main St\nO\'Fallon MO',
    lines: [{ partNumber: '06U357', description: 'Masterack shelf', quantity: 2 }],
  };

  it('is titled Job Order and carries no prices', () => {
    const doc = buildJobOrderPdf(data, { logo: null, printedAt: new Date('2026-10-09T12:00:00Z') });
    const raw = doc.output();
    expect(raw).toContain('JOB ORDER');
    expect(raw).toContain('SO1060');
    expect(raw).toContain('06U357');
    expect(raw).not.toContain('$');
    expect(raw).not.toMatch(/Rate|Amount|Total/);
  });

  it('names the file after the SO', () => {
    expect(jobOrderFilename({ soNumber: 'SO 1060' })).toBe('job-order-so-1060.pdf');
  });
});
