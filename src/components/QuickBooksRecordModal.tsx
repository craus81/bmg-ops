'use client';

/**
 * One QuickBooks sales document from before the cutover, opened from any list
 * that merges QuickBooks history in (a customer's Transactions, the Invoices
 * search). Read-only by design (src/lib/ledger/history.ts): the lines are the
 * point, so a build done years ago can be read off and repeated, and the
 * stored QuickBooks PDF and attachments open through the ledger document
 * route. Nothing here emails, pushes or records a payment.
 */

import { useEffect, useState } from 'react';
import { deepLinks } from '@/lib/deep-links';
import type { HistoryDetail } from '@/lib/ledger/history';

interface Props {
  recordId: string;
  onClose: () => void;
  /** Where the PDF viewer's ← lands when its tab can't close itself. */
  backHref?: string | null;
  backLabel?: string | null;
}

const usd = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmtDate = (d: string | null) => {
  if (!d) return '—';
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]}` : d;
};

const fmtSize = (n: number | null) => {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const th: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left' };
const td: React.CSSProperties = { fontSize: '12.5px', color: 'var(--text-secondary)', padding: '6px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' };
const btn: React.CSSProperties = { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' };

export default function QuickBooksRecordModal({ recordId, onClose, backHref, backLabel }: Props) {
  const [record, setRecord] = useState<HistoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRecord(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/ledger/history/${recordId}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !body.success) setError(body.error || `Could not load the record (${res.status})`);
        else setRecord(body.record);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not load the record');
      }
    })();
    return () => { cancelled = true; };
  }, [recordId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pdf = record?.documents.find(d => d.kind === 'pdf') || null;
  const attachments = record?.documents.filter(d => d.kind === 'attachment') || [];
  // Subtotal/description rows carry no money of their own; keep them as
  // headings so a grouped build still reads the way it was written.
  const lines = record?.lines.filter(l => l.kind !== 'tax') || [];

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="QuickBooks record"
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', width: 'min(820px, 100%)', maxHeight: 'calc(90vh / var(--ts))', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', background: 'rgba(44,160,28,0.14)', color: '#2ca01c' }}>QuickBooks</span>
              <span style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                {record ? `${record.typeLabel} #${record.number}` : 'Loading…'}
              </span>
            </div>
            {record && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {record.customerName} · {fmtDate(record.date)}{record.po ? ` · PO ${record.po}` : ''} · {record.status}
              </div>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ ...btn, padding: '4px 10px' }}>✕</button>
        </div>

        {error && <div style={{ fontSize: '12.5px', color: 'var(--error)', padding: '8px 0' }}>{error}</div>}
        {!record && !error && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading the QuickBooks record…</div>}

        {record && (
          <>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
              {pdf ? (
                <a
                  href={deepLinks.pdfViewer(deepLinks.ledgerDocument(pdf.id), { name: pdf.fileName, back: backHref, backLabel })}
                  target="_blank" rel="noopener noreferrer"
                  style={{ ...btn, color: '#60a5fa' }}
                >Open QuickBooks PDF</a>
              ) : (
                <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', alignSelf: 'center' }}>No PDF was stored for this record.</span>
              )}
            </div>

            {(record.memo || record.customerMemo) && (
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 10px', marginBottom: '12px', whiteSpace: 'pre-wrap' }}>
                {record.customerMemo || record.memo}
                {record.customerMemo && record.memo && record.memo !== record.customerMemo && (
                  <div style={{ marginTop: '6px', color: 'var(--text-muted)' }}>Internal: {record.memo}</div>
                )}
              </div>
            )}

            <div className="responsive-table">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Item</th>
                    <th style={th}>Description</th>
                    <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                    <th style={{ ...th, textAlign: 'right' }}>Rate</th>
                    <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr><td colSpan={5} style={{ ...td, color: 'var(--text-muted)' }}>QuickBooks had no lines on this record.</td></tr>
                  )}
                  {lines.map((l, i) => {
                    const heading = l.kind === 'subtotal' || l.kind === 'group' || l.kind === 'description';
                    return (
                      <tr key={i}>
                        <td style={{ ...td, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                          {l.kind === 'subtotal' ? 'Subtotal' : l.itemName || l.itemNumber || ''}
                        </td>
                        <td style={{ ...td, whiteSpace: 'pre-wrap', fontStyle: heading && !l.itemName ? 'italic' : undefined }}>{l.description || ''}</td>
                        <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{l.quantity ?? ''}</td>
                        <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{l.unitPrice !== null ? usd(l.unitPrice) : ''}</td>
                        <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>{l.kind === 'description' ? '' : usd(l.amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '16px', flexWrap: 'wrap', fontSize: '12.5px', marginTop: '8px', color: 'var(--text-secondary)' }}>
              {record.subtotal !== null && <span>Subtotal <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(record.subtotal)}</strong></span>}
              {record.taxTotal !== null && <span>Tax <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(record.taxTotal)}</strong></span>}
              <span>Total <strong style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>{usd(record.total)}</strong></span>
            </div>

            {(record.shipAddress || record.billAddress || record.terms || record.dueDate || record.shipDate) && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginTop: '14px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {record.billAddress && <div><div style={{ ...th, border: 'none', padding: '0 0 3px' }}>Bill to</div><div style={{ whiteSpace: 'pre-wrap' }}>{record.billAddress}</div></div>}
                {record.shipAddress && <div><div style={{ ...th, border: 'none', padding: '0 0 3px' }}>Ship to</div><div style={{ whiteSpace: 'pre-wrap' }}>{record.shipAddress}</div></div>}
                {(record.terms || record.dueDate) && <div><div style={{ ...th, border: 'none', padding: '0 0 3px' }}>Terms</div><div>{record.terms || '—'}{record.dueDate ? ` · due ${fmtDate(record.dueDate)}` : ''}</div></div>}
                {record.shipDate && <div><div style={{ ...th, border: 'none', padding: '0 0 3px' }}>Ship date</div><div>{fmtDate(record.shipDate)}</div></div>}
              </div>
            )}

            {attachments.length > 0 && (
              <div style={{ marginTop: '14px' }}>
                <div style={{ ...th, border: 'none', padding: '0 0 6px' }}>Attachments · {attachments.length}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  {attachments.map(a => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px' }}>
                      <a href={/pdf/i.test(a.contentType || '') || /\.pdf$/i.test(a.fileName) ? deepLinks.pdfViewer(deepLinks.ledgerDocument(a.id), { name: a.fileName, back: backHref, backLabel }) : deepLinks.ledgerDocument(a.id)} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontWeight: 700, textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{a.fileName}</a>
                      <span style={{ color: 'var(--text-muted)', fontSize: '11px', flexShrink: 0 }}>{fmtSize(a.sizeBytes)}</span>
                      <span style={{ flex: 1 }} />
                      <a href={`${deepLinks.ledgerDocument(a.id)}?download=1`} style={{ ...btn, padding: '3px 9px' }}>Download</a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '14px', lineHeight: 1.5 }}>
              Imported from QuickBooks, from before NetSuite took over. It&apos;s read-only here and isn&apos;t counted in any balance.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
