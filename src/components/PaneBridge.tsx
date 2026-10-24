'use client';

/**
 * Runs inside a split-screen pane (src/lib/split-screen.ts): the app in a
 * frame beside another one. It
 *  - tells the page around it which page it's on, and when it's touched
 *    (that pane is the one the tab bar changes);
 *  - opens pages it's sent (a tab tapped, a page picked in the pane's bar);
 *  - sends a Client Files proof's 🎨 Builder link to the other pane instead
 *    of leaving Client Files;
 *  - lets a proof be pressed and held (or dragged with a mouse) and dropped
 *    on the other pane, which opens it in the Graphics Builder there.
 */

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  builderUrlFor, clientFileFromBuilderLink, OPEN_CLIENT_FILE_EVENT, safePaneUrl,
  type HostMessage, type PaneMessage,
} from '@/lib/split-screen';

const HOLD_MS = 400;
const MOVE_SLOP = 10;

export default function PaneBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // Where this pane is. Query-only changes (?tab=…) don't move usePathname,
  // so a light check of the address catches those too.
  useEffect(() => {
    let last = '';
    const report = () => {
      const url = window.location.pathname + window.location.search + window.location.hash;
      if (url === last) return;
      last = url;
      post({ type: 'fs-pane-url', url });
    };
    report();
    const t = window.setInterval(report, 700);
    return () => window.clearInterval(t);
  }, [pathname]);

  useEffect(() => {
    document.documentElement.setAttribute('data-fs-pane', '');

    const onTouch = () => post({ type: 'fs-pane-touch' });
    window.addEventListener('pointerdown', onTouch, true);

    // 🎨 Builder on a Client Files proof: open it on the other side.
    const onClick = (e: MouseEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const id = clientFileFromBuilderLink(a.getAttribute('href') || '', window.location.origin);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'fs-pane-send-client-file', id });
    };
    window.addEventListener('click', onClick, true);

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const msg = e.data as HostMessage;
      if (msg?.type === 'fs-host-go') {
        const url = safePaneUrl(msg.url);
        if (url) router.push(url);
      } else if (msg?.type === 'fs-host-open-client-file' && typeof msg.id === 'string') {
        if (pathRef.current.startsWith('/admin/wrap-quote')) {
          window.dispatchEvent(new CustomEvent(OPEN_CLIENT_FILE_EVENT, { detail: { id: msg.id } }));
        } else {
          router.push(builderUrlFor(msg.id));
        }
      }
    };
    window.addEventListener('message', onMessage);

    // ── Drag a proof across ──
    let hold: number | null = null;
    let start: { x: number; y: number; id: string; name: string } | null = null;
    let dragging = false;
    const frac = (x: number, y: number) => ({ fx: x / window.innerWidth, fy: y / window.innerHeight });
    const reset = () => {
      if (hold) window.clearTimeout(hold);
      hold = null; start = null; dragging = false;
      document.documentElement.removeAttribute('data-fs-dragging');
    };
    const begin = (x: number, y: number) => {
      if (!start) return;
      dragging = true;
      document.documentElement.setAttribute('data-fs-dragging', '');
      post({ type: 'fs-pane-drag', phase: 'start', id: start.id, name: start.name, ...frac(x, y) });
    };
    const sourceOf = (t: EventTarget | null) => {
      const el = (t as Element | null)?.closest?.('[data-client-file-id]') as HTMLElement | null;
      const id = el?.dataset.clientFileId;
      return id ? { id, name: el!.dataset.clientFileName || 'File' } : null;
    };

    // Touch: press and hold, then drag. Moving first is a scroll.
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { reset(); return; }
      const src = sourceOf(e.target);
      if (!src) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, ...src };
      hold = window.setTimeout(() => begin(t.clientX, t.clientY), HOLD_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0];
      if (!dragging) {
        if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > MOVE_SLOP) reset();
        return;
      }
      e.preventDefault(); // no scrolling while a file is in hand
      post({ type: 'fs-pane-drag', phase: 'move', ...frac(t.clientX, t.clientY) });
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (dragging) {
        const t = e.changedTouches[0];
        post({ type: 'fs-pane-drag', phase: e.type === 'touchcancel' ? 'cancel' : 'end', ...frac(t.clientX, t.clientY) });
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 400);
      }
      reset();
    };

    // Mouse (iPad with a trackpad, the Mac app, computers): drag past a few px.
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const src = sourceOf(e.target);
      if (src) start = { x: e.clientX, y: e.clientY, ...src };
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!start) return;
      if (!dragging) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= MOVE_SLOP) return;
        begin(e.clientX, e.clientY);
      }
      e.preventDefault();
      post({ type: 'fs-pane-drag', phase: 'move', ...frac(e.clientX, e.clientY) });
    };
    const onMouseUp = (e: MouseEvent) => {
      if (dragging) {
        post({ type: 'fs-pane-drag', phase: 'end', ...frac(e.clientX, e.clientY) });
        suppressClick.current = true;
        window.setTimeout(() => { suppressClick.current = false; }, 400);
      }
      reset();
    };
    // Links and pictures would start the browser's own drag instead.
    const onDragStart = (e: DragEvent) => { if (sourceOf(e.target)) e.preventDefault(); };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('dragstart', onDragStart);

    return () => {
      reset();
      document.documentElement.removeAttribute('data-fs-pane');
      window.removeEventListener('pointerdown', onTouch, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('message', onMessage);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('dragstart', onDragStart);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- listeners live for the pane's life
  }, []);

  return null;
}

const suppressClick = { current: false };

function post(msg: PaneMessage) {
  try {
    window.parent.postMessage(msg, window.location.origin);
  } catch { /* the page around us went away */ }
}
