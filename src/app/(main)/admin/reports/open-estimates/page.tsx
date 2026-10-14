'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { deepLinks } from '@/lib/deep-links';
import { OPEN_BUCKETS, OLD_DRAFT_DAYS, type OpenBucket, type OpenEstimatesReport } from '@/lib/open-estimates';

/**
 * Open Estimates (owner ask 2026-10-14): every estimate still waiting on
 * someone — in review, handed back, not sent, waiting on the customer, or
 * approved with no sales order — so an admin can scan one page and know
 * nothing is being dropped. Bucketing and staleness live in
 * src/lib/open-estimates.ts.
 */

type Report = OpenEstimatesReport & { generatedAt: string; names: Record<string, string> };

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');

export default function OpenEstimatesPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<OpenBucket | 'all'>('all');
  const [staleOnly, setStaleOnly] = useState(false);
  const [showOld, setShowOld] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) { router.push('/home'); return; }
    (async () => {
      try {
        const res = await fetch('/api/reports/open-estimates', { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        setData(json);
      } catch (e: any) {
        setError(e?.message || 'Report failed');
      }
    })();
  }, [authLoading, isAdmin, router]);

  const rows = useMemo(() => (data?.rows || [])
    .filter(r => only === 'all' || r.bucket === only)
    .filter(r => !staleOnly || r.stale)
    .filter(r => showOld || !r.old),
  [data, only, staleOnly, showOld]);
  const oldCount = (data?.rows || []).filter(r => r.old).length;
  const staleTotal = data ? OPEN_BUCKETS.reduce((s, b) => s + data.counts[b.key].stale, 0) : 0;
  const name = (id: string | null) => (id && data?.names[id]) || '—';

  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Open Estimates</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px', maxWidth: '760px' }}>
        Every estimate still waiting on someone, grouped by where it is stuck and oldest first.
        Red rows have waited past the limit on their card. Tap a row to open the estimate.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '13px' }}>{error}</div>}
      {!data && !error && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading open estimates…</div>}

      {data && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {OPEN_BUCKETS.map(b => {
              const c = data.counts[b.key];
              const active = only === b.key;
              return (
                <button
                  key={b.key}
                  onClick={() => setOnly(active ? 'all' : b.key)}
                  title={b.help}
                  style={{
                    flex: '1 1 170px', textAlign: 'left', cursor: 'pointer',
                    background: 'var(--card)', padding: '12px 14px', borderRadius: '12px',
                    border: `1px solid ${active ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
                    color: 'inherit', font: 'inherit',
                  }}
                >
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{b.label}</div>
                  <div style={{ fontSize: '22px', fontWeight: 800, marginTop: '2px' }}>{c.count}</div>
                  <div style={{ fontSize: '11px', marginTop: '2px', color: c.stale ? '#ef4444' : 'var(--text-muted)', fontWeight: c.stale ? 700 : 400 }}>
                    {c.stale ? `${c.stale} overdue (${b.staleLabel})` : `none overdue (${b.staleLabel})`}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{fmt(c.total)}</div>
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginBottom: '10px', fontSize: '12px' }}>
            <div style={{ fontSize: '13px', fontWeight: 700 }}>
              {rows.length} shown{staleTotal > 0 && <span style={{ color: '#ef4444' }}> · {staleTotal} overdue</span>}
            </div>
            {only !== 'all' && (
              <button onClick={() => setOnly('all')} style={{ fontSize: '12px', background: 'none', border: 'none', color: 'var(--accent, #3b82f6)', cursor: 'pointer', padding: 0 }}>
                Show all
              </button>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <input type="checkbox" checked={staleOnly} onChange={e => setStaleOnly(e.target.checked)} />
              Overdue only
            </label>
            {oldCount > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={showOld} onChange={e => setShowOld(e.target.checked)} />
                Show {oldCount} draft{oldCount !== 1 ? 's' : ''} untouched {OLD_DRAFT_DAYS}+ days
              </label>
            )}
          </div>

          {rows.length === 0 ? (
            <div style={{
              padding: '12px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', color: '#22c55e',
            }}>
              Nothing here. Every estimate in this view is moving.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '12px', width: '100%' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px' }}>
                    <th style={{ padding: '8px 10px' }}>Estimate</th>
                    <th style={{ padding: '8px 10px' }}>Customer</th>
                    <th style={{ padding: '8px 10px' }}>Stage</th>
                    <th style={{ padding: '8px 10px' }}>Waiting on</th>
                    <th style={{ padding: '8px 10px' }}>Rep</th>
                    <th style={{ padding: '8px 10px' }}>Since</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Waited</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr
                      key={r.id}
                      onClick={() => router.push(deepLinks.estimate(r.id))}
                      style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: r.stale ? 'rgba(239,68,68,0.06)' : undefined }}
                    >
                      <td style={{ padding: '7px 10px', fontWeight: 700, color: 'var(--accent, #3b82f6)', whiteSpace: 'nowrap' }}>{r.number}</td>
                      <td style={{ padding: '7px 10px' }}>
                        <div>{r.customer || '—'}</div>
                        {r.title && <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{r.title}</div>}
                        {r.note && <div style={{ color: '#ef4444', fontSize: '11px' }}>“{r.note}”</div>}
                      </td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {OPEN_BUCKETS.find(b => b.key === r.bucket)?.label}
                      </td>
                      <td style={{ padding: '7px 10px', fontWeight: 600 }}>
                        {r.bucket === 'waiting' ? 'Customer' : name(r.ownerId)}
                      </td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)' }}>{name(r.repId)}</td>
                      <td style={{ padding: '7px 10px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{day(r.since)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: r.stale ? 800 : 400, color: r.stale ? '#ef4444' : undefined, fontVariantNumeric: 'tabular-nums' }}>
                        {r.age} {r.ageUnit === 'shop_hours' ? 'shop hr' : r.age === 1 ? 'day' : 'days'}
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px', lineHeight: 1.6 }}>
            Estimates with a sales order or marked lost are not listed. Review time counts shop hours only
            (weekdays 7:00 to 3:30 Central), the same clock as the review reminder.
            {' '}Generated {new Date(data.generatedAt).toLocaleString('en-US')}.
          </div>
        </>
      )}
    </div>
  );
}
