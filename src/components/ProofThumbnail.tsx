'use client';

import { useState, useRef, useEffect } from 'react';

interface ProofThumbnailProps {
  /** Dropbox file path — uses Dropbox thumbnail API */
  dropboxPath?: string;
  /** Direct URL to a PDF (e.g. R2 public URL) — renders page 1 via pdfjs */
  pdfUrl?: string;
  /** Base64 PDF data — renders page 1 via pdfjs */
  pdfBase64?: string;
  /** Fallback label when no thumbnail loads */
  label?: string;
  /** Small thumb size in px (default 60) */
  thumbSize?: number;
  /** Expanded preview size in px (default 300) */
  expandedSize?: number;
}

/**
 * Expandable proof thumbnail.
 * Shows a small thumbnail; tap to expand to a larger preview inline.
 * Supports Dropbox thumbnails (server-rendered PNG) and PDF URLs (client-rendered via pdfjs).
 */
export default function ProofThumbnail({
  dropboxPath,
  pdfUrl,
  pdfBase64,
  label = 'PDF',
  thumbSize = 60,
  expandedSize = 300,
}: ProofThumbnailProps) {
  const [expanded, setExpanded] = useState(false);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendered = useRef(false);

  // For Dropbox files — use the thumbnail API endpoint
  const dropboxThumbUrl = dropboxPath
    ? `/api/dropbox/thumbnail?path=${encodeURIComponent(dropboxPath)}&size=${expanded ? 'w480h320' : 'w128h128'}`
    : null;

  // For PDF URLs or base64 — render page 1 to canvas using pdfjs
  useEffect(() => {
    if (dropboxPath || rendered.current) return;
    if (!pdfUrl && !pdfBase64) return;

    const renderPdf = async () => {
      setLoading(true);
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        let pdfData: any;
        if (pdfBase64) {
          const raw = atob(pdfBase64);
          const bytes = new Uint8Array(raw.length);
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
          pdfData = { data: bytes };
        } else {
          pdfData = { url: pdfUrl };
        }

        const pdf = await pdfjsLib.getDocument(pdfData).promise;
        const page = await pdf.getPage(1);

        // Render at a reasonable size
        const targetWidth = expandedSize;
        const viewport = page.getViewport({ scale: 1 });
        const scale = targetWidth / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d')!;

        await page.render({ canvasContext: ctx, viewport: scaledViewport, canvas } as any).promise;
        setImgSrc(canvas.toDataURL('image/png'));
        rendered.current = true;
      } catch (e) {
        console.warn('PDF thumbnail render failed:', e);
        setError(true);
      }
      setLoading(false);
    };

    renderPdf();
  }, [pdfUrl, pdfBase64, dropboxPath, expandedSize]);

  const currentSize = expanded ? expandedSize : thumbSize;
  const src = dropboxThumbUrl || imgSrc;

  if (!src && !loading && !error) {
    // Nothing to render yet
    return null;
  }

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      style={{ cursor: 'pointer', flexShrink: 0, position: 'relative' }}
    >
      {loading ? (
        <div style={{
          width: thumbSize, height: thumbSize * 1.3,
          borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: '16px', height: '16px', border: '2px solid var(--border)',
            borderTopColor: 'var(--text-muted)', borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
        </div>
      ) : error ? (
        <div style={{
          width: thumbSize, height: thumbSize * 1.3,
          borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '20px',
        }}>📄</div>
      ) : src ? (
        <img
          src={src}
          alt={label}
          style={{
            width: expanded ? expandedSize : thumbSize,
            maxHeight: expanded ? expandedSize * 1.4 : thumbSize * 1.3,
            objectFit: 'contain',
            borderRadius: expanded ? '10px' : '6px',
            border: '1px solid var(--border)',
            background: '#fff',
            transition: 'all 0.2s ease',
            boxShadow: expanded ? '0 4px 20px rgba(0,0,0,0.15)' : 'none',
          }}
          onError={() => setError(true)}
        />
      ) : null}
      {!expanded && src && !error && (
        <div style={{
          position: 'absolute', bottom: '2px', right: '2px',
          width: '16px', height: '16px', borderRadius: '4px',
          background: 'rgba(0,0,0,0.5)', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          fontSize: '9px', color: '#fff',
        }}>🔍</div>
      )}
    </div>
  );
}
