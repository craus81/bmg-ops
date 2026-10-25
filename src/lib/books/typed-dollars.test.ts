import { describe, it, expect } from 'vitest';
import { parseDollars } from './typed-dollars';

describe('what is typed in a money box', () => {
  it('is whole cents, however the dollars are written', () => {
    expect(parseDollars('1296.83')).toBe(129683);
    expect(parseDollars('$1,296.83')).toBe(129683);
    expect(parseDollars(' 12.5 ')).toBe(1250);
    expect(parseDollars('12.')).toBe(1200);
    expect(parseDollars('.5')).toBe(50);
    expect(parseDollars('0')).toBe(0);
    expect(parseDollars('1284.33')).toBe(128433);
    // Where the dollars times 100 come out a hair under in floating point.
    expect(parseDollars('0.29')).toBe(29);
    expect(parseDollars('1.13')).toBe(113);
    expect(parseDollars('4.35')).toBe(435);
  });

  it('is a credit with a minus sign or in brackets, as bills print them', () => {
    expect(parseDollars('-15.00')).toBe(-1500);
    expect(parseDollars('($15.00)')).toBe(-1500);
    expect(parseDollars('-$1,000')).toBe(-100000);
  });

  it("is nothing when it's empty or isn't an amount", () => {
    for (const text of ['', ' ', '$', '.', '12.345', 'twelve', '1.2.3', '--5', '(5', '5-', '1e3']) {
      expect(parseDollars(text)).toBeNull();
    }
  });
});
