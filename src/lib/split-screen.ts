// Split screen: two FleetSuite pages side by side (Craig, 2026-10-24).
//
// Built for the open iPhone Duo screen, where the line between the two panes
// sits on the crease: held with the crease running up and down the panes are
// left and right, turned the other way they stack. Unfolding turns it on by
// itself (Craig: "start on"); folding goes back to one page, the one touched
// last. Computers and iPads get the same split from the header's Split
// button, off until they ask for it.
//
// Each pane is the app itself in a frame (named fs-pane-a / fs-pane-b) with
// its own header and tab bar hidden. The frames tell the page around them
// where they are and when they're touched (PaneBridge); the page around them
// sends taps on its tab bar to the pane touched last (SplitScreen).
//
// A Client Files proof can go from one pane to the other: its 🎨 Builder
// button, or press and hold and drag it across, opens it in the Graphics
// Builder on the other side.

export type PaneId = 'a' | 'b';

export const PANE_NAME_PREFIX = 'fs-pane-';
export const paneName = (p: PaneId) => `${PANE_NAME_PREFIX}${p}`;
export const otherPane = (p: PaneId): PaneId => (p === 'a' ? 'b' : 'a');

/** The pair Craig picked for the first split. */
export const DEFAULT_PANES: Record<PaneId, string> = { a: '/admin/wrap-quote', b: '/client-files' };

export const SPLIT_STORAGE_KEY = 'bmg-split';

export interface SplitState {
  /** The user's own choice from the Split button; null = the default for this screen. */
  choice: 'on' | 'off' | null;
  urls: Record<PaneId, string>;
  active: PaneId;
}

export const defaultSplitState = (): SplitState => ({ choice: null, urls: { ...DEFAULT_PANES }, active: 'a' });

/** Only same-site app pages may go in a pane (never /api, /login or another site). */
export function safePaneUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  if (/^\/(api|login|auth)(\/|\?|#|$)/.test(raw)) return null;
  return raw;
}

export function parseSplitState(raw: string | null): SplitState {
  const base = defaultSplitState();
  if (!raw) return base;
  try {
    const v = JSON.parse(raw);
    return {
      choice: v?.choice === 'on' || v?.choice === 'off' ? v.choice : null,
      urls: { a: safePaneUrl(v?.urls?.a) ?? base.urls.a, b: safePaneUrl(v?.urls?.b) ?? base.urls.b },
      active: v?.active === 'b' ? 'b' : 'a',
    };
  } catch {
    return base;
  }
}

/** The narrowest screen (in CSS px) that gets the Split button off the Duo. */
export const MIN_SPLIT_WIDTH = 1000;

/**
 * Whether split screen is on.
 *  - the open Duo screen: on unless the user turned it off
 *  - a wide computer or iPad screen: off unless the user turned it on
 *  - anything else (phones, the folded Duo): never
 */
export function splitOn(duoWide: boolean, cssWidth: number, choice: SplitState['choice']): boolean {
  if (duoWide) return choice !== 'off';
  if (cssWidth >= MIN_SPLIT_WIDTH) return choice === 'on';
  return false;
}

/** Whether the Split button shows at all. */
export const splitAvailable = (duoWide: boolean, cssWidth: number) => duoWide || cssWidth >= MIN_SPLIT_WIDTH;

/**
 * Side by side when the screen is wider than tall: on the open Duo that's
 * when the crease runs up and down. Taller than wide, the crease runs across
 * and the panes stack.
 */
export const splitDirection = (width: number, height: number): 'columns' | 'rows' => (width >= height ? 'columns' : 'rows');

/** Rectangle of a pane inside the split area, in the area's own px. */
export interface PaneRect { left: number; top: number; width: number; height: number }

/** Which pane a point (in the split area's px) falls on, if any. */
export function paneAt(x: number, y: number, rects: Record<PaneId, PaneRect>): PaneId | null {
  for (const p of ['a', 'b'] as PaneId[]) {
    const r = rects[p];
    if (x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height) return p;
  }
  return null;
}

/** The page a dropped or sent Client Files file opens in. */
export const builderUrlFor = (clientFileId: string) => `/admin/wrap-quote?clientFile=${encodeURIComponent(clientFileId)}`;

/** A 🎨 Builder link's client file id, or null for any other link. */
export function clientFileFromBuilderLink(href: string, origin: string): string | null {
  try {
    const u = new URL(href, origin);
    if (u.origin !== origin || u.pathname !== '/admin/wrap-quote') return null;
    return u.searchParams.get('clientFile');
  } catch {
    return null;
  }
}

// Messages between the page and its panes (same site only).
export type PaneMessage =
  | { type: 'fs-pane-url'; url: string }
  | { type: 'fs-pane-touch' }
  | { type: 'fs-pane-send-client-file'; id: string }
  | { type: 'fs-pane-drag'; phase: 'start' | 'move' | 'end' | 'cancel'; fx: number; fy: number; id?: string; name?: string };

export type HostMessage =
  | { type: 'fs-host-go'; url: string }
  | { type: 'fs-host-open-client-file'; id: string };

/** Window event the Graphics Builder listens for, to read a dropped file onto the open worksheet. */
export const OPEN_CLIENT_FILE_EVENT = 'fs-open-client-file';

/** True inside a split-screen pane. */
export function isPaneWindow(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top && window.name.startsWith(PANE_NAME_PREFIX);
  } catch {
    return false;
  }
}

export function paneIdOfWindow(): PaneId | null {
  if (!isPaneWindow()) return null;
  return window.name === paneName('b') ? 'b' : 'a';
}
