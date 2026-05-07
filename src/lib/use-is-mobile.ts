'use client';

import { useEffect, useState } from 'react';

/**
 * Returns true when the viewport is at most `maxWidth` wide. Updates on
 * resize. Defaults to 640px (Tailwind's `sm` breakpoint) so consumers can
 * branch UI for mobile vs. desktop without each page rolling its own logic.
 *
 * Returns `false` during SSR to avoid hydration mismatch — components should
 * treat the first render as desktop and only switch to mobile after mount.
 */
export function useIsMobile(maxWidth = 640): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [maxWidth]);

  return isMobile;
}
