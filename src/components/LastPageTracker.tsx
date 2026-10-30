'use client';

/**
 * Remembers the last screen someone was on (this tab only), so a request
 * sent from More → Requests or the Home card can say which screen it's
 * about without the person having to explain (Requests, 2026-10-30).
 */

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

export const LAST_PAGE_KEY = 'bmg-last-page';

/** Screens that are on the way to Requests, not what a request is about. */
const SKIP = [/^\/requests/, /^\/more$/];

export function readLastPage(): string | null {
  try { return sessionStorage.getItem(LAST_PAGE_KEY); } catch { return null; }
}

export default function LastPageTracker() {
  const pathname = usePathname();
  useEffect(() => {
    if (!pathname || SKIP.some(re => re.test(pathname))) return;
    try { sessionStorage.setItem(LAST_PAGE_KEY, pathname); } catch { /* private mode: no screen name */ }
  }, [pathname]);
  return null;
}
