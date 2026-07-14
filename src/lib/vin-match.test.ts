import { describe, it, expect } from 'vitest';
import { vinTail, sameVehicleVin, vinMatchOrFilter } from './vin-match';

describe('vinTail', () => {
  it('takes the last 8 of a full VIN, uppercased', () => {
    expect(vinTail('1ftbw3xg5mka12345')).toBe('5MKA12345'.slice(-8));
    expect(vinTail('1FTBW3XG5MKA12345')).toBe('MKA12345');
  });

  it('strips separators and whitespace before slicing', () => {
    expect(vinTail(' mka-12345 ')).toBe('MKA12345');
  });

  it('returns the whole entry when shorter than 8', () => {
    expect(vinTail('A12345')).toBe('A12345');
  });
});

describe('sameVehicleVin', () => {
  const fullVin = '1FTBW3XG5MKA12345';

  it('matches a full VIN against its last-8 bulk entry (the Tyler/Katie case)', () => {
    expect(sameVehicleVin(fullVin, 'MKA12345')).toBe(true);
    expect(sameVehicleVin('MKA12345', fullVin)).toBe(true);
  });

  it('matches identical strings', () => {
    expect(sameVehicleVin(fullVin, fullVin)).toBe(true);
    expect(sameVehicleVin('MKA12345', 'mka12345')).toBe(true);
  });

  it('matches a shorter partial (min 5) against a full VIN', () => {
    expect(sameVehicleVin('12345', fullVin)).toBe(true);
    expect(sameVehicleVin(fullVin, 'A12345')).toBe(true);
  });

  it('rejects different vehicles', () => {
    expect(sameVehicleVin(fullVin, 'MKA99999')).toBe(false);
    expect(sameVehicleVin('MKA12345', 'MKB12346')).toBe(false);
  });

  it('rejects empty entries', () => {
    expect(sameVehicleVin('', fullVin)).toBe(false);
    expect(sameVehicleVin('---', fullVin)).toBe(false);
  });
});

describe('vinMatchOrFilter', () => {
  it('builds a suffix LIKE for a full VIN plus shorter stored partials', () => {
    expect(vinMatchOrFilter('1FTBW3XG5MKA12345')).toBe('vin.like.%MKA12345,vin.in.(12345,A12345,KA12345)');
  });

  it('handles a last-8 entry', () => {
    expect(vinMatchOrFilter('MKA12345')).toBe('vin.like.%MKA12345,vin.in.(12345,A12345,KA12345)');
  });

  it('omits the in-list for a minimum-length entry', () => {
    expect(vinMatchOrFilter('12345')).toBe('vin.like.%12345');
  });

  it('returns empty for entries too short to match safely', () => {
    expect(vinMatchOrFilter('1234')).toBe('');
    expect(vinMatchOrFilter('')).toBe('');
  });
});
