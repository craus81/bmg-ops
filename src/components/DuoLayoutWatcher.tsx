'use client';

import { useEffect } from 'react';
import { computeDuoLayout, SIDENAV_STORAGE_KEY } from '@/lib/duo-layout';

// Stamps data-sidenav / data-duo-wide on <html> for iPhone Duo screens and
// keeps --hdr-h in step with the header's height (In-Shop's detail pane sits
// just under it). See src/lib/duo-layout.ts; the layout itself is globals.css.
export default function DuoLayoutWatcher() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      let override: string | null = null;
      try { override = localStorage.getItem(SIDENAV_STORAGE_KEY); } catch { /* private mode */ }
      // innerWidth/innerHeight are real px, the units the rule is written in.
      const { sideNav, wide } = computeDuoLayout(window.innerWidth, window.innerHeight, navigator.userAgent, override);
      root.toggleAttribute('data-sidenav', sideNav);
      root.toggleAttribute('data-duo-wide', wide);
    };
    apply();
    window.addEventListener('resize', apply);

    // The header renders after auth loads, so watch for it rather than
    // measuring once.
    let headerObs: ResizeObserver | null = null;
    const watchHeader = () => {
      const header = document.querySelector('header.app-header');
      if (!header || headerObs) return;
      headerObs = new ResizeObserver(() => {
        root.style.setProperty('--hdr-h', `${(header as HTMLElement).offsetHeight}px`);
      });
      headerObs.observe(header);
      domObs.disconnect();
    };
    const domObs = new MutationObserver(watchHeader);
    domObs.observe(document.body, { childList: true, subtree: true });
    watchHeader();

    return () => {
      window.removeEventListener('resize', apply);
      domObs.disconnect();
      headerObs?.disconnect();
    };
  }, []);
  return null;
}
