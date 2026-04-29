// Best-effort screen-orientation lock for camera-driven flows.
//
// Prefers the @capacitor/screen-orientation plugin (works on iOS +
// Android Capacitor builds). Falls back to the standard Screen
// Orientation API for the plain web/PWA path. Silently no-ops where
// neither is allowed (iOS Safari without Capacitor, desktop without
// fullscreen, etc.).

type Orientation = 'portrait' | 'landscape';

export function lockOrientation(orientation: Orientation = 'portrait'): () => void {
  if (typeof window === 'undefined') return () => {};

  let unlocked = false;
  let nativeUnlock: (() => Promise<unknown>) | null = null;

  // Try Capacitor plugin first. Dynamic import so the web build
  // doesn't pay the cost when the plugin isn't actually used.
  (async () => {
    try {
      const cap = await import('@capacitor/core');
      if (!cap.Capacitor?.isNativePlatform?.()) throw new Error('not-native');
      const { ScreenOrientation } = await import('@capacitor/screen-orientation');
      await ScreenOrientation.lock({ orientation });
      nativeUnlock = () => ScreenOrientation.unlock();
      if (unlocked) await ScreenOrientation.unlock();
      return;
    } catch {
      // Fall through to the web path.
    }

    const so: any = (window.screen as any)?.orientation;
    if (!so || typeof so.lock !== 'function') return;
    try {
      await so.lock(orientation);
      nativeUnlock = async () => { try { so.unlock?.(); } catch {/* no-op */} };
      if (unlocked && nativeUnlock) await nativeUnlock();
    } catch {/* unsupported / refused */}
  })();

  return () => {
    unlocked = true;
    if (nativeUnlock) {
      Promise.resolve()
        .then(() => nativeUnlock!())
        .catch(() => {/* no-op */});
    }
  };
}
