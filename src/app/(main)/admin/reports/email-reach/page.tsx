'use client';

/**
 * Email Reach Report (R6-13) — deliverability by kind and domain, plus the
 * customers we can no longer reach.
 *
 * Pending is its own column everywhere, never folded into delivered:
 * a message with no delivery webhook is not a delivered one, and a
 * deliverability page that pretended otherwise would flatter every number
 * on it.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { deepLinks } from '@/lib/deep-links';
import type { ReachReport, ReachRow } from '@/lib/email-reach';

const pct = (r: number | null) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`);

export default function EmailReachPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const [days, setDays] = useState<30 | 90 | 180>(30);
  const [data, setData] = useState<ReachReport | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) { router.push('/home'); return; }
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(`/api/reports/email-reach?days=${days}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) { setStatus('error'); return; }
        setData(json); setStatus('ready');
      } catch { if (!cancelled) setStatus('error'); }
    })();
    return () => { cancelled = true; };
  }, [authLoading, isAdmin, days, router]);

  const card: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px',
    padding: '14px 16px', marginBottom: '12px',
  };
  const th: React.CSSProperties = { textAlign: 'right', padding: '6px 8px', fontSize: '10px', fontWeight: 800, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.6px' };
  const td: React.CSSProperties = { textAlign: 'right', padding: '7px 8px', fontSize: '12px', borderTop: '1px solid var(--border)' };

  const table = (title: string, rows: ReachRow[], note?: string) => (
    <div style={card}>
      <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{title}</div>
      {note && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>{note}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '480px' }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Name</th>
              <th style={th}>Delivered</th>
              <th style={th}>Failed</th>
              <th style={th}>Pending</th>
              <th style={th}>Failure rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: 'var(--text-body)' }}>{r.label}</td>
                <td style={td}>{r.delivered.toLocaleString()}</td>
                <td style={{ ...td, color: r.failed > 0 ? '#ef4444' : undefined }}>{r.failed.toLocaleString()}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{r.pending.toLocaleString()}</td>
                <td style={{ ...td, fontWeight: 800, color: (r.failureRate ?? 0) >= 0.1 ? '#ef4444' : (r.failureRate ?? 0) >= 0.03 ? '#f59e0b' : 'var(--text-body)' }}>
                  {pct(r.failureRate)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>Nothing in this window.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>Email Reach</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Where our mail lands, and who we can no longer reach.</div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {[30, 90, 180].map(d => (
            <button key={d} type="button" onClick={() => setDays(d as 30 | 90 | 180)}
              style={{
                padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, cursor: 'pointer',
                border: `1px solid ${days === d ? 'var(--accent)' : 'var(--border)'}`,
                background: days === d ? 'var(--accent)' : 'transparent',
                color: days === d ? '#fff' : 'var(--text-muted)',
              }}>{d}d</button>
          ))}
        </div>
      </div>

      {status === 'loading' && <div style={{ ...card, color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>}
      {status === 'error' && <div style={{ ...card, color: 'var(--text-muted)', fontSize: '12px' }}>Could not build the report — try again in a moment.</div>}

      {status === 'ready' && data && (
        <>
          <div style={{ ...card, background: 'var(--subtle-bg)' }}>
            <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '6px' }}>How to read these numbers</div>
            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {data.caveats.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>

          {table('Overall', [data.totals])}
          {table('By email kind', data.byKind, 'Worst first, weighted by volume — a single failure is not a 100% problem.')}
          {table('By recipient domain', data.byDomain, 'One send counts once per recipient address here.')}

          <div style={card}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Unreachable customers</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Addresses that failed more than once and nobody has marked resolved. Fix the contact, then
              mark the bounce resolved on <a href="/admin/system-health" style={{ color: 'var(--accent)', fontWeight: 700 }}>System Health</a> so it leaves this list.
            </div>
            {data.unreachable.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#22c55e', fontWeight: 700 }}>Nothing outstanding.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {data.unreachable.map(u => (
                  <div key={u.address} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-body)' }}>{u.address}</span>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {u.failures} failure{u.failures === 1 ? '' : 's'} · last {u.lastStatus} {new Date(u.lastFailureAt).toLocaleDateString()} · {u.kinds.join(', ')}
                      </div>
                    </div>
                    {u.customerNetsuiteId
                      ? <a href={deepLinks.customerByNetsuiteId(u.customerNetsuiteId)} style={{ fontSize: '11px', fontWeight: 800, color: 'var(--accent)' }}>Fix contact →</a>
                      : u.prospectId
                        ? <a href={deepLinks.prospect(u.prospectId)} style={{ fontSize: '11px', fontWeight: 800, color: 'var(--accent)' }}>Fix contact →</a>
                        : (
                          /* No routable record — a "Fix contact" link that
                             went nowhere is worse than saying so. */
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>No linked record — search the address</span>
                        )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <div style={{ height: '60px' }} />
    </div>
  );
}
