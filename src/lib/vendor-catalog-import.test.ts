import { describe, it, expect } from 'vitest';
import { extractDimensions } from './vendor-catalog-import';

const ldPage = (product: Record<string, unknown>) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Shelf', ...product })}</script></head><body></body></html>`;

describe('extractDimensions', () => {
  it('reads JSON-LD QuantitativeValue dimensions in inches', () => {
    const html = ldPage({
      width: { '@type': 'QuantitativeValue', value: 52, unitCode: 'INH' },
      depth: { '@type': 'QuantitativeValue', value: 14, unitCode: 'INH' },
      height: { '@type': 'QuantitativeValue', value: 46, unitCode: 'INH' },
      weight: { '@type': 'QuantitativeValue', value: 78, unitCode: 'LBR' },
    });
    expect(extractDimensions(html)).toEqual({ widthIn: 52, depthIn: 14, heightIn: 46, weightLb: 78 });
  });

  it('converts metric JSON-LD values to inches and pounds', () => {
    const html = ldPage({
      width: { value: 132.08, unitCode: 'CMT' },
      depth: '355.6 mm',
      height: { value: 1.1684, unitText: 'M' },
      weight: { value: 35.4, unitCode: 'KGM' },
    });
    const d = extractDimensions(html)!;
    expect(d.widthIn).toBeCloseTo(52, 1);
    expect(d.depthIn).toBeCloseTo(14, 1);
    expect(d.heightIn).toBeCloseTo(46, 1);
    expect(d.weightLb).toBeCloseTo(78, 0);
  });

  it('reads additionalProperty PropertyValue rows', () => {
    const html = ldPage({
      additionalProperty: [
        { '@type': 'PropertyValue', name: 'Overall Width', value: '52 in' },
        { '@type': 'PropertyValue', name: 'Depth', value: 14 },
        { '@type': 'PropertyValue', name: 'Height', value: { value: 46, unitCode: 'INH' } },
        { '@type': 'PropertyValue', name: 'Weight', value: '78 lb' },
      ],
    });
    expect(extractDimensions(html)).toEqual({ widthIn: 52, depthIn: 14, heightIn: 46, weightLb: 78 });
  });

  it("parses Ranger-style compact prose: 52\"W x 14\"D x 46\"H", () => {
    const html = '<html><body><p>Aluminum shelving unit, 52"W x 14"D x 46"H, ships assembled.</p></body></html>';
    expect(extractDimensions(html)).toEqual({ widthIn: 52, depthIn: 14, heightIn: 46 });
  });

  it('parses compact prose in any order, with unicode marks and spelled letters', () => {
    const html = '<html><body>Dimensions: 46″Height × 52″Width × 14″Depth. Weight: 78 lbs.</body></html>';
    expect(extractDimensions(html)).toEqual({ widthIn: 52, depthIn: 14, heightIn: 46, weightLb: 78 });
  });

  it('parses labeled prose with units, converting cm', () => {
    const html = '<html><body><ul><li>Width: 132.08 cm</li><li>Depth: 35.56 cm</li><li>Height: 116.84 cm</li><li>Weight: 35.4 kg</li></ul></body></html>';
    const d = extractDimensions(html)!;
    expect(d.widthIn).toBeCloseTo(52, 1);
    expect(d.depthIn).toBeCloseTo(14, 1);
    expect(d.heightIn).toBeCloseTo(46, 1);
    expect(d.weightLb).toBeCloseTo(78, 0);
  });

  it('prefers JSON-LD over conflicting prose, merging missing fields from prose', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'Product', name: 'Shelf', width: { value: 52, unitCode: 'INH' },
    })}</script></head><body>Overall: 99"W x 14"D x 46"H</body></html>`;
    expect(extractDimensions(html)).toEqual({ widthIn: 52, depthIn: 14, heightIn: 46 });
  });

  it('drops insane values instead of trusting them', () => {
    const html = '<html><body>Established 2024. Width: 2024 in. Depth: 0.1". Height: 46"H shelf.</body></html>';
    // 2024 and 0.1 fail the sanity band; only the 46"H token survives.
    expect(extractDimensions(html)).toEqual({ heightIn: 46 });
  });

  it('ignores dimensions hiding inside script blobs', () => {
    const html = '<html><body><script>var cfg = {w: "52 in W", d: "14 in D", h: "46 in H"};</script><p>No specs listed.</p></body></html>';
    expect(extractDimensions(html)).toBeNull();
  });

  it('does not misread prose words as dimension letters', () => {
    const html = '<html><body>Model 52 White, 12 Warranty options, item 46 Heavy-duty.</body></html>';
    expect(extractDimensions(html)).toBeNull();
  });

  it('returns null for a page with nothing usable', () => {
    expect(extractDimensions('<html><body><h1>Van Shelving</h1><p>Call for specs.</p></body></html>')).toBeNull();
  });
});
