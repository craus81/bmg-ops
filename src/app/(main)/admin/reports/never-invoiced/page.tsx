'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { downloadCsv } from '@/lib/csv';
import { BUCKET_LABEL, BUCKET_HELP, type RecoveryBucket } from '@/lib/never-invoiced';

/**
 * Never-Invoiced Recovery Queue (R6-12) — the drill-down behind the
 * dashboard tile that only ever said "N vehicles". Oldest first, bucketed
 * by the work each one needs, with every row deep-linked to the vehicle
 * whose invoice is missing.
 */

interface Row {
  checkinId: string;
  vin: string;
  vehicle: string | null;
  customerName: string | null;
  status: string;
  completedAt: string | null;
  daysSince: number | null;
  bucket: RecoveryBucket;
  expectedAmount: number | null;
  amountPartial: boolean;
  amountSource: 'sales_order' | 'estimate' | null;
  salesOrders: { netsuiteId: string; number: string | null; total: number | null; invoiced: boolean; invoiceNumber: string | null }[];
  estimates: { id: string; number: string | null; status: string | null; total: number | null }[];
  url: string;
}

interface Report {
  rows: Row[];
  partiallyInvoiced: Row[];
  totals: {
    count: number;
    expectedTotal: number;
    unknownAmountCount: number;
    byBucket: Record<RecoveryBucket, { count: number; expectedTotal: number }>;
    oldestDays: number | null;
    partiallyInvoicedCount: number;
  };
  meta: { windowDays: number; generatedAt: string };
}

const BUCKETS: RecoveryBucket[] = ['has_so', 'estimate_only', 'no_paperwork'];

const BUCKET_COLOR: Record<RecoveryBucket, string> = {
  has_so: '#22c55e',
  estimate_only: '#f59e0b',
  no_paperwork: '#ef4444',
};

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Unknown is never rendered as $0 — that reads as "nothing is owed". */
const fmtAmount = (r: Row) =>
  r.expectedAmount == null ? 'unknown' : `${fmtMoney(r.expectedAmount)}${r.amountPartial ? '+' : ''}`;

const ageColor = (days: number | null) =>
  days == null ? 'var(--text-muted)' : days > 60 ? '#ef4444' : days > 30 ? '#f59e0b' : 'inherit';

