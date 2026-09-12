'use client';

/**
 * A full-screen photo viewer with gallery navigation — dark overlay, click
 * the backdrop / ✕ / Esc to close, ‹ › and arrow keys to move through the
 * set, a counter, and a caption strip.
 *
 * This exists because "N photos" links around the app opened photo #1 and
 * nothing else: the Scan Log's completion-photo chip was an <a> pointed at
 * `paths[0]`, so on a scan with three photos the other two were unreachable
 * from the UI that counted them. A viewer that takes the WHOLE set is the
 * fix, and it is shared so the next surface that lists photos doesn't grow
 * its own half of one.
 *
 * The caller owns the thumbnails and the open/close state; this renders the
 * overlay only. `ZoomableImage` stays the right choice for a lone image with
 * no set to page through.
 */

import { useEffect } from 'react';

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

export default function PhotoLightbox({ photos, index, onClose, onIndex }: {
  photos: LightboxPhoto[];
  /** null = closed. */
  index: number | null;
  onClose: () => void;
  onIndex: (next: number) => void;
}) {
  const open = index !== null && index >= 0 && index < photos.length;

  useEffect(() => {
    if (!open || index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < photos.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, index, photos.length, onClose, onIndex]);

  if (!open || index === null) return null;
  const photo = photos[index];

  const navButton = (side: 'left' | 'right'): React.CSSProperties => ({
    position: 'absolute', [side]: '20px', top: '50%', transform: 'translateY(-50%)',
    background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none',
    borderRadius: '50%', width: '44px', height: '44px',
    fontSize: '20px', cursor: 'pointer', zIndex: 1,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={photo.title || 'Photo'}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '20px',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.url}
        alt={photo.title || 'Photo'}
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }}
        onError={e => {
          // Never a silent black screen: say the file didn't load and leave
          // the "Open original" link below as the way to reach it.
          const el = e.target as HTMLImageElement;
          el.style.display = 'none';
          const parent = el.parentElement;
          if (parent && !parent.querySelector('[data-imgfail]')) {
            const msg = document.createElement('div');
            msg.setAttribute('data-imgfail', '1');
            msg.textContent = 'This photo failed to load.';
            msg.style.cssText = 'color:#fff;font-size:14px;font-weight:700;padding:20px;text-align:center;';
            parent.appendChild(msg);
          }
        }}
      />

      {/* Counter + close */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute', top: '20px', right: '20px',
          display: 'flex', alignItems: 'center', gap: '12px', zIndex: 1,
        }}
      >
        {photos.length > 1 && (
          <span style={{ color: '#fff', fontSize: '13px', fontWeight: 700, opacity: 0.85 }}>
            {index + 1} / {photos.length}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: '28px', lineHeight: 1, cursor: 'pointer' }}
        >✕</button>
      </div>

      {index > 0 && (
        <button aria-label="Previous photo" onClick={e => { e.stopPropagation(); onIndex(index - 1); }} style={navButton('left')}>‹</button>
      )}
      {index < photos.length - 1 && (
        <button aria-label="Next photo" onClick={e => { e.stopPropagation(); onIndex(index + 1); }} style={navButton('right')}>›</button>
      )}

      {/* Caption strip */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'absolute', bottom: '20px', left: '20px', right: '20px',
          background: 'rgba(0,0,0,0.7)', color: '#fff',
          padding: '10px 14px', borderRadius: '10px', fontSize: '12px',
          maxWidth: '600px', margin: '0 auto',
        }}
      >
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
    </div>
  );
}
