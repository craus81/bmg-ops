'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Routes Universal Link / App Link opens (e.g. the "Open job card" button in
// pickup / vehicle-complete emails) to the in-app path. Without this the
// native Capacitor wrapper opens at its server.url root and the deep link is
// lost. No-ops on the plain web build and on native if the URL host doesn't
// match the app's own origin.
// Sign-in links (staff invites, Magic Link, password reset) come back as
// /auth/callback?next=…#access_token=…. That has to be a full page load: the
// callback is a server route, and the Supabase client only reads the tokens
// in the # when the page starts. A router.push left the app on a blank screen
// and never signed the person in.
function isAuthLink(path: string): boolean {
  return path.startsWith('/auth/') || /[#&](access_token|error_code)=/.test(path);
}

export default function DeepLinkHandler() {
  const router = useRouter();
  const go = (path: string) => {
    if (isAuthLink(path)) window.location.replace(path);
    else router.push(path);
  };

  useEffect(() => {
    let cancelled = false;
    let removeListener: (() => void) | null = null;

    const toInAppPath = (url: string): string | null => {
      try {
        const u = new URL(url);
        // Only follow links pointing at our own site; ignore anything else
        // (other custom schemes, third-party hosts).
        if (!/^https?:$/.test(u.protocol)) return null;
        return u.pathname + u.search + u.hash;
      } catch {
        return null;
      }
    };

    (async () => {
      try {
        const cap = await import('@capacitor/core');
        if (!cap.Capacitor?.isNativePlatform?.()) return;
        const { App } = await import('@capacitor/app');

        // Cold start: app launched by tapping the email link.
        const launch = await App.getLaunchUrl();
        if (!cancelled && launch?.url) {
          const path = toInAppPath(launch.url);
          if (path) go(path);
        }

        // Warm start: app already running when the link is tapped.
        const handle = await App.addListener('appUrlOpen', (event) => {
          const path = toInAppPath(event.url);
          if (path) go(path);
        });
        if (cancelled) handle.remove();
        else removeListener = () => handle.remove();
      } catch (err) {
        // Not native (web handles deep links via the URL itself), OR the
        // native binary was built without the @capacitor/app plugin — in the
        // latter case link taps only foreground the app and the URL is lost,
        // so make the failure visible instead of swallowing it.
        try {
          const cap = await import('@capacitor/core');
          if (cap.Capacitor?.isNativePlatform?.()) {
            console.error('DeepLinkHandler: @capacitor/app unavailable — universal links will not navigate. Rebuild the app with `npx cap sync`.', err);
          }
        } catch { /* not even capacitor core — plain web, nothing to report */ }
      }
    })();

    return () => {
      cancelled = true;
      removeListener?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bind once on mount
  }, []);

  return null;
}
