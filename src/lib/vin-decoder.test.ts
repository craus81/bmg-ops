import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeVIN, decodeVinDetails, isValidVIN, windowStickerUrl } from './vin-decoder';

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
          Doors: '4', GVWR: 'Class 2E', Series: 'Transit-250',
          WheelBaseShort: '147.8', BedLengthIN: '', BodyCabType: '',
        }],
      }), { status: 200 })
    ));

    expect(await decodeVIN('1FTBW3XM5PKA12345')).toEqual({
      year: '2023', make: 'FORD', model: 'Transit', trim: 'Base',
      bodyClass: 'Van', driveType: 'RWD', fuelType: 'Gasoline',
      doors: '4', gvwr: 'Class 2E', series: 'Transit-250',
      wheelBaseIn: '147.8', bedLengthIn: '', cabType: '',
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

describe('decodeVinDetails — VIN lookup window', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (r: Record<string, string>) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ Results: [r] }) }));
  const row = (d: Awaited<ReturnType<typeof decodeVinDetails>>, label: string) =>
    d.groups.flatMap(g => g.rows).find(x => x.label === label)?.value;

  it('formats bed length, wheelbase and engine for display', async () => {
    stub({
      ModelYear: '2024', Make: 'FORD', Model: 'F-150', Trim: 'XLT', ErrorCode: '0',
      BedLengthIN: '78.9', WheelBaseShort: '157.2', BodyCabType: 'Crew/ Super Crew/ Crew Max',
      DisplacementL: '3.5', EngineConfiguration: 'V-Shaped', EngineCylinders: '6', EngineModel: 'EcoBoost',
      DriveType: '4WD/4-Wheel Drive/4x4', GVWR: 'Class 2E: 6,001 - 7,000 lb', Doors: 'Not Applicable',
    });
    const d = await decodeVinDetails('1FTFW1E80RFA00000');
    expect(d.title).toBe('2024 FORD F-150 XLT');
    expect(row(d, 'Bed length')).toBe('78.9" (6.6 ft)');
    expect(row(d, 'Wheelbase')).toBe('157.2" (13.1 ft)');
    expect(row(d, 'Engine')).toBe('3.5L V6 EcoBoost');
    expect(row(d, 'Doors')).toBe('');
    expect(d.warning).toBe('');
  });

  it('passes on NHTSA\'s warning without its code numbers', async () => {
    stub({ ModelYear: '2020', Make: 'RAM', Model: '2500', ErrorCode: '1', ErrorText: '1 - Check Digit (9th position) does not calculate properly' });
    const d = await decodeVinDetails('3C6UR5DL0LG000000');
    expect(d.warning).toBe('Check Digit (9th position) does not calculate properly');
  });

  it('returns an empty title when NHTSA knows nothing', async () => {
    stub({ ErrorCode: '8', ErrorText: '8 - No detailed data available currently' });
    expect((await decodeVinDetails('ZZZZZZZZZZZZZZZZZ')).title).toBe('');
  });
});

describe('windowStickerUrl', () => {
  it('links Ford, GM and Stellantis makes and nothing else', () => {
    expect(windowStickerUrl('FORD', 'V')).toContain('forddirect');
    expect(windowStickerUrl('GMC', 'V')).toContain('gm.com');
    expect(windowStickerUrl('RAM', 'V')).toContain('chrysler.com');
    expect(windowStickerUrl('MERCEDES-BENZ', 'V')).toBeNull();
  });
});
