'use client';

/**
 * In-app PDF viewer tab.
 *
 * "Open in new tab" used to point straight at the PDF bytes (the Gmail
 * attachment API / an R2 file URL). That tab is a dead end: it's the
 * browser's bare PDF viewer, with no app chrome, and — because a new tab has
 * no history — no working Back button. Anyone who opened a PO PDF while
 * reviewing an import had no way back to the app from inside that tab.
 *
 * This page wraps the same bytes in the normal app shell (header + bottom
 * nav are always one tap away) and adds an explicit ← button that closes the
 * tab when the app opened it with window.open() — landing back in the tab
 * whose review panel is still open, edits intact — or navigates to `back`
 * when it can't (middle-click, bookmarked URL, restored session).
 *
 * Params (build them with `deepLinks.pdfViewer`, never by hand):
 *   src       — the PDF. Same-origin path or a URL on our file host, only.
 *   name      — filename shown in the toolbar.
 *   back      — where ← goes when the tab can't close itself. Default /.
 *   backLabel — what ← is called, e.g. "PO import".
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { allowedPdfSrc } from '@/lib/deep-links';

function safePath(raw: string | null): string | null {
  if (!raw) return null;
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

export default function PdfViewerPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The src check needs the browser's origin, so resolve after mount rather
  // than during the server render (where it would fail every link).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const rawSrc = searchParams.get('src');
  const src = useMemo(
    () => (mounted ? allowedPdfSrc(rawSrc, window.location.origin) : null),
    [mounted, rawSrc],
  );
  const name = searchParams.get('name') || 'PDF';
  const back = safePath(searchParams.get('back')) || '/';
  const backLabel = searchParams.get('backLabel') || 'the app';

  const goBack = () => {
    // Tabs opened by window.open() can close themselves; that drops the user
    // back on the tab they came from, which still has their work on screen.
    if (window.opener && !window.opener.closed) {
      window.close();
      // close() is a no-op for tabs the browser doesn't consider
      // script-opened, so fall through to a real navigation if we're still here.
      setTimeout(() => router.push(back), 150);
      return;
    }
    router.push(back);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') goBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- goBack only reads params
  }, [back]);

  const btn: React.CSSProperties = {
    padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
    background: 'var(--subtle-bg)', border: '1px solid var(--border)',
    color: 'var(--text-body)', textDecoration: 'none', cursor: 'pointer',
    whiteSpace: 'nowrap',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <button
          type="button"
          onClick={goBack}
          style={{ ...btn, background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa' }}
        >
          ← Back to {backLabel}
        </button>
        <div style={{ flex: 1, minWidth: 0, fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </div>
        {src && (
          <>
            <a href={src} download={name} style={btn}>Download</a>
            {/* Escape hatch for browsers (notably iOS) whose in-frame PDF
                rendering only shows the first page. */}
            <a href={src} target="_blank" rel="noreferrer" style={btn}>Full screen ↗</a>
          </>
        )}
      </div>

      {!mounted ? null : src ? (
        <iframe
          src={src}
          title={name}
          style={{
            width: '100%', height: 'calc(100vh / var(--ts) - 230px)', minHeight: '420px',
            border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--card)',
          }}
        />
      ) : (
        <div style={{ padding: '20px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '13px', color: 'var(--text-muted)' }}>
          Nothing to preview — this viewer link is missing or points somewhere it isn&apos;t allowed to.
        </div>
      )}
    </div>
  );
}
