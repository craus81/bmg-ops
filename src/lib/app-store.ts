// Getting the FleetSuite iPhone app (Craig, 2026-10-27).
//
// The app is an Unlisted App Store app: it can't be found by searching the
// App Store, only through its link (and Apple doesn't let an unlisted app go
// public). Installed from that link it updates itself like any other app;
// the TestFlight copy doesn't. So the link goes where new staff look first:
// the sign-in page (a button on a phone, a QR code on a computer) and the
// welcome / login-link emails.

export const IOS_APP_STORE_URL = 'https://apps.apple.com/us/app/id6815076090';

/** QR code for IOS_APP_STORE_URL, in public/. */
export const IOS_APP_QR_PATH = '/app-store-qr.png';

/** Which "get the app" the sign-in page shows on this device. */
export function getAppKind(userAgent: string, maxTouchPoints = 0): 'button' | 'qr' | null {
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'button';
  // No iPhone app for Android phones, so nothing to offer there.
  if (/Android/.test(userAgent)) return null;
  return 'qr';
}

/** Customer-portal-only accounts don't use the staff app. */
export function usesStaffApp(roles: string[]): boolean {
  return roles.some(r => r !== 'customer');
}

/** The "Get the iPhone app" block for the welcome and login-link emails (dark card style). */
export function appStoreEmailBlock(appUrl: string): string {
  return `
    <div style="background: #141e2b; border: 1px solid #1e2d3d; border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: center;">
      <div style="font-size: 15px; font-weight: 700; margin-bottom: 6px; color: #ffffff;">Get the iPhone app</div>
      <p style="color: #c8d6e5; font-size: 13px; line-height: 1.6; margin: 0 0 14px;">
        On your iPhone, tap the button. On a computer, scan the code with your iPhone camera.
        It isn't listed in App Store search, so use this link.
      </p>
      <a href="${IOS_APP_STORE_URL}" style="display: block; text-align: center; padding: 12px; background: #ffffff; color: #0a1017; font-weight: 800; font-size: 14px; border-radius: 10px; text-decoration: none; margin-bottom: 14px;">
        Get FleetSuite on the App Store
      </a>
      <img src="${appUrl}${IOS_APP_QR_PATH}" width="140" height="140" alt="QR code for the FleetSuite iPhone app" style="display: inline-block; width: 140px; height: 140px; border-radius: 8px; background: #ffffff;" />
    </div>
  `;
}
