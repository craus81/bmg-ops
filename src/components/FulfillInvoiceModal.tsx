'use client';

/**
 * Fulfill & Invoice an estimate's sales order (Craig, 2026-10-21): parts-only
 * orders no vehicle, scan or check-in touches. Lists the order's lines live
 * from NetSuite with what's billed and on hand at O'Fallon, takes a "ship &
 * bill now" quantity per line (partial shipments allowed), and makes the
 * fulfillment and invoice via /api/estimates/[id]/fulfill-invoice (or, from
 * the sales order page, /api/sales-orders/[id]/fulfill-invoice). Then
 * offers the invoice PDF and the normal invoice email screen — a person
 * presses Send; nothing goes to the customer on its own.
 */

import { useEffect, useMemo, useState } from 'react';
import { closeOnEscape } from '@/lib/modal-escape';
import { openNetSuitePdf, openNetSuiteInvoicePdfByNumber } from '@/lib/netsuite-pdf-client';
import EmailInvoicesModal from '@/components/EmailInvoicesModal';
import { ADJUSTMENT_TYPES, SHIPPED_TYPES, defaultBillNow, openOn, type SoBillingLine } from '@/lib/so-fulfill-invoice';

interface Props {
  /** One of the two: the estimate's button, or the sales order page's (NetSuite id). */
  estimateId?: string;
  salesOrderId?: string;
  soLabel: string;
  onClose: () => void;
  /** Called after an invoice is made, so the screen behind can refresh. */
  onInvoiced?: () => void;
}

