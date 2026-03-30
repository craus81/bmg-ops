'use client';

import { useState } from 'react';

interface SalesOrderPdfProps {
  salesOrderId: string | null;
  salesOrderNumber: string | null;
}

/**
 * Inline Sales Order PDF viewer.
 * Fetches the PDF from NetSuite via our API, shows an inline preview,
 * and opens in a new tab when clicked (for printing).
 */
export default function SalesOrderPdf({ salesOrderId, salesOrderNumber }: SalesOrderPdfProps) {
  const [pdfDataUrl, setPdfDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(true);

  if (!salesOrderId || !salesOrderNumber) return null;

  const fetchPdf = async () => {
    if (pdfDataUrl) {
      // Already loaded — just toggle visibility
      setCollapsed(!collapsed);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/netsuite/sales-order-pdf?id=${encodeURIComponent(salesOrderId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Failed to load PDF');
        return;
      }
      const dataUrl = `data:application/pdf;base64,${data.pdfBase64}`;
      setPdfDataUrl(dataUrl);
      setCollapsed(false);
    } catch (err: any) {
      setError(err.message || 'Network error');
    } finally {
      setLoading(false);
    }
  };

  const openInNewTab = () => {
    if (!pdfDataUrl) return;
    // Create a blob URL for better print support
    const byteChars = atob(pdfDataUrl.split(',')[1]);
    const byteNumbers = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteNumbers], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);
    window.open(blobUrl, '_blank');
  };

  return (
    <div style={{ marginTop: '8px' }}>
      {/* Toggle button */}
      <button
        onClick={fetchPdf}
        disabled={loading}
        style={{
          width: '100%', padding: '10px 14px', borderRadius: '10px',
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
            Loading SO #{salesOrderNumber}...
          </>
        ) : (
          <>
            <span>📄</span>
            {pdfDataUrl && !collapsed ? `Hide SO #${salesOrderNumber}` : `View SO #${salesOrderNumber} PDF`}
            <span style={{ fontSize: '10px' }}>{pdfDataUrl && !collapsed ? '▲' : '▼'}</span>
          </>
        )}
      </button>

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
          {/* Click to open hint */}
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
            <span>🖨️</span> Tap to open in new window for printing
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
              title={`Sales Order ${salesOrderNumber}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}
