'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { periodFor, shiftPeriod, PERIOD_RE, type GateState } from '@/lib/month-close';

/**
 * Month-End Close Cockpit (R6-12). One page per accounting month.
 *
 * The UI's whole job is to keep the six states apart: pass, fail, unknown
 * (the check FAILED — not clean), pending (nobody has looked), acknowledged,
 * and waived (failed, and someone took responsibility). A waived gate keeps
 * showing its outstanding count; a closed month says how many gates were
 * waived rather than reading as "all clean".
 */

interface Gate {
  key: string;
  title: string;
  passMeans: string;
  link: string;
  fixLabel: string;
  kind: 'computed' | 'manual';
  manualBecause?: string;
  state: GateState;
  count: number | null;
  examples: { label: string; url?: string }[];
  error: string | null;
  signoff: { kind: 'acknowledged' | 'waived'; note: string | null; signedByName: string | null; signedAt: string } | null;
}

interface Report {
  period: string;
  label: string;
  gates: Gate[];
  verdict: { ready: boolean; blocking: Gate[]; waived: Gate[]; unmeasured: Gate[]; passed: number };
  closed: { closedByName: string | null; closedAt: string; note: string | null } | null;
  fromSnapshot: boolean;
  meta: { startIso: string; endIso: string; generatedAt: string };
}

const STATE_META: Record<GateState, { label: string; color: string; icon: string }> = {
  pass: { label: 'Clear', color: '#22c55e', icon: '✓' },
  fail: { label: 'Open', color: '#ef4444', icon: '✕' },
  unknown: { label: 'Not checked', color: '#a78bfa', icon: '?' },
  pending: { label: 'Awaiting sign-off', color: '#f59e0b', icon: '•' },
  acknowledged: { label: 'Signed off', color: '#22c55e', icon: '✓' },
  waived: { label: 'Waived', color: '#f59e0b', icon: '!' },
};