export default function NeverInvoicedPage() {
  const { isAdmin, hasRole, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // deepLinks.neverInvoicedQueue(bucket) lands here — open on that bucket.
  const [bucket, setBucket] = useState<RecoveryBucket | 'all'>(() => {
    const b = searchParams?.get('bucket');
    return b && (BUCKETS as string[]).includes(b) ? (b as RecoveryBucket) : 'all';
  });
  const [search, setSearch] = useState('');

  // Mirrors the route's requireRole(req, ['executive']) — admins auto-pass there.
  const allowed = isAdmin || hasRole('executive');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/reports/never-invoiced');
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
    if (!allowed) { router.push('/home'); return; }
    load();
  }, [authLoading, allowed, router, load]);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      'never-invoiced-recovery.csv',
      ['VIN', 'Vehicle', 'Customer', 'Status', 'Completed', 'Days since', 'Needs', 'Expected', 'Amount known', 'Sales orders', 'Estimates'],
      report.rows.map(r => [
        r.vin, r.vehicle || '', r.customerName || '', r.status,
        r.completedAt ? r.completedAt.slice(0, 10) : '',
        r.daysSince ?? '',
        BUCKET_LABEL[r.bucket],
        r.expectedAmount ?? '',
        r.expectedAmount == null ? 'unknown' : (r.amountPartial ? 'partial' : 'yes'),
        r.salesOrders.filter(s => !s.invoiced).map(s => s.number || s.netsuiteId).join(' '),
        r.estimates.map(e => e.number || e.id).join(' '),
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
    (bucket === 'all' || r.bucket === bucket)
    && (!q
      || r.vin.toLowerCase().includes(q)
      || (r.vehicle || '').toLowerCase().includes(q)
      || (r.customerName || '').toLowerCase().includes(q)
      || r.salesOrders.some(s => (s.number || '').toLowerCase().includes(q))
      || r.estimates.some(e => (e.number || '').toLowerCase().includes(q))));

  const paperTrail = (r: Row) => {
    const openSos = r.salesOrders.filter(s => !s.invoiced);
    if (openSos.length) return `SO ${openSos.map(s => s.number || s.netsuiteId).join(', ')}`;
    if (r.estimates.length) return `Est ${r.estimates.map(e => e.number || 'draft').join(', ')}`;
    return '—';
  };

  if (authLoading || !allowed) return null;

  return (
    <div style={{ maxWidth: '1150px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Never-Invoiced Recovery</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Vehicles marked complete or shipped in the last {report?.meta.windowDays ?? 180} days with no invoice recorded anywhere —
        oldest first, grouped by what each one needs before it can be billed. This is the same count the dashboard tile shows.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {report && !loading && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {tile('Leaking', String(report.totals.count), report.totals.count > 0 ? '#ef4444' : '#22c55e', 'vehicles never invoiced')}
            {tile(
              'Expected revenue',
              report.totals.expectedTotal > 0 ? fmtMoney(report.totals.expectedTotal) : '—',
              '#2563eb',
              report.totals.unknownAmountCount > 0
                ? `${report.totals.unknownAmountCount} more with no figure on file`
                : 'from the open paperwork',
            )}
            {tile('Oldest', report.totals.oldestDays == null ? '—' : `${report.totals.oldestDays}d`,
              (report.totals.oldestDays ?? 0) > 60 ? '#ef4444' : '#f59e0b', 'since completion')}
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {(['all', ...BUCKETS] as const).map(key => {
              const active = bucket === key;
              const count = key === 'all' ? report.totals.count : report.totals.byBucket[key].count;
              return (
                <button
                  key={key}
                  onClick={() => setBucket(key)}
                  style={{
                    padding: '7px 12px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px', fontWeight: 700,
                    border: `1px solid ${active ? (key === 'all' ? 'var(--text-primary)' : BUCKET_COLOR[key]) : 'var(--border)'}`,
                    background: active ? 'var(--card)' : 'transparent',
                    color: key === 'all' ? 'var(--text-primary)' : BUCKET_COLOR[key],
                  }}
                >
                  {key === 'all' ? 'All' : BUCKET_LABEL[key]} · {count}
                </button>
              );
            })}
          </div>

          {bucket !== 'all' && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>{BUCKET_HELP[bucket]}</div>
          )}

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search VIN, customer, SO #, estimate #…"
              style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px', minWidth: '250px' }}
            />
            <button
              onClick={exportCsv}
              style={{ padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
            >Export CSV</button>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{rows.length} of {report.rows.length} vehicles</span>
          </div>

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>Vehicle</th>
                  <th style={{ padding: '8px 12px' }}>Customer</th>
                  <th style={{ padding: '8px 12px' }}>Completed</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Waiting</th>
                  <th style={{ padding: '8px 12px' }}>Needs</th>
                  <th style={{ padding: '8px 12px' }}>Paperwork</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Expected</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.checkinId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}>
                      <Link href={r.url} style={{ color: 'var(--accent, #2563eb)', fontWeight: 700, textDecoration: 'none' }}>
                        {r.vehicle || r.vin}
                      </Link>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{r.vin}</div>
                    </td>
                    <td style={{ padding: '8px 12px' }}>{r.customerName || '—'}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      {r.completedAt ? new Date(r.completedAt).toLocaleDateString() : <span style={{ color: 'var(--text-muted)' }}>not recorded</span>}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: (r.daysSince ?? 0) > 60 ? 800 : 400, color: ageColor(r.daysSince) }}>
                      {r.daysSince == null ? '—' : `${r.daysSince}d`}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ color: BUCKET_COLOR[r.bucket], fontWeight: 700, fontSize: '12px' }}>{BUCKET_LABEL[r.bucket]}</span>
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>{paperTrail(r)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: r.expectedAmount == null ? 'var(--text-muted)' : 'inherit' }}>
                      {fmtAmount(r)}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    {report.rows.length === 0 ? 'Nothing leaking — every completed vehicle in the window is invoiced.' : 'No vehicles match this filter.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {report.partiallyInvoiced.length > 0 && (
            <div style={{ marginTop: '18px' }}>
              <h2 style={{ fontSize: '15px', fontWeight: 800, marginBottom: '4px' }}>
                Partly invoiced — {report.partiallyInvoiced.length} vehicle{report.partiallyInvoiced.length === 1 ? '' : 's'}
              </h2>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                At least one sales order on these vehicles was billed and at least one never was. They are NOT in the count above —
                that count matches the dashboard tile, which asks whether a vehicle has any invoice at all — but the unbilled orders are the same leak.
              </div>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px' }}>Vehicle</th>
                      <th style={{ padding: '8px 12px' }}>Customer</th>
                      <th style={{ padding: '8px 12px' }}>Billed</th>
                      <th style={{ padding: '8px 12px' }}>Still open</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.partiallyInvoiced.map(r => (
                      <tr key={r.checkinId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px' }}>
                          <Link href={r.url} style={{ color: 'var(--accent, #2563eb)', fontWeight: 700, textDecoration: 'none' }}>
                            {r.vehicle || r.vin}
                          </Link>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{r.vin}</div>
                        </td>
                        <td style={{ padding: '8px 12px' }}>{r.customerName || '—'}</td>
                        <td style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                          {r.salesOrders.filter(s => s.invoiced).map(s => s.invoiceNumber || s.number || s.netsuiteId).join(', ') || '—'}
                        </td>
                        <td style={{ padding: '8px 12px', fontSize: '12px' }}>
                          {r.salesOrders.filter(s => !s.invoiced).map(s => s.number || s.netsuiteId).join(', ') || '—'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: r.expectedAmount == null ? 'var(--text-muted)' : 'inherit' }}>
                          {fmtAmount(r)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
            &ldquo;Waiting&rdquo; counts from the vehicle&rsquo;s completion event; a vehicle with no status event on file shows &mdash; and sorts last.
            &ldquo;Expected&rdquo; is the open paperwork&rsquo;s own total &mdash; a trailing + means some of it carried no figure, so the real number is higher.
            &ldquo;unknown&rdquo; means nothing on file carried a total, not that nothing is owed.
          </div>
        </>
      )}
    </div>
  );
}
