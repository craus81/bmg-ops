// iPhone Duo layout (Apple's folding iPhone, 2026).
//
// Closed, its outer screen is short and wide and Apple puts the clock,
// camera and tab bars down the right edge; open, the inner screen is close to
// a small iPad. FleetSuite's bars are HTML, so iOS can't move them for us —
// DuoLayoutWatcher stamps two attributes on <html> and globals.css does the rest:
//
//   data-sidenav   the bottom tab bar becomes a rail down the right edge
//   data-duo-wide  wide enough for two panes (Home's two columns, In-Shop
//                  details beside the list, Scan & Log split at the fold)
//
// Detection is by shape, not by model: an iPhone whose window is at least
// 500px tall and wider than a normal phone held upright. No other iPhone
// matches — upright they're ~0.46 wide-to-tall, and on their side they're
// under 450px tall — so regular phones, iPads and computers are unchanged.
// localStorage `bmg-sidenav` = 'on' / 'off' forces it, for checking the
// layout in a desktop browser.

export const SIDENAV_STORAGE_KEY = 'bmg-sidenav';

export interface DuoLayout { sideNav: boolean; wide: boolean }

export function computeDuoLayout(
  width: number, height: number, userAgent: string, override?: string | null,
): DuoLayout {
  let sideNav: boolean;
  if (override === 'on') sideNav = true;
  else if (override === 'off') sideNav = false;
  else sideNav = /iPhone/.test(userAgent) && height >= 500 && width / height >= 0.6;
  return { sideNav, wide: sideNav && width >= 700 };
}
