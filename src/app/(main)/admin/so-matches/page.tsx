'use client';

/**
 * Orphan sales-order match review (R6-13, audit line 424).
 *
 * The nightly pass only ever SUGGESTS. This is where a person turns a
 * suggestion into a link, and the page is built so the decision is made on
 * the evidence rather than on the score. The rationale under each pair
 * spells out what was actually compared — the customer id, how far apart
 * the totals were, how many line items overlapped, how many days separated
 * them — AND names the signals that did not fire, so a match on customer
 * and date alone reads as thin, because it is.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { deepLinks } from '@/lib/deep-links';

interface SignalDetail { strength: number; points: number; detail: string }

interface Suggestion {
  id: string;
  so_id: string;
  estimate_id: string;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  signals: Record<string, SignalDetail | boolean | string | null>;
  text_compared: boolean | null;
  text_verdict: string | null;
  created_at: string;
  so: { tranid: string | null; customer: string | null; date: string | null; total: number | null } | null;
  estimate: { number: string | null; title: string | null; status: string; total: number | null; createdAt: string } | null;
  alreadyLinked: boolean;
}

const money = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');

const CONF_COLOR: Record<string, string> = { high: '#22c55e', medium: '#fbbf24', low: '#94a3b8' };

export default function SoMatchesPage() {
  const router = useRouter();
  const { isAdmin, isSales, loading: authLoading } = useAuth();
  const allowed = isAdmin || isSales;

  const [rows, setRows] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !allowed) router.push('/home');
  }, [authLoading, allowed, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/so-matches');
      const body = await res.json();
      if (!res.ok) { setError(body?.error || 'Could not load suggestions.'); return; }
      setRows(body.suggestions || []);
    } catch (e: any) {
      setError(e?.message || 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  const decide = async (id: string, decision: 'accept' | 'reject') => {
    setBusy(id);
    setMsg(null);
    try {
      const res = await fetch('/api/so-matches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision }),
      });
      const body = await res.json();
      if (!res.ok) { setMsg(body?.error || 'That did not go through.'); return; }
      if (body.warning) setMsg(body.warning);
      setRows(prev => prev.filter(r => r.id !== id));
    } catch (e: any) {
      setMsg(e?.message || 'That did not go through.');
    } finally {
      setBusy(null);
    }
  };

  if (authLoading || !allowed) return null;

  return (
    <div>
      <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>
        Unmatched sales orders
      </h1>
      <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '16px' }}>
        Sales orders raised inside NetSuite carry none of the signals the sync links on, so the estimate
        they came from never learns it converted. These are scored guesses, nothing more — accepting one
        writes the link; rejecting keeps it out of the queue for good.
      </p>

      {msg && (
        <div style={{
          background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)',
          color: '#fbbf24', borderRadius: '9px', padding: '10px 12px', fontSize: '12.5px',
          fontWeight: 600, marginBottom: '12px',
        }}>{msg}</div>
      )}

      {loading && <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}

      {!loading && error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', borderRadius: '9px', padding: '11px 12px', fontSize: '12.5px', fontWeight: 600 }}>
          {error} <button onClick={load} style={{ marginLeft: '8px', background: 'transparent', border: 'none', color: '#ef4444', fontWeight: 800, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ padding: '36px 20px', textAlign: 'center', background: 'var(--card)', borderRadius: '12px', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-label)' }}>Nothing to review</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', lineHeight: 1.5 }}>
            Either every mirrored order is already linked, or none of the unlinked ones scored high enough
            to be worth your time. This is not a claim that every order found its estimate.
          </div>
        </div>
      )}

      {!loading && rows.map(r => (
        <div key={r.id} style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px',
          padding: '14px', marginBottom: '10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'start', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '220px' }}>
              <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                SO {r.so?.tranid || '(unknown)'} → {r.estimate?.number || '(unknown estimate)'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {r.so?.customer || 'Unknown customer'} · order {r.so?.date || '—'} {money(r.so?.total)} · estimate {money(r.estimate?.total)} ({r.estimate?.status})
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: CONF_COLOR[r.confidence] }}>{Math.round(r.score)}</div>
              <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: CONF_COLOR[r.confidence] }}>
                {r.confidence}
              </div>
            </div>
          </div>

          <div style={{ fontSize: '12.5px', color: 'var(--text-body)', marginTop: '8px', lineHeight: 1.5 }}>
            {r.rationale}
          </div>

          {/* The tie-break, stated as what it is. An ambiguous pair whose
              text comparison never ran says so — it does not quietly look
              the same as one that ran and agreed. */}
          {r.text_compared === true && r.text_verdict && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', fontStyle: 'italic' }}>
              {r.text_verdict}
            </div>
          )}
          {r.text_compared === false && (
            <div style={{ fontSize: '12px', color: '#fbbf24', marginTop: '6px' }}>
              The numbers could not separate this from another candidate, and the line-description
              comparison did not run. Read both records before accepting.
            </div>
          )}

          {r.alreadyLinked && (
            <div style={{ fontSize: '12px', color: '#fbbf24', marginTop: '6px', fontWeight: 600 }}>
              This order or estimate has been linked since the suggestion was made — accepting will be refused.
            </div>
          )}

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
            <button
              onClick={() => decide(r.id, 'accept')}
              disabled={busy === r.id || r.alreadyLinked}
              style={{
                padding: '8px 14px', borderRadius: '9px', border: 'none', fontSize: '12.5px', fontWeight: 800,
                background: busy === r.id || r.alreadyLinked ? 'var(--border)' : '#22c55e',
                color: busy === r.id || r.alreadyLinked ? 'var(--text-muted)' : '#fff',
                cursor: busy === r.id || r.alreadyLinked ? 'default' : 'pointer',
              }}
            >{busy === r.id ? 'Working…' : 'Link them'}</button>
            <button
              onClick={() => decide(r.id, 'reject')}
              disabled={busy === r.id}
              style={{
                padding: '8px 14px', borderRadius: '9px', fontSize: '12.5px', fontWeight: 700,
                background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', cursor: 'pointer',
              }}
            >Not a match</button>
            {r.estimate_id && (
              <button
                onClick={() => router.push(deepLinks.estimate(r.estimate_id))}
                style={{
                  padding: '8px 14px', borderRadius: '9px', fontSize: '12.5px', fontWeight: 700,
                  background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', cursor: 'pointer',
                }}
              >Open estimate</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
