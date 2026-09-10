'use client';

import { useState, useCallback, useEffect } from 'react';

/**
 * Integration Checkup — the Connections tab on System Health.
 *
 * Answers "is it actually set up?" for every external dependency, so that
 * question stops requiring a person to log into Vercel and NetSuite and
 * compare against a document.
 *
 * Deliberately NOT loaded with the rest of the page: the probes hit NetSuite
 * and the three RESTlets live, so they run when someone opens this tab and
 * not on every System Health visit.
 */

type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

interface CheckRow {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
  impact?: string;
  fix?: string;
  docs?: string;
}

interface CheckGroup {
  key: string;
  label: string;
  blurb: string;
  status: CheckStatus;
  rows: CheckRow[];
}

const STATUS_STYLE: Record<CheckStatus, { label: string; color: string; bg: string }> = {
  ok: { label: 'OK', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  warn: { label: 'Check', color: '#fbbf24', bg: 'rgba(251,191,36,0.1)' },
  fail: { label: 'Missing', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  unknown: { label: 'Off', color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' },
};

const chip = (status: CheckStatus) => {
  const s = STATUS_STYLE[status];
  return (
    <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '6px', background: s.bg, color: s.color, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
};

export default function ConnectionsPanel() {
  const [groups, setGroups] = useState<CheckGroup[]>([]);
  const [generatedAt, setGeneratedAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Defaults to the question people actually open this tab to ask. The full
  // list is ~70 rows; leading with all of them buries the four that matter.
  const [problemsOnly, setProblemsOnly] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/system-health/connections');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setGroups(data.groups || []);
      setGeneratedAt(data.generatedAt || '');
    } catch (e: any) {
      setError(e.message || 'Could not run the checkup');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // 'unknown' is an unprovisioned optional integration — a decision, not a
  // fault. Counting it as a problem would make the headline permanently red
  // over things nobody intends to turn on.
  const isProblem = (r: CheckRow) => r.status === 'fail' || r.status === 'warn';
  const problems = groups.flatMap(g => g.rows).filter(isProblem);
  const failures = problems.filter(r => r.status === 'fail').length;

  const shown = groups
    .map(g => ({ ...g, rows: problemsOnly ? g.rows.filter(isProblem) : g.rows }))
    .filter(g => g.rows.length > 0);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '240px' }}>
          <div style={{ fontSize: '16px', fontWeight: 800 }}>Connections</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Everything the app needs from NetSuite, Vercel and connected apps, probed live. Setup steps for anything missing are in <code>docs/owner-setup-runbook.md</code>.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button onClick={() => setProblemsOnly(v => !v)} style={{
            padding: '6px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: problemsOnly ? 'rgba(251,191,36,0.1)' : 'var(--card)',
            border: `1px solid ${problemsOnly ? 'rgba(251,191,36,0.35)' : 'var(--border)'}`,
            color: problemsOnly ? '#fbbf24' : 'var(--text-muted)',
          }}>{problemsOnly ? '✓ Needs attention' : 'Needs attention'}</button>
          <button onClick={load} disabled={loading} style={{
            padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer',
          }}>{loading ? 'Probing…' : '↻ Re-run'}</button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {loading && groups.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px' }}>
          Probing NetSuite, the RESTlets and connected apps…
        </div>
      )}

      {!loading && !error && (
        <div style={{ fontSize: '12px', fontWeight: 700, color: problems.length === 0 ? '#22c55e' : failures > 0 ? '#ef4444' : '#fbbf24', marginBottom: '10px' }}>
          {problems.length === 0
            ? '✓ Everything the app depends on is configured'
            : `⚠ ${problems.length} item${problems.length !== 1 ? 's' : ''} need attention${failures > 0 ? ` — ${failures} breaking something today` : ''}`}
          {generatedAt && <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '8px' }}>checked {new Date(generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
        </div>
      )}

      {!loading && !error && problemsOnly && problems.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px' }}>
          Nothing to fix. Switch off &quot;Needs attention&quot; to see the full inventory.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {shown.map(g => (
          <div key={g.key}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{g.label}</div>
              {chip(g.status)}
            </div>
            {!problemsOnly && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>{g.blurb}</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {g.rows.map(r => {
                const s = STATUS_STYLE[r.status];
                const bad = r.status === 'fail' || r.status === 'warn';
                return (
                  <div key={r.key} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 14px', borderRadius: '10px',
                    background: 'var(--card)', border: `1px solid ${bad ? s.color + '44' : 'var(--border)'}`,
                  }}>
                    <span style={{ marginTop: '1px' }}>{chip(r.status)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{r.label}</div>
                      <div style={{ fontSize: '11px', color: bad ? s.color : 'var(--text-muted)', marginTop: '2px' }}>{r.detail}</div>
                      {r.impact && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                          <strong style={{ color: 'var(--text-secondary)' }}>While unset:</strong> {r.impact}
                        </div>
                      )}
                      {r.fix && (
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                          <strong style={{ color: 'var(--text-secondary)' }}>Fix:</strong> {r.fix}
                        </div>
                      )}
                      {r.docs && (
                        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                          Runbook: <code>{r.docs}</code>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
