import { describe, it, expect } from 'vitest';
import { normalizeVinRead, vinCheckDigitOk, matchVinRead } from './vin-plate';

// Real-format VINs with valid check digits.
const FORD = '1FTBR1C82MKA12345'; // check digit computed below
const valid = (base: string) => {
  // brute-force the check digit so fixtures stay valid
  for (const c of '0123456789X') {
    const v = base.slice(0, 8) + c + base.slice(9);
    if (vinCheckDigitOk(v)) return v;
  }
  throw new Error('no check digit');
};

describe('vinCheckDigitOk', () => {
  it('accepts a known-good VIN and rejects a one-character misread', () => {
    expect(vinCheckDigitOk('1M8GDM9AXKP042788')).toBe(true); // textbook example
    expect(vinCheckDigitOk('1M8GDM9AXKP042789')).toBe(false);
  });
  it('rejects letters a VIN never has and wrong lengths', () => {
    expect(vinCheckDigitOk('1M8GDM9AXKP04278O')).toBe(false);
    expect(vinCheckDigitOk('1M8GDM9AXKP04278')).toBe(false);
  });
});

describe('normalizeVinRead', () => {
  it('strips separators and maps I/O/Q to digits', () => {
    expect(normalizeVinRead(' 1m8-gdm9 axkp O427 88 ')).toBe('1M8GDM9AXKP042788');
    expect(normalizeVinRead('IQ')).toBe('10');
    expect(normalizeVinRead(null)).toBe('');
  });
});

describe('matchVinRead', () => {
  const a = valid(FORD);
  const b = valid('1FTBR1C82MKA99999');
  const lot = [a, b, '3C6TRVDG5LE123456'];

  it('returns an exact read', () => {
    expect(matchVinRead([a.toLowerCase()], lot)).toEqual({ vin: a, kind: 'exact', differences: 0 });
  });

  it('corrects a one-character misread to the only close vehicle on the lot', () => {
    const misread = a.slice(0, 12) + (a[12] === '8' ? 'B' : '8') + a.slice(13);
    expect(matchVinRead([misread], lot)).toEqual({ vin: a, kind: 'close', differences: 1 });
  });

  it('matches on the last 8 when only part of the plate was readable', () => {
    expect(matchVinRead(['LE123456'], lot)?.vin).toBe('3C6TRVDG5LE123456');
  });

  it('refuses to guess between two near-misses', () => {
    const twins = [valid('1FTBR1C82MKA12340'), valid('1FTBR1C82MKA12341')];
    expect(matchVinRead(['1FTBR1C80MKA12349'], twins)).toBeNull();
  });

  it('returns null for a vehicle not on the lot', () => {
    expect(matchVinRead(['2GCEK19T441234567'], lot)).toBeNull();
  });
});
