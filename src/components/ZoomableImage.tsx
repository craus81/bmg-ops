'use client';

/**
 * An <img> the viewer can click/tap to see full-screen — dark overlay,
 * tap anywhere / ✕ / Esc closes. Built for the public approval pages
 * (/approve/estimate, /approve/quote, /approve/proof), where product
 * photos render as 56px thumbnails and coverage diagrams / proofs are
 * capped at the 640px card width: the full-size file is already behind
 * the URL, this just lets the customer look at it. Same overlay pattern
 * as VehiclePhotoTimeline's lightbox, minus the gallery navigation.
 */

import { useEffect, useState } from 'react';

export default function ZoomableImage({ src, alt, style, wrapStyle }: {
  src: string;
  alt: string;
  /** Styles for the thumbnail <img> itself (size, objectFit, border…). */
  style?: React.CSSProperties;
  /** Styles for the wrapping <button> — layout context belongs here
   *  (flexShrink in a flex row, margins). */
  wrapStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`View ${alt} full screen`}
        style={{ display: 'block', padding: 0, border: 'none', background: 'none', cursor: 'zoom-in', lineHeight: 0, ...wrapStyle }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} style={{ display: 'block', ...style }} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, padding: '20px', cursor: 'zoom-out',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '8px' }} />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{
              position: 'absolute', top: '16px', right: '16px',
              background: 'rgba(0,0,0,0.5)', border: 'none', color: '#fff',
              fontSize: '22px', lineHeight: 1, cursor: 'pointer',
              borderRadius: '50%', width: '40px', height: '40px',
            }}
          >✕</button>
        </div>
      )}
    </>
  );
}
