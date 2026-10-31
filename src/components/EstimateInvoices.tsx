'use client';

/**
 * The invoices billed from the estimate's sales order (migration 461, Craig
 * 2026-10-31, thread "Auto-link invoice when linking a sales order"), under
 * the estimate's SO bar. Comes with Link SO and the two-hour sync, and is
 * checked again when the estimate opens. Tap a number for the NetSuite PDF.
 */

import { useCallback, useEffect, useState } from 'react';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { useDialog } from '@/components/DialogProvider';

interface EstimateInvoice {
  id: string;
  number: string;
  date: string | null;
  total: number | null;
  status: string | null;
}

interface EstimateInvoicesData {
  linked: boolean;
  billing: 'none' | 'partial' | 'full' | null;
  checkedAt: string | null;
  checkError: string | null;
  soTotal: number | null;
  invoices: EstimateInvoice[];
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} hour${hrs === 1 ? '' : 's'} ago` : new Date(iso).toLocaleDateString('en-US');
}

export default function EstimateInvoices({ estimateId, soId }: {
  estimateId: string;
  /** The linked SO; a change (Link SO) reloads. */
  soId: string;
}) {
  const dialog = useDialog();
  const [data, setData] = useState<EstimateInvoicesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/estimates/${estimateId}/invoices`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load the invoices.'); return; }
      setError(null);
      setData(json);
    } catch {
      setError('Network error loading the invoices.');
    }
  }, [estimateId]);

  useEffect(() => { load(); }, [load, soId]);

  if (error) return <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '6px' }}>{error}</div>;
  if (!data?.linked) return null;

  const open = async (inv: EstimateInvoice) => {
    setOpening(inv.id);
    const r = await openNetSuitePdf('invoice', inv.id);
    setOpening(null);
    if (!r.ok) await dialog.alert(`Could not open invoice ${inv.number}: ${r.error}`, { error: true });
  };

  const billed = data.invoices.reduce((s, i) => s + (i.total || 0), 0);
  const left = data.billing === 'partial' && data.soTotal != null && data.invoices.every(i => i.total != null)
    ? Math.round((data.soTotal - billed) * 100) / 100
    : null;

  return (
    <div style={{
      width: '100%', marginTop: '6px', padding: '8px 12px', borderRadius: '10px',
      background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.25)', fontSize: '12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: data.invoices.length ? '4px' : 0 }}>
        <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Invoices</span>
        {data.billing === 'full' && (
          <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, background: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>Fully billed</span>
        )}
        {data.billing === 'partial' && (
          <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '11px', fontWeight: 800, background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Partly billed</span>
        )}
      </div>
      {data.invoices.length === 0 && (
        <div style={{ color: 'var(--text-muted)' }}>
          Nothing billed yet.{data.checkedAt ? ` Checked ${ago(data.checkedAt)}.` : ''}
        </div>
      )}
      {data.invoices.map((inv, i) => (
        <div key={inv.id} style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '5px 0',
          borderTop: i === 0 ? 'none' : '1px solid var(--border)',
        }}>
          <button
            onClick={() => open(inv)}
            disabled={opening === inv.id}
            title={`Open invoice ${inv.number} from NetSuite to view, print or save`}
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 800, color: '#60a5fa', textDecoration: 'underline', cursor: opening === inv.id ? 'wait' : 'pointer' }}
          >
            {opening === inv.id ? 'Opening…' : inv.number}
          </button>
          {inv.date && <span style={{ color: 'var(--text-muted)' }}>{day(inv.date)}</span>}
          {inv.total != null && <span style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--text-body)' }}>{money(inv.total)}</span>}
        </div>
      ))}
      {left != null && left > 0 && (
        <div style={{ marginTop: '4px', color: '#f59e0b' }}>{money(left)} still to bill on this order.</div>
      )}
      {data.checkError && (
        <div style={{ marginTop: '4px', color: '#dc2626' }}>
          Couldn&apos;t check NetSuite just now, so this may be out of date ({data.checkError}).
        </div>
      )}
    </div>
  );
}
