// Best-effort screen-orientation lock for camera-driven flows.
//
// Uses the standard Screen Orientation API. Works on Android Chrome
// (and inside Capacitor's Android WebView). Silently no-ops where the
// API is missing or refuses (iOS Safari, desktop, non-fullscreen
// contexts).
//
// For full iOS support, install @capacitor/screen-orientation and
// extend this helper to call ScreenOrientation.lock() / unlock().

type Orientation = 'portrait' | 'landscape';

export function lockOrientation(orientation: Orientation = 'portrait'): () => void {
  if (typeof window === 'undefined') return () => {};
  const so: any = (window.screen as any)?.orientation;
  if (!so || typeof so.lock !== 'function') return () => {};

  let locked = false;
  Promise.resolve()
    .then(() => so.lock(orientation))
    .then(() => { locked = true; })
    .catch(() => {/* unsupported / refused — no-op */});

  return () => {
    if (!locked) return;
    try { so.unlock?.(); } catch {/* no-op */}
  };
}
