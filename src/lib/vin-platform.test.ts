import { describe, it, expect } from 'vitest';
import { resolvePlatform } from './vin-platform';

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

  it('reads Transit roof + wheelbase from VIN positions 5-7', () => {
    const r = resolvePlatform({ make: 'FORD', model: 'Transit' }, '1FTBE2CM5PKA12345'.slice(0, 4) + 'E2C' + '5PKA123456');
    expect(r.roof).toBe('medium');
    expect(r.wheelbase).toBe('148');
    const unknown = resolvePlatform({ make: 'FORD', model: 'Transit' }, '1FTBZZZM5PKA12345');
    expect(unknown.roof).toBeNull(); // unknown body code → ask, never guess
  });

  it('reads Sprinter wheelbase from VIN positions 5-6; roof stays null', () => {
    const r = resolvePlatform({ make: 'MERCEDES-BENZ', model: 'Sprinter' }, 'W1W4E8VY5PT123456'.slice(0, 4) + 'E8' + 'VY5PT123456');
    expect(r.wheelbase).toBe('170');
    expect(r.roof).toBeNull();
  });
});
