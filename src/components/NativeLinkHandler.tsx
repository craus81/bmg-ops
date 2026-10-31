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
 *  - Links to other sites (NetSuite, UPS, Dropbox) still go to Safari, and
 *    so does any link marked data-browser (sign-in's "Request access", which
 *    the app itself doesn't offer).
 *
 * Screens that already handle the app themselves (graphics job files) call
 * preventDefault, and this leaves those clicks alone. Clicks are caught on
 * the way down, so a screen that stops the click on the way up (a sheet
 * that keeps taps from closing it) can't send it to Safari any more: that
 * hit Client Files twice (Craig, 2026-10-16 and 2026-10-29). A link clicked
 * from code without being on the page (a.click()) is caught too. Computers
 * never mount any of this. See also src/lib/native-files.ts.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import ProofViewer from '@/components/ProofViewer';
import { isNativeApp, ensureFreshSession, blobUrlName, fileNameFromDisposition, withFileExtension } from '@/lib/native-files';

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

function nameHint(url: string, fallback?: string | null): string {
  if (url.startsWith('blob:')) {
    const given = blobUrlName(url);
    if (given) return given;
  }
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
        // Renew an expired token first (the app may have been asleep); then
        // default credentials: the session cookie goes to our own routes,
        // and a redirect on to a presigned R2 link is fetched without it, so
        // R2's "*" CORS rule applies.
        if (!url.startsWith('blob:')) await ensureFreshSession();
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
        // Always a name with an ending: Save to Files on a PDF called just
        // "File" saved something the phone couldn't open (Craig, 2026-10-21).
        const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
        if (run !== runRef.current) return;
        const realName = withFileExtension(
          fileNameFromDisposition(res.headers.get('content-disposition')) || name,
          blob.type || type,
          head,
        );
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

    /** A link that would leave for Safari, with what to open in its place. */
    const catchable = (a: HTMLAnchorElement | null): { href: string; hint: string | null } | null => {
      if (!a || !a.href || a.hasAttribute('data-browser')) return null;
      const newTab = a.target === '_blank' || a.hasAttribute('download');
      if (!newTab || !classify(a.href)) return null;
      return { href: a.href, hint: a.getAttribute('download') || a.textContent };
    };

    // Capture phase on window: runs before anything on the page can stop the
    // click. Safari is blocked straight away, and once the click has been
    // everywhere it goes, the link opens here unless a screen called
    // preventDefault itself (it opened the file its own way).
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const link = catchable((e.target as Element | null)?.closest?.('a') as HTMLAnchorElement | null);
      if (!link) return;
      let screenHandled = false;
      const block = e.preventDefault.bind(e);
      e.preventDefault = () => { screenHandled = true; block(); };
      block();
      setTimeout(() => { if (!screenHandled) route(link.href, link.hint); }, 0);
    };
    window.addEventListener('click', onClick, true);

    // a.click() on a link that isn't on the page: its click never reaches
    // window, so catch it at the source.
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      const link = this.isConnected ? null : catchable(this);
      if (link && route(link.href, link.hint)) return;
      originalClick.call(this);
    };

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
      window.removeEventListener('click', onClick, true);
      HTMLAnchorElement.prototype.click = originalClick;
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
      className="duo-clear-status"
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
