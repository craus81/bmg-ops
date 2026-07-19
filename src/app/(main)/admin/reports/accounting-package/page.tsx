'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

interface Totals {
  vendorInvoices: number;
  vendorInvoiceTotal: number;
  invoiceFiles: number;
  payoutsPaid: number;
  payoutsPaidTotal: number;
  payCredits: number;
  payCreditsTotal: number;
  unpricedCredits: number;
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lastMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
};

export default function AccountingPackagePage() {
  const router = useRouter();
  const { isAdmin, hasRole, loading: authLoading } = useAuth();
  const canUse = isAdmin || hasRole('finance');

  const [month, setMonth] = useState(lastMonth);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useCallback(async (mo: string) => {
    setLoading(true);
    setError(null);
    setTotals(null);
    try {
      const res = await fetch(`/api/reports/accounting-package?month=${mo}&preview=1`);
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Preview failed');
      else setTotals(data.totals);
    } catch (e: any) {
      setError(e.message || 'Preview failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!canUse) { router.push('/home'); return; }
    preview(month);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after auth resolves
  }, [authLoading, canUse, router]);

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/accounting-package?month=${month}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Export failed (${res.status})`);
      } else {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bmg-accounting-${month}.zip`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      setError(e.message || 'Export failed');
    }
    setDownloading(false);
  };

  const inputStyle: React.CSSProperties = {
    padding: '9px 12px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px',
  };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Monthly Accounting Package</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          One ZIP per month for your accountant: vendor invoices (with the original documents), payouts paid, and per-VIN pay credits — all with NetSuite references.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Month</div>
          <input type="month" style={inputStyle} value={month} onChange={e => { setMonth(e.target.value); if (e.target.value) preview(e.target.value); }} />
        </div>
        <button
          onClick={download}
          disabled={downloading || loading || !totals}
          style={{ padding: '10px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, background: downloading ? 'var(--text-muted)' : '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}
        >
          {downloading ? 'Building ZIP…' : 'Download Package'}
        </button>
      </div>

      {error && <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', marginBottom: '14px' }}>{error}</div>}
      {loading && <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '13px' }}>Checking what&apos;s in {month}…</div>}

      {totals && !loading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '14px' }}>
          {[
            { label: 'Vendor invoices', value: `${totals.vendorInvoices}`, sub: `${fmtMoney(totals.vendorInvoiceTotal)} · ${totals.invoiceFiles} files attached`, color: '#f472b6' },
            { label: 'Payouts paid', value: `${totals.payoutsPaid}`, sub: fmtMoney(totals.payoutsPaidTotal), color: '#22c55e' },
            { label: 'Pay credits earned', value: `${totals.payCredits}`, sub: fmtMoney(totals.payCreditsTotal), color: '#60a5fa' },
            { label: 'Unpriced credits', value: `${totals.unpricedCredits}`, sub: totals.unpricedCredits > 0 ? 'price before closing the month' : 'all priced', color: totals.unpricedCredits > 0 ? '#ef4444' : '#22c55e' },
          ].map(t => (
            <div key={t.label} style={{ padding: '14px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t.label}</div>
              <div style={{ fontSize: '20px', fontWeight: 800, color: t.color, marginTop: '2px' }}>{t.value}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t.sub}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--text-primary)' }}>What&apos;s inside:</strong> vendor-invoices.csv (with lifecycle dates and NetSuite bill numbers), invoice-files/ (the original uploaded documents, named by vendor and invoice number), payouts.csv (everything paid in the month), pay-credits.csv (per-VIN detail), and summary.csv. Every download is recorded in the audit log.
      </div>
    </div>
  );
}
