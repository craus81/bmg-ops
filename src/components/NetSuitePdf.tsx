'use client';

import { useState, useEffect, useRef } from 'react';

interface NetSuitePdfProps {
  type: 'salesOrder' | 'invoice';
  recordId: string | null;
  recordNumber: string | null;
  /** Optional label override, e.g. "SO" or "INV". Defaults based on type. */
  label?: string;
}

/**
 * Inline NetSuite PDF viewer with thumbnail preview.
 * Works for Sales Orders, Invoices, or any supported transaction type.
 */
export default function NetSuitePdf({ type, recordId, recordNumber, label }: NetSuitePdfProps) {
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [thumbSrc, setThumbSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(true);
  const [thumbExpanded, setThumbExpanded] = useState(false);
  const rendered = useRef(false);

  const prefix = label || (type === 'invoice' ? 'INV' : 'SO');

  // Render thumbnail when PDF is loaded
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!pdfBase64 || rendered.current) return;
    rendered.current = true;

    const renderThumb = async () => {
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

        const raw = atob(pdfBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        const scale = 300 / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport: scaledViewport, canvas } as any).promise;
        setThumbSrc(canvas.toDataURL('image/png'));
      } catch (e) {
        console.warn(`${prefix} PDF thumbnail render failed:`, e);
      }
    };

    renderThumb();
  }, [pdfBase64]);

  if (!recordId || !recordNumber) return null;

  const fetchPdf = async () => {
    if (pdfBase64) {
      // Already loaded — just toggle visibility
      setCollapsed(!collapsed);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/netsuite/pdf?type=${encodeURIComponent(type)}&id=${encodeURIComponent(recordId)}`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { setError(`Invalid response: ${text.slice(0, 120)}`); return; }
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to load PDF');
        return;
      }
      if (!data.pdfBase64 || data.pdfBase64.length < 100) {
        setError('PDF data is empty — check print template in NetSuite.');
        return;
      }
      setPdfBase64(data.pdfBase64);
      setCollapsed(false);
    } catch (err: any) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const pdfDataUrl = pdfBase64 ? `data:application/pdf;base64,${pdfBase64}` : null;

  const openInNewTab = () => {
    if (!pdfBase64) return;
    const raw = atob(pdfBase64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
  };

  return (
    <div style={{ marginTop: '8px' }}>
      {/* Header row with toggle button and thumbnail */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          onClick={fetchPdf}
          disabled={loading}
          style={{
            flex: 1, padding: '10px 14px', borderRadius: '10px',
            border: '1px solid var(--border)',
            background: pdfDataUrl && !collapsed ? 'rgba(59,130,246,0.08)' : 'var(--card)',
            color: loading ? 'var(--text-muted)' : '#60a5fa',
            fontSize: '12px', fontWeight: 700, cursor: loading ? 'wait' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          }}
        >
          {loading ? (
            <>
              <div style={{
                width: '14px', height: '14px', borderRadius: '50%',
                border: '2px solid rgba(59,130,246,0.3)', borderTopColor: '#60a5fa',
                animation: 'spin 0.8s linear infinite',
              }} />
              Loading {prefix} #{recordNumber}...
            </>
          ) : (
            <>
              <span></span>
              {pdfDataUrl && !collapsed ? `Hide ${prefix} #${recordNumber}` : `View ${prefix} #${recordNumber} PDF`}
              <span style={{ fontSize: '10px' }}>{pdfDataUrl && !collapsed ? '▲' : '▼'}</span>
            </>
          )}
        </button>

        {/* Expandable thumbnail */}
        {thumbSrc && (
          <div
            onClick={(e) => { e.stopPropagation(); setThumbExpanded(!thumbExpanded); }}
            style={{ cursor: 'pointer', flexShrink: 0, position: 'relative' }}
          >
            <img
              src={thumbSrc}
              alt={`${prefix} #${recordNumber}`}
              style={{
                width: thumbExpanded ? 280 : 40,
                maxHeight: thumbExpanded ? 400 : 52,
                objectFit: 'contain',
                borderRadius: thumbExpanded ? '10px' : '6px',
                border: '1px solid var(--border)',
                background: '#fff',
                transition: 'all 0.2s ease',
                boxShadow: thumbExpanded ? '0 4px 20px rgba(0,0,0,0.15)' : 'none',
              }}
            />
            {!thumbExpanded && (
              <div style={{
                position: 'absolute', bottom: '1px', right: '1px',
                width: '14px', height: '14px', borderRadius: '3px',
                background: 'rgba(0,0,0,0.5)', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontSize: '8px', color: '#fff',
              }}>+</div>
            )}
          </div>
        )}
      </div>

      {/* Error */}
      {error && (
        <div style={{
          marginTop: '6px', padding: '8px 12px', borderRadius: '8px',
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
          color: 'var(--error)', fontSize: '11px', fontWeight: 600,
        }}>
          {error}
        </div>
      )}

      {/* Inline PDF viewer */}
      {pdfDataUrl && !collapsed && (
        <div style={{ marginTop: '8px' }}>
          <div
            onClick={openInNewTab}
            style={{
              padding: '6px 12px', borderRadius: '8px 8px 0 0',
              background: 'rgba(59,130,246,0.08)', border: '1px solid var(--border)', borderBottom: 'none',
              color: '#60a5fa', fontSize: '11px', fontWeight: 700,
              cursor: 'pointer', textAlign: 'center',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
            }}
          >
            Tap to open in new window for printing
          </div>
          <div
            onClick={openInNewTab}
            style={{
              width: '100%', height: '400px',
              border: '1px solid var(--border)', borderRadius: '0 0 10px 10px',
              overflow: 'hidden', cursor: 'pointer',
            }}
          >
            <iframe
              src={pdfDataUrl}
              style={{ width: '100%', height: '100%', border: 'none' }}
              title={`${prefix} ${recordNumber}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
