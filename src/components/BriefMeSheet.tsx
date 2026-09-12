'use client';

/**
 * "Brief me" — the pre-call rundown, over whatever screen you're on
 * (R6-13, audit line 415b).
 *
 * Renders the model's ten-line brief and, folded underneath it, the raw
 * findings it was written from. Both, deliberately: the brief is what you
 * read aloud, the findings are what you check before you quote a number down
 * the phone. A summary and the facts behind it must never be
 * indistinguishable, and the footer always says which one you are reading.
 *
 * When a section could not be read, this says so in its own band. A short
 * brief has two very different causes — a quiet account, or half the
 * systems being unreachable — and the reader has to be able to tell which.
 */

import { useState, useEffect, useCallback } from 'react';

interface BriefResponse {
  brief: string;
  source: 'ai' | 'facts';
  note?: string;
  /** The findings the brief was written from, one line per section. */
  lines?: string[];
  unknown?: string[];
}

export interface BriefTarget {
  prospectId?: string | null;
  netsuiteId?: string | null;
  name?: string | null;
}

/** Bold the leading **Label:** the brief prompt asks for; everything else is plain. */
function renderLine(line: string, i: number) {
  const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(line.trim());
  if (!m) return <div key={i} style={{ marginBottom: '6px', lineHeight: 1.45 }}>{line}</div>;
  return (
    <div key={i} style={{ marginBottom: '6px', lineHeight: 1.45 }}>
      <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{m[1]}</span>{' '}
      <span>{m[2]}</span>
    </div>
  );
}

export default function BriefMeSheet({ target, onClose }: { target: BriefTarget; onClose: () => void }) {
  const [data, setData] = useState<BriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/customers/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prospectId: target.prospectId || undefined,
          netsuiteId: target.netsuiteId || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body?.error || 'Could not build the brief.'); return; }
      setData(body);
    } catch (e: any) {
      setError(e?.message || 'Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [target.prospectId, target.netsuiteId]);

  useEffect(() => { load(); }, [load]);

  const lines = (data?.brief || '').split('\n').filter(l => l.trim());

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', padding: '18px', width: '100%', maxWidth: '520px',
        maxHeight: 'calc(88vh / var(--ts))', overflowY: 'auto', boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', alignItems: 'start', gap: '10px', marginBottom: '12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>Brief me</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{target.name || 'This customer'}</div>
          </div>
          <button onClick={onClose} style={{
            background: 'transparent', border: '1px solid var(--border)', borderRadius: '8px',
            padding: '5px 10px', color: 'var(--text-body)', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
          }}>Close</button>
        </div>

        {loading && (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: '13px', color: 'var(--text-muted)' }}>
            Gathering estimates, A/R, shop status, email and threads…
          </div>
        )}

        {!loading && error && (
          <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', borderRadius: '9px', padding: '11px 12px', fontSize: '12.5px', fontWeight: 600 }}>
            {error}
            <button onClick={load} style={{ marginLeft: '10px', background: 'transparent', border: 'none', color: '#ef4444', fontWeight: 800, cursor: 'pointer', textDecoration: 'underline' }}>Retry</button>
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* Sections that could not be read. Named first, because a short
                brief reads as a quiet account unless you know otherwise. */}
            {(data.unknown?.length ?? 0) > 0 && (
              <div style={{
                background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)',
                borderRadius: '9px', padding: '10px 12px', fontSize: '12px', color: '#fbbf24',
                fontWeight: 600, marginBottom: '12px', lineHeight: 1.45,
              }}>
                Could not be read, so it is missing below rather than clear:{' '}
                {data.unknown!.join(', ')}.
              </div>
            )}

            <div style={{ fontSize: '13px', color: 'var(--text-body)' }}>
              {lines.length > 0 ? lines.map(renderLine) : <span style={{ color: 'var(--text-muted)' }}>Nothing to report.</span>}
            </div>

            {/* The evidence, under the prose. The brief is what you read
                aloud; these are the lines it was written from, so a figure
                can be checked instead of taken on the summary's word. Hidden
                when the brief IS the findings — no point showing them twice. */}
            {data.source === 'ai' && (data.lines?.length ?? 0) > 0 && (
              <details style={{ marginTop: '14px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Findings it was written from
                </summary>
                <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {data.lines!.map((l, i) => (
                    <div key={i} style={{ marginBottom: '4px' }}>{l}</div>
                  ))}
                </div>
              </details>
            )}

            <div style={{
              marginTop: '14px', paddingTop: '10px', borderTop: '1px solid var(--border)',
              fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5,
            }}>
              {data.source === 'ai'
                ? 'Written by FleetSuite AI from the findings above — check any figure before you quote it.'
                : (data.note || 'Raw findings, not an AI summary.')}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
