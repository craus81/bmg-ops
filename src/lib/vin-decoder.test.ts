import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeVIN, isValidVIN } from './vin-decoder';

describe('isValidVIN', () => {
  it('accepts a well-formed 17-character VIN', () => {
    expect(isValidVIN('1FTBW3XM5PKA12345')).toBe(true);
  });

  it('accepts lowercase', () => {
    expect(isValidVIN('1ftbw3xm5pka12345')).toBe(true);
  });

  it('rejects wrong lengths', () => {
    expect(isValidVIN('1FTBW3XM5PKA1234')).toBe(false);
    expect(isValidVIN('1FTBW3XM5PKA123456')).toBe(false);
    expect(isValidVIN('')).toBe(false);
  });

  it('rejects the illegal VIN letters I, O, and Q', () => {
    expect(isValidVIN('IFTBW3XM5PKA12345')).toBe(false);
    expect(isValidVIN('1FTBW3XM5PKO12345')).toBe(false);
    expect(isValidVIN('1FTBW3XM5PKQ12345')).toBe(false);
  });
});

describe('decodeVIN — NHTSA API path', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the NHTSA response fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        Results: [{
          ModelYear: '2023', Make: 'FORD', Model: 'Transit', Trim: 'Base',
          BodyClass: 'Van', DriveType: 'RWD', FuelTypePrimary: 'Gasoline',
          Doors: '4', GVWR: 'Class 2E',
        }],
      }), { status: 200 })
    ));

    expect(await decodeVIN('1FTBW3XM5PKA12345')).toEqual({
      year: '2023', make: 'FORD', model: 'Transit', trim: 'Base',
      bodyClass: 'Van', driveType: 'RWD', fuelType: 'Gasoline',
      doors: '4', gvwr: 'Class 2E',
    });
  });
});

describe('decodeVIN — offline fallback (network unavailable)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('decodes a Ford Transit cargo van', async () => {
    const result = await decodeVIN('1FTBW3XM5PKA12345');
    expect(result.make).toBe('Ford');
    expect(result.model).toBe('Transit');
    expect(result.bodyClass).toBe('Van');
    expect(result.year).toBe('2023'); // position 10 = P
  });

  it('decodes a Ford F-150', async () => {
    const result = await decodeVIN('1FTFW1E58PFA00001');
    expect(result.make).toBe('Ford');
    expect(result.model).toBe('F-150');
    expect(result.bodyClass).toBe('Pickup');
  });

  it('decodes a Mercedes Sprinter', async () => {
    const result = await decodeVIN('WD4PF1CD5KP123456');
    expect(result.make).toBe('Mercedes-Benz');
    expect(result.model).toBe('Sprinter');
    expect(result.bodyClass).toBe('Van');
    expect(result.year).toBe('2019'); // position 10 = K
  });

  it('decodes model-year letters and digits from position 10', async () => {
    expect((await decodeVIN('1FTBW3XM5RKA12345')).year).toBe('2024'); // R
    expect((await decodeVIN('1FTBW3XM55KA12345')).year).toBe('2005'); // 5
  });

  it('recognizes a RAM ProMaster only when position 4 is "6"', async () => {
    // Real ProMaster VINs start 3C6T…, which this decoder maps to the
    // generic "RAM" model — characterized here as current behavior.
    const promasterReal = await decodeVIN('3C6TRVDG5PE123456');
    expect(promasterReal.make).toBe('RAM');
    expect(promasterReal.model).toBe('RAM');

    const promasterMatched = await decodeVIN('3C66RVDG5PE123456');
    expect(promasterMatched.model).toBe('ProMaster');
    expect(promasterMatched.bodyClass).toBe('Van');
  });

  it('falls back to the 2-character WMI map, then Unknown', async () => {
    expect((await decodeVIN('1GBZGUC34PJ123456')).make).toBe('GM');
    expect((await decodeVIN('ZZZZZZZZZPZ123456')).make).toBe('Unknown');
  });
});
