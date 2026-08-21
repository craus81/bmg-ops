'use client';

/**
 * Every NetSuite transaction a part appears on — invoices, sales orders,
 * estimates — newest first, from the parts catalog (field ask, 2026-08-21:
 * "search a part number, look at the invoice, then easily print a packing
 * list for any order"). Each row opens the record's NetSuite PDF and can
 * print a packing list built from that transaction's own lines (customer,
 * PO, qty + part + description).
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { exportPackingListPDF } from '@/lib/packing-list-pdf';
import { deepLinks } from '@/lib/deep-links';

interface TxRow {
  id: string;
  tranid: string;
  type: string;
  date: string | null;
  poNumber: string | null;
  customer: string | null;
  quantity: number;
  /** The FleetSuite graphics job behind this transaction, when one exists. */
  graphicsJob: { id: string; jobNumber: string | null; title: string | null } | null;
}

const TYPE_LABELS: Record<string, string> = {
  CustInvc: 'Invoice',
  SalesOrd: 'Sales Order',
  Estimate: 'Estimate',
};
const PDF_TYPES: Record<string, 'invoice' | 'salesOrder' | 'estimate'> = {
  CustInvc: 'invoice',
  SalesOrd: 'salesOrder',
  Estimate: 'estimate',
};

interface Props {
  partNumber: string;
  /** NetSuite item internal id (netsuite_parts.netsuite_id). */
  itemId: string;
  onClose: () => void;
}

export default function PartTransactionsModal({ partNumber, itemId, onClose }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<TxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/parts/transactions?itemId=${encodeURIComponent(itemId)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || 'Failed to load transactions');
        else setRows(data.transactions || []);
      } catch {
        if (!cancelled) setError('Network error loading transactions');
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [itemId]);

  const printPackingList = async (tx: TxRow) => {
    setWorking(tx.id);
    setError(null);
    try {
      const res = await fetch(`/api/netsuite/transaction-packing/${tx.id}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Could not load the transaction lines'); return; }
      exportPackingListPDF({
        title: `${TYPE_LABELS[data.header.type] || data.header.type} ${data.header.tranid}`,
        customer: data.header.customer,
        poNumber: data.header.poNumber,
        invoiceNumber: data.header.type === 'CustInvc' ? data.header.tranid : null,
        dueDate: null,
        lines: data.lines,
      }, { print: true });
    } catch {
      setError('Network error building the packing list');
    } finally {
      setWorking(null);
    }
  };

  const fmtDate = (s: string | null) => {
    if (!s) return '—';
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1400, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
      <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Part transactions"
        style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px', width: 'min(720px, 100%)', maxHeight: 'calc(100vh / var(--ts) - 40px)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>Transactions — {partNumber}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: 0 }}>✕</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '12px' }}>Loading from NetSuite…</div>
        ) : rows.length === 0 && !error ? (
          <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '12px' }}>
            This part hasn&apos;t appeared on any invoice, sales order, or estimate.
          </div>
        ) : (
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {rows.map(tx => (
              <div key={tx.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 4px', borderBottom: '1px solid var(--border)', fontSize: '12px', flexWrap: 'wrap' }}>
                <span style={{ width: '84px', color: 'var(--text-muted)', flexShrink: 0 }}>{fmtDate(tx.date)}</span>
                <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', flexShrink: 0,
                  background: tx.type === 'CustInvc' ? 'rgba(34,197,94,0.12)' : tx.type === 'SalesOrd' ? 'rgba(96,165,250,0.12)' : 'rgba(167,139,250,0.12)',
                  color: tx.type === 'CustInvc' ? '#22c55e' : tx.type === 'SalesOrd' ? '#60a5fa' : '#a78bfa' }}>
                  {TYPE_LABELS[tx.type] || tx.type}
                </span>
                <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{tx.tranid}</span>
                <span style={{ flex: 1, minWidth: '120px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tx.customer || '—'}{tx.poNumber ? ` · PO ${tx.poNumber}` : ''}
                </span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>qty {tx.quantity}</span>
                <span style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  {tx.graphicsJob && (
                    <button onClick={() => router.push(deepLinks.graphicsJob(tx.graphicsJob!.id))}
                      title={`Open graphics job ${tx.graphicsJob.jobNumber ? `#${tx.graphicsJob.jobNumber}` : ''}${tx.graphicsJob.title ? ` — ${tx.graphicsJob.title}` : ''}`}
                      style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa' }}>
                      🎨 Job
                    </button>
                  )}
                  <button onClick={() => openNetSuitePdf(PDF_TYPES[tx.type] || 'invoice', tx.id)}
                    title="Open the record's NetSuite PDF"
                    style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa' }}>
                    PDF
                  </button>
                  <button onClick={() => printPackingList(tx)} disabled={!!working}
                    title="Print a packing list built from this transaction's lines"
                    style={{ padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', opacity: working === tx.id ? 0.6 : 1 }}>
                    {working === tx.id ? '…' : 'Packing List'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        {error && <div style={{ fontSize: '11px', color: 'var(--error, #ef4444)' }}>{error}</div>}
      </div>
    </div>
  );
}
