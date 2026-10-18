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
// Detection is by shape, not by model: an iPhone window at least 360px on its
// short side whose width-to-height ratio is between 0.6 and 1.7. Regular
// iPhones never match — upright they're ~0.46, on their side 1.78 (SE, Plus)
// to 2.17 — so they, iPads and computers are unchanged.
//
//   data-duo-status-side  Apple's clock/camera bubble sits at the top of the
//                         right edge (everywhere except the big screen held
//                         upright, where the status bar runs across the top),
//                         so the rail starts below it.
//
// localStorage `bmg-sidenav` = 'on' / 'off' forces it, for checking the
// layout in a desktop browser.

export const SIDENAV_STORAGE_KEY = 'bmg-sidenav';

export interface DuoLayout { sideNav: boolean; wide: boolean; statusOnSide: boolean }

export function computeDuoLayout(
  width: number, height: number, userAgent: string, override?: string | null,
): DuoLayout {
  let sideNav: boolean;
  if (override === 'on') sideNav = true;
  else if (override === 'off') sideNav = false;
  else {
    const ratio = width / height;
    sideNav = /iPhone/.test(userAgent) && Math.min(width, height) >= 360 && ratio >= 0.6 && ratio <= 1.7;
  }
  // The big screen held upright (≥560px wide) keeps a normal status bar on top.
  const statusOnSide = sideNav && !(height > width && width >= 560);
  return { sideNav, wide: sideNav && width >= 700, statusOnSide };
}
