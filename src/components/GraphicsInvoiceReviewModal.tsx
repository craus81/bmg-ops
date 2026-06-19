'use client';

/**
 * Review & verify a graphics job's invoice lines BEFORE anything is created.
 *
 * Opens on "Create Invoice". Pulls a proposed set of lines from
 * /api/graphics/invoice-preview (one per part, quantities from the linked PO,
 * prices from the catalog/NetSuite), lets the user correct quantities, rates
 * and descriptions, then either prints a matching packing list or creates the
 * invoice with the verified lines. This is the fix for "quantities on the
 * invoice don't match reality" — nothing is created until it's been checked.
 */

import { useState, useEffect, useCallback } from 'react';
import type { GraphicsJob } from '@/lib/types';
import { exportPackingListPDF, packingListFromJob, type PackingListLine } from '@/lib/packing-list-pdf';

interface ReviewLine {
  key: string;
  partNumber: string;
  itemId: string | null;
  displayName: string;
  description: string;
  quantity: number;
  rate: number;
  found: boolean;
  qtySource: 'po' | 'job';
}

interface Props {
  job: GraphicsJob;
  onClose: () => void;
  onComplete: (result: {
    invoiceId?: string;
    invoiceNumber?: string;
    invoiceAmount?: number;
    lines: PackingListLine[];
  }) => void;
}

const genKey = () => Math.random().toString(36).slice(2, 10);

