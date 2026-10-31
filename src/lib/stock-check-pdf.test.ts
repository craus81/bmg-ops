import { describe, expect, it } from 'vitest';
import { buildStockCheckPdf, stockCheckFilename, stockCheckRows, type StockCheckData } from './stock-check-pdf';

const data: StockCheckData = {
  estimateNumber: 'EST-2041', customer: 'Acme Plumbing', vehicle: '2026 Ford Transit 250',
  vin: '1FTBR1C82PKA12345', soNumber: 'SO #1186', accepted: true,
  lines: [
    { itemNumber: 'ACC-8000', description: 'Ratchet strap', needed: 2, onHand: 1, available: 1, onOrder: 0, requesting: 1, short: true, uncatalogued: false },
    { itemNumber: '13193', description: 'Curt hitch', needed: 1, onHand: 3, available: 2, onOrder: 2, requesting: 0, short: false, uncatalogued: false },
    { itemNumber: 'CUSTOM-1', description: null, needed: 1.5, onOrder: 0, requesting: 1.5, short: false, uncatalogued: true },
  ],
};

describe('stockCheckRows', () => {
  it('shows counts, flags short and uncatalogued parts, and leaves Counted/OK blank', () => {
    expect(stockCheckRows(data.lines)).toEqual([
      ['ACC-8000  SHORT\nRatchet strap', '2', '1', '1', '0', '1', '', ''],
      ['13193\nCurt hitch', '1', '3', '2', '2', '—', '', ''],
      ['CUSTOM-1  (not in catalog)', '1.5', '—', '—', '0', '1.5', '', ''],
    ]);
  });
});

describe('buildStockCheckPdf', () => {
  it('renders a letter PDF with the parts and no prices', () => {
    const doc = buildStockCheckPdf(data, { logo: null, printedAt: new Date('2026-10-26T20:00:00Z') });
    const out = doc.output();
    expect(out.startsWith('%PDF')).toBe(true);
    expect(out).toContain('PARTS STOCK CHECK');
    expect(out).toContain('ACC-8000');
    expect(out).toContain('Counted');
    expect(out).not.toContain('$');
  });

  it('still renders with no parts', () => {
    const out = buildStockCheckPdf({ ...data, lines: [] }, { logo: null }).output();
    expect(out).toContain('No parts on this estimate');
  });
});

describe('stockCheckFilename', () => {
  it('makes a safe file name', () => {
    expect(stockCheckFilename({ estimateNumber: 'EST-2041 / 77' })).toBe('stock-check-est-2041-77.pdf');
    expect(stockCheckFilename({ estimateNumber: '' })).toBe('stock-check-estimate.pdf');
  });
});
