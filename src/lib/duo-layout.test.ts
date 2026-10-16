import { describe, expect, it } from 'vitest';
import { computeDuoLayout } from './duo-layout';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 27_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

describe('computeDuoLayout', () => {
  it('leaves regular iPhones alone, upright and on their side', () => {
    expect(computeDuoLayout(393, 852, IPHONE)).toEqual({ sideNav: false, wide: false });
    expect(computeDuoLayout(440, 956, IPHONE)).toEqual({ sideNav: false, wide: false });
    expect(computeDuoLayout(852, 393, IPHONE)).toEqual({ sideNav: false, wide: false });
    expect(computeDuoLayout(956, 440, IPHONE)).toEqual({ sideNav: false, wide: false });
  });

  it('uses the side rail on a short, wide iPhone screen (Duo closed)', () => {
    expect(computeDuoLayout(460, 680, IPHONE)).toEqual({ sideNav: true, wide: false });
  });

  it('goes wide on the big inner screen (Duo open)', () => {
    expect(computeDuoLayout(920, 720, IPHONE)).toEqual({ sideNav: true, wide: true });
    expect(computeDuoLayout(720, 920, IPHONE)).toEqual({ sideNav: true, wide: true });
  });

  it('never changes iPads or computers', () => {
    expect(computeDuoLayout(1024, 1366, IPAD).sideNav).toBe(false);
    expect(computeDuoLayout(1440, 900, MAC).sideNav).toBe(false);
  });

  it('honours the on/off override', () => {
    expect(computeDuoLayout(1440, 900, MAC, 'on')).toEqual({ sideNav: true, wide: true });
    expect(computeDuoLayout(460, 680, IPHONE, 'off')).toEqual({ sideNav: false, wide: false });
  });
});
