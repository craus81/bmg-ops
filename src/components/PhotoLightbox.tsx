'use client';

/**
 * A full-screen photo viewer with gallery navigation — dark overlay, click
 * the backdrop / ✕ / Esc to close, ‹ › and arrow keys (or a swipe) to move
 * through the set, a counter, and a caption strip.
 *
 * This exists because "N photos" links around the app opened photo #1 and
 * nothing else: the Scan Log's completion-photo chip was an <a> pointed at
 * `paths[0]`, so on a scan with three photos the other two were unreachable
 * from the UI that counted them. A viewer that takes the WHOLE set is the
 * fix, and it is shared so the next surface that lists photos doesn't grow
 * its own half of one.
 *
 * Zoom (pinch, double-tap, ctrl+wheel, + / − / Fit) and Print / Print all
 * were added for the part record (Craig, 2026-10-20). Zoom lives in here
 * because the iPhone app turns page pinch off, same as ProofViewer: the
 * zoomed photo is wider than its scroll box, so panning is native scrolling.
 * Print is the photo on screen, one to a page; Print all is the whole set,
 * four to a page (src/lib/photo-print.ts).
 *
 * The caller owns the thumbnails and the open/close state; this renders the
 * overlay only. `ZoomableImage` stays the right choice for a lone image with
 * no set to page through.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getTextZoom } from '@/lib/text-size';
import { printPhotos, type PhotosPerPage } from '@/lib/photo-print';

export interface LightboxPhoto {
  /** Stable key — a row id, or the storage path when there is no row. */
  id: string;
  /** What the <img> loads. */
  url: string;
  /** Where "Open original" goes; defaults to `url`. */
  downloadUrl?: string;
  /** Bold first line of the caption (e.g. the VIN, or the photo angle). */
  title?: string | null;
  /** Dimmer second line (who took it, when, which job). */
  subtitle?: string | null;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 6;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export default function PhotoLightbox({ photos, index, onClose, onIndex, printHeading }: {
  photos: LightboxPhoto[];
  /** null = closed. */
  index: number | null;
  onClose: () => void;
  onIndex: (next: number) => void;
  /** Heading on printed pages, e.g. "Part MRK-CONSOLE-120". */
  printHeading?: string;
}) {
  const open = index !== null && index >= 0 && index < photos.length;
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [failed, setFailed] = useState(false);
  const [printing, setPrinting] = useState<PhotosPerPage | null>(null);
  const [printNote, setPrintNote] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(index);
  indexRef.current = index;

  // A new photo starts fitted, and gets its own chance to load.
  useEffect(() => { setZoom(1); setFailed(false); }, [index]);

  const go = useCallback((delta: number) => {
    const i = indexRef.current;
    if (i === null) return;
    const next = i + delta;
    if (next >= 0 && next < photos.length) onIndex(next);
  }, [photos.length, onIndex]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, go]);

  // The scroll box's size, so a zoomed photo can be laid out at an exact
  // multiple of it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!open || !el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Change zoom while keeping the point (cx, cy), in the scroll box's own
  // coordinates, under the finger / at the center.
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

  // Pinch / double-tap to zoom, swipe to change photo when not zoomed.
  // Non-passive listeners so the browser's own gestures stay out of it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!open || !el) return;
    let startDist = 0;
    let startZoom = 1;
    let lastTap = 0;
    let swipe: { x: number; y: number } | null = null;

    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    // Finger positions are real px; the scroll box works in CSS px, which
    // the Text size setting's body zoom scales (see CLAUDE.md).
    const local = (x: number, y: number) => {
      const r = el.getBoundingClientRect();
      const tz = getTextZoom();
      return { x: (x - r.left) / tz, y: (y - r.top) / tz };
    };
    const mid = (t: TouchList) => local((t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2);

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        swipe = null;
        startDist = dist(e.touches);
        startZoom = zoomRef.current;
        e.preventDefault();
      } else if (e.touches.length === 1) {
        swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        const now = Date.now();
        if (now - lastTap < 300) {
          const p = local(e.touches[0].clientX, e.touches[0].clientY);
          zoomAround(zoomRef.current > 1.2 ? 1 : 2.5, p.x, p.y);
          e.preventDefault();
          lastTap = 0;
          swipe = null;
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
      if (swipe && e.changedTouches.length === 1 && zoomRef.current <= 1.01) {
        const dx = e.changedTouches[0].clientX - swipe.x;
        const dy = e.changedTouches[0].clientY - swipe.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
      }
      swipe = null;
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
  }, [open, zoomAround, go]);

  if (!open || index === null) return null;
  const photo = photos[index];

  const print = async (perPage: PhotosPerPage) => {
    if (printing) return;
    setPrinting(perPage);
    setPrintNote(null);
    const set = perPage === 1 ? [photo] : photos;
    const note = await printPhotos(set, { perPage, heading: printHeading });
    setPrintNote(note);
    setPrinting(null);
  };

  const navButton = (side: 'left' | 'right'): React.CSSProperties => ({
    position: 'absolute', [side]: '16px', top: '50%', transform: 'translateY(-50%)',
    background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none',
    borderRadius: '50%', width: '44px', height: '44px',
    fontSize: '20px', cursor: 'pointer', zIndex: 2,
  });
  const btn: React.CSSProperties = {
    padding: '8px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
    background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)',
    color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap',
  };
  const zoomBtn: React.CSSProperties = { ...btn, background: 'rgba(0,0,0,0.6)', width: '44px', height: '44px', fontSize: '20px', padding: 0 };
  const zoomed = zoom > 1.01;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={photo.title || 'Photo'}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
        display: 'flex', flexDirection: 'column',
        zIndex: 1000,
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* Top bar: counter, print, close */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', flexShrink: 0, flexWrap: 'wrap' }}
      >
        <span style={{ flex: 1, color: '#fff', fontSize: '13px', fontWeight: 700, opacity: 0.85 }}>
          {photos.length > 1 ? `${index + 1} / ${photos.length}` : ''}
        </span>
        <button type="button" onClick={() => print(1)} disabled={!!printing}
          style={{ ...btn, background: '#2563eb', border: '1px solid #2563eb', opacity: printing ? 0.6 : 1 }}>
          {printing === 1 ? 'Preparing…' : 'Print'}
        </button>
        {photos.length > 1 && (
          <button type="button" onClick={() => print(4)} disabled={!!printing}
            title="Every photo here, four to a page"
            style={{ ...btn, opacity: printing ? 0.6 : 1 }}>
            {printing === 4 ? 'Preparing…' : `Print all (${photos.length})`}
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close"
          style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '28px', lineHeight: 1, cursor: 'pointer', padding: '0 4px' }}>✕</button>
      </div>
      {printNote && (
        <div onClick={e => e.stopPropagation()} style={{ margin: '0 16px 8px', padding: '8px 12px', borderRadius: '8px', background: 'rgba(239,68,68,0.2)', color: '#fecaca', fontSize: '12px', fontWeight: 600 }}>
          {printNote}
        </div>
      )}

      {/* The photo. Fitted, it centers in the box; zoomed, it is laid out at
          zoom × the box and the box scrolls to pan. */}
      <div
        ref={scrollRef}
        onClick={e => { if (zoomed) e.stopPropagation(); }}
        style={{ flex: 1, minHeight: 0, overflow: zoomed ? 'auto' : 'hidden', WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y', position: 'relative' }}
      >
        <div style={{
          width: zoomed && box.w ? `${box.w * zoom}px` : '100%',
          height: zoomed && box.h ? `${box.h * zoom}px` : '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: zoomed ? 0 : '0 16px', boxSizing: 'border-box',
        }}>
          {failed ? (
            // Never a silent black screen: say the file didn't load and leave
            // the "Open original" link below as the way to reach it.
            <div onClick={e => e.stopPropagation()} style={{ color: '#fff', fontSize: '14px', fontWeight: 700, padding: '20px', textAlign: 'center' }}>
              This photo failed to load.
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={photo.id}
              src={photo.url}
              alt={photo.title || 'Photo'}
              draggable={false}
              onClick={e => e.stopPropagation()}
              onDoubleClick={e => {
                const el = scrollRef.current;
                if (!el) return;
                const r = el.getBoundingClientRect();
                const tz = getTextZoom();
                zoomAround(zoomRef.current > 1.2 ? 1 : 2.5, (e.clientX - r.left) / tz, (e.clientY - r.top) / tz);
              }}
              onError={() => setFailed(true)}
              style={{
                maxWidth: '100%', maxHeight: '100%',
                width: zoomed ? '100%' : undefined, height: zoomed ? '100%' : undefined,
                objectFit: 'contain', borderRadius: zoomed ? 0 : '8px', userSelect: 'none',
                cursor: zoomed ? 'zoom-out' : 'zoom-in',
              }}
            />
          )}
        </div>

        {index > 0 && !zoomed && (
          <button aria-label="Previous photo" onClick={e => { e.stopPropagation(); go(-1); }} style={navButton('left')}>‹</button>
        )}
        {index < photos.length - 1 && !zoomed && (
          <button aria-label="Next photo" onClick={e => { e.stopPropagation(); go(1); }} style={navButton('right')}>›</button>
        )}
      </div>

      {/* Caption strip + zoom buttons */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', padding: '10px 16px 16px', flexShrink: 0 }}
      >
        <div style={{
          flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.7)', color: '#fff',
          padding: '10px 14px', borderRadius: '10px', fontSize: '12px',
        }}>
          {photo.title && <div style={{ fontWeight: 700, marginBottom: '4px' }}>{photo.title}</div>}
          {photo.subtitle && <div style={{ opacity: 0.8 }}>{photo.subtitle}</div>}
          <a
            href={photo.downloadUrl || photo.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', marginTop: '6px', color: '#93c5fd', fontWeight: 700, textDecoration: 'none' }}
          >
            Open original ↗
          </a>
        </div>
        {!failed && (
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
            <button type="button" aria-label="Zoom out" onClick={() => zoomAround(zoomRef.current / 1.5)} style={zoomBtn}>−</button>
            {zoomed && (
              <button type="button" onClick={() => zoomAround(1)} style={{ ...btn, background: 'rgba(0,0,0,0.6)', height: '44px' }}>Fit</button>
            )}
            <button type="button" aria-label="Zoom in" onClick={() => zoomAround(zoomRef.current * 1.5)} style={zoomBtn}>+</button>
          </div>
        )}
      </div>
    </div>
  );
}
