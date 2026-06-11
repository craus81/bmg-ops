import { describe, it, expect } from 'vitest';
import { parsePOFromItems, type TItem } from './parsePO-core';

// Synthetic positional text emulating the Masterack PO layout (PDF
// coordinates: higher y = nearer the top of the page).
function t(str: string, x: number, y: number): TItem {
  return { str, x, y, w: str.length * 5 };
}

const header: TItem[] = [
  t('PURCHASE ORDER NUMBER', 300, 750), t('4500123456', 480, 750),
  t('Ordered Date: 01/15/26', 50, 720),
  t('REQUESTED DELIVERY DATE', 400, 700),
  t('02/01/26', 420, 690),
];

// Row 1: shelf unit with a supplier-part continuation line
const row1: TItem[] = [
  t('1.000', 20, 600), t('MA021234', 60, 600), t('SHELF UNIT', 140, 600),
  t('48IN', 200, 600), t('4', 300, 600), t('EA', 330, 600),
  t('125.50', 360, 600), t('Y', 420, 600), t('02/01/26', 460, 600),
];
const row1cont: TItem[] = [
  t('WB1234', 60, 588), t('WIRE BASKET', 140, 588),
];

// Row 2: simple bracket line, no continuation
const row2: TItem[] = [
  t('2.000', 20, 560), t('BR5678', 60, 560), t('BRACKET', 140, 560),
  t('10', 300, 560), t('EA', 330, 560), t('8.25', 360, 560),
  t('N', 420, 560), t('01/20/26', 460, 560),
];

describe('parsePOFromItems', () => {
  const result = parsePOFromItems([...header, ...row1, ...row1cont, ...row2]);

  it('extracts the PO header fields', () => {
    expect(result.po_number).toBe('4500123456');
    expect(result.ordered_date).toBe('01/15/26');
    expect(result.customer).toBe('Masterack');
  });

  it('finds the requested delivery date on the line below its label', () => {
    expect(result.requested_delivery_date).toBe('02/01/26');
  });

  it('parses both line items with quantity × price math', () => {
    expect(result.lines).toHaveLength(2);

    expect(result.lines[0]).toEqual({
      line_no: '1.000',
      part_number: 'MA021234',
      supplier_part: 'WB1234',
      description: 'SHELF UNIT 48IN WIRE BASKET',
      quantity: 4,
      unit_price: 125.5,
      extended_price: 502,
      delivery_date: '02/01/26',
    });

    expect(result.lines[1]).toEqual({
      line_no: '2.000',
      part_number: 'BR5678',
      supplier_part: '',
      description: 'BRACKET',
      quantity: 10,
      unit_price: 8.25,
      extended_price: 82.5,
      delivery_date: '01/20/26',
    });
  });

  it('groups items within a 5pt vertical tolerance onto one row', () => {
    const jittered = row2.map((item) => ({ ...item, y: item.y + (item.x % 4) - 2 }));
    const r = parsePOFromItems([...header, ...jittered]);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].part_number).toBe('BR5678');
    expect(r.lines[0].quantity).toBe(10);
  });

  it('falls back to the earliest per-line delivery date when the header label is missing', () => {
    const noHeaderDate = header.filter((i) => !/REQUESTED|02\/01/.test(i.str));
    const r = parsePOFromItems([...noHeaderDate, ...row1, ...row1cont, ...row2]);
    // 01/20/26 (row 2) is earlier than 02/01/26 (row 1)
    expect(r.requested_delivery_date).toBe('01/20/26');
  });

  it('returns empty fields for an unrecognized document', () => {
    const r = parsePOFromItems([t('INVOICE', 10, 700), t('something else', 10, 650)]);
    expect(r.po_number).toBe('');
    expect(r.ordered_date).toBe('');
    expect(r.lines).toHaveLength(0);
  });

  it('skips rows whose part number cannot be identified', () => {
    // A line-number row with no alphanumeric part token
    const r = parsePOFromItems([
      t('3.000', 20, 500), t('—', 60, 500), t('2', 300, 500), t('EA', 330, 500), t('5.00', 360, 500),
    ]);
    expect(r.lines).toHaveLength(0);
  });
});
