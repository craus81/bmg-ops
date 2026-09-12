import { describe, it, expect } from 'vitest';
import { determineCatalog, resolveSalesPrice } from './parts-sync';

// The classification heuristic is now shared by the manual full rebuild and
// the hourly incremental cron — pin it so the two paths can't drift. (The
// "06" prefix quirk mis-files the Verizon RFID part under graphics; that's
// known, and the S1/product_line work replaces this heuristic — update these
// expectations deliberately when it does.)
describe('determineCatalog', () => {
  it('files anything with a graphics class under graphics', () => {
    expect(determineCatalog('C4-RA24-3', 'Graphics')).toBe('graphics');
    expect(determineCatalog('C4-RA24-3', 'Fleet Graphics : Decals')).toBe('graphics');
    expect(determineCatalog('C4-RA24-3', 'graphic design')).toBe('graphics');
  });

  it('files 06-prefixed item numbers under graphics (legacy convention)', () => {
    expect(determineCatalog('06N5TR', null)).toBe('graphics');
    expect(determineCatalog('06N179', '')).toBe('graphics');
  });

  it('defaults everything else to upfit', () => {
    expect(determineCatalog('C4-RA24-3', null)).toBe('upfit');
    expect(determineCatalog('C4-RA24-3', 'Upfit Parts')).toBe('upfit');
    expect(determineCatalog('', null)).toBe('upfit');
  });

  it('class beats item-number prefix', () => {
    // A graphics-classed part keeps graphics even without the 06 prefix,
    // and an 06 part with a non-graphics class still lands in graphics
    // (prefix rule fires when the class rule doesn't).
    expect(determineCatalog('ZZ-100', 'Graphics')).toBe('graphics');
    expect(determineCatalog('06N5TR', 'Upfit Parts')).toBe('graphics');
  });
});

// FleetSuite is the pricing authority: when the two systems disagree,
// FleetSuite's price is the current one and a sync run must not overwrite it.
// Shared by the manual full rebuild and the hourly incremental cron, so these
// pin the policy for both.
describe('resolveSalesPrice', () => {
  it('keeps the FleetSuite price when the two disagree', () => {
    expect(resolveSalesPrice(177.5, 160)).toBe(177.5);
    // The reverse of the old policy: a lower NetSuite price no longer wins.
    expect(resolveSalesPrice(160, 177.5)).toBe(160);
  });

  it('never lets a NetSuite item with no price zero out a FleetSuite price', () => {
    // The field bug this fixes: no price-level-1 row in NetSuite resolved to
    // 0, and `pricingMap[id] || 0` wrote that 0 over a good price every hour.
    expect(resolveSalesPrice(177.5, 0)).toBe(177.5);
    expect(resolveSalesPrice(177.5, undefined)).toBe(177.5);
    expect(resolveSalesPrice(177.5, null)).toBe(177.5);
  });

  it("fills from NetSuite when FleetSuite has no price of its own", () => {
    // A brand-new NetSuite item, or one nobody has priced here yet.
    expect(resolveSalesPrice(0, 160)).toBe(160);
    expect(resolveSalesPrice(null, 160)).toBe(160);
    expect(resolveSalesPrice(undefined, 160)).toBe(160);
  });

  it('resolves to 0 when neither system has a price', () => {
    expect(resolveSalesPrice(null, null)).toBe(0);
    expect(resolveSalesPrice(0, 0)).toBe(0);
  });

  it('treats junk and negatives as no price', () => {
    // Values arrive as Postgres numerics / SuiteQL strings — coerce, and
    // never let a nonsense local value shadow a real NetSuite price.
    expect(resolveSalesPrice('177.50', '160')).toBe(177.5);
    expect(resolveSalesPrice('', '160')).toBe(160);
    expect(resolveSalesPrice('abc', '160')).toBe(160);
    expect(resolveSalesPrice(-5, 160)).toBe(160);
  });
});
