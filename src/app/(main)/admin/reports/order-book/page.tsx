'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { downloadCsv } from '@/lib/csv';

/**
 * Open Order Book (R4-3): every open sales order from the NetSuite mirror —
 * sold total, billed progress, unbilled remainder, age. The headline
 * numbers here are the SAME loadOrderBook() the nightly snapshots and the
 * CEO view read, so this page is the drill-down behind those tiles.
 */

interface OrderBookRow {
  id: string;
  netsuiteId: string;
  tranid: string | null;
  customerName: string | null;
  trandate: string | null;
  statusLabel: string | null;
  total: number;
  unbilled: number;
  billedPct: number;
  ageDays: number;
}

interface Report {
  rows: OrderBookRow[];
  totals: {
    count: number;
    value: number;
    unbilled: number;
    over60Count: number;
    aging: { d0_30: number; d31_60: number; d61_90: number; d90plus: number };
  };
  meta: { mirrorSyncedAt: string | null };
}

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const soUrl = (netsuiteId: string) =>
  `https://system.netsuite.com/app/accounting/transactions/salesord.nl?id=${netsuiteId}`;

export default function OrderBookPage() {
  const { isAdmin, isSales, loading: authLoading } = useAuth();
  const router = useRouter();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/reports/order-book');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Report failed');
      setReport(data as Report);
    } catch (e: any) {
      setError(e.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    load();
  }, [authLoading, isAdmin, isSales, router, load]);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      'open-order-book.csv',
      ['SO', 'Customer', 'Date', 'Status', 'Age (days)', 'Total', 'Billed %', 'Unbilled'],
      report.rows.map(r => [
        r.tranid || '', r.customerName || '', r.trandate || '', r.statusLabel || '',
        r.ageDays, r.total, r.billedPct, r.unbilled,
      ]),
    );
  };

  const tile = (label: string, value: string, color: string, sub?: string) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '150px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color, marginTop: '2px' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );

  const q = search.trim().toLowerCase();
  const rows = (report?.rows || []).filter(r =>
    !q
    || (r.tranid || '').toLowerCase().includes(q)
    || (r.customerName || '').toLowerCase().includes(q)
    || (r.statusLabel || '').toLowerCase().includes(q));

  if (authLoading || (!isAdmin && !isSales)) return null;

  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Open Order Book</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Every open sales order with what&rsquo;s sold, what&rsquo;s billed, and the unbilled remainder — money sold but not yet invoiced.
        {report?.meta.mirrorSyncedAt && (
          <> Mirror synced {new Date(report.meta.mirrorSyncedAt).toLocaleString()} (refreshes every 2 hours).</>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {report && !loading && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {tile('Order book', fmtMoney(report.totals.value), '#2563eb', `${report.totals.count} open orders`)}
            {tile('Unbilled', fmtMoney(report.totals.unbilled), '#f59e0b', 'sold, not yet invoiced')}
            {tile('Over 60 days old', String(report.totals.over60Count), report.totals.over60Count > 0 ? '#ef4444' : '#22c55e', `${fmtMoney(report.totals.aging.d61_90 + report.totals.aging.d90plus)} of backlog`)}
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search SO #, customer, status…"
              style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', minWidth: '240px' }}
            />
            <button
              onClick={exportCsv}
              style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
            >Export CSV</button>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{rows.length} of {report.rows.length} orders</span>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>SO</th>
                  <th style={{ padding: '8px 12px' }}>Customer</th>
                  <th style={{ padding: '8px 12px' }}>Date</th>
                  <th style={{ padding: '8px 12px' }}>Status</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Age</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Billed</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Unbilled</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      <a href={soUrl(r.netsuiteId)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent, #2563eb)', fontWeight: 700, textDecoration: 'none' }}>
                        {r.tranid || r.netsuiteId} ↗
                      </a>
                    </td>
                    <td style={{ padding: '8px 12px' }}>{r.customerName || '—'}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{r.trandate || '—'}</td>
                    <td style={{ padding: '8px 12px' }}>{r.statusLabel || '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: r.ageDays > 60 ? 800 : 400, color: r.ageDays > 60 ? '#ef4444' : r.ageDays > 30 ? '#f59e0b' : 'inherit' }}>{r.ageDays}d</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{fmtMoney(r.total)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{r.billedPct}%</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{fmtMoney(r.unbilled)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>No open sales orders{q ? ' match the search' : ''}.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
            Unbilled = each line&rsquo;s amount scaled by its unbilled quantity fraction. Age is from the SO&rsquo;s transaction date. Rows open the sales order in NetSuite.
          </div>
        </>
      )}
    </div>
  );
}
