import { describe, it, expect } from 'vitest';
import { cleanImei, formatImei, luhnOk } from './camera-install';

describe('camera install IMEIs', () => {
  it('accepts a 15-digit Luhn-valid IMEI, stripping label text', () => {
    expect(cleanImei('490154203237518')).toBe('490154203237518');
    expect(cleanImei('IMEI: 49-015420-323751-8')).toBe('490154203237518');
  });

  it('rejects a misread digit, the wrong length, or a serial', () => {
    expect(cleanImei('490154203237519')).toBeNull();
    expect(cleanImei('49015420323751')).toBeNull();
    expect(cleanImei('G9B123456789')).toBeNull();
    expect(cleanImei('')).toBeNull();
  });

  it('runs the Luhn check', () => {
    expect(luhnOk('79927398713')).toBe(true);
    expect(luhnOk('79927398710')).toBe(false);
  });

  it('groups an IMEI for reading', () => {
    expect(formatImei('490154203237518')).toBe('49 015420 323751 8');
    expect(formatImei('123')).toBe('123');
  });
});
