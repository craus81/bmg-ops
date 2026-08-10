import { describe, it, expect } from 'vitest';
import { determineCatalog } from './parts-sync';

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