export default function GraphicsInvoiceReviewModal({ job, onClose, onComplete }: Props) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [customer, setCustomer] = useState<{ netsuiteId: string | null; name: string | null }>({ netsuiteId: null, name: null });
  const [poNumber, setPoNumber] = useState<string | null>(null);
  const [lines, setLines] = useState<ReviewLine[]>([]);
  const [skippedParts, setSkippedParts] = useState<string[]>([]);
  const [alreadyInvoiced, setAlreadyInvoiced] = useState<{ number?: string | null } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/graphics/invoice-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: job.id }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error || `Failed to load preview (${res.status})`);
        } else if (data.alreadyInvoiced) {
          setAlreadyInvoiced({ number: data.alreadyInvoiced.number });
        } else {
          setCustomer(data.customer || { netsuiteId: null, name: null });
          setPoNumber(data.poNumber || null);
          setSkippedParts(data.skippedParts || []);
          setLines((data.lines || []).map((l: any) => ({
            key: genKey(),
            partNumber: l.partNumber,
            itemId: l.itemId,
            displayName: l.displayName,
            description: l.displayName || l.partNumber || '',
            quantity: l.quantity,
            rate: l.rate,
            found: l.found,
            qtySource: l.qtySource,
          })));
        }
      } catch {
        if (!cancelled) setLoadError('Network error loading preview');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [job.id]);

  const updateLine = useCallback((key: string, patch: Partial<ReviewLine>) => {
    setLines(prev => prev.map(l => l.key === key ? { ...l, ...patch } : l));
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines(prev => prev.filter(l => l.key !== key));
  }, []);

  // Lines that can go on the invoice (matched to a NetSuite item, qty > 0).
  const invoiceLines = lines.filter(l => l.found && l.itemId && l.quantity > 0);
  const unpriced = invoiceLines.filter(l => !(l.rate > 0));
  const total = invoiceLines.reduce((sum, l) => sum + l.quantity * l.rate, 0);

  // Packing list reflects everything being shipped (qty > 0), found or not.
  const packingLines = (): PackingListLine[] =>
    lines.filter(l => l.quantity > 0).map(l => ({
      partNumber: l.partNumber,
      description: l.description || l.displayName || '',
      quantity: l.quantity,
    }));

  const canCreate = !!customer.netsuiteId && invoiceLines.length > 0 && unpriced.length === 0 && !submitting;

  const printPackingList = () => {
    try {
      exportPackingListPDF(packingListFromJob(job, { lines: packingLines() }), { print: true });
    } catch {
      setError('Could not generate the packing list.');
    }
  };

  const createInvoice = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/graphics/create-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          lines: invoiceLines.map(l => ({
            itemId: l.itemId,
            quantity: l.quantity,
            rate: l.rate,
            description: l.description.trim() || undefined,
            partNumber: l.partNumber || undefined,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setError(data.error || `Failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      onComplete({
        invoiceId: data.invoiceId,
        invoiceNumber: data.invoiceNumber,
        invoiceAmount: data.invoiceAmount,
        lines: packingLines(),
      });
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setSubmitting(false);
    }
  };

  const numInput: React.CSSProperties = {
    width: '100%', padding: '6px 8px', borderRadius: '6px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-primary)', fontSize: '12px', boxSizing: 'border-box',
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 1000, padding: '20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '760px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
      }}>
        {/* Header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Review &amp; Verify Invoice</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {job.title || 'Graphics job'}{job.job_number ? ` · #${job.job_number}` : ''}{poNumber ? ` · PO #${poNumber}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading proposed lines…</div>
          ) : loadError ? (
            <div style={{ padding: '12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))', border: '1px solid var(--danger, #ef4444)', fontSize: '12px', color: 'var(--danger, #ef4444)' }}>{loadError}</div>
          ) : alreadyInvoiced ? (
            <div style={{ padding: '12px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', fontSize: '13px', color: '#22c55e' }}>
              This job is already invoiced{alreadyInvoiced.number ? ` as #${alreadyInvoiced.number}` : ''}.
            </div>
          ) : (
            <>
              {/* Customer */}
              <div style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                <span style={{ color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', fontSize: '11px' }}>Customer</span>
                <div style={{ marginTop: '4px' }}>
                  {customer.name || '—'}
                  {customer.netsuiteId
                    ? <span style={{ color: 'var(--text-muted)', marginLeft: '8px' }}>NS {customer.netsuiteId}</span>
                    : <span style={{ color: 'var(--danger, #ef4444)', marginLeft: '8px', fontWeight: 700 }}>· no NetSuite customer — set it on the job first</span>}
                </div>
              </div>

              {/* Quantity source hint */}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Quantities are suggested from {poNumber ? `PO #${poNumber}` : 'the linked PO'} where parts match, otherwise the job quantity ({job.quantity || 1}).
                Check each line before creating anything.
              </div>

              {/* Parts not in NetSuite */}
              {skippedParts.length > 0 && (
                <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', fontSize: '11px', color: '#f59e0b' }}>
                  Not found in NetSuite (won't be invoiced): {skippedParts.join(', ')}
                </div>
              )}

              {/* Lines */}
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px 70px 28px', gap: '8px', padding: '0 4px 6px', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  <div>Part / Description</div>
                  <div style={{ textAlign: 'center' }}>Qty</div>
                  <div style={{ textAlign: 'center' }}>Rate</div>
                  <div style={{ textAlign: 'right' }}>Total</div>
                  <div />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {lines.length === 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px' }}>No parts on this job.</div>
                  )}
                  {lines.map(line => {
                    const lineUnpriced = line.found && !(line.rate > 0);
                    return (
                      <div key={line.key} style={{
                        padding: '10px', borderRadius: '8px',
                        border: `1px solid ${line.found ? 'var(--border)' : 'rgba(245,158,11,0.4)'}`,
                        background: line.found ? 'var(--card)' : 'rgba(245,158,11,0.04)',
                      }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 110px 70px 28px', gap: '8px', alignItems: 'center' }}>
                          {/* Part + description */}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{line.partNumber || '—'}</span>
                              {line.qtySource === 'po' && (
                                <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }}>PO QTY</span>
                              )}
                              {!line.found && (
                                <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '4px', background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>NOT IN NS</span>
                              )}
                            </div>
                            <input
                              type="text"
                              value={line.description}
                              onChange={e => updateLine(line.key, { description: e.target.value })}
                              placeholder="Description"
                              style={{ ...numInput, marginTop: '6px', fontSize: '11px' }}
                            />
                          </div>
                          {/* Qty */}
                          <input
                            type="number" min={0} step={1} value={line.quantity}
                            onChange={e => updateLine(line.key, { quantity: Math.max(0, parseFloat(e.target.value) || 0) })}
                            style={{ ...numInput, textAlign: 'center' }}
                          />
                          {/* Rate */}
                          <input
                            type="number" min={0} step={0.01} value={line.rate}
                            onChange={e => updateLine(line.key, { rate: Math.max(0, parseFloat(e.target.value) || 0) })}
                            style={{ ...numInput, textAlign: 'center', border: `1px solid ${lineUnpriced ? 'var(--danger, #ef4444)' : 'var(--border)'}` }}
                          />
                          {/* Line total */}
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', textAlign: 'right' }}>
                            ${(line.quantity * line.rate).toFixed(2)}
                          </div>
                          {/* Remove */}
                          <button
                            onClick={() => removeLine(line.key)}
                            title="Remove line"
                            style={{ background: 'transparent', border: 'none', color: 'var(--danger, #ef4444)', fontSize: '16px', cursor: 'pointer', padding: 0 }}
                          >✕</button>
                        </div>
                        {lineUnpriced && (
                          <div style={{ fontSize: '10px', color: 'var(--danger, #ef4444)', marginTop: '6px' }}>Enter a price for this part to invoice it.</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Total */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Invoice total · {invoiceLines.length} line{invoiceLines.length !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>${total.toFixed(2)}</div>
              </div>

              {error && (
                <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--danger, #ef4444) 8%, var(--card))', border: '1px solid var(--danger, #ef4444)', fontSize: '12px', color: 'var(--danger, #ef4444)' }}>{error}</div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && !loadError && !alreadyInvoiced && (
          <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              onClick={printPackingList}
              disabled={packingLines().length === 0}
              style={{
                padding: '10px 14px', borderRadius: '10px', border: '1px solid rgba(34,197,94,0.3)',
                background: 'rgba(34,197,94,0.1)', color: '#22c55e', fontSize: '13px', fontWeight: 700,
                cursor: packingLines().length === 0 ? 'not-allowed' : 'pointer', opacity: packingLines().length === 0 ? 0.5 : 1,
              }}
            >Print Packing List</button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={onClose}
                style={{ padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
              >Cancel</button>
              <button
                onClick={createInvoice}
                disabled={!canCreate}
                title={!customer.netsuiteId ? 'Set the customer on the job first' : unpriced.length > 0 ? 'Some lines need a price' : undefined}
                style={{
                  padding: '10px 18px', borderRadius: '10px', border: 'none',
                  background: canCreate ? '#22c55e' : 'var(--border)', color: '#fff', fontSize: '14px', fontWeight: 800,
                  cursor: canCreate ? 'pointer' : 'not-allowed', opacity: canCreate ? 1 : 0.5,
                }}
              >{submitting ? 'Creating…' : 'Create Invoice'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
