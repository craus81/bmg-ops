import { describe, expect, it } from 'vitest';
import { appStoreEmailBlock, getAppKind, IOS_APP_STORE_URL, usesStaffApp } from './app-store';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';

describe('getAppKind', () => {
  it('gives an iPhone or iPad the App Store button', () => {
    expect(getAppKind(IPHONE)).toBe('button');
    expect(getAppKind(IPAD, 5)).toBe('button');
  });
  it('gives a computer the QR code to scan', () => {
    expect(getAppKind(IPAD, 0)).toBe('qr');
    expect(getAppKind(WINDOWS)).toBe('qr');
  });
  it('offers Android phones nothing', () => {
    expect(getAppKind(ANDROID, 5)).toBeNull();
  });
});

describe('usesStaffApp', () => {
  it('skips customer-portal-only accounts', () => {
    expect(usesStaffApp(['customer'])).toBe(false);
    expect(usesStaffApp(['customer', 'sales'])).toBe(true);
    expect(usesStaffApp(['installer'])).toBe(true);
  });
});

describe('appStoreEmailBlock', () => {
  it('links the unlisted App Store page and the QR image on the app site', () => {
    const html = appStoreEmailBlock('https://go.bmgfleet.com');
    expect(html).toContain(`href="${IOS_APP_STORE_URL}"`);
    expect(html).toContain('src="https://go.bmgfleet.com/app-store-qr.png"');
  });
});
