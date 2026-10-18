import { describe, expect, it } from 'vitest';
import { computeDuoLayout } from './duo-layout';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('computeDuoLayout', () => {
  it('leaves regular iPhones alone, upright and on their side', () => {
    expect(computeDuoLayout(393, 852, IPHONE)).toMatchObject({ sideNav: false, wide: false });
    expect(computeDuoLayout(440, 956, IPHONE)).toMatchObject({ sideNav: false, wide: false });
    expect(computeDuoLayout(852, 393, IPHONE)).toMatchObject({ sideNav: false, wide: false });
    expect(computeDuoLayout(956, 440, IPHONE)).toMatchObject({ sideNav: false, wide: false });
    expect(computeDuoLayout(667, 375, IPHONE)).toMatchObject({ sideNav: false, wide: false }); // SE on its side
    expect(computeDuoLayout(736, 414, IPHONE)).toMatchObject({ sideNav: false, wide: false }); // Plus on its side
  });

  it('uses the side rail on a short, wide iPhone screen (Duo closed)', () => {
    expect(computeDuoLayout(460, 680, IPHONE)).toEqual({ sideNav: true, wide: false, statusOnSide: true });
  });

  it('keeps the side rail when the closed phone is turned on its side', () => {
    expect(computeDuoLayout(680, 440, IPHONE)).toMatchObject({ sideNav: true, wide: false });
  });

  it('goes wide on the big inner screen (Duo open)', () => {
    expect(computeDuoLayout(920, 720, IPHONE)).toEqual({ sideNav: true, wide: true, statusOnSide: true });
    // Upright, the big screen has a normal status bar across the top.
    expect(computeDuoLayout(720, 920, IPHONE)).toEqual({ sideNav: true, wide: true, statusOnSide: false });
    expect(computeDuoLayout(640, 860, IPHONE)).toEqual({ sideNav: true, wide: false, statusOnSide: false });
  });

  it('never changes iPads or computers', () => {
    expect(computeDuoLayout(1024, 1366, IPAD).sideNav).toBe(false);
    expect(computeDuoLayout(1440, 900, MAC).sideNav).toBe(false);
  });

  it('honours the on/off override', () => {
    expect(computeDuoLayout(1440, 900, MAC, 'on')).toMatchObject({ sideNav: true, wide: true });
    expect(computeDuoLayout(460, 680, IPHONE, 'off')).toMatchObject({ sideNav: false, wide: false });
  });
});
