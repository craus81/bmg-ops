'use client';

/**
 * Alert Scoreboard (R6-13) — per-type effectiveness and push coverage.
 *
 * The page leads with what the numbers CANNOT show (the caveats the server
 * returns), because a report about whether alerts are being read is exactly
 * the kind that gets quoted later: "read" here means an in-app row was
 * marked read, click-through is not recorded anywhere, and bulk-cleared is
 * an inference from mark-all-read timing.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import type { Scoreboard } from '@/lib/alert-scoreboard';

const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function AlertScoreboardPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const [days, setDays] = useState<30 | 90>(30);
  const [data, setData] = useState<Scoreboard | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) { router.push('/home'); return; }
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const res = await fetch(`/api/reports/alert-scoreboard?days=${days}`);
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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>Alert Scoreboard</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Which alerts get read, and who can&apos;t receive a push.</div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {[30, 90].map(d => (
            <button key={d} type="button" onClick={() => setDays(d as 30 | 90)}
              style={{
                padding: '6px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, cursor: 'pointer',
                border: `1px solid ${days === d ? 'var(--accent)' : 'var(--border)'}`,
                background: days === d ? 'var(--accent)' : 'transparent',
                color: days === d ? '#fff' : 'var(--text-muted)',
              }}>{d} days</button>
          ))}
        </div>
      </div>

      {status === 'loading' && <div style={{ ...card, color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>}
      {status === 'error' && <div style={{ ...card, color: 'var(--text-muted)', fontSize: '12px' }}>Could not build the scoreboard — try again in a moment.</div>}

      {status === 'ready' && data && (
        <>
          <div style={{ ...card, background: 'var(--subtle-bg)' }}>
            <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '6px' }}>What these numbers do and don&apos;t say</div>
            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
              {data.caveats.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>

          <div style={card}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>
              By type — noisiest ignored first
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              {data.totalSent.toLocaleString()} in-app notifications over {data.windowDays} days.
              Change a type&apos;s defaults in <a href="/settings" style={{ color: 'var(--accent)', fontWeight: 700 }}>Settings → Which alerts reach you</a>.
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '620px' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Alert</th>
                    <th style={th}>Sent</th>
                    <th style={th}>Read</th>
                    <th style={th}>Bulk-cleared</th>
                    <th style={th}>Never opened</th>
                    <th style={th}>Ignored</th>
                    <th style={th}>Median to read</th>
                  </tr>
                </thead>
                <tbody>
                  {data.types.map(t => (
                    <tr key={t.type}>
                      <td style={{ ...td, textAlign: 'left' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-body)' }}>
                          {t.label}
                          {t.unregistered && <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 800, color: '#f59e0b' }}>not in registry</span>}
                        </div>
                        <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>{t.areaLabel} · {t.type}</div>
                      </td>
                      <td style={td}>{t.sent.toLocaleString()}</td>
                      <td style={td}>{t.read.toLocaleString()}</td>
                      <td style={td}>{t.bulkCleared.toLocaleString()}</td>
                      <td style={td}>{t.unread.toLocaleString()}</td>
                      <td style={{ ...td, fontWeight: 800, color: t.ignoredRate >= 0.8 ? '#ef4444' : t.ignoredRate >= 0.5 ? '#f59e0b' : 'var(--text-body)' }}>{pct(t.ignoredRate)}</td>
                      {/* Unknown, not zero: nobody read it individually. */}
                      <td style={td}>{t.medianMinutesToRead == null ? '—' : `${Math.round(t.medianMinutesToRead)} min`}</td>
                    </tr>
                  ))}
                  {data.types.length === 0 && (
                    <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>No notifications in this window.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={card}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>Push coverage</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              {data.pushCoverage.withPush} of {data.pushCoverage.staff} staff accounts have at least one browser or device
              registered. The rest only ever see an alert when they open the app.
            </div>
            {data.pushCoverage.missing.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#22c55e', fontWeight: 700 }}>Everyone can receive a push.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {data.pushCoverage.missing.map(m => (
                  <div key={m.userId} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', fontSize: '12px', padding: '5px 0', borderTop: '1px solid var(--border)' }}>
                    <span style={{ fontWeight: 700, color: 'var(--text-body)' }}>{m.name || m.email || m.userId}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                      No browser or device — ask them to open Settings and tap Enable Push Notifications.
                    </span>
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