export default function MonthClosePage() {
  const { isAdmin, hasRole, loading: authLoading } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Mirrors the route's requireRole(req, ['executive']) — admins auto-pass there.
  const allowed = isAdmin || hasRole('executive');

  const initial = searchParams?.get('period');
  // Default to LAST month: the month you close is the one that has ended.
  const [period, setPeriod] = useState(
    initial && PERIOD_RE.test(initial) ? initial : shiftPeriod(periodFor(), -1),
  );
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/reports/month-close?period=${p}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Report failed');
      setReport(data as Report);
    } catch (e: any) {
      setError(e.message || 'Report failed');
      setReport(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!allowed) { router.push('/home'); return; }
    load(period);
  }, [authLoading, allowed, router, load, period]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/reports/month-close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      setReport(data as Report);
    } catch (e: any) {
      setError(e.message || 'Action failed');
    }
    setBusy(false);
  };

  const signOff = (g: Gate) => {
    if (g.kind === 'manual') {
      const note = window.prompt(`Sign off "${g.title}"?\n\n${g.passMeans}\n\nOptional note:`);
      if (note === null) return;
      post({ action: 'sign_off', gateKey: g.key, kind: 'acknowledged', note });
    } else {
      const note = window.prompt(
        `Waive "${g.title}" with ${g.count} still open?\n\n`
        + 'A waiver does not fix anything — it records that you accepted it. A written reason is required.',
      );
      if (note === null) return;
      if (!note.trim()) { setError('A waiver needs a written reason.'); return; }
      post({ action: 'sign_off', gateKey: g.key, kind: 'waived', note });
    }
  };

  const closeMonth = () => {
    const note = window.prompt(`Close ${report?.label}? Gates are re-checked on the server before it stamps.\n\nOptional note:`);
    if (note === null) return;
    post({ action: 'close', note });
  };

  const reopen = () => {
    if (!window.confirm(`Reopen ${report?.label}? The close stamp stays on record as reopened.`)) return;
    post({ action: 'reopen' });
  };

  const chip = (state: GateState) => {
    const m = STATE_META[state];
    return (
      <span style={{
        fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px',
        color: m.color, background: `${m.color}1f`, padding: '3px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
      }}>{m.icon} {m.label}</span>
    );
  };

  if (authLoading || !allowed) return null;

  const isCurrentOrFuture = period >= periodFor();

  return (
    <div style={{ maxWidth: '900px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Month-End Close</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        The gates that have to be clear before a month is put to bed. A check the app could not run says
        <strong> Not checked</strong> — never &ldquo;clear&rdquo;.
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' }}>
        <button onClick={() => setPeriod(shiftPeriod(period, -1))} disabled={busy}
          style={{ padding: '7px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontWeight: 700 }}>←</button>
        <div style={{ fontSize: '17px', fontWeight: 800, minWidth: '160px', textAlign: 'center' }}>{report?.label || period}</div>
        <button onClick={() => setPeriod(shiftPeriod(period, 1))} disabled={busy}
          style={{ padding: '7px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontWeight: 700 }}>→</button>
        {period !== shiftPeriod(periodFor(), -1) && (
          <button onClick={() => setPeriod(shiftPeriod(periodFor(), -1))} disabled={busy}
            style={{ padding: '7px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: '12px' }}>
            Last month
          </button>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px', fontSize: '13px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {report && !loading && (
        <>
          {report.closed && (
            <div style={{
              border: '1px solid #22c55e', background: '#22c55e14', borderRadius: '12px',
              padding: '12px 16px', marginBottom: '14px',
            }}>
              <div style={{ fontWeight: 800, color: '#22c55e' }}>
                Closed {new Date(report.closed.closedAt).toLocaleDateString()}
                {report.closed.closedByName ? ` by ${report.closed.closedByName}` : ''}
              </div>
              {report.verdict.waived.length > 0 && (
                <div style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 700, marginTop: '3px' }}>
                  {report.verdict.waived.length} gate{report.verdict.waived.length === 1 ? '' : 's'} closed on a waiver, not a fix.
                </div>
              )}
              {report.closed.note && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>{report.closed.note}</div>}
              {report.fromSnapshot && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '5px' }}>
                  Showing what the gates said when the month was closed, not a fresh check.
                </div>
              )}
              <button onClick={reopen} disabled={busy}
                style={{ marginTop: '8px', padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', cursor: 'pointer', fontSize: '12px', fontWeight: 700 }}>
                Reopen
              </button>
            </div>
          )}

          <div style={{ display: 'grid', gap: '10px', marginBottom: '16px' }}>
            {report.gates.map(g => {
              const m = STATE_META[g.state];
              return (
                <div key={g.key} style={{
                  border: `1px solid ${g.state === 'fail' || g.state === 'unknown' ? m.color : 'var(--border)'}`,
                  borderRadius: '12px', padding: '12px 16px', background: 'var(--card)',
                }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 380px', minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: '14px' }}>{g.title}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{g.passMeans}</div>
                    </div>
                    {chip(g.state)}
                  </div>

                  {g.state === 'unknown' && (
                    <div style={{ fontSize: '12px', color: '#a78bfa', marginTop: '8px', fontWeight: 600 }}>
                      This check did not run{g.error ? `: ${g.error}` : ''}. It is not a pass and it cannot be waived — the month stays open until it runs.
                    </div>
                  )}

                  {g.kind === 'manual' && g.state === 'pending' && g.manualBecause && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>{g.manualBecause}</div>
                  )}

                  {(g.state === 'fail' || g.state === 'waived') && g.count != null && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: g.state === 'waived' ? '#f59e0b' : '#ef4444' }}>
                        {g.count} outstanding
                      </div>
                      {g.examples.length > 0 && (
                        <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-muted)' }}>
                          {g.examples.map((ex, i) => (
                            <li key={i} style={{ marginBottom: '2px' }}>
                              {ex.url
                                ? <Link href={ex.url} style={{ color: 'var(--accent, #2563eb)', textDecoration: 'none' }}>{ex.label}</Link>
                                : ex.label}
                            </li>
                          ))}
                          {g.count > g.examples.length && <li>…and {g.count - g.examples.length} more</li>}
                        </ul>
                      )}
                    </div>
                  )}

                  {g.signoff && (
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
                      {g.signoff.kind === 'waived' ? 'Waived' : 'Signed off'} by {g.signoff.signedByName || 'someone'} on{' '}
                      {new Date(g.signoff.signedAt).toLocaleDateString()}
                      {g.signoff.note && <> — &ldquo;{g.signoff.note}&rdquo;</>}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
                    {g.state !== 'pass' && (
                      <Link href={g.link} style={{
                        padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border)',
                        fontSize: '12px', fontWeight: 700, textDecoration: 'none', color: 'var(--text-primary)',
                      }}>{g.fixLabel}</Link>
                    )}
                    {!report.closed && (g.state === 'fail' || g.state === 'pending') && (
                      <button onClick={() => signOff(g)} disabled={busy}
                        style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: '12px', fontWeight: 700 }}>
                        {g.kind === 'manual' ? 'Sign off' : 'Waive with a reason'}
                      </button>
                    )}
                    {!report.closed && g.signoff && (
                      <button onClick={() => post({ action: 'unsign', gateKey: g.key })} disabled={busy}
                        style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: '12px', color: 'var(--text-muted)' }}>
                        Undo sign-off
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {!report.closed && (
            <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '14px 16px', background: 'var(--card)' }}>
              {isCurrentOrFuture ? (
                <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                  {report.label} has not ended yet — half a month&rsquo;s gates passing says nothing about the month.
                </div>
              ) : report.verdict.ready ? (
                <>
                  <div style={{ fontSize: '13px', marginBottom: '10px' }}>
                    Every gate is clear{report.verdict.waived.length > 0 && <> or waived ({report.verdict.waived.length} waived)</>}.
                  </div>
                  <button onClick={closeMonth} disabled={busy}
                    style={{ padding: '9px 18px', borderRadius: '9px', border: 'none', background: '#22c55e', color: '#fff', cursor: 'pointer', fontWeight: 800 }}>
                    {busy ? 'Closing…' : `Close ${report.label}`}
                  </button>
                </>
              ) : (
                <div style={{ fontSize: '13px' }}>
                  <strong>{report.verdict.blocking.length} gate{report.verdict.blocking.length === 1 ? '' : 's'}</strong> still standing in the way:
                  <ul style={{ margin: '6px 0 0', paddingLeft: '18px', color: 'var(--text-muted)' }}>
                    {report.verdict.blocking.map(b => (
                      <li key={b.key}>{b.title} — {STATE_META[b.state].label.toLowerCase()}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
            Months run on the shop calendar (America/Chicago), the same one the nightly metric snapshots use.
            Closing re-checks every gate on the server first and freezes what they said, so a closed month never re-renders
            against data that moved on afterwards.
          </div>
        </>
      )}
    </div>
  );
}
