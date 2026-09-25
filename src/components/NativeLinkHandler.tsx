'use client';

/**
 * iPhone app only: keeps "open in a new tab" links inside the app.
 *
 * Capacitor hands every target="_blank" link and window.open() to Safari,
 * which has no FleetSuite session. Files behind /api/... then answer
 * "Unauthorized", in-app pages land on the login screen, and blob: PDFs made
 * in the page can't be reached from Safari at all. In the app this catches
 * those opens instead:
 *
 *  - /api/... and blob: URLs are fetched here (the web view has the session
 *    cookie) and shown full screen: PDFs and images in ProofViewer, HTML
 *    pages (packing lists, printouts) in a frame, and anything else offered
 *    to the share sheet (Save to Files, AirDrop, Print).
 *  - Other same-site pages open in place with the router.
 *  - Links to other sites (NetSuite, UPS, Dropbox) still go to Safari.
 *
 * Screens that already handle the app themselves (graphics job files) call
 * preventDefault first, and this leaves those clicks alone. Computers never
 * mount any of this. See also src/lib/native-files.ts.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import ProofViewer from '@/components/ProofViewer';
import { isNativeApp } from '@/lib/native-files';

type Opened =
  | { kind: 'loading'; url: string; name: string }
  | { kind: 'file'; url: string; name: string; blob: Blob }
  | { kind: 'page'; url: string; name: string }
  | { kind: 'error'; url: string; name: string; message: string };

type Target = { kind: 'file'; url: string } | { kind: 'page'; path: string } | null;

/** Where an opened URL should go in the app, or null to let Safari have it. */
function classify(raw: string): Target {
  if (!raw || raw === 'about:blank') return null;
  let u: URL;
  try {
    u = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (u.protocol === 'blob:') return { kind: 'file', url: u.href };
  if (u.origin !== window.location.origin) return null;
  if (u.pathname.startsWith('/api/')) return { kind: 'file', url: u.href };
  return { kind: 'page', path: u.pathname + u.search + u.hash };
}

function nameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { /* fall through */ }
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}

function nameHint(url: string, fallback?: string | null): string {
  if (fallback && /\.[a-z0-9]{2,5}$/i.test(fallback.trim())) return fallback.trim();
  try {
    const u = new URL(url, window.location.href);
    const n = u.searchParams.get('name') || u.searchParams.get('filename');
    if (n) return n;
  } catch { /* ignore */ }
  return fallback?.trim() || 'File';
}

export default function NativeLinkHandler() {
  const router = useRouter();
  const [opened, setOpened] = useState<Opened | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    if (!isNativeApp()) return;

    const open = async (url: string, hint?: string | null) => {
      const run = ++runRef.current;
      const name = nameHint(url, hint);
      setOpened({ kind: 'loading', url, name });
      try {
        // Default credentials: the session cookie goes to our own routes,
        // and a redirect on to a presigned R2 link is fetched without it, so
        // R2's "*" CORS rule applies.
        const res = await fetch(url);
        if (run !== runRef.current) return;
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `HTTP ${res.status}`);
        }
        const type = res.headers.get('content-type') || '';
        if (type.includes('text/html')) {
          setOpened({ kind: 'page', url, name });
          return;
        }
        const blob = await res.blob();
        if (run !== runRef.current) return;
        const realName = nameFromDisposition(res.headers.get('content-disposition')) || name;
        setOpened({ kind: 'file', url, name: realName, blob });
      } catch (e: any) {
        if (run !== runRef.current) return;
        setOpened({ kind: 'error', url, name, message: e?.message || 'unknown error' });
      }
    };

    const route = (raw: string, hint?: string | null): boolean => {
      const t = classify(raw);
      if (!t) return false;
      if (t.kind === 'page') router.push(t.path);
      else open(t.url, hint);
      return true;
    };

    // Bubble phase on window runs after React's own handlers, so a screen
    // that already called preventDefault keeps its click.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.('a');
      if (!a || !a.href) return;
      const newTab = a.target === '_blank' || a.hasAttribute('download');
      if (!newTab) return;
      if (route(a.href, a.getAttribute('download') || a.textContent)) e.preventDefault();
    };
    window.addEventListener('click', onClick);

    // window.open(url) — only calls with a real URL. window.open('') is used
    // to write a print page, and that keeps the original behavior.
    const originalOpen = window.open;
    window.open = function (url?: string | URL, target?: string, features?: string) {
      const href = url ? String(url) : '';
      if (href && route(href)) {
        // Callers treat null as "popup blocked" and retry with a link, so
        // hand back a stand-in window instead.
        return { closed: false, close() {}, focus() {} } as unknown as Window;
      }
      return originalOpen.call(window, url as any, target, features);
    } as typeof window.open;

    return () => {
      window.removeEventListener('click', onClick);
      window.open = originalOpen;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bind once on mount
  }, []);

  const close = () => {
    runRef.current++;
    setOpened(null);
  };

  if (!opened) return null;

  if (opened.kind === 'file') {
    const blob = opened.blob;
    return (
      <ProofViewer
        key={opened.url}
        loadFile={() => Promise.resolve(blob)}
        filename={opened.name}
        noun="file"
        onClose={close}
      />
    );
  }

  const bar: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.12)', flexShrink: 0, color: '#fff',
  };
  const closeBtn: React.CSSProperties = {
    padding: '6px 12px', borderRadius: '8px', fontSize: '16px', fontWeight: 700,
    background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
    color: '#fff', cursor: 'pointer',
  };

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={opened.name}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000, background: '#111',
        display: 'flex', flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div style={bar}>
        <div style={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {opened.kind === 'page' ? opened.name : opened.kind === 'loading' ? 'Opening…' : 'Could not open'}
        </div>
        <button type="button" onClick={close} aria-label="Close" style={closeBtn}>✕</button>
      </div>
      {opened.kind === 'page' && (
        <iframe src={opened.url} title={opened.name} style={{ flex: 1, border: 0, background: '#fff', width: '100%' }} />
      )}
      {opened.kind === 'loading' && (
        <div style={{ color: 'rgba(255,255,255,0.7)', textAlign: 'center', padding: '40px 16px', fontSize: '14px' }}>Loading {opened.name}…</div>
      )}
      {opened.kind === 'error' && (
        <div style={{ color: 'rgba(255,255,255,0.8)', textAlign: 'center', padding: '40px 16px', fontSize: '14px' }}>
          Couldn&apos;t open this file: {opened.message}
        </div>
      )}
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(overlay, document.body);
}