interface Done {
  invoiceId: string | null;
  invoiceNumber: string | null;
  fulfillmentNumber: string | null;
  units: number;
  customerName: string;
  customerNetsuiteId: string | null;
  poNumber: string | null;
  warning?: string;
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function FulfillInvoiceModal({ estimateId, salesOrderId, soLabel, onClose, onInvoiced }: Props) {
  const url = estimateId
    ? `/api/estimates/${estimateId}/fulfill-invoice`
    : `/api/sales-orders/${encodeURIComponent(salesOrderId || '')}/fulfill-invoice`;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [so, setSo] = useState<{ soNumber: string; customerName: string | null; poNumber: string | null; lines: SoBillingLine[] } | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [memo, setMemo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [opening, setOpening] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not read the sales order');
      setSo(data);
      const start: Record<number, string> = {};
      for (const l of data.lines as SoBillingLine[]) start[l.lineSeq] = String(defaultBillNow(l));
      setQty(start);
    } catch (e: any) {
      setError(e?.message || 'Could not read the sales order');
    } finally {
      setLoading(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per open
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => (so?.lines ?? []).map(l => {
    const open = openOn(l);
    const now = Math.max(0, Number(qty[l.lineSeq] || 0));
    const shipNow = SHIPPED_TYPES.has(l.itemType) && !l.dropShipPo ? Math.max(0, now - open.shippedNotBilled) : 0;
    const short = l.onHand !== null && shipNow > l.onHand;
    const over = now > open.toBill;
    return { l, open, now, short, over, amount: l.rate !== null ? now * l.rate : null };
  }), [so, qty]);

  const units = rows.reduce((s, r) => s + r.now, 0);
  const subtotal = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const anyOpen = rows.some(r => r.open.toBill > 0 || r.open.vendorWaiting > 0);
  const stillOpenAfter = rows.filter(r => r.open.toBill > 0 && r.now < r.open.toBill);
  const hasAdjustment = rows.some(r => ADJUSTMENT_TYPES.has(r.l.itemType) && !r.l.closed);
  const invalid = rows.some(r => r.over) || units <= 0 || (hasAdjustment && stillOpenAfter.length > 0);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const billNow: Record<string, number> = {};
      for (const r of rows) if (r.now > 0) billNow[String(r.l.lineSeq)] = r.now;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billNow, ...(memo.trim() ? { memo: memo.trim() } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Fulfill & Invoice failed');
      setDone(data);
      onInvoiced?.();
    } catch (e: any) {
      setError(e?.message || 'Fulfill & Invoice failed');
    } finally {
      setSubmitting(false);
    }
  };

  const openPdf = async () => {
    if (!done) return;
    setOpening(true);
    const r = done.invoiceId
      ? await openNetSuitePdf('invoice', done.invoiceId)
      : await openNetSuiteInvoicePdfByNumber(done.invoiceNumber || '');
    setOpening(false);
    if (!r.ok) setError(r.error || 'Could not open the invoice PDF');
  };

  const title = `Fulfill & Invoice ${so?.soNumber ? `SO ${so.soNumber}` : soLabel}`;
  const cell: React.CSSProperties = { padding: '8px', borderTop: '1px solid var(--border)', fontSize: '13px' };
  const num: React.CSSProperties = { ...cell, textAlign: 'right', whiteSpace: 'nowrap' };
  const head: React.CSSProperties = { padding: '8px', fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' };
  const btn = (bg: string, fg: string, border = 'none'): React.CSSProperties => ({
    padding: '10px 16px', borderRadius: '10px', border, background: bg, color: fg, fontWeight: 800, fontSize: '13px', cursor: 'pointer',
  });

  return (
    <>
      <div ref={closeOnEscape(emailing ? undefined : onClose)} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 1050, padding: '20px', overflowY: 'auto',
      }}>
        <div role="dialog" aria-label={title} onClick={e => e.stopPropagation()} style={{
          background: 'var(--card)', borderRadius: '14px', maxWidth: '820px', width: '100%',
          border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
          padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '18px', fontWeight: 800 }}>{title}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                {[so?.customerName, "Ships from BMG O'Fallon", so?.poNumber ? `PO ${so.poNumber}` : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', borderRadius: '8px', width: '32px', height: '32px', cursor: 'pointer' }}>✕</button>
          </div>

          {loading && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Reading the sales order from NetSuite…</div>}

          {error && (
            <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444', fontSize: '13px', fontWeight: 700 }}>
              {error}
            </div>
          )}

          {!loading && so && !done && (
            <>
              {!anyOpen ? (
                <div style={{ fontSize: '14px', fontWeight: 700, color: '#22c55e' }}>Nothing left to invoice on this sales order.</div>
              ) : (
                <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '10px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '600px' }}>
                    <thead>
                      <tr>
                        <th style={{ ...head, textAlign: 'left' }}>Item</th>
                        <th style={head}>Ordered</th>
                        <th style={head}>Billed</th>
                        <th style={head}>On hand</th>
                        <th style={head}>Ship &amp; bill now</th>
                        <th style={head}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ l, open, now, short, over, amount }) => {
                        const adjustment = ADJUSTMENT_TYPES.has(l.itemType);
                        const editable = !adjustment && open.toBill > 0;
                        return (
                          <tr key={l.lineSeq} style={{ opacity: editable || adjustment ? 1 : 0.55 }}>
                            <td style={cell}>
                              <div style={{ fontWeight: 700 }}>{l.itemNumber || `Line ${l.lineSeq}`}</div>
                              {l.description && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{l.description}</div>}
                              {adjustment && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Goes on the invoice that bills the rest of the order</div>}
                              {!adjustment && !l.dropShipPo && !SHIPPED_TYPES.has(l.itemType) && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No stock: billed, not shipped</div>}
                              {l.dropShipPo && (
                                <div style={{ fontSize: '11px', color: '#60a5fa', fontWeight: 700 }}>
                                  🚚 Drop ship, PO {l.dropShipPo}{open.vendorWaiting > 0 ? `: ${open.vendorWaiting} waiting on the vendor. Mark the PO shipped in NetSuite, then bill it here.` : ''}
                                </div>
                              )}
                            </td>
                            <td style={num}>{adjustment ? '' : l.ordered}</td>
                            <td style={num}>{adjustment ? '' : l.billed}</td>
                            <td style={{ ...num, color: short ? '#f59e0b' : undefined, fontWeight: short ? 800 : undefined }}>
                              {SHIPPED_TYPES.has(l.itemType) && !l.dropShipPo ? (l.onHand ?? '?') : '-'}
                            </td>
                            <td style={num}>
                              {editable ? (
                                <input
                                  aria-label={`Ship and bill now, ${l.itemNumber || `line ${l.lineSeq}`}`}
                                  type="number" min={0} max={open.toBill} step="any" inputMode="decimal"
                                  value={qty[l.lineSeq] ?? '0'}
                                  onChange={e => setQty(q => ({ ...q, [l.lineSeq]: e.target.value }))}
                                  style={{
                                    width: '70px', textAlign: 'right', padding: '6px', borderRadius: '6px',
                                    background: 'var(--input-bg, var(--card))', color: 'var(--text)',
                                    border: `1px solid ${over ? '#ef4444' : short ? '#f59e0b' : 'var(--border)'}`,
                                  }}
                                />
                              ) : adjustment ? '' : <span style={{ color: 'var(--text-muted)' }}>{open.vendorWaiting > 0 ? 'waiting' : 'done'}</span>}
                              {over && <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '2px' }}>Only {open.toBill} open</div>}
                            </td>
                            <td style={num}>{adjustment ? (l.amount !== null ? `-${money(l.amount)}` : '') : amount !== null && now > 0 ? money(amount) : ''}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {rows.some(r => r.short) && (
                <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b', fontSize: '13px', fontWeight: 700 }}>
                  Some lines are more than NetSuite shows on hand at O&apos;Fallon. NetSuite may refuse to ship them; lower the quantity to bill what&apos;s here and invoice the rest later.
                </div>
              )}
              {anyOpen && stillOpenAfter.length > 0 && !hasAdjustment && units > 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  The rest ({stillOpenAfter.map(r => `${r.open.toBill - r.now} ${r.l.itemNumber || `line ${r.l.lineSeq}`}`).join(', ')}) stays open on the sales order for another Fulfill &amp; Invoice later.
                </div>
              )}
              {hasAdjustment && stillOpenAfter.length > 0 && (
                <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.4)', color: '#f59e0b', fontSize: '13px', fontWeight: 700 }}>
                  This order has a discount line, so it can only be invoiced all at once from here. Bill everything that&apos;s left, or wait until the rest is in.
                </div>
              )}

              {anyOpen && (
                <>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 700, color: 'var(--text-label)' }}>
                    Memo (optional)
                    <input value={memo} onChange={e => setMemo(e.target.value)} maxLength={300} placeholder={`Invoice from BMG FleetSuite — ${so.soNumber || soLabel}`}
                      style={{ padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg, var(--card))', color: 'var(--text)', fontSize: '13px' }} />
                  </label>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
                    <div style={{ fontSize: '14px' }}>
                      Subtotal <strong>{money(subtotal)}</strong>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}> · NetSuite adds tax</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button onClick={onClose} style={btn('transparent', 'var(--text-label)', '1px solid var(--border)')}>Cancel</button>
                      <button onClick={submit} disabled={invalid || submitting}
                        style={{ ...btn('#22c55e', '#052e16'), opacity: invalid || submitting ? 0.5 : 1, cursor: invalid || submitting ? 'not-allowed' : 'pointer' }}>
                        {submitting ? 'Shipping and invoicing…' : `Fulfill & Invoice (${units} unit${units !== 1 ? 's' : ''})`}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {done && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ fontSize: '17px', fontWeight: 800, color: '#22c55e' }}>
                Invoice {done.invoiceNumber || done.invoiceId || ''} created in NetSuite
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-label)' }}>
                {done.fulfillmentNumber ? `Fulfillment ${done.fulfillmentNumber} shipped from O'Fallon. ` : ''}
                {done.units} unit{done.units !== 1 ? 's' : ''} billed.
              </div>
              {done.warning && <div style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 700 }}>{done.warning}</div>}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button onClick={openPdf} disabled={opening || !(done.invoiceId || done.invoiceNumber)}
                  style={btn('rgba(96,165,250,0.12)', '#60a5fa', '1px solid rgba(96,165,250,0.5)')}>
                  {opening ? 'Opening…' : 'Invoice PDF (Print / Save)'}
                </button>
                <button onClick={() => setEmailing(true)} disabled={!done.invoiceNumber} style={btn('#22c55e', '#052e16')}>Email invoice…</button>
                <button onClick={() => { setDone(null); load(); }} style={btn('transparent', 'var(--text-label)', '1px solid var(--border)')}>Back to the order</button>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Email invoice opens the invoice email screen; nothing is sent until someone presses Send.
              </div>
            </div>
          )}
        </div>
      </div>
      {emailing && done?.invoiceNumber && (
        <EmailInvoicesModal
          customerName={done.customerName}
          customerNetsuiteId={done.customerNetsuiteId}
          invoices={[{ invoiceId: done.invoiceId || undefined, invoiceNumber: done.invoiceNumber, po: done.poNumber || undefined }]}
          onClose={() => setEmailing(false)}
        />
      )}
    </>
  );
}
