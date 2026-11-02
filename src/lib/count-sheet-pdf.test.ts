import { describe, expect, it } from 'vitest';
import { buildCountSheetPdf, countSheetFilename, countSheetRows, type CountSheetData } from './count-sheet-pdf';

// A count's sheet (Books part 69): the items in the count's order with an
// empty Counted box each, and no NetSuite counts or pricing. Made-up data.

const data: CountSheetData = {
  label: 'CNT-0007',
  locationName: "O'Fallon",
  what: 'Items matching “hitch”',
  countDate: '2027-09-15',
  lines: [
    { position: 1, itemNumber: 'HITCH-2', displayName: 'Hitch, 2 in.' },
    { position: 2, itemNumber: 'BALL-2', displayName: 'BALL-2' },
    { position: 3, itemNumber: 'PIN-58', displayName: null },
  ],
};

describe('countSheetRows', () => {
  it("lists each item in the count's order with its name under it, and leaves Counted blank", () => {
    expect(countSheetRows(data.lines)).toEqual([
      ['1', 'HITCH-2\nHitch, 2 in.', ''],
      ['2', 'BALL-2', ''],
      ['3', 'PIN-58', ''],
    ]);
  });
});

describe('buildCountSheetPdf', () => {
  it("renders a letter PDF with the count's items and no counts or prices", () => {
    const out = buildCountSheetPdf(data, { logo: null, printedAt: new Date('2027-09-15T13:00:00Z') }).output();
    expect(out.startsWith('%PDF')).toBe(true);
    expect(out).toContain('STOCK COUNT');
    expect(out).toContain('CNT-0007');
    expect(out).toContain('HITCH-2');
    expect(out).toContain('PIN-58');
    expect(out).toContain('Counted by / Date');
    expect(out).not.toContain('$');
    expect(out).not.toContain('NetSuite count');
    expect(out).not.toContain('counted already');
    // The count's label is in the reference block and in the footer.
    expect(out.split('CNT-0007').length - 1).toBe(2);
    expect(out).not.toContain('Page 1 of');
    expect(buildCountSheetPdf({ ...data, leftOut: 0 }, { logo: null }).output()).not.toContain('counted already');
  });

  it("says how many it leaves out when it's only what's left, and still renders with nothing left", () => {
    expect(buildCountSheetPdf({ ...data, leftOut: 1 }, { logo: null }).output()).toContain("1 item counted already isn't on this sheet.");
    expect(buildCountSheetPdf({ ...data, leftOut: 4 }, { logo: null }).output()).toContain("4 items counted already aren't on this sheet.");
    expect(buildCountSheetPdf({ ...data, lines: [], leftOut: 3 }, { logo: null }).output()).toContain('Nothing left to count on this sheet');
  });

  it('runs onto more pages for a long count, numbering them', () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({ position: i + 1, itemNumber: `PART-${i + 1}`, displayName: `Part ${i + 1}` }));
    const doc = buildCountSheetPdf({ ...data, lines }, { logo: null });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    expect(doc.output()).toContain(`Page 1 of ${doc.getNumberOfPages()}`);
    // A sheet that just runs onto a second page numbers both.
    const two = Array.from({ length: 200 }, (_, n) => n + 1).map((n) => buildCountSheetPdf({ ...data, lines: lines.slice(0, n) }, { logo: null }))
      .find((d) => d.getNumberOfPages() === 2);
    expect(two?.output()).toContain('Page 2 of 2');
  });
});

describe('countSheetFilename', () => {
  it('makes a safe file name', () => {
    expect(countSheetFilename({ label: 'CNT-0007' })).toBe('count-sheet-cnt-0007.pdf');
    expect(countSheetFilename({ label: ' / ' })).toBe('count-sheet-count.pdf');
    expect(countSheetFilename({ label: '' })).toBe('count-sheet-count.pdf');
    expect(countSheetFilename({ label: 'CNT 7!' })).toBe('count-sheet-cnt-7.pdf');
  });
});
