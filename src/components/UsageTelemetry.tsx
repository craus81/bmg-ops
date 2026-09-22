'use client';

/**
 * <UsageTelemetry /> — null-rendering mount point for the browser usage
 * instrumentation (R7-4). Mounted once inside ClientProviders for every
 * staff page, and on the two public forms (booking, credit application).
 * The core module's install guard makes a second mount a no-op.
 *
 * This component owns the React-facing plumbing only:
 *   - usePathname() → soft-navigation timing + abandon of open form attempts
 *   - the capture-phase input/change listener that attributes a keystroke
 *     to the nearest [data-form] root (never reading the field's value,
 *     name or id — only the element reference is handed to the core)
 * Everything else (queue, beacons, error listeners, fetch wrapper) lives in
 * src/lib/usage-telemetry.ts. Kill switch: NEXT_PUBLIC_TELEMETRY=off.
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { installUsageTelemetry } from '@/lib/usage-telemetry';

export default function UsageTelemetry() {
  const pathname = usePathname();

  useEffect(() => {
    const api = installUsageTelemetry();
    if (!api.enabled) return;
    const onInput = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const root = t.closest('[data-form]');
      if (!root) return;
      if (root.hasAttribute('data-form-manual')) return; // typing is not the start signal there
      const formId = root.getAttribute('data-form');
      if (formId) api.touchField(formId, t);
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onInput, true);
    return () => {
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onInput, true);
    };
  }, []);

  useEffect(() => {
    if (pathname) installUsageTelemetry().notePathChange(pathname);
  }, [pathname]);

  return null;
}
