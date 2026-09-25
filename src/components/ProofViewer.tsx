'use client';

/**
 * Full-screen proof viewer for installers: every page of a PDF proof (or the
 * image itself) at full width, pinch / double-tap / +/- zoom, and a Print
 * button.
 *
 * Built because the vehicle record's proof preview only grew inline to 300px,
 * too small to read the dimensions on a proof and wide enough to push the
 * Upload / Dropbox buttons off the side of a phone.
 *
 * Zoom lives inside the viewer on purpose: the iPhone app turns page-level
 * pinch off (see the zoom-on-focus note in globals.css), so the only zoom an
 * installer gets is the one this component does itself. Zoom widens the
 * content and the scroll container pans it, so panning is native scrolling.
 *
 * Print: the iPhone app's web view ignores window.print(), so where the
 * browser can share files (iOS Safari and the app) Print opens the share
 * sheet with the file, which has Print, AirPrint and Save to Files. Elsewhere
 * it prints the rendered pages from a hidden frame.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTextZoom } from '@/lib/text-size';
import { isNativeApp } from '@/lib/native-files';

const MAX_PAGES = 20;
const MIN_ZOOM = 1;
const MAX_ZOOM = 6;

type Phase = 'loading' | 'ready' | 'unsupported' | 'error';

function extOf(name: string | undefined | null): string {
  const m = (name || '').toLowerCase().match(/\.([a-z0-9]+)(?:$|\?)/);
  return m ? m[1] : '';
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export default function ProofViewer({ url, loadFile, filename, noun = 'proof', dropboxPath, onClose }: {
  /** Where the proof file lives (same-origin /api/storage URL or a public URL). */
  url?: string | null;
  /** Fetches the file instead of `url` (the iPhone app loads graphics job files straight from R2). */
  loadFile?: () => Promise<Blob>;
  filename?: string | null;
  /** What the loading and error lines call the file. */
  noun?: string;
  /** Used for a large Dropbox preview when the file can't be rendered here (.eps, .psd). */
  dropboxPath?: string | null;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [pages, setPages] = useState<string[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [printing, setPrinting] = useState(false);
  const blobRef = useRef<Blob | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  const title = filename || 'Proof';

  // Load the file once, render it to page images.
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];

    const load = async () => {
      setPhase('loading');
      try {
        let blob: Blob;
        if (loadFile) {
          blob = await loadFile();
        } else {
          if (!url) throw new Error('no url');
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          blob = await res.blob();
        }
        if (cancelled) return;
        blobRef.current = blob;

        const ext = extOf(filename) || extOf(url);
        const type = blob.type || '';
        const isImage = type.startsWith('image/') && !/heic|heif|photoshop|postscript/.test(type)
          || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);

        if (isImage) {
          const obj = URL.createObjectURL(blob);
          made.push(obj);
          setPages([obj]);
          setPageCount(1);
          setPhase('ready');
          return;
        }

        // PDFs, and .ai files saved PDF-compatible (most are).
        try {
          const pdfjsLib = await import('pdfjs-dist');
          pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
          const data = new Uint8Array(await blob.arrayBuffer());
          const pdf = await pdfjsLib.getDocument({ data }).promise;
          if (cancelled) return;
          setPageCount(pdf.numPages);
          // Wide enough to stay sharp at a few steps of zoom and on paper.
          const targetWidth = Math.min(3000, Math.max(1600, window.innerWidth * (window.devicePixelRatio || 1) * 2));
          const out: string[] = [];
          for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES); n++) {
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: targetWidth / base.width });
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            const ctx = canvas.getContext('2d')!;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
            const pageBlob: Blob | null = await new Promise(r => canvas.toBlob(r, 'image/png'));
            if (cancelled) return;
            if (!pageBlob) continue;
            const obj = URL.createObjectURL(pageBlob);
            made.push(obj);
            out.push(obj);
            setPages([...out]);
            setPhase('ready');
          }
          if (out.length === 0) throw new Error('no pages rendered');
          return;
        } catch (e) {
          console.warn('Proof render failed:', e);
        }

        if (cancelled) return;
        if (dropboxPath) {
          setPages([`/api/dropbox/thumbnail?path=${encodeURIComponent(dropboxPath)}&size=w2048h1536`]);
          setPageCount(1);
          setPhase('ready');
        } else {
          setPhase('unsupported');
        }
      } catch (e) {
        console.warn('Proof load failed:', e);
        if (cancelled) return;
        if (dropboxPath) {
          setPages([`/api/dropbox/thumbnail?path=${encodeURIComponent(dropboxPath)}&size=w2048h1536`]);
          setPageCount(1);
          setPhase('ready');
        } else {
          setPhase('error');
        }
      }
    };

    load();
    return () => {
      cancelled = true;
      made.forEach(u => URL.revokeObjectURL(u));
    };
    // loadFile is left out on purpose: callers pass a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, filename, dropboxPath]);

  // Esc closes; keep the page behind from scrolling while open.
  useEffect(() => {
    // Capture phase so Esc closes only the viewer, not the vehicle window under it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // Change zoom while keeping the point (cx, cy) — in viewport coordinates of
  // the scroll box — under the finger / at the center.
  const zoomAround = useCallback((next: number, cx?: number, cy?: number) => {
    const el = scrollRef.current;
    const prev = zoomRef.current;
    const z = clampZoom(next);
    if (!el || z === prev) { setZoom(z); return; }
    const px = cx ?? el.clientWidth / 2;
    const py = cy ?? el.clientHeight / 2;
    const contentX = (el.scrollLeft + px) / prev;
    const contentY = (el.scrollTop + py) / prev;
    zoomRef.current = z;
    setZoom(z);
    requestAnimationFrame(() => {
      el.scrollLeft = contentX * z - px;
      el.scrollTop = contentY * z - py;
    });
  }, []);

  // Pinch to zoom. Needs a non-passive listener to stop the browser's own
  // gesture handling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let startDist = 0;
    let startZoom = 1;
    let lastTap = 0;

    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    // Finger positions are real px; the scroll box works in CSS px, which
    // the Text size setting's body zoom scales (see CLAUDE.md).
    const local = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      const z = getTextZoom();
      return { x: (x - r.left) / z, y: (y - r.top) / z };
    };
    const mid = (t: TouchList) => local((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches);
        startZoom = zoomRef.current;
        e.preventDefault();
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300) {
          const p = local(e.touches[0].clientX, e.touches[0].clientY);
          zoomAround(zoomRef.current > 1.2 ? 1 : 2.5, p.x, p.y);
          e.preventDefault();
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    };
    const onMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !startDist) return;
      e.preventDefault();
      const m = mid(e.touches);
      zoomAround(startZoom * (dist(e.touches) / startDist), m.x, m.y);
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) startDist = 0;
    };
    // Ctrl + wheel = trackpad pinch on desktop.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const p = local(e.clientX, e.clientY);
      zoomAround(zoomRef.current * Math.exp(-e.deltaY / 200), p.x, p.y);
    };

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('wheel', onWheel);
    };
  }, [zoomAround, phase]);

  const printInFrame = () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(`<!doctype html><html><head><title>${title.replace(/</g, '&lt;')}</title><style>
      @page { margin: 0.25in; }
      html, body { margin: 0; padding: 0; background: #fff; }
      img { display: block; width: 100%; height: auto; max-height: 100vh; object-fit: contain; page-break-after: always; break-after: page; }
      img:last-child { page-break-after: auto; break-after: auto; }
    </style></head><body>${pages.map(p => `<img src="${p}">`).join('')}</body></html>`);
    doc.close();
    const imgs = Array.from(doc.images);
    const ready = Promise.all(imgs.map(i => i.complete ? Promise.resolve() : new Promise(r => { i.onload = r; i.onerror = r; })));
    ready.then(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => frame.remove(), 60_000);
      setPrinting(false);
    });
  };

  const handlePrint = async () => {
    if (printing) return;
    setPrinting(true);
    const blob = blobRef.current;
    const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
    if (blob && isTouch && typeof navigator !== 'undefined' && navigator.canShare) {
      const name = filename || `proof.${blob.type === 'application/pdf' ? 'pdf' : 'png'}`;
      const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title });
        } catch { /* cancelled */ }
        setPrinting(false);
        return;
      }
    }
    if (pages.length > 0) {
      printInFrame();
      return;
    }
    if (url) window.open(url, '_blank', 'noopener');
    setPrinting(false);
  };

  const btn: React.CSSProperties = {
    padding: '8px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
    background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
    color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap',
  };

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      // Portal events still bubble up the React tree; keep taps in here from
      // reaching the vehicle window's handlers.
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 3000, background: '#111',
        display: 'flex', flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.12)', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0, color: '#fff' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          {pageCount > 1 && (
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.6)' }}>
              {pageCount} pages{pageCount > MAX_PAGES ? ` (first ${MAX_PAGES} shown)` : ''}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={handlePrint}
          disabled={phase !== 'ready' && !url && !blobRef.current}
          style={{ ...btn, background: '#2563eb', border: '1px solid #2563eb', opacity: printing ? 0.6 : 1 }}
        >{printing ? 'Preparing…' : 'Print'}</button>
        <button type="button" onClick={onClose} aria-label="Close" style={{ ...btn, fontSize: '16px', padding: '6px 12px' }}>✕</button>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-x pan-y', position: 'relative',
        }}
      >
        {phase === 'loading' && (
          <div style={{ color: 'rgba(255,255,255,0.7)', textAlign: 'center', padding: '40px 16px', fontSize: '14px' }}>Loading {noun}…</div>
        )}
        {(phase === 'unsupported' || phase === 'error') && (
          <div style={{ color: 'rgba(255,255,255,0.8)', textAlign: 'center', padding: '40px 16px', fontSize: '14px' }}>
            {phase === 'unsupported' ? "This file type can't be previewed here." : `Couldn't load this ${noun}.`}
            {phase === 'unsupported' && blobRef.current && isNativeApp() ? (
              // A link would leave the app for Safari, which isn't signed in.
              <div style={{ marginTop: '12px' }}>
                <button type="button" onClick={handlePrint} style={{ ...btn, background: '#2563eb', border: '1px solid #2563eb' }}>Save or share</button>
              </div>
            ) : url && !isNativeApp() && (
              <div style={{ marginTop: '12px' }}>
                <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontWeight: 700 }}>Open the file</a>
              </div>
            )}
          </div>
        )}
        {phase === 'ready' && (
          <div style={{ width: `${zoom * 100}%`, padding: '12px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {pages.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={src}
                src={src}
                alt={pages.length > 1 ? `${title}, page ${i + 1}` : title}
                draggable={false}
                style={{ display: 'block', width: '100%', height: 'auto', background: '#fff', borderRadius: '4px', userSelect: 'none' }}
              />
            ))}
          </div>
        )}
      </div>

      {phase === 'ready' && (
        <div style={{ position: 'absolute', right: '12px', bottom: 'calc(16px + env(safe-area-inset-bottom))', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button type="button" aria-label="Zoom out" onClick={() => zoomAround(zoomRef.current / 1.5)} style={{ ...btn, background: 'rgba(0,0,0,0.6)', width: '44px', height: '44px', fontSize: '20px', padding: 0 }}>−</button>
          {zoom > 1.01 && (
            <button type="button" onClick={() => zoomAround(1)} style={{ ...btn, background: 'rgba(0,0,0,0.6)', height: '44px' }}>Fit</button>
          )}
          <button type="button" aria-label="Zoom in" onClick={() => zoomAround(zoomRef.current * 1.5)} style={{ ...btn, background: 'rgba(0,0,0,0.6)', width: '44px', height: '44px', fontSize: '20px', padding: 0 }}>+</button>
        </div>
      )}
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(overlay, document.body);
}
