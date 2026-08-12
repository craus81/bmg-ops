import { describe, it, expect } from 'vitest';
import { resolvePlatform, matchQualifiersToConfig } from './vin-platform';

describe('resolvePlatform', () => {
  it('maps models to platforms with make disambiguation', () => {
    expect(resolvePlatform({ make: 'FORD', model: 'Transit Connect' }).platformKey).toBe('transit-connect');
    expect(resolvePlatform({ make: 'FORD', model: 'Transit' }).platformKey).toBe('transit');
    expect(resolvePlatform({ make: 'RAM', model: 'ProMaster City' }).platformKey).toBe('promaster-city');
    expect(resolvePlatform({ make: 'RAM', model: '2500' }).platformKey).toBe('ram-hd');
    expect(resolvePlatform({ make: 'CHEVROLET', model: 'Silverado 1500' }).platformKey).toBe('silverado-sierra-1500');
    expect(resolvePlatform({ make: 'GMC', model: 'Sierra 3500HD' }).platformKey).toBe('silverado-sierra-hd');
    expect(resolvePlatform({ make: 'TOYOTA', model: 'Tacoma' }).platformKey).toBe('tacoma');
    expect(resolvePlatform({ make: 'HONDA', model: 'Civic' }).platformKey).toBeNull();
  });

  it('reads Transit roof + wheelbase from the VIN body code (positions 5-7, MY2024 and older)', () => {
    // R1C = van, medium roof, 130" WB — confirmed against a real 2023 listing
    const r1c = resolvePlatform({ make: 'FORD', model: 'Transit', year: '2023' }, '1FTBR1C89PKB74203');
    expect(r1c.roof).toBe('medium');
    expect(r1c.wheelbase).toBe('130');
    // R2X = van, high roof, 148"
    const r2x = resolvePlatform({ make: 'FORD', model: 'Transit', year: '2023' }, '1FTBR2X84PKA30462');
    expect(r2x.roof).toBe('high');
    expect(r2x.wheelbase).toBe('148');
    // R3X = van, high roof, 148" EL
    expect(resolvePlatform({ make: 'FORD', model: 'Transit', year: '2023' }, '1FTBR3X84PKA30462').wheelbase).toBe('148 EL');
    // R1Y = van, low roof, 130"
    expect(resolvePlatform({ make: 'FORD', model: 'Transit', year: '2023' }, '1FTYR1Y84PKA30462').roof).toBe('low');
    // No decoded year → the gate falls back to VIN position 10 (R = 2024)
    expect(resolvePlatform({ make: 'FORD', model: 'Transit' }, '1FTBR1C89RKB58750').roof).toBe('medium');
    // Unknown body code → ask, never guess
    const unknown = resolvePlatform({ make: 'FORD', model: 'Transit', year: '2023' }, '1FTBZZZM5PKA12345');
    expect(unknown.roof).toBeNull();
    expect(unknown.wheelbase).toBeNull();
  });

  it('refuses to apply the legacy Transit body table to MY2025+ VINs', () => {
    // Ford revised the body codes for MY2025 — a 2026 R1C is NOT a
    // medium/130 (that combo died with MY2023). Craig's real 2026 VIN.
    const my2026 = resolvePlatform({ make: 'FORD', model: 'Transit', year: '2026' }, '1FTBR1C82TKA17431');
    expect(my2026.platformKey).toBe('transit');
    expect(my2026.roof).toBeNull();
    expect(my2026.wheelbase).toBeNull();
    // Same gate from VIN position 10 alone (T = 2026) when no year decoded
    const noYear = resolvePlatform({ make: 'FORD', model: 'Transit' }, '1FTBR1C82TKA17431');
    expect(noYear.roof).toBeNull();
    expect(noYear.wheelbase).toBeNull();
  });

  it('reads Sprinter wheelbase from VIN positions 5-6; roof stays null', () => {
    const r = resolvePlatform({ make: 'MERCEDES-BENZ', model: 'Sprinter' }, 'W1W4E8VY5PT123456'.slice(0, 4) + 'E8' + 'VY5PT123456');
    expect(r.wheelbase).toBe('170');
    expect(r.roof).toBeNull();
  });
});

describe('matchQualifiersToConfig', () => {
  const truckConfig = { cabs: ['Regular', 'SuperCab', 'SuperCrew'], beds: ['5.5', '6.5', '8'] };

  it('matches wheelbase inches to a unique configured label', () => {
    expect(matchQualifiersToConfig({ wheelBaseIn: '117.9' }, { wheelbases: ['118', '136', '159', '159 EXT'] }).wheelbase).toBe('118');
    // 159 vs 159 EXT share the wheelbase → ambiguous, stays null
    expect(matchQualifiersToConfig({ wheelBaseIn: '159.2' }, { wheelbases: ['118', '136', '159', '159 EXT'] }).wheelbase).toBeNull();
    // Way off any option → null
    expect(matchQualifiersToConfig({ wheelBaseIn: '200' }, { wheelbases: ['118', '136'] }).wheelbase).toBeNull();
  });

  it('matches bed length inches to feet labels', () => {
    expect(matchQualifiersToConfig({ bedLengthIn: '78.9' }, truckConfig).bed).toBe('6.5');
    expect(matchQualifiersToConfig({ bedLengthIn: '97.6' }, truckConfig).bed).toBe('8');
  });

  it('maps vPIC cab families to configured cab labels, refusing ambiguity', () => {
    expect(matchQualifiersToConfig({ cabType: 'Crew/ Super Crew/ Crew Max' }, truckConfig).cab).toBe('SuperCrew');
    expect(matchQualifiersToConfig({ cabType: 'Extra/Super/Quad/Double/King/Extended' }, truckConfig).cab).toBe('SuperCab');
    expect(matchQualifiersToConfig({ cabType: 'Regular' }, truckConfig).cab).toBe('Regular');
    // Ram HD: Crew and Mega are both vPIC crew-family → ambiguous
    expect(matchQualifiersToConfig({ cabType: 'Crew/ Super Crew/ Crew Max' }, { cabs: ['Regular', 'Crew', 'Mega'] }).cab).toBeNull();
    // Tacoma: XtraCab and Double are both vPIC extended-family → ambiguous
    expect(matchQualifiersToConfig({ cabType: 'Extra/Super/Quad/Double/King/Extended' }, { cabs: ['XtraCab', 'Double'] }).cab).toBeNull();
  });

  it('returns all-null on missing config or decode fields', () => {
    expect(matchQualifiersToConfig({}, truckConfig)).toEqual({ wheelbase: null, cab: null, bed: null });
    expect(matchQualifiersToConfig({ wheelBaseIn: '148' }, null)).toEqual({ wheelbase: null, cab: null, bed: null });
  });
});
