import { describe, it, expect } from 'vitest';
import { detectFitment } from './vehicle-fitment';

const keys = (t: string) => detectFitment(t).map(h => h.platformKey);

describe('detectFitment (ordering traps + qualifiers)', () => {
  it('Transit Connect never tags as Transit; E-Transit folds into Transit', () => {
    expect(keys('Shelving unit for Transit Connect LWB')).toEqual(['transit-connect']);
    expect(keys('Partition, Ford Transit 148" high roof')).toEqual(['transit']);
    expect(keys('E-Transit floor kit')).toEqual(['transit']);
  });

  it('ProMaster City never tags as ProMaster; City Express never as Express/Savana', () => {
    expect(keys('Drawer unit Pro Master City')).toEqual(['promaster-city']);
    expect(keys('ProMaster 159" HR ladder rack')).toEqual(['promaster']);
    expect(keys('City Express shelving package')).toEqual(['city-express']);
    expect(keys('Chevy Express / GMC Savana partition')).toEqual(['express-savana']);
  });

  it('bare RAM never tags a truck; RAM 1500/2500 do; Silverado HD splits from 1500', () => {
    expect(keys('Cargo ram bracket for Sprinter')).toEqual(['sprinter']);
    expect(keys('RAM 1500 Trazer rack')).toEqual(['ram-1500']);
    expect(keys('Ram 2500 bed rail kit')).toEqual(['ram-hd']);
    expect(keys('Silverado 2500 HD toolbox')).toEqual(['silverado-sierra-hd']);
    expect(keys('Sierra 1500 short bed rack')).toEqual(['silverado-sierra-1500']);
  });

  it('F-250/350 tag Super Duty, not F-150', () => {
    expect(keys('F-250 headache rack')).toEqual(['super-duty']);
    expect(keys('F150 5.5ft bed Trazer')).toEqual(['f-150']);
  });

  it('extracts wheelbase and roof qualifiers when present', () => {
    const [hit] = detectFitment('N4 Shelving, Transit 148" High Roof');
    expect(hit.platformKey).toBe('transit');
    expect(hit.wheelbase).toBe('148');
    expect(hit.roof).toBe('high');
    const [el] = detectFitment('Transit 148 EL HR partition');
    expect(el.wheelbase).toBe('148 EL');
    expect(el.roof).toBe('high');
    const [none] = detectFitment('Sprinter shelf unit');
    expect(none.wheelbase).toBeNull();
    expect(none.roof).toBeNull();
  });

  it('returns nothing for vehicle-free text', () => {
    expect(detectFitment('Aluminum shelf divider 12in')).toEqual([]);
    expect(detectFitment(null)).toEqual([]);
  });
});
