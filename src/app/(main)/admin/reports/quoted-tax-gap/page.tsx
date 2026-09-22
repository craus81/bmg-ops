'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import type { TaxGapBucket as Bucket, TaxGapReport } from '@/lib/quoted-tax-gap';

/**
 * The cleanup list for PR #984: estimates whose SAVED tax is below what
 * today's tax math gives, because the old per-item exclusion dropped
 * ordinary parts out of the tax base.
 *
 * Bucketed by what someone has to do, not by size — a signed quote is frozen
 * and needs a conversation, an unsigned one just needs re-saving before it
 * gets signed at the old figure.
 */

type Report = TaxGapReport & { generatedAt: string };

const BUCKETS: { key: Bucket; label: string; what: string }[] = [
  { key: 'signed', label: 'Signed', what: 'The customer already agreed to the lower figure. Someone has to decide whether to absorb the difference or raise it with them.' },
  { key: 'sent', label: 'Sent, not signed', what: 'Still out for approval at the old figure. Reopen and save it, then resend, before it gets signed.' },
  { key: 'open', label: 'Never sent', what: 'Open and save each one and the tax corrects itself. Nobody outside has seen these.' },
];

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US') : '—');

export default function QuotedTaxGapPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<Bucket | 'all'>('all');

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) { router.push('/home'); return; }
    (async () => {
      try {
        const res = await fetch('/api/reports/quoted-tax-gap');
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        setData(json);
      } catch (e: any) {
        setError(e?.message || 'Report failed');
      }
    })();
  }, [authLoading, isAdmin, router]);

  const rows = useMemo(
    () => (data ? (only === 'all' ? data.rows : data.rows.filter(r => r.bucket === only)) : []),
    [data, only],
  );

  const exportCsv = () => {
    if (!data) return;
    const headers = ['Estimate', 'Customer', 'Needs', 'Status', 'NetSuite estimate', 'Vehicles', 'Rate %', 'Quoted tax', 'Correct tax', 'Short by', 'Signed', 'Sent', 'Created'];
    const escape = (v: any) => `"${(v === null || v === undefined ? '' : String(v)).replace(/"/g, '""')}"`;
    const csv = [
      headers.join(','),
      ...rows.map(r => [
        r.estimate_number, r.customer_name,
        BUCKETS.find(b => b.key === r.bucket)?.label, r.status,
        r.netsuite_estimate_number, r.vehicle_count, (r.tax_rate * 100).toFixed(2),
        r.quoted_tax.toFixed(2), r.correct_tax.toFixed(2), r.gap.toFixed(2),
        day(r.signed_at), day(r.sent_at), day(r.created_at),
      ].map(escape).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quoted-tax-gap_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Quoted Tax Shortfall</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px', maxWidth: '760px' }}>
        Estimates whose saved tax is below what the tax math gives today. Until 22 Sep 2026 the builder skipped any
        line whose NetSuite item had the Taxable box unticked — a checkbox nobody maintains — so ordinary parts fell
        out of the tax base and these quotes went out charging less tax than the invoice will. Each row is listed
        because its own numbers disagree, not because of its date. Tax-exempt customers are excluded.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '13px' }}>{error}</div>}
      {!data && !error && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Recomputing every estimate…</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {BUCKETS.map(b => (
              <button
                key={b.key}
                onClick={() => setOnly(only === b.key ? 'all' : b.key)}
                title={b.what}
                style={{
                  flex: '1 1 220px', textAlign: 'left', cursor: 'pointer',
                  background: 'var(--card)', padding: '12px 14px', borderRadius: '12px',
                  border: `1px solid ${only === b.key ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
                  color: 'inherit', font: 'inherit',
                }}
              >
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{b.label}</div>
                <div style={{ fontSize: '22px', fontWeight: 800, marginTop: '2px' }}>{fmt(data.buckets[b.key].gap)}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {data.buckets[b.key].count} estimate{data.buckets[b.key].count !== 1 ? 's' : ''}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-body)', marginTop: '6px', lineHeight: 1.4 }}>{b.what}</div>
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <div style={{ fontSize: '13px', fontWeight: 700 }}>
              {rows.length} of {data.rows.length} shown · {fmt(data.totalGap)} short in total
            </div>
            {only !== 'all' && (
              <button onClick={() => setOnly('all')} style={{ fontSize: '12px', background: 'none', border: 'none', color: 'var(--accent, #3b82f6)', cursor: 'pointer', padding: 0 }}>
                Show all
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button
              onClick={exportCsv}
              disabled={rows.length === 0}
              style={{
                padding: '7px 14px', borderRadius: '8px', border: '1px solid var(--border)',
                background: 'var(--card)', fontSize: '12px', fontWeight: 700,
                cursor: rows.length === 0 ? 'default' : 'pointer', opacity: rows.length === 0 ? 0.5 : 1,
              }}
            >
              Download CSV
            </button>
          </div>

          {data.rows.length === 0 ? (
            <div style={{
              padding: '12px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', color: '#22c55e',
            }}>
              Nothing short — every estimate&rsquo;s saved tax matches what the app computes today.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '12px', width: '100%' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px' }}>
                    <th style={{ padding: '8px 10px' }}>Estimate</th>
                    <th style={{ padding: '8px 10px' }}>Customer</th>
                    <th style={{ padding: '8px 10px' }}>Needs</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Quoted tax</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Correct tax</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Short by</th>
                    <th style={{ padding: '8px 10px' }}>Signed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '7px 10px', fontWeight: 700 }}>
                        <a href={r.url} style={{ color: 'var(--accent, #3b82f6)', textDecoration: 'none' }}>
                          {r.estimate_number || 'untitled'}
                        </a>
                        {r.vehicle_count > 1 && (
                          <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {r.vehicle_count} vehicles</span>
                        )}
                      </td>
                      <td style={{ padding: '7px 10px' }}>{r.customer_name || '—'}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>
                        {BUCKETS.find(b => b.key === r.bucket)?.label}
                        {r.status ? ` · ${r.status}` : ''}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.quoted_tax)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.correct_tax)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.gap)}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{day(r.signed_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px', lineHeight: 1.6 }}>
            Checked {data.examined.toLocaleString()} of {data.totalEstimates.toLocaleString()} estimates
            ({data.skippedExempt.toLocaleString()} tax-exempt or zero-rated, {data.skippedNoLines.toLocaleString()} with no lines).
            {data.overQuoted.count > 0 && (
              <> {data.overQuoted.count.toLocaleString()} estimate{data.overQuoted.count !== 1 ? 's' : ''} went out
                {' '}{fmt(data.overQuoted.gap)} OVER instead — not listed here, because that difference comes back at invoicing.</>
            )}
            {' '}Generated {new Date(data.generatedAt).toLocaleString('en-US')}.
          </div>
        </>
      )}
    </div>
  );
}
